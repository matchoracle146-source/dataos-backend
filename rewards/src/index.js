// ═══════════════════════════════════════════════════════════════
// REWARDS SERVICE — Referrals, Achievements, Challenges
// Port: 3006
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const { globalErrorHandler, AuthenticationError, NotFoundError, ConflictError, ValidationError } = require('../shared/errors');
const { success, createLogger, generateSecureToken } = require('../shared/utils');
const { EVENTS } = require('../shared/constants');

const log = createLogger('rewards-service');
const { createDbPool } = require('../shared/utils/db-client');
const db = createDbPool();

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

// Credit wallet via internal call
async function awardCredits(userId, credits, subType, description, referenceId = null) {
  await db.query(`
    INSERT INTO wallet_transactions (user_id, type, sub_type, credits_delta, ngn_delta, description, reference_id)
    VALUES ($1, 'earn', $2, $3, 0, $4, $5)
  `, [userId, subType, credits, description, referenceId]);
  await db.query(`
    UPDATE wallets SET credits_balance = credits_balance + $1, total_earned = total_earned + $1, updated_at = NOW()
    WHERE user_id = $2
  `, [credits, userId]);
  log.info('Credits awarded', { userId, credits, subType });
}

// ─── Referrals ────────────────────────────────────────────────────────────────
app.get('/api/v1/rewards/referrals', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const [codeRes, referralsRes, pendingRes] = await Promise.all([
    db.query('SELECT referral_code FROM users WHERE id = $1', [userId]),
    db.query(`
      SELECT r.*, u.phone, up.display_name, r.created_at, r.status
      FROM referrals r
      JOIN users u ON u.id = r.referee_id
      LEFT JOIN user_profiles up ON up.user_id = r.referee_id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `, [userId]),
    db.query('SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND status = $2', [userId, 'pending']),
  ]);

  const totalEarned = referralsRes.rows.filter(r => r.status === 'rewarded').length * 500;

  return success({
    referralCode: codeRes.rows[0]?.referral_code,
    referralUrl: `https://app.dataos.ng/join/${codeRes.rows[0]?.referral_code}`,
    referrals: referralsRes.rows,
    stats: {
      total: referralsRes.rows.length,
      activated: referralsRes.rows.filter(r => r.status !== 'pending').length,
      pending: parseInt(pendingRes.rows[0]?.count || 0),
      totalCreditsEarned: totalEarned,
    },
  });
});

app.post('/api/v1/rewards/referrals/apply', async (req) => {
  const { referralCode, refereeUserId } = req.body;
  if (!referralCode || !refereeUserId) throw new ValidationError('referralCode and refereeUserId required', null);

  // Find referrer
  const { rows: referrerRows } = await db.query('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()]);
  if (!referrerRows.length) throw new NotFoundError('Referral code');
  const referrerId = referrerRows[0].id;

  if (referrerId === refereeUserId) throw new ValidationError('Cannot refer yourself', null);

  // Check not already referred
  const existing = await db.query('SELECT id FROM referrals WHERE referee_id = $1', [refereeUserId]);
  if (existing.rows.length) throw new ConflictError('This user was already referred');

  await db.query(`
    INSERT INTO referrals (referrer_id, referee_id, referral_code, status)
    VALUES ($1, $2, $3, 'pending')
  `, [referrerId, refereeUserId, referralCode]);

  // Give referee signup credits immediately
  await awardCredits(refereeUserId, 200, 'referral', 'Welcome bonus from referral!', referrerId);

  log.info('Referral applied', { referrerId, refereeUserId });
  return success({ message: 'Referral applied. Earn 200 credits once your friend activates DataOS.' });
});

// Activate referral (called when referee meets activation criteria)
app.post('/api/v1/rewards/referrals/activate', async (req) => {
  const { refereeUserId } = req.body;

  const { rows } = await db.query(
    'SELECT * FROM referrals WHERE referee_id = $1 AND status = $2',
    [refereeUserId, 'pending']
  );
  if (!rows.length) return success({ message: 'No pending referral to activate' });

  const referral = rows[0];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE referrals SET status = 'rewarded', referee_activated_at = NOW(), rewarded_at = NOW()
      WHERE id = $1
    `, [referral.id]);
    await awardCredits(referral.referrer_id, 500, 'referral', `Referral reward — friend activated DataOS!`, refereeUserId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return success({ referrerId: referral.referrer_id, creditsAwarded: 500 });
});

// ─── Achievements ─────────────────────────────────────────────────────────────
app.get('/api/v1/rewards/achievements', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const { rows: earned } = await db.query('SELECT * FROM achievements WHERE user_id = $1', [userId]);

  const allAchievements = [
    { key: 'first_bundle', label: 'First Bundle', icon: '🎯', description: 'Buy your first bundle via DataOS', credits: 50 },
    { key: 'streak_7', label: '7-Day Streak', icon: '🔥', description: 'Open DataOS 7 days in a row', credits: 150 },
    { key: 'streak_30', label: '30-Day Streak', icon: '🔥🔥', description: 'Open DataOS 30 days in a row', credits: 500 },
    { key: 'budget_hero', label: 'Budget Hero', icon: '💰', description: 'Stay within budget for a full month', credits: 300 },
    { key: 'referral_1', label: 'First Referral', icon: '👥', description: 'Refer your first friend', credits: 100 },
    { key: 'referral_5', label: 'Referral Champ', icon: '🏆', description: 'Refer 5 friends', credits: 500 },
    { key: 'score_600', label: 'Score 600+', icon: '⭐', description: 'Reach a Connectivity Score of 600', credits: 100 },
    { key: 'score_700', label: 'Score 700+', icon: '⭐⭐', description: 'Reach a Connectivity Score of 700', credits: 200 },
    { key: 'score_800', label: 'Score 800+', icon: '⭐⭐⭐', description: 'Reach a Connectivity Score of 800', credits: 500 },
    { key: 'triple_sim', label: 'Power User', icon: '📱', description: 'Connect 3 SIM cards', credits: 200 },
    { key: 'kyc_nin', label: 'Verified', icon: '✅', description: 'Complete NIN verification', credits: 150 },
    { key: 'saver_2000', label: 'Money Saver', icon: '💸', description: 'Save ₦2,000 on data in one month', credits: 400 },
    { key: 'night_owl', label: 'Night Owl', icon: '🦉', description: 'Use night bundles 5 times', credits: 100 },
    { key: 'community', label: 'Community Star', icon: '🌟', description: 'Contribute to community intelligence for 30 days', credits: 200 },
  ];

  const earnedKeys = new Set(earned.map(e => e.achievement_key));

  return success(allAchievements.map(a => ({
    ...a,
    earned: earnedKeys.has(a.key),
    earnedAt: earned.find(e => e.achievement_key === a.key)?.earned_at || null,
  })));
});

// Award an achievement
app.post('/api/v1/rewards/achievements/award', async (req) => {
  const { userId, achievementKey } = req.body;
  if (!userId || !achievementKey) throw new ValidationError('userId and achievementKey required', null);

  const achievementCredits = {
    first_bundle: 50, streak_7: 150, streak_30: 500, budget_hero: 300,
    referral_1: 100, referral_5: 500, score_600: 100, score_700: 200,
    score_800: 500, triple_sim: 200, kyc_nin: 150, saver_2000: 400,
    night_owl: 100, community: 200,
  };

  const credits = achievementCredits[achievementKey];
  if (!credits) throw new ValidationError('Unknown achievement', null);

  // Idempotent — only award once
  const { rowCount } = await db.query(`
    INSERT INTO achievements (user_id, achievement_key, credits_earned)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, achievement_key) DO NOTHING
  `, [userId, achievementKey, credits]);

  if (rowCount > 0) {
    await awardCredits(userId, credits, 'achievement', `Achievement unlocked: ${achievementKey}`);
    log.info('Achievement awarded', { userId, achievementKey, credits });
    return success({ awarded: true, credits, achievementKey });
  }

  return success({ awarded: false, message: 'Already earned' });
});

// ─── Challenges ───────────────────────────────────────────────────────────────
app.get('/api/v1/rewards/challenges', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const { rows: challenges } = await db.query(`
    SELECT c.*, ucp.progress, ucp.completed_at, ucp.expires_at
    FROM challenges c
    LEFT JOIN user_challenge_progress ucp ON ucp.challenge_id = c.id AND ucp.user_id = $1
      AND ucp.expires_at > NOW()
    WHERE c.is_active = TRUE
    ORDER BY c.credits_reward DESC
  `, [userId]);

  return success(challenges.map(c => ({
    ...c,
    progressPct: c.target_count > 0 ? Math.min(100, Math.round((c.progress || 0) / c.target_count * 100)) : 0,
    completed: !!c.completed_at,
    active: !!c.expires_at,
  })));
});

// Update challenge progress
app.post('/api/v1/rewards/challenges/progress', async (req) => {
  const { userId, challengeKey, increment = 1 } = req.body;

  const { rows: challengeRows } = await db.query('SELECT * FROM challenges WHERE key = $1', [challengeKey]);
  if (!challengeRows.length) return success({ message: 'Challenge not found' });
  const challenge = challengeRows[0];

  const expiresAt = new Date(Date.now() + challenge.duration_days * 24 * 60 * 60 * 1000);

  const { rows: progressRows } = await db.query(`
    INSERT INTO user_challenge_progress (user_id, challenge_id, progress, expires_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, challenge_id, expires_at)
    DO UPDATE SET progress = LEAST(user_challenge_progress.progress + $3, $5)
    RETURNING *
  `, [userId, challenge.id, increment, expiresAt, challenge.target_count]);

  const progress = progressRows[0];

  // Check completion
  if (progress.progress >= challenge.target_count && !progress.completed_at) {
    await db.query(`
      UPDATE user_challenge_progress SET completed_at = NOW()
      WHERE id = $1
    `, [progress.id]);
    await awardCredits(userId, challenge.credits_reward, 'challenge', `Challenge completed: ${challenge.title}`);
    log.info('Challenge completed', { userId, challengeKey, credits: challenge.credits_reward });
    return success({ completed: true, creditsAwarded: challenge.credits_reward, challenge: challenge.title });
  }

  return success({ completed: false, progress: progress.progress, target: challenge.target_count });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────
app.get('/api/v1/rewards/leaderboard', async (req) => {
  const { type = 'referrals', period = 'monthly' } = req.query;

  let query;
  if (type === 'referrals') {
    query = `
      SELECT up.display_name, u.referral_code,
             COUNT(r.id) as count,
             COUNT(r.id) * 500 as credits_earned
      FROM users u
      JOIN user_profiles up ON up.user_id = u.id
      LEFT JOIN referrals r ON r.referrer_id = u.id AND r.status = 'rewarded'
        ${period === 'monthly' ? "AND r.rewarded_at >= date_trunc('month', NOW())" : ''}
      GROUP BY u.id, up.display_name, u.referral_code
      ORDER BY count DESC
      LIMIT 10
    `;
  } else {
    query = `
      SELECT up.display_name, cs.overall_score as score, cs.tier
      FROM connectivity_scores cs
      JOIN users u ON u.id = cs.user_id
      JOIN user_profiles up ON up.user_id = cs.user_id
      WHERE cs.id IN (
        SELECT DISTINCT ON (user_id) id FROM connectivity_scores
        ORDER BY user_id, calculated_at DESC
      )
      ORDER BY cs.overall_score DESC
      LIMIT 10
    `;
  }

  const { rows } = await db.query(query);

  return success(rows.map((row, i) => ({
    rank: i + 1,
    ...row,
    displayName: row.display_name || 'DataOS User',
  })));
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'rewards' }));
app.setErrorHandler(globalErrorHandler);

app.listen({ port: process.env.PORT || 3006, host: '0.0.0.0' })
  .then(() => log.info('Rewards service started', { port: process.env.PORT || 3006 }))
  .catch(err => { log.error('Failed to start', { err: err.message }); process.exit(1); });

module.exports = app;
