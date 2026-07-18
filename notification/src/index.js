// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SERVICE — Port 3009
// Push (FCM/APNs), SMS, In-app | Kafka consumer
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const axios = require('axios');
const fcmClient = require('./fcm'); // FCM V1 API — service account auth
const { globalErrorHandler, AuthenticationError } = require('../shared/errors');
const { success, createLogger } = require('../shared/utils');
const { EVENTS } = require('../shared/constants');

const log = createLogger('notification-service');
const { createDbPool } = require('../shared/utils/db-client');
const db = createDbPool();
const { createRedisClient } = require('../shared/utils/redis-client');
const redis = createRedisClient();

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION TEMPLATES
// ═══════════════════════════════════════════════════════════════
const templates = {
  [EVENTS.BALANCE_LOW]: (data) => ({
    title: `⚠️ Low Data — ${data.network}`,
    body: `Only ${data.balanceMb < 1024 ? Math.round(data.balanceMb) + 'MB' : (data.balanceMb / 1024).toFixed(1) + 'GB'} remaining on ${data.network}. Top up now to stay connected.`,
    deepLink: '/emergency',
    type: 'balance_low',
  }),

  [EVENTS.BUDGET_THRESHOLD]: (data) => ({
    title: `💰 Budget ${data.pct}% Used`,
    body: `You've used ₦${data.spent?.toLocaleString()} of your ₦${data.budget?.toLocaleString()} monthly budget. ${data.pct >= 90 ? 'Almost at limit!' : 'Stay on track.'}`,
    deepLink: '/analytics',
    type: 'budget_alert',
  }),

  [EVENTS.DATA_EXHAUSTION_PREDICTED]: (data) => ({
    title: `📡 Data Running Low — ${data.network}`,
    body: `Your ${data.network} data is predicted to run out in ${data.hoursRemaining < 24 ? Math.round(data.hoursRemaining) + ' hours' : Math.ceil(data.hoursRemaining / 24) + ' days'}. Plan ahead.`,
    deepLink: `/sims/${data.simId}`,
    type: 'exhaustion_warning',
  }),

  [EVENTS.DATA_EXPIRY_WARNING]: (data) => ({
    title: `⏳ Data Expiring — ${data.network}`,
    body: `${data.balanceMb < 1024 ? Math.round(data.balanceMb) + 'MB' : (data.balanceMb / 1024).toFixed(1) + 'GB'} on ${data.network} expires in ${data.daysToExpiry} day${data.daysToExpiry === 1 ? '' : 's'}. Use it or renew!`,
    deepLink: '/bundles',
    type: 'expiry_warning',
  }),

  [EVENTS.BUNDLE_PURCHASED]: (data) => ({
    title: `✅ Bundle Activated!`,
    body: `Your ${data.network} bundle is active. ${data.dataMb >= 1024 ? (data.dataMb / 1024).toFixed(1) + 'GB' : data.dataMb + 'MB'} added successfully.`,
    deepLink: '/home',
    type: 'purchase_success',
  }),

  [EVENTS.SCORE_RECALCULATED]: (data) => ({
    title: `⭐ Score ${data.delta > 0 ? 'Up' : 'Down'} ${Math.abs(data.delta)} Points`,
    body: `Your Connectivity Score is now ${data.score}/850 (${data.tier}). ${data.delta > 0 ? 'Great progress! 🎉' : 'Check your score for improvement tips.'}`,
    deepLink: '/score',
    type: 'score_update',
  }),

  [EVENTS.CREDIT_EARNED]: (data) => ({
    title: `🎁 +${data.credits} Credits Earned!`,
    body: `You earned ${data.credits} DataOS Credits (₦${Math.floor(data.credits * 0.5)} value). ${data.subType === 'referral' ? 'Your referral paid off!' : 'Keep it up!'}`,
    deepLink: '/wallet',
    type: 'credit_earned',
  }),

  [EVENTS.AI_INSIGHT_GENERATED]: (data) => ({
    title: `🤖 New AI Insight`,
    body: data.body || 'DataOS AI has a new recommendation for you.',
    deepLink: '/home',
    type: 'ai_insight',
  }),

  weekly_summary: (data) => ({
    title: `📊 Your Weekly Data Summary`,
    body: `This week: spent ₦${data.weeklySpend?.toLocaleString()}, used ${data.weeklyMb >= 1024 ? (data.weeklyMb / 1024).toFixed(1) + 'GB' : data.weeklyMb + 'MB'}. Score: ${data.score}/850.`,
    deepLink: '/analytics',
    type: 'weekly_summary',
  }),

  emergency: (data) => ({
    title: `🚨 No Data Remaining`,
    body: `You've run out of data on all SIMs. Tap for emergency options — borrow credits or find free Wi-Fi.`,
    deepLink: '/emergency',
    type: 'emergency',
  }),
};

// ═══════════════════════════════════════════════════════════════
// DELIVERY CHANNELS
// ═══════════════════════════════════════════════════════════════
// FCM uses V1 API (service account) — legacy server key is disabled on this project

async function sendPush(fcmToken, notification, data = {}) {
  const result = await fcmClient.send(fcmToken, notification, data);
  if (result.unregistered) {
    await db.query('UPDATE user_profiles SET fcm_token = NULL WHERE fcm_token = $1', [fcmToken]).catch(() => {});
  }
  return result;
}

const sms = {
  send: async (phone, message) => {
    if (process.env.NODE_ENV !== 'production') {
      log.debug('SMS notification (dev skipped)', { phone: phone.slice(0, 7) + 'XXXX' });
      return { success: true, dev: true };
    }
    try {
      await axios.post('https://api.ng.termii.com/api/sms/send', {
        to: phone, from: 'DataOS', sms: message,
        type: 'plain', api_key: process.env.TERMII_API_KEY, channel: 'generic',
      }, { timeout: 10000 });
      return { success: true };
    } catch (err) {
      log.error('Termii SMS failed', { err: err.message });
      return { success: false };
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// CORE NOTIFICATION SENDER
// ═══════════════════════════════════════════════════════════════

async function sendNotification(userId, eventType, eventData, options = {}) {
  // Get user preferences and device tokens
  const { rows: userRows } = await db.query(`
    SELECT u.phone, up.fcm_token, np.*
    FROM users u
    JOIN user_profiles up ON up.user_id = u.id
    JOIN notification_preferences np ON np.user_id = u.id
    WHERE u.id = $1 AND u.status = 'active'
  `, [userId]);

  if (!userRows.length) return;
  const user = userRows[0];

  // Check preferences
  const prefMap = {
    [EVENTS.BALANCE_LOW]: 'low_balance',
    [EVENTS.BUDGET_THRESHOLD]: 'budget_alerts',
    [EVENTS.DATA_EXPIRY_WARNING]: 'expiry_warnings',
    [EVENTS.AI_INSIGHT_GENERATED]: 'ai_insights',
    [EVENTS.SCORE_RECALCULATED]: 'score_updates',
    weekly_summary: 'weekly_summary',
  };

  const prefKey = prefMap[eventType];
  if (prefKey && user[prefKey] === false) {
    log.debug('Notification suppressed by user preference', { userId, eventType });
    return;
  }

  // Check quiet hours
  const nowHour = new Date().getHours();
  const isQuietHour = user.quiet_hours_start && user.quiet_hours_end &&
    (nowHour >= user.quiet_hours_start || nowHour < user.quiet_hours_end);

  const isCritical = eventType === 'emergency' || eventType === EVENTS.BALANCE_LOW;
  if (isQuietHour && !isCritical) {
    log.debug('Notification suppressed by quiet hours', { userId, eventType });
    return;
  }

  // Check daily rate limit
  const dailyKey = `notif:daily:${userId}:${new Date().toDateString()}`;
  const dailyCount = await redis.incr(dailyKey);
  await redis.expire(dailyKey, 86400);

  if (dailyCount > (user.max_per_day || 5) && !isCritical) {
    log.debug('Daily notification limit reached', { userId, dailyCount });
    return;
  }

  // Build notification content
  const templateFn = templates[eventType];
  if (!templateFn) {
    log.warn('No template for event type', { eventType });
    return;
  }

  const notification = templateFn(eventData);

  // Store in-app notification
  await db.query(`
    INSERT INTO notifications (user_id, type, title, body, data, deep_link, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')
  `, [userId, notification.type, notification.title, notification.body,
      JSON.stringify(eventData), notification.deepLink]);

  // Send push
  if (user.fcm_token) {
    const result = await sendPush(user.fcm_token, notification, eventData);
    await db.query(`
      UPDATE notifications SET is_sent = TRUE, sent_at = NOW()
      WHERE user_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1
    `, [userId, notification.type]);
    log.info('Push sent', { userId, type: notification.type, success: result.success });
  }

  // Send SMS for critical notifications (no push token, or critical override)
  if (!user.fcm_token && isCritical && user.phone) {
    await sms.send(user.phone, `DataOS: ${notification.title}\n${notification.body}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// KAFKA CONSUMER (simplified in-process scheduler)
// ═══════════════════════════════════════════════════════════════

// In production this uses Kafka. For standalone service, we poll for triggers.
async function processNotificationTriggers() {
  try {
    // Check for low balances
    const { rows: lowBalances } = await db.query(`
      SELECT DISTINCT ON (sc.user_id) sc.user_id, sb.balance_mb, sc.network, sc.id as sim_id,
             sc.monthly_budget
      FROM sim_balances sb
      JOIN sim_cards sc ON sc.id = sb.sim_id
      WHERE sb.balance_mb < 500
        AND sb.fetched_at > NOW() - INTERVAL '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = sc.user_id AND n.type = 'balance_low'
            AND n.created_at > NOW() - INTERVAL '3 hours'
        )
      ORDER BY sc.user_id, sb.balance_mb ASC
    `);

    for (const row of lowBalances) {
      await sendNotification(row.user_id, EVENTS.BALANCE_LOW, {
        balanceMb: parseFloat(row.balance_mb),
        network: row.network,
        simId: row.sim_id,
      });
    }

    // Check for expiry warnings
    const { rows: expiryWarnings } = await db.query(`
      SELECT DISTINCT ON (sc.user_id, sc.network) sc.user_id, sc.network, sc.id as sim_id,
             sb.balance_mb, sb.expiry_date,
             EXTRACT(DAY FROM sb.expiry_date - NOW())::int as days_to_expiry
      FROM sim_balances sb
      JOIN sim_cards sc ON sc.id = sb.sim_id
      WHERE sb.expiry_date IS NOT NULL
        AND sb.expiry_date > NOW()
        AND sb.expiry_date < NOW() + INTERVAL '3 days'
        AND sb.balance_mb > 100
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = sc.user_id AND n.type = 'expiry_warning'
            AND n.created_at > NOW() - INTERVAL '24 hours'
        )
      ORDER BY sc.user_id, sc.network, sb.expiry_date ASC
    `);

    for (const row of expiryWarnings) {
      await sendNotification(row.user_id, EVENTS.DATA_EXPIRY_WARNING, {
        balanceMb: parseFloat(row.balance_mb),
        network: row.network,
        simId: row.sim_id,
        daysToExpiry: row.days_to_expiry,
        expiryDate: row.expiry_date,
      });
    }

    // Weekly summary (every Sunday 8 PM WAT)
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 5) {
      await sendWeeklySummaries();
    }

  } catch (err) {
    log.error('Notification trigger processing failed', { err: err.message });
  }
}

async function sendWeeklySummaries() {
  const { rows: activeUsers } = await db.query(`
    SELECT u.id, SUM(r.amount_ngn) as weekly_spend, SUM(r.data_mb) as weekly_mb,
           cs.overall_score, cs.tier
    FROM users u
    LEFT JOIN recharges r ON r.user_id = u.id AND r.status = 'completed'
      AND r.initiated_at > NOW() - INTERVAL '7 days'
    LEFT JOIN LATERAL (
      SELECT overall_score, tier FROM connectivity_scores
      WHERE user_id = u.id ORDER BY calculated_at DESC LIMIT 1
    ) cs ON TRUE
    JOIN notification_preferences np ON np.user_id = u.id AND np.weekly_summary = TRUE
    WHERE u.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n WHERE n.user_id = u.id
        AND n.type = 'weekly_summary' AND n.created_at > NOW() - INTERVAL '6 days'
      )
    GROUP BY u.id, cs.overall_score, cs.tier
    LIMIT 1000
  `);

  for (const user of activeUsers) {
    await sendNotification(user.id, 'weekly_summary', {
      weeklySpend: parseFloat(user.weekly_spend || 0),
      weeklyMb: parseInt(user.weekly_mb || 0),
      score: user.overall_score,
      tier: user.tier,
    });
  }
  log.info('Weekly summaries sent', { count: activeUsers.length });
}

// Run trigger check every 5 minutes
setInterval(processNotificationTriggers, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// FASTIFY APP
// ═══════════════════════════════════════════════════════════════
const app = Fastify({ logger: true, trustProxy: true });
app.register(require('@fastify/helmet'), { contentSecurityPolicy: false });
app.register(require('@fastify/cors'), { origin: true });
app.register(require('@fastify/jwt'), {
  secret: { public: process.env.JWT_PUBLIC_KEY },
  verify: { algorithms: ['RS256'], issuer: 'dataos-auth' },
});
app.decorate('authenticate', async (req) => {
  try { await req.jwtVerify(); } catch { throw new AuthenticationError(); }
});

// Get notifications
app.get('/api/v1/notifications', { preHandler: [app.authenticate] }, async (req) => {
  const { page = 1, limit = 20, unreadOnly } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM notifications WHERE user_id = $1';
  const params = [req.user.sub];
  let idx = 2;
  if (unreadOnly === 'true') { query += ` AND is_read = FALSE`; }
  query += ` AND (expires_at IS NULL OR expires_at > NOW())`;
  query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(query, params);
  const { rows: unread } = await db.query(
    'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.sub]
  );

  return success(rows, { unreadCount: parseInt(unread[0].count) });
});

// Mark as read
app.patch('/api/v1/notifications/:id/read', { preHandler: [app.authenticate] }, async (req) => {
  await db.query(
    'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  return success({ message: 'Marked as read' });
});

// Mark all as read
app.patch('/api/v1/notifications/read-all', { preHandler: [app.authenticate] }, async (req) => {
  const { rowCount } = await db.query(
    'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND is_read = FALSE',
    [req.user.sub]
  );
  return success({ marked: rowCount });
});

// Update preferences
app.patch('/api/v1/notifications/preferences', { preHandler: [app.authenticate] }, async (req) => {
  const allowed = ['low_balance', 'budget_alerts', 'expiry_warnings', 'ai_insights', 'weekly_summary', 'score_updates', 'promotions', 'quiet_hours_start', 'quiet_hours_end', 'max_per_day'];
  const updates = [];
  const values = [req.user.sub];
  let idx = 2;

  for (const [key, val] of Object.entries(req.body || {})) {
    if (allowed.includes(key)) {
      updates.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (updates.length) {
    await db.query(`UPDATE notification_preferences SET ${updates.join(', ')}, updated_at = NOW() WHERE user_id = $1`, values);
  }
  return success({ message: 'Preferences updated' });
});

// Internal: send a notification (called by other services)
app.post('/internal/notify', async (req) => {
  const { userId, eventType, eventData } = req.body;
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return reply.status(403).send({ error: 'Forbidden' });
  }
  await sendNotification(userId, eventType, eventData);
  return success({ sent: true });
});

app.get('/health', async () => ({ status: 'ok', service: 'notification' }));
app.setErrorHandler(globalErrorHandler);

app.listen({ port: process.env.PORT || 3009, host: '0.0.0.0' })
  .then(() => {
    log.info('Notification service started', { port: process.env.PORT || 3009 });
    // Run initial check on startup
    setTimeout(processNotificationTriggers, 10000);
  })
  .catch(err => { log.error('Failed to start', { err: err.message }); process.exit(1); });

module.exports = { app, sendNotification };
