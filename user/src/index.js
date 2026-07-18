// ═══════════════════════════════════════════════════════════════
// USER SERVICE — Complete Implementation
// Port: 3002 | Handles: profiles, SIM cards, budgets, KYC
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const { z } = require('zod');
const axios = require('axios');
const { globalErrorHandler, ValidationError, AuthenticationError, NotFoundError, ConflictError, KYCRequiredError } = require('../shared/errors');
const { normalizePhone, detectNetwork, maskPhone, hashValue, success, paginated, createLogger, isValidNigerianPhone } = require('../shared/utils');
const { NETWORKS, KYC_LEVELS, EVENTS } = require('../shared/constants');

const log = createLogger('user-service');

// ─── DB & Redis ───────────────────────────────────────────────────────────────
const { createDbPool } = require('../shared/utils/db-client');
const db = createDbPool();
const { createRedisClient } = require('../shared/utils/redis-client');
const redis = createRedisClient();

// ─── App ──────────────────────────────────────────────────────────────────────
const app = Fastify({ logger: true, trustProxy: true });

app.register(require('@fastify/helmet'), { contentSecurityPolicy: false });
app.register(require('@fastify/cors'), { origin: process.env.ALLOWED_ORIGINS?.split(',') || true });
app.register(require('@fastify/jwt'), {
  secret: { public: process.env.JWT_PUBLIC_KEY },
  verify: { algorithms: ['RS256'], issuer: 'dataos-auth' },
});

app.decorate('authenticate', async (req) => {
  try { await req.jwtVerify(); }
  catch { throw new AuthenticationError(); }
});

// ─── Kafka Producer (simplified for standalone use) ───────────────────────────
const emitEvent = async (topic, payload) => {
  try {
    if (process.env.KAFKA_BROKER) {
      // Production: use kafka client
    } else {
      log.debug('Event emitted (no kafka in dev)', { topic, payload });
    }
  } catch (err) {
    log.error('Event emit failed', { topic, err: err.message });
  }
};

// ─── Validators ──────────────────────────────────────────────────────────────
const simSchema = z.object({
  msisdn: z.string().min(10).max(15),
  nickname: z.string().max(50).optional(),
  monthlyBudget: z.number().positive().optional(),
  weeklyBudget: z.number().positive().optional(),
});

const updateProfileSchema = z.object({
  displayName: z.string().max(100).optional(),
  language: z.enum(['en', 'yo', 'ha', 'ig']).optional(),
  fcmToken: z.string().max(200).optional(),
});

const budgetSchema = z.object({
  simId: z.string().uuid().optional(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  amountNgn: z.number().positive(),
  alertPcts: z.array(z.number().min(1).max(100)).optional(),
});

const validate = (schema) => (data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Validation failed', r.error.flatten());
  return r.data;
};

// ─── User Profile Routes ──────────────────────────────────────────────────────
app.get('/api/v1/users/me', { preHandler: [app.authenticate] }, async (req) => {
  const { rows } = await db.query(`
    SELECT u.id, u.phone, u.email, u.country_code, u.kyc_level, u.status, u.referral_code,
           u.created_at, up.display_name, up.avatar_url, up.language, up.currency, up.timezone,
           up.onboarding_done,
           w.credits_balance, w.cashback_ngn, w.borrowed_ngn,
           cs.overall_score, cs.tier
    FROM users u
    LEFT JOIN user_profiles up ON up.user_id = u.id
    LEFT JOIN wallets w ON w.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT overall_score, tier FROM connectivity_scores
      WHERE user_id = u.id ORDER BY calculated_at DESC LIMIT 1
    ) cs ON TRUE
    WHERE u.id = $1 AND u.status != 'deleted'
  `, [req.user.sub]);

  if (!rows.length) throw new NotFoundError('User');
  return success(rows[0]);
});

app.patch('/api/v1/users/me', { preHandler: [app.authenticate] }, async (req) => {
  const body = validate(updateProfileSchema)(req.body);
  const fields = [];
  const values = [req.user.sub];
  let idx = 2;

  if (body.displayName !== undefined) { fields.push(`display_name = $${idx++}`); values.push(body.displayName); }
  if (body.language) { fields.push(`language = $${idx++}`); values.push(body.language); }
  if (body.fcmToken) { fields.push(`fcm_token = $${idx++}`); values.push(body.fcmToken); }

  if (fields.length) {
    await db.query(`UPDATE user_profiles SET ${fields.join(', ')}, updated_at = NOW() WHERE user_id = $1`, values);
    await redis.del(`user:profile:${req.user.sub}`);
  }

  return success({ message: 'Profile updated' });
});

// ─── SIM Card Routes ──────────────────────────────────────────────────────────
app.get('/api/v1/users/me/sims', { preHandler: [app.authenticate] }, async (req) => {
  const { rows } = await db.query(`
    SELECT sc.*,
           slb.balance_mb, slb.bonus_mb, slb.expiry_date, slb.confidence_score, slb.fetched_at,
           slb.airtime_ngn
    FROM sim_cards sc
    LEFT JOIN sim_latest_balances slb ON slb.sim_id = sc.id
    WHERE sc.user_id = $1 AND sc.is_active = TRUE
    ORDER BY sc.is_primary DESC, sc.created_at ASC
  `, [req.user.sub]);

  return success(rows.map(r => ({
    ...r,
    msisdn: maskPhone(r.msisdn),
  })));
});

app.post('/api/v1/users/me/sims', { preHandler: [app.authenticate] }, async (req) => {
  const body = validate(simSchema)(req.body);
  const msisdn = normalizePhone(body.msisdn);

  if (!isValidNigerianPhone(msisdn)) throw new ValidationError('Invalid Nigerian phone number', null);

  const network = detectNetwork(msisdn);
  if (!network) throw new ValidationError('Unrecognized network for this phone number', null);

  const { hash: msisdnHash } = hashValue(msisdn, process.env.MSISDN_HASH_SECRET);

  // Check duplicate
  const existing = await db.query('SELECT id FROM sim_cards WHERE user_id = $1 AND msisdn_hash = $2', [req.user.sub, msisdnHash]);
  if (existing.rows.length) throw new ConflictError('This SIM is already registered to your account');

  // Check limit (free: 2 SIMs, premium: unlimited)
  const simCount = await db.query('SELECT COUNT(*) FROM sim_cards WHERE user_id = $1 AND is_active = TRUE', [req.user.sub]);
  if (parseInt(simCount.rows[0].count) >= 2) {
    // TODO: Check subscription tier
    // throw new ValidationError('Free plan supports up to 2 SIM cards. Upgrade to Premium for unlimited.', null);
  }

  // Is first SIM? Make primary
  const isPrimary = parseInt(simCount.rows[0].count) === 0;

  const { rows } = await db.query(`
    INSERT INTO sim_cards (user_id, msisdn, msisdn_hash, network, nickname, is_primary, monthly_budget, weekly_budget)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, network, nickname, is_primary, monthly_budget, created_at
  `, [req.user.sub, msisdn, msisdnHash, network, body.nickname || `${network} SIM`, isPrimary, body.monthlyBudget, body.weeklyBudget]);

  await emitEvent(EVENTS.SIM_ADDED, { userId: req.user.sub, simId: rows[0].id, network });

  return success({ ...rows[0], msisdn: maskPhone(msisdn), network });
});

app.patch('/api/v1/users/me/sims/:simId', { preHandler: [app.authenticate] }, async (req) => {
  const { simId } = req.params;
  const body = req.body || {};

  const owned = await db.query('SELECT id FROM sim_cards WHERE id = $1 AND user_id = $2', [simId, req.user.sub]);
  if (!owned.rows.length) throw new NotFoundError('SIM card');

  const updates = [];
  const values = [simId];
  let idx = 2;

  if (body.nickname !== undefined) { updates.push(`nickname = $${idx++}`); values.push(body.nickname); }
  if (body.monthlyBudget !== undefined) { updates.push(`monthly_budget = $${idx++}`); values.push(body.monthlyBudget); }
  if (body.weeklyBudget !== undefined) { updates.push(`weekly_budget = $${idx++}`); values.push(body.weeklyBudget); }
  if (body.isPrimary === true) {
    await db.query('UPDATE sim_cards SET is_primary = FALSE WHERE user_id = $1', [req.user.sub]);
    updates.push('is_primary = TRUE');
  }

  if (updates.length) {
    await db.query(`UPDATE sim_cards SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`, values);
  }

  return success({ message: 'SIM updated' });
});

app.delete('/api/v1/users/me/sims/:simId', { preHandler: [app.authenticate] }, async (req) => {
  const { simId } = req.params;
  const { rowCount } = await db.query(
    'UPDATE sim_cards SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [simId, req.user.sub]
  );
  if (!rowCount) throw new NotFoundError('SIM card');
  await emitEvent(EVENTS.SIM_REMOVED, { userId: req.user.sub, simId });
  return success({ message: 'SIM removed' });
});

// ─── Budget Routes ────────────────────────────────────────────────────────────
app.get('/api/v1/users/me/budgets', { preHandler: [app.authenticate] }, async (req) => {
  const { rows } = await db.query(`
    SELECT ub.*, sc.network, sc.nickname
    FROM user_budgets ub
    LEFT JOIN sim_cards sc ON sc.id = ub.sim_id
    WHERE ub.user_id = $1 AND ub.is_active = TRUE
    ORDER BY ub.period, ub.created_at DESC
  `, [req.user.sub]);
  return success(rows);
});

app.post('/api/v1/users/me/budgets', { preHandler: [app.authenticate] }, async (req) => {
  const body = validate(budgetSchema)(req.body);
  if (body.simId) {
    const owned = await db.query('SELECT id FROM sim_cards WHERE id = $1 AND user_id = $2', [body.simId, req.user.sub]);
    if (!owned.rows.length) throw new NotFoundError('SIM card');
  }

  const { rows } = await db.query(`
    INSERT INTO user_budgets (user_id, sim_id, period, amount_ngn, alert_pcts)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, sim_id, period, effective_from)
    DO UPDATE SET amount_ngn = EXCLUDED.amount_ngn, alert_pcts = EXCLUDED.alert_pcts
    RETURNING *
  `, [req.user.sub, body.simId || null, body.period, body.amountNgn, body.alertPcts || [50, 75, 90]]);

  return success(rows[0]);
});

// ─── KYC Routes ───────────────────────────────────────────────────────────────
app.post('/api/v1/users/me/kyc/nin', { preHandler: [app.authenticate] }, async (req) => {
  const { nin } = req.body;
  if (!nin || !/^\d{11}$/.test(nin)) throw new ValidationError('NIN must be 11 digits', null);

  // Verify via Smile Identity
  const verified = await verifyNINWithSmile(nin, req.user.sub);
  if (!verified.success) throw new ValidationError('NIN verification failed. Please check and try again.', null);

  const { hash, salt } = hashValue(nin, process.env.NIN_HASH_SECRET);
  await db.query(`
    UPDATE users SET nin_hash = $1, nin_salt = $2, kyc_level = GREATEST(kyc_level, $3), updated_at = NOW()
    WHERE id = $4
  `, [hash, salt, KYC_LEVELS.NIN, req.user.sub]);

  await db.query(`
    INSERT INTO audit_log (user_id, action, resource_type) VALUES ($1, 'kyc_nin_verified', 'user')
  `, [req.user.sub]);

  return success({ message: 'NIN verified successfully', kycLevel: KYC_LEVELS.NIN });
});

app.post('/api/v1/users/me/kyc/bvn', { preHandler: [app.authenticate] }, async (req) => {
  const { bvn } = req.body;
  if (!bvn || !/^\d{11}$/.test(bvn)) throw new ValidationError('BVN must be 11 digits', null);

  const verified = await verifyBVNWithSmile(bvn, req.user.sub);
  if (!verified.success) throw new ValidationError('BVN verification failed.', null);

  const { hash, salt } = hashValue(bvn, process.env.BVN_HASH_SECRET);
  await db.query(`
    UPDATE users SET bvn_hash = $1, bvn_salt = $2, kyc_level = GREATEST(kyc_level, $3), updated_at = NOW()
    WHERE id = $4
  `, [hash, salt, KYC_LEVELS.BVN, req.user.sub]);

  return success({ message: 'BVN verified successfully', kycLevel: KYC_LEVELS.BVN });
});

// ─── Data Export (NDPR Compliance) ───────────────────────────────────────────
app.get('/api/v1/users/me/data-export', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;

  const [profile, sims, transactions, scores, insights] = await Promise.all([
    db.query('SELECT * FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1', [userId]),
    db.query('SELECT id, network, nickname, created_at FROM sim_cards WHERE user_id = $1', [userId]),
    db.query('SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000', [userId]),
    db.query('SELECT * FROM connectivity_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 12', [userId]),
    db.query('SELECT type, title, body, created_at FROM ai_insights WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [userId]),
  ]);

  return success({
    exportedAt: new Date().toISOString(),
    profile: profile.rows[0],
    sims: sims.rows,
    transactions: transactions.rows,
    scores: scores.rows,
    insights: insights.rows,
  });
});

// ─── Account Deletion (NDPR Right to Erasure) ────────────────────────────────
app.delete('/api/v1/users/me/account', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const { confirmation } = req.body;
  if (confirmation !== 'DELETE MY ACCOUNT') throw new ValidationError('Please confirm account deletion', null);

  // Anonymize rather than hard delete (retain financial records per CBN/EFCC)
  await db.query(`
    UPDATE users SET
      phone = 'deleted_' || id,
      phone_hash = 'deleted_' || id,
      email = NULL,
      nin_hash = NULL, nin_salt = NULL,
      bvn_hash = NULL, bvn_salt = NULL,
      status = 'deleted',
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
  `, [userId]);

  await db.query('DELETE FROM user_profiles WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM user_devices WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM ai_conversations WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  await db.query(`UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'account_deleted' WHERE user_id = $1`, [userId]);

  log.info('Account deleted', { userId });
  return success({ message: 'Account deleted. Financial records retained per regulatory requirements.' });
});

// ─── KYC Helpers ─────────────────────────────────────────────────────────────
async function verifyNINWithSmile(nin, userId) {
  if (process.env.NODE_ENV !== 'production') return { success: true };
  try {
    const response = await axios.post('https://api.smileidentity.com/v1/id_verification', {
      partner_id: process.env.SMILE_PARTNER_ID,
      source_sdk: 'dataos',
      timestamp: new Date().toISOString(),
      sec_key: process.env.SMILE_API_KEY,
      country: 'NG',
      id_type: 'NIN',
      id_number: nin,
      partner_params: { user_id: userId, job_id: `nin_${userId}`, job_type: 5 },
    }, { timeout: 15000 });
    return { success: response.data?.ResultCode === '1012' };
  } catch (err) {
    log.error('NIN verification failed', { err: err.message });
    return { success: false };
  }
}

async function verifyBVNWithSmile(bvn, userId) {
  if (process.env.NODE_ENV !== 'production') return { success: true };
  try {
    const response = await axios.post('https://api.smileidentity.com/v1/id_verification', {
      partner_id: process.env.SMILE_PARTNER_ID,
      source_sdk: 'dataos',
      timestamp: new Date().toISOString(),
      sec_key: process.env.SMILE_API_KEY,
      country: 'NG',
      id_type: 'BVN',
      id_number: bvn,
      partner_params: { user_id: userId, job_id: `bvn_${userId}`, job_type: 5 },
    }, { timeout: 15000 });
    return { success: response.data?.ResultCode === '1012' };
  } catch (err) {
    log.error('BVN verification failed', { err: err.message });
    return { success: false };
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'user', ts: new Date().toISOString() }));
app.setErrorHandler(globalErrorHandler);

app.listen({ port: process.env.PORT || 3002, host: '0.0.0.0' })
  .then(() => log.info('User service started', { port: process.env.PORT || 3002 }))
  .catch(err => { log.error('Failed to start', { err: err.message }); process.exit(1); });

module.exports = app;
