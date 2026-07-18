// ═══════════════════════════════════════════════════════════════
// AI SERVICE — Complete Implementation
// Port: 3004 | Claude-powered assistant + all AI engines
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const axios = require('axios');
const {
  globalErrorHandler, AuthenticationError, NotFoundError, ValidationError,
} = require('../shared/errors');
const {
  success, createLogger, formatDataSize, formatNaira, daysUntil, startOfMonth, endOfMonth,
} = require('../shared/utils');
const { EVENTS, getScoreTier } = require('../shared/constants');

const log = createLogger('ai-service');
const { createDbPool } = require('../shared/utils/db-client');
const db = createDbPool();
const { createRedisClient } = require('../shared/utils/redis-client');
const redis = createRedisClient();

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

// ═══════════════════════════════════════════════════════════════
// CONTEXT BUILDER — Assembles full user context for AI
// ═══════════════════════════════════════════════════════════════
async function buildUserContext(userId) {
  const [profileRes, simsRes, balancesRes, spendRes, scoreRes, twinRes, budgetRes, bundleRes] = await Promise.all([
    db.query('SELECT u.*, up.display_name, up.language FROM users u JOIN user_profiles up ON up.user_id = u.id WHERE u.id = $1', [userId]),
    db.query('SELECT sc.id, sc.network, sc.nickname, sc.monthly_budget FROM sim_cards sc WHERE sc.user_id = $1 AND sc.is_active = TRUE ORDER BY sc.is_primary DESC', [userId]),
    db.query(`SELECT DISTINCT ON (sb.sim_id) sb.*, sc.network, sc.nickname FROM sim_balances sb JOIN sim_cards sc ON sc.id = sb.sim_id WHERE sc.user_id = $1 ORDER BY sb.sim_id, sb.fetched_at DESC`, [userId]),
    db.query(`SELECT SUM(amount_ngn) as total_spent, COUNT(*) as purchase_count FROM recharges WHERE user_id = $1 AND status = 'completed' AND initiated_at >= $2`, [userId, startOfMonth()]),
    db.query('SELECT * FROM connectivity_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1', [userId]),
    db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]),
    db.query('SELECT * FROM user_budgets WHERE user_id = $1 AND is_active = TRUE AND period = $2', [userId, 'monthly']),
    db.query('SELECT * FROM bundle_catalog WHERE is_active = TRUE ORDER BY cost_per_gb ASC LIMIT 10'),
  ]);

  const profile = profileRes.rows[0];
  const sims = simsRes.rows;
  const balances = balancesRes.rows;
  const spend = spendRes.rows[0];
  const score = scoreRes.rows[0];
  const twin = twinRes.rows[0];
  const budget = budgetRes.rows[0];
  const topBundles = bundleRes.rows;

  const totalMb = balances.reduce((s, b) => s + parseFloat(b.balance_mb || 0), 0);
  const totalBudget = sims.reduce((s, sim) => s + parseFloat(sim.monthly_budget || 0), 0) || (budget?.amount_ngn);
  const totalSpent = parseFloat(spend?.total_spent || 0);
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date().getDate();
  const projectedMonthCost = totalSpent * (daysInMonth / dayOfMonth);
  const burnRateMbPerHour = twin?.daily_avg_mb ? twin.daily_avg_mb / 24 : 50;
  const daysOfDataLeft = burnRateMbPerHour > 0 ? Math.floor(totalMb / burnRateMbPerHour / 24) : 99;

  const simSummary = balances.map(b => {
    const sim = sims.find(s => s.id === b.sim_id);
    return `${sim?.network || b.network}: ${formatDataSize(b.balance_mb)} (${b.expiry_date ? daysUntil(b.expiry_date) + 'd until expiry' : 'no expiry'}, confidence: ${Math.round(b.confidence_score * 100)}%)`;
  }).join(' | ');

  const urgentAlerts = [];
  for (const b of balances) {
    if (b.expiry_date && daysUntil(b.expiry_date) <= 3 && parseFloat(b.balance_mb) > 200) {
      urgentAlerts.push(`${b.network} has ${formatDataSize(b.balance_mb)} expiring in ${daysUntil(b.expiry_date)} days!`);
    }
    if (parseFloat(b.balance_mb) < 200) {
      urgentAlerts.push(`${b.network} balance critically low: ${formatDataSize(b.balance_mb)}`);
    }
  }

  const bestBundle = topBundles.find(b => sims.some(s => s.network === b.network));

  return {
    userId,
    name: profile?.display_name || 'there',
    totalMb,
    totalBudget,
    totalSpent,
    projectedMonthCost,
    budgetRemaining: totalBudget - totalSpent,
    budgetPct: totalBudget ? Math.round((totalSpent / totalBudget) * 100) : 0,
    daysOfDataLeft,
    burnRateMbPerHour,
    score: score?.overall_score || 0,
    scoreTier: score?.tier || 'FAIR',
    twin,
    simSummary,
    urgentAlerts,
    bestBundle,
    sims,
    balances,
    topBundles,
    language: profile?.language || 'en',
    country: profile?.country_code || 'NG',
  };
}

// ═══════════════════════════════════════════════════════════════
// AI ASSISTANT — Claude-powered conversational advisor
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = (ctx) => `You are DataOS AI — a warm, direct, expert connectivity financial advisor for Nigerian mobile internet users.

USER CONTEXT (use ONLY these numbers, never invent):
Name: ${ctx.name}
Connectivity Score: ${ctx.score}/850 (${ctx.scoreTier})
Active SIMs: ${ctx.simSummary}
Total data remaining: ${formatDataSize(ctx.totalMb)}
Estimated days of data left: ${ctx.daysOfDataLeft} days (burn rate: ${Math.round(ctx.burnRateMbPerHour)}MB/hr)
Monthly spend so far: ₦${ctx.totalSpent.toLocaleString()} of ₦${ctx.totalBudget?.toLocaleString() || 'no budget set'} budget (${ctx.budgetPct}%)
Projected month-end spend: ₦${ctx.projectedMonthCost.toLocaleString()}
Budget remaining: ₦${ctx.budgetRemaining?.toLocaleString() || 'N/A'}
Best available bundle: ${ctx.bestBundle ? `${ctx.bestBundle.network} ${ctx.bestBundle.name} (${formatDataSize(ctx.bestBundle.data_mb)}, ₦${ctx.bestBundle.price_ngn}, ₦${ctx.bestBundle.cost_per_gb}/GB)` : 'none found'}
${ctx.urgentAlerts.length ? 'URGENT ALERTS: ' + ctx.urgentAlerts.join(' | ') : ''}
${ctx.twin?.churn_risk_score > 0.7 ? 'Note: User shows signs of low engagement this month.' : ''}

PERSONALITY & RULES:
- Be direct and warm — like a smart friend, not a corporate bot
- ALWAYS use specific numbers from the context above
- Bold key numbers using **₦X,XXX** format
- Keep responses under 120 words for mobile readability
- ALWAYS end with ONE clear, specific action the user can take right now
- If data is critical (<200MB total): lead with emergency options immediately
- If budget is >90% used: focus on cost reduction
- If recommending a bundle: always say network + name + price + why
- Never apologize excessively. Be helpful and move forward.
- Language: ${ctx.language === 'yo' ? 'Mix in some Yoruba words warmly' : ctx.language === 'ha' ? 'Mix in some Hausa words warmly' : 'English'}`;

async function callClaude(systemPrompt, messages, maxTokens = 600) {
  const cacheKey = `ai:cache:${require('crypto').createHash('md5').update(systemPrompt + JSON.stringify(messages.slice(-1))).digest('hex')}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  const result = {
    content: response.data.content[0].text,
    tokensUsed: response.data.usage?.input_tokens + response.data.usage?.output_tokens,
    model: response.data.model,
  };

  await redis.setex(cacheKey, 600, JSON.stringify(result));
  return result;
}

// ─── Chat Route ───────────────────────────────────────────────────────────────
app.post('/api/v1/ai/chat', { preHandler: [app.authenticate] }, async (req) => {
  const { message, sessionId, history = [] } = req.body;
  if (!message || message.length > 500) throw new ValidationError('Message required (max 500 chars)', null);

  const ctx = await buildUserContext(req.user.sub);
  const systemPrompt = SYSTEM_PROMPT(ctx);

  // Build message history (last 10 turns max)
  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  let aiResult;
  try {
    aiResult = await callClaude(systemPrompt, messages);
  } catch (err) {
    log.error('Claude API error', { err: err.message });
    // Fallback: rule-based response
    aiResult = {
      content: generateFallbackResponse(message, ctx),
      tokensUsed: 0,
      model: 'fallback',
    };
  }

  // Persist conversation
  const sid = sessionId || require('uuid').v4();
  await db.query(`
    INSERT INTO ai_conversations (user_id, session_id, role, content, tokens_used, model)
    VALUES ($1, $2, 'user', $3, 0, $4),
           ($1, $2, 'assistant', $5, $6, $7)
  `, [req.user.sub, sid, message, aiResult.model, aiResult.content, aiResult.tokensUsed, aiResult.model]);

  return success({
    message: aiResult.content,
    sessionId: sid,
    tokensUsed: aiResult.tokensUsed,
    context: {
      urgentAlerts: ctx.urgentAlerts,
      totalMb: ctx.totalMb,
      score: ctx.score,
    },
  });
});

// Rule-based fallback when Claude API is unavailable
function generateFallbackResponse(message, ctx) {
  const lower = message.toLowerCase();
  if (lower.includes('balance') || lower.includes('data')) {
    return `You have **${formatDataSize(ctx.totalMb)}** total across ${ctx.sims.length} SIMs. ${ctx.urgentAlerts[0] || 'Burn rate is ' + Math.round(ctx.burnRateMbPerHour) + 'MB/hr.'} Check the Terminal for a full breakdown.`;
  }
  if (lower.includes('spend') || lower.includes('cost') || lower.includes('money')) {
    return `You've spent **₦${ctx.totalSpent.toLocaleString()}** of your **₦${ctx.totalBudget?.toLocaleString() || '0'}** budget this month (${ctx.budgetPct}%). ${ctx.projectedMonthCost > ctx.totalBudget ? 'You\'re on track to overspend — open Analytics to see where to cut.' : 'You\'re within budget so far. Keep it up!'}`;
  }
  if (lower.includes('bundle') || lower.includes('buy') || lower.includes('recharge')) {
    return ctx.bestBundle
      ? `Best bundle for you right now: **${ctx.bestBundle.network} ${ctx.bestBundle.name}** — ${formatDataSize(ctx.bestBundle.data_mb)} for **₦${ctx.bestBundle.price_ngn}** (₦${ctx.bestBundle.cost_per_gb}/GB). Open the Bundle Market to buy it.`
      : 'Open the Bundle Market tab to see all available bundles ranked for your usage pattern.';
  }
  return `Hi ${ctx.name}! You have **${formatDataSize(ctx.totalMb)}** remaining. ${ctx.urgentAlerts[0] || 'Everything looks stable right now.'} What would you like to know?`;
}

// ─── AI Insights Route ────────────────────────────────────────────────────────
app.get('/api/v1/ai/insights', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;

  // Get or generate insights
  const existing = await db.query(`
    SELECT * FROM ai_insights
    WHERE user_id = $1 AND is_read = FALSE AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY priority DESC, created_at DESC
    LIMIT 5
  `, [userId]);

  if (existing.rows.length >= 2) return success(existing.rows);

  // Generate fresh insights
  const ctx = await buildUserContext(userId);
  const insights = await generateInsights(userId, ctx);

  return success(insights);
});

async function generateInsights(userId, ctx) {
  const insights = [];

  // Expiry warnings
  for (const b of ctx.balances) {
    if (b.expiry_date && daysUntil(b.expiry_date) <= 3 && parseFloat(b.balance_mb) > 100) {
      insights.push({
        type: 'warning',
        title: `${b.network} data expires in ${daysUntil(b.expiry_date)} days`,
        body: `You have ${formatDataSize(b.balance_mb)} on ${b.network} expiring soon. Use it or buy a rollover bundle to avoid losing it.`,
        actionLabel: 'See Options',
        savingsNgn: parseFloat(b.balance_mb) * 0.7,
        priority: 9,
      });
    }
  }

  // Budget warning
  if (ctx.budgetPct > 75 && ctx.totalBudget) {
    insights.push({
      type: 'info',
      title: `${ctx.budgetPct}% of monthly budget used`,
      body: `You've spent ₦${ctx.totalSpent.toLocaleString()} of ₦${ctx.totalBudget.toLocaleString()}. Projected month-end: ₦${ctx.projectedMonthCost.toLocaleString()}.`,
      actionLabel: 'Optimize Spending',
      priority: 7,
    });
  }

  // Bundle savings
  if (ctx.bestBundle) {
    insights.push({
      type: 'save',
      title: `Save on your next bundle`,
      body: `${ctx.bestBundle.network} ${ctx.bestBundle.name}: ${formatDataSize(ctx.bestBundle.data_mb)} for ₦${ctx.bestBundle.price_ngn} — best value at ₦${ctx.bestBundle.cost_per_gb}/GB right now.`,
      actionLabel: 'Buy Now',
      savingsNgn: 400,
      priority: 6,
    });
  }

  // Score improvement
  if (ctx.score < 700) {
    insights.push({
      type: 'score',
      title: `Boost your Connectivity Score`,
      body: `Your score is ${ctx.score}/850. Staying within budget for 7 more days could add +12 points and unlock higher credit limits.`,
      actionLabel: 'View Score',
      priority: 4,
    });
  }

  // Persist insights
  for (const ins of insights) {
    await db.query(`
      INSERT INTO ai_insights (user_id, type, title, body, action_label, savings_ngn, priority, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '24 hours')
      ON CONFLICT DO NOTHING
    `, [userId, ins.type, ins.title, ins.body, ins.actionLabel, ins.savingsNgn || 0, ins.priority]);
  }

  return insights;
}

// ─── Bundle Recommendations ───────────────────────────────────────────────────
app.get('/api/v1/ai/recommendations', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const ctx = await buildUserContext(userId);
  const { network, maxPrice } = req.query;

  let query = 'SELECT * FROM bundle_catalog WHERE is_active = TRUE';
  const params = [];
  let idx = 1;

  if (network) { query += ` AND network = $${idx++}`; params.push(network.toUpperCase()); }
  if (maxPrice) { query += ` AND price_ngn <= $${idx++}`; params.push(parseFloat(maxPrice)); }

  // Filter to user's connected networks
  const userNetworks = ctx.sims.map(s => s.network);
  if (!network && userNetworks.length) {
    query += ` AND network = ANY($${idx++})`;
    params.push(userNetworks);
  }

  query += ' ORDER BY cost_per_gb ASC LIMIT 20';
  const { rows: bundles } = await db.query(query, params);

  // Score each bundle for this user
  const scored = bundles.map(b => {
    let score = 0;

    // Cost efficiency (40%)
    const avgCostPerGb = bundles.reduce((s, x) => s + parseFloat(x.cost_per_gb), 0) / bundles.length;
    score += (1 - parseFloat(b.cost_per_gb) / avgCostPerGb) * 40;

    // Network preference (20%)
    if (ctx.twin?.preferred_network === b.network) score += 20;
    else if (userNetworks.includes(b.network)) score += 10;

    // Validity match to twin recharge interval (20%)
    if (ctx.twin?.avg_recharge_interval_days) {
      const intervalDiff = Math.abs(b.validity_days - ctx.twin.avg_recharge_interval_days);
      score += Math.max(0, 20 - intervalDiff * 2);
    }

    // Budget compliance (20%)
    if (ctx.budgetRemaining && parseFloat(b.price_ngn) <= ctx.budgetRemaining) score += 20;
    else if (parseFloat(b.price_ngn) <= 3500) score += 10;

    // Bonus for promo
    if (b.is_promotional) score += 5;

    return { ...b, relevanceScore: Math.round(score), recommended: false };
  });

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  if (scored.length) scored[0].recommended = true;

  // Generate AI explanation for top 3
  const top3 = scored.slice(0, 3);
  for (const b of top3) {
    b.explanation = `Best value at ₦${b.cost_per_gb}/GB. ${b.validity_days}-day plan matches your typical usage cycle.`;
  }

  return success(scored.slice(0, 8), { userId, generatedAt: new Date().toISOString() });
});

// ─── Feedback Route ───────────────────────────────────────────────────────────
app.post('/api/v1/ai/feedback', { preHandler: [app.authenticate] }, async (req) => {
  const { recommendationId, accepted, reason } = req.body;

  // Update twin acceptance rate (exponential moving average)
  const alpha = 0.1;
  await db.query(`
    UPDATE user_data_twins
    SET bundle_acceptance_rate = bundle_acceptance_rate * $1 + $2 * (1 - $1),
        last_updated = NOW()
    WHERE user_id = $3
  `, [1 - alpha, accepted ? 1 : 0, req.user.sub]);

  log.info('AI feedback recorded', { userId: req.user.sub, accepted, reason });
  return success({ message: 'Feedback recorded. Your AI gets better with every response.' });
});

// ─── Mark Insight Read ────────────────────────────────────────────────────────
app.patch('/api/v1/ai/insights/:id/read', { preHandler: [app.authenticate] }, async (req) => {
  await db.query(
    'UPDATE ai_insights SET is_read = TRUE, is_acted = $1 WHERE id = $2 AND user_id = $3',
    [req.body?.acted === true, req.params.id, req.user.sub]
  );
  return success({ message: 'Insight marked as read' });
});

// ═══════════════════════════════════════════════════════════════
// CONNECTIVITY SCORE ENGINE
// ═══════════════════════════════════════════════════════════════
app.post('/api/v1/ai/score/calculate', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const score = await calculateConnectivityScore(userId);
  return success(score);
});

async function calculateConnectivityScore(userId) {
  const now = new Date();
  const monthStart = startOfMonth();

  const [spendRes, budgetRes, purchaseRes, balanceRes, emergencyRes] = await Promise.all([
    db.query('SELECT SUM(amount_ngn) as total FROM recharges WHERE user_id = $1 AND status = $2 AND initiated_at >= $3', [userId, 'completed', monthStart]),
    db.query('SELECT amount_ngn FROM user_budgets WHERE user_id = $1 AND period = $2 AND is_active = TRUE LIMIT 1', [userId, 'monthly']),
    db.query('SELECT COUNT(*) as count, AVG(amount_ngn) as avg_amount FROM recharges WHERE user_id = $1 AND status = $2 AND initiated_at >= $3', [userId, 'completed', monthStart]),
    db.query('SELECT AVG(confidence_score) as avg_conf, COUNT(*) as fetches FROM sim_balances sb JOIN sim_cards sc ON sc.id = sb.sim_id WHERE sc.user_id = $1 AND sb.fetched_at >= $2', [userId, monthStart]),
    // Emergency events = purchases of very small bundles (< ₦200) = run-out indicator
    db.query('SELECT COUNT(*) as count FROM recharges WHERE user_id = $1 AND amount_ngn < 200 AND status = $2 AND initiated_at >= $3', [userId, 'completed', monthStart]),
  ]);

  const totalSpent = parseFloat(spendRes.rows[0]?.total || 0);
  const budget = parseFloat(budgetRes.rows[0]?.amount_ngn || 0);
  const purchaseCount = parseInt(purchaseRes.rows[0]?.count || 0);
  const avgPurchaseAmount = parseFloat(purchaseRes.rows[0]?.avg_amount || 0);
  const avgConfidence = parseFloat(balanceRes.rows[0]?.avg_conf || 0.8);
  const emergencyCount = parseInt(emergencyRes.rows[0]?.count || 0);

  // Sub-score 1: Budget Score (30%)
  let budgetScore = 70; // Default if no budget set
  if (budget > 0) {
    const adherence = 1 - Math.max(0, (totalSpent - budget) / budget);
    budgetScore = Math.round(Math.min(100, adherence * 100));
  }

  // Sub-score 2: Efficiency Score (25%)
  const marketAvgCostPerGb = 700; // ₦700/GB market average
  const { rows: gbRes } = await db.query(`
    SELECT SUM(data_mb) as total_mb FROM recharges r
    JOIN bundle_catalog bc ON bc.id = r.bundle_id
    WHERE r.user_id = $1 AND r.status = 'completed' AND r.initiated_at >= $2
  `, [userId, monthStart]);
  const totalGb = (parseInt(gbRes.rows[0]?.total_mb || 0)) / 1024;
  const userCostPerGb = totalGb > 0 ? totalSpent / totalGb : marketAvgCostPerGb;
  const efficiencyScore = Math.round(Math.min(100, (marketAvgCostPerGb / Math.max(userCostPerGb, 100)) * 80));

  // Sub-score 3: Reliability Score (20%)
  const connectivityHoursProxy = Math.min(100, avgConfidence * 100);
  const reliabilityScore = Math.round(connectivityHoursProxy);

  // Sub-score 4: Access Score (25%) — planning quality
  const emergencyPenalty = Math.min(50, emergencyCount * 15);
  const planningBonus = purchaseCount > 0 && avgPurchaseAmount > 1000 ? 20 : 0;
  const accessScore = Math.max(0, Math.min(100, 70 - emergencyPenalty + planningBonus));

  // Composite (0–850)
  const raw = budgetScore * 0.30 + efficiencyScore * 0.25 + reliabilityScore * 0.20 + accessScore * 0.25;
  const overall = Math.round(raw * 8.5);
  const tier = getScoreTier(overall);

  // Persist score
  const { rows } = await db.query(`
    INSERT INTO connectivity_scores (user_id, overall_score, budget_score, efficiency_score, reliability_score, access_score, tier, calculation_inputs)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [userId, overall, budgetScore, efficiencyScore, reliabilityScore, accessScore, tier.label, JSON.stringify({ totalSpent, budget, userCostPerGb, emergencyCount })]);

  const prevScore = await db.query('SELECT overall_score FROM connectivity_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1 OFFSET 1', [userId]);
  const delta = prevScore.rows.length ? overall - prevScore.rows[0].overall_score : 0;

  log.info('Score calculated', { userId, overall, tier: tier.label });
  return { ...rows[0], delta, creditLimit: tier.creditLimit };
}

// ═══════════════════════════════════════════════════════════════
// DATA TWIN ENGINE
// ═══════════════════════════════════════════════════════════════
app.get('/api/v1/ai/twin/:userId', { preHandler: [app.authenticate] }, async (req) => {
  if (req.params.userId !== req.user.sub) throw new AuthenticationError('Unauthorized');
  const { rows } = await db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [req.params.userId]);
  if (!rows.length) throw new NotFoundError('Data twin not yet generated');
  return success(rows[0]);
});

app.post('/api/v1/ai/twin/update', { preHandler: [app.authenticate] }, async (req) => {
  const updated = await updateDataTwin(req.user.sub);
  return success(updated);
});

async function updateDataTwin(userId) {
  const monthStart = startOfMonth(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

  const [rechargesRes, balanceHistoryRes] = await Promise.all([
    db.query(`
      SELECT r.amount_ngn, r.initiated_at, r.data_mb, r.network, sc.id as sim_id
      FROM recharges r
      JOIN sim_cards sc ON sc.id = r.sim_id
      WHERE r.user_id = $1 AND r.status = 'completed' AND r.initiated_at >= $2
      ORDER BY r.initiated_at ASC
    `, [userId, monthStart]),
    db.query(`
      SELECT balance_mb, fetched_at FROM sim_balances sb
      JOIN sim_cards sc ON sc.id = sb.sim_id
      WHERE sc.user_id = $1 AND sb.fetched_at >= $2
      ORDER BY sb.fetched_at ASC
    `, [userId, monthStart]),
  ]);

  const recharges = rechargesRes.rows;
  const balances = balanceHistoryRes.rows;

  if (recharges.length < 2) return { message: 'Insufficient data for twin update. Keep using DataOS!' };

  // Calculate avg recharge interval
  const intervals = [];
  for (let i = 1; i < recharges.length; i++) {
    const diff = (new Date(recharges[i].initiated_at) - new Date(recharges[i-1].initiated_at)) / (1000 * 60 * 60 * 24);
    intervals.push(diff);
  }
  const avgInterval = intervals.reduce((s, x) => s + x, 0) / intervals.length;

  // Avg recharge amount
  const avgAmount = recharges.reduce((s, r) => s + parseFloat(r.amount_ngn), 0) / recharges.length;

  // Preferred network
  const networkCounts = {};
  recharges.forEach(r => { networkCounts[r.network] = (networkCounts[r.network] || 0) + 1; });
  const preferredNetwork = Object.entries(networkCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

  // Estimate daily avg MB from balance drops
  let dailyAvgMb = 1000; // default
  if (balances.length > 1) {
    const drops = [];
    for (let i = 1; i < balances.length; i++) {
      const drop = parseFloat(balances[i-1].balance_mb) - parseFloat(balances[i].balance_mb);
      const hours = (new Date(balances[i].fetched_at) - new Date(balances[i-1].fetched_at)) / (1000 * 60 * 60);
      if (drop > 0 && hours > 0) drops.push((drop / hours) * 24);
    }
    if (drops.length) dailyAvgMb = drops.reduce((s, x) => s + x, 0) / drops.length;
  }

  // Preferred recharge hour (time of day most recharges happen)
  const hourCounts = new Array(24).fill(0);
  recharges.forEach(r => { hourCounts[new Date(r.initiated_at).getHours()]++; });
  const preferredHour = hourCounts.indexOf(Math.max(...hourCounts));

  // Recharge trigger (balance level at time of recharge = low balance before recharge)
  const rechargeTriggMb = 200; // Simplified — in production computed from balance history

  // Churn risk (days since last app open proxy: days since last recharge)
  const daysSinceLastRecharge = (Date.now() - new Date(recharges[recharges.length - 1]?.initiated_at || Date.now())) / (1000 * 60 * 60 * 24);
  const churnRisk = Math.min(0.95, daysSinceLastRecharge / 30);

  const twin = {
    dailyAvgMb: Math.round(dailyAvgMb),
    weeklyAvgMb: Math.round(dailyAvgMb * 7),
    monthlyAvgMb: Math.round(dailyAvgMb * 30),
    avgRechargeIntervalDays: Math.round(avgInterval * 10) / 10,
    rechargeTriggMb,
    preferredRechargeHour: preferredHour,
    avgRechargeAmountNgn: Math.round(avgAmount),
    preferredNetwork,
    churnRiskScore: Math.round(churnRisk * 100) / 100,
    budgetAdherenceRate: 0.75,
    savingsSensitivity: avgAmount < 1500 ? 'high' : avgAmount < 3000 ? 'medium' : 'low',
    modelVersion: '1.1',
    dataPoints: recharges.length,
  };

  await db.query(`
    INSERT INTO user_data_twins (
      user_id, daily_avg_mb, weekly_avg_mb, monthly_avg_mb,
      avg_recharge_interval_days, recharge_trigger_mb, preferred_recharge_hour,
      avg_recharge_amount_ngn, preferred_network, churn_risk_score,
      budget_adherence_rate, savings_sensitivity, model_version, data_points, last_updated
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      daily_avg_mb=$2, weekly_avg_mb=$3, monthly_avg_mb=$4,
      avg_recharge_interval_days=$5, recharge_trigger_mb=$6, preferred_recharge_hour=$7,
      avg_recharge_amount_ngn=$8, preferred_network=$9, churn_risk_score=$10,
      budget_adherence_rate=$11, savings_sensitivity=$12, model_version=$13, data_points=$14,
      last_updated=NOW()
  `, [userId, twin.dailyAvgMb, twin.weeklyAvgMb, twin.monthlyAvgMb,
      twin.avgRechargeIntervalDays, twin.rechargeTriggMb, twin.preferredRechargeHour,
      twin.avgRechargeAmountNgn, twin.preferredNetwork, twin.churnRiskScore,
      twin.budgetAdherenceRate, twin.savingsSensitivity, twin.modelVersion, twin.dataPoints]);

  log.info('Data twin updated', { userId, dailyAvgMb: twin.dailyAvgMb, preferredNetwork });
  return twin;
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'ai', ts: new Date().toISOString() }));
app.setErrorHandler(globalErrorHandler);

app.listen({ port: process.env.PORT || 3004, host: '0.0.0.0' })
  .then(() => log.info('AI service started', { port: process.env.PORT || 3004 }))
  .catch(err => { log.error('Failed to start', { err: err.message }); process.exit(1); });

module.exports = { app, calculateConnectivityScore, updateDataTwin, generateInsights };
