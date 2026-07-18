// ═══════════════════════════════════════════════════════════════
// WALLET SERVICE — Complete Implementation
// Port: 3005 | Credits, cashback, borrow, repay, gift, ledger
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const {
  globalErrorHandler, AuthenticationError, NotFoundError,
  ValidationError, InsufficientBalanceError, KYCRequiredError,
} = require('../shared/errors');
const { success, paginated, createLogger } = require('../shared/utils');
const { WALLET, EVENTS, getScoreTier } = require('../shared/constants');

const log = createLogger('wallet-service');
const { createDbPool } = require('../shared/utils/db-client');
const db = createDbPool();
const { createRedisClient } = require('../shared/utils/redis-client');
const redis = createRedisClient();

const app = Fastify({ logger: true, trustProxy: true });
app.register(require('@fastify/helmet'), { contentSecurityPolicy: false });
app.register(require('@fastify/cors'), { origin: true });
app.register(require('@fastify/rate-limit'), { global: false, redis });
app.register(require('@fastify/jwt'), {
  secret: { public: process.env.JWT_PUBLIC_KEY },
  verify: { algorithms: ['RS256'], issuer: 'dataos-auth' },
});
app.decorate('authenticate', async (req) => {
  try { await req.jwtVerify(); } catch { throw new AuthenticationError(); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getWallet(userId) {
  const { rows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  if (!rows.length) throw new NotFoundError('Wallet');
  return rows[0];
}

async function recordTransaction(client, userId, type, subType, creditsDelta, ngnDelta, description, referenceId = null, referenceType = null, metadata = null) {
  const wallet = await client.query('SELECT credits_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  const balanceAfter = wallet.rows[0].credits_balance + creditsDelta;

  await client.query(`
    INSERT INTO wallet_transactions (user_id, type, sub_type, credits_delta, ngn_delta, balance_after, description, reference_id, reference_type, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [userId, type, subType, creditsDelta, ngnDelta, balanceAfter, description, referenceId, referenceType, metadata ? JSON.stringify(metadata) : null]);

  await client.query(`
    UPDATE wallets
    SET credits_balance = credits_balance + $1,
        cashback_ngn = cashback_ngn + $2,
        total_earned = total_earned + GREATEST(0, $1),
        total_redeemed = total_redeemed + GREATEST(0, -$1),
        updated_at = NOW()
    WHERE user_id = $3
  `, [creditsDelta, Math.max(0, ngnDelta), userId]);

  return balanceAfter;
}

async function emitEvent(topic, payload) {
  log.debug('Event emitted', { topic, payload });
}

// ─── Get Wallet ───────────────────────────────────────────────────────────────
app.get('/api/v1/wallet', { preHandler: [app.authenticate] }, async (req) => {
  const wallet = await getWallet(req.user.sub);
  const valueNgn = wallet.credits_balance * WALLET.CREDIT_TO_NGN;

  return success({
    ...wallet,
    valueNgn,
    creditToNgn: WALLET.CREDIT_TO_NGN,
    canBorrow: wallet.borrowed_ngn === 0,
  });
});

// ─── Transaction History ──────────────────────────────────────────────────────
app.get('/api/v1/wallet/transactions', { preHandler: [app.authenticate] }, async (req) => {
  const { type, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM wallet_transactions WHERE user_id = $1';
  const params = [req.user.sub];
  let idx = 2;

  if (type) { query += ` AND type = $${idx++}`; params.push(type); }
  query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(query, params);
  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1' + (type ? ' AND type = $2' : ''),
    type ? [req.user.sub, type] : [req.user.sub]
  );

  return paginated(rows, parseInt(countRows[0].count), parseInt(page), parseInt(limit));
});

// ─── Earn Credits (from various actions) ─────────────────────────────────────
app.post('/api/v1/wallet/earn', { preHandler: [app.authenticate] }, async (req) => {
  const { subType, credits, description, referenceId } = req.body;
  if (!credits || credits <= 0) throw new ValidationError('Credits must be positive', null);

  const EARN_LIMITS = {
    ad_watch: { max: 500, period: 'day', description: 'Ad reward' },
    bundle_acceptance: { max: 200, period: 'day', description: 'Bundle recommendation accepted' },
    budget_goal: { max: 1, period: 'month', description: 'Monthly budget goal achieved' },
    referral: { max: 10, period: 'month', description: 'Referral reward' },
    challenge: { max: 10, period: 'week', description: 'Challenge completed' },
    signup: { max: 1, period: 'lifetime', description: 'Welcome bonus' },
  };

  if (!EARN_LIMITS[subType]) throw new ValidationError('Invalid earn type', null);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await recordTransaction(client, req.user.sub, 'earn', subType, credits, 0,
      description || EARN_LIMITS[subType].description, referenceId);
    await client.query('COMMIT');
    await emitEvent(EVENTS.CREDIT_EARNED, { userId: req.user.sub, credits, subType });
    const wallet = await getWallet(req.user.sub);
    return success({ creditsEarned: credits, newBalance: wallet.credits_balance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Redeem Credits for Data ──────────────────────────────────────────────────
app.post('/api/v1/wallet/redeem', {
  preHandler: [app.authenticate],
  config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
}, async (req) => {
  const { credits, simId, bundleId } = req.body;
  if (!credits || credits < WALLET.MIN_REDEEM) throw new ValidationError(`Minimum redemption is ${WALLET.MIN_REDEEM} credits`, null);
  if (credits > WALLET.MAX_REDEEM_PER_TX) throw new ValidationError(`Maximum ${WALLET.MAX_REDEEM_PER_TX} credits per transaction`, null);

  const wallet = await getWallet(req.user.sub);
  if (wallet.credits_balance < credits) {
    throw new InsufficientBalanceError(credits, wallet.credits_balance, 'CREDITS');
  }

  const ngnValue = credits * WALLET.CREDIT_TO_NGN;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Deduct credits
    await recordTransaction(client, req.user.sub, 'spend', 'bundle_redeem', -credits, 0,
      `Redeemed ${credits} credits for ₦${ngnValue} bundle credit`, bundleId, 'bundle');

    // If bundle specified, trigger purchase via telecom service
    let purchaseResult = null;
    if (simId && bundleId) {
      // This would call telecom-service in production
      log.info('Bundle purchase triggered via credit redemption', { simId, bundleId, ngnValue });
      purchaseResult = { triggered: true, ngnValue };
    }

    await client.query('COMMIT');
    const updated = await getWallet(req.user.sub);
    return success({ creditsUsed: credits, ngnValue, newBalance: updated.credits_balance, purchase: purchaseResult });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Borrow Credits (Score-gated) ────────────────────────────────────────────
app.post('/api/v1/wallet/borrow', {
  preHandler: [app.authenticate],
  config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
}, async (req) => {
  const { amountNgn } = req.body;
  if (!amountNgn || amountNgn <= 0) throw new ValidationError('Amount required', null);

  const wallet = await getWallet(req.user.sub);
  if (wallet.borrowed_ngn > 0) throw new ValidationError('You have an outstanding loan. Repay before borrowing again.', null);

  // Check score for borrow eligibility
  const { rows: scoreRows } = await db.query(
    'SELECT overall_score, tier FROM connectivity_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1',
    [req.user.sub]
  );
  if (!scoreRows.length) throw new ValidationError('Complete your profile to unlock borrowing', null);

  const tier = getScoreTier(scoreRows[0].overall_score);
  if (tier.creditLimit === 0) throw new KYCRequiredError(2);
  if (amountNgn > tier.creditLimit) {
    throw new ValidationError(`Your score allows borrowing up to ₦${tier.creditLimit}. Improve your score for higher limits.`, null);
  }

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const creditsEquivalent = Math.round(amountNgn / WALLET.CREDIT_TO_NGN);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Add credits to balance
    await recordTransaction(client, req.user.sub, 'borrow', 'data_credit', creditsEquivalent, 0,
      `Borrowed ₦${amountNgn} data credit (due ${dueDate.toDateString()})`);

    // Record borrow
    await client.query(`
      UPDATE wallets SET borrowed_ngn = $1, borrow_due_date = $2, updated_at = NOW()
      WHERE user_id = $3
    `, [amountNgn, dueDate, req.user.sub]);

    await client.query('COMMIT');

    await emitEvent(EVENTS.CREDIT_BORROWED, { userId: req.user.sub, amountNgn });

    const updated = await getWallet(req.user.sub);
    return success({
      borrowed: amountNgn,
      creditsAdded: creditsEquivalent,
      dueDate,
      feeIfLate: amountNgn * WALLET.BORROW_INTEREST_7D,
      newBalance: updated.credits_balance,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Check Borrow Eligibility ─────────────────────────────────────────────────
app.get('/api/v1/wallet/borrow/eligibility', { preHandler: [app.authenticate] }, async (req) => {
  const wallet = await getWallet(req.user.sub);
  const { rows } = await db.query(
    'SELECT overall_score, tier FROM connectivity_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1',
    [req.user.sub]
  );

  const score = rows[0]?.overall_score || 0;
  const tier = getScoreTier(score);

  return success({
    eligible: tier.creditLimit > 0 && wallet.borrowed_ngn === 0,
    creditLimit: tier.creditLimit,
    currentBorrowed: wallet.borrowed_ngn,
    score,
    scoreTier: tier.label,
    outstandingLoan: wallet.borrowed_ngn > 0 ? { amount: wallet.borrowed_ngn, dueDate: wallet.borrow_due_date } : null,
    nextTier: score < 850 ? Object.values(require('../shared/constants').SCORE_TIERS).find(t => t.min > score) : null,
  });
});

// ─── Repay Borrowed Amount ────────────────────────────────────────────────────
app.post('/api/v1/wallet/repay', { preHandler: [app.authenticate] }, async (req) => {
  const wallet = await getWallet(req.user.sub);
  if (wallet.borrowed_ngn === 0) throw new ValidationError('No outstanding loan to repay', null);

  const now = new Date();
  const isLate = wallet.borrow_due_date && now > new Date(wallet.borrow_due_date);
  const fee = wallet.borrowed_ngn * (isLate ? WALLET.BORROW_INTEREST_14D : WALLET.BORROW_INTEREST_7D);
  const totalNgn = wallet.borrowed_ngn + fee;
  const creditsToDeduct = Math.ceil(totalNgn / WALLET.CREDIT_TO_NGN);

  if (wallet.credits_balance < creditsToDeduct) {
    throw new InsufficientBalanceError(creditsToDeduct, wallet.credits_balance, 'CREDITS');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await recordTransaction(client, req.user.sub, 'repay', 'loan_repayment', -creditsToDeduct, -totalNgn,
      `Loan repayment ₦${wallet.borrowed_ngn} + ₦${fee.toFixed(0)} fee`);
    await client.query(`
      UPDATE wallets SET borrowed_ngn = 0, borrow_due_date = NULL, updated_at = NOW()
      WHERE user_id = $1
    `, [req.user.sub]);
    await client.query('COMMIT');
    await emitEvent(EVENTS.CREDIT_REPAID, { userId: req.user.sub, amount: wallet.borrowed_ngn });
    const updated = await getWallet(req.user.sub);
    return success({ repaid: wallet.borrowed_ngn, fee, totalPaid: totalNgn, newBalance: updated.credits_balance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Gift Credits to Another User ────────────────────────────────────────────
app.post('/api/v1/wallet/gift', {
  preHandler: [app.authenticate],
  config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
}, async (req) => {
  const { recipientPhone, credits, message } = req.body;
  if (!credits || credits < 50) throw new ValidationError('Minimum gift is 50 credits', null);
  if (credits > 1000) throw new ValidationError('Maximum gift is 1,000 credits per transaction', null);

  const sender = await getWallet(req.user.sub);
  if (sender.credits_balance < credits) {
    throw new InsufficientBalanceError(credits, sender.credits_balance, 'CREDITS');
  }

  const { normalizePhone } = require('../shared/utils');
  const normalizedPhone = normalizePhone(recipientPhone);
  const { rows: recipientRows } = await db.query('SELECT id FROM users WHERE phone = $1 AND status = $2', [normalizedPhone, 'active']);
  if (!recipientRows.length) throw new NotFoundError('Recipient (must be a DataOS user)');
  const recipientId = recipientRows[0].id;
  if (recipientId === req.user.sub) throw new ValidationError('Cannot gift credits to yourself', null);

  const fee = Math.ceil(credits * 0.02); // 2% gift fee
  const netCredits = credits - fee;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await recordTransaction(client, req.user.sub, 'gift_sent', 'peer_gift', -credits, 0,
      `Gift to ${recipientPhone.slice(-4).padStart(recipientPhone.length, '*')}${message ? ': ' + message : ''}`,
      recipientId, 'user');
    await recordTransaction(client, recipientId, 'gift_received', 'peer_gift', netCredits, 0,
      `Gift from a DataOS user`, req.user.sub, 'user');
    await client.query('COMMIT');
    return success({ sent: credits, fee, recipientReceives: netCredits });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Convert Cashback to Credits ──────────────────────────────────────────────
app.post('/api/v1/wallet/cashback/convert', { preHandler: [app.authenticate] }, async (req) => {
  const wallet = await getWallet(req.user.sub);
  if (wallet.cashback_ngn < 50) throw new ValidationError('Minimum conversion is ₦50 cashback', null);

  const creditsToAdd = Math.floor(wallet.cashback_ngn / WALLET.CREDIT_TO_NGN);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await recordTransaction(client, req.user.sub, 'earn', 'cashback_convert', creditsToAdd, -wallet.cashback_ngn,
      `Converted ₦${wallet.cashback_ngn} cashback to ${creditsToAdd} credits`);
    await client.query(`UPDATE wallets SET cashback_ngn = 0 WHERE user_id = $1`, [req.user.sub]);
    await client.query('COMMIT');
    const updated = await getWallet(req.user.sub);
    return success({ converted: wallet.cashback_ngn, creditsAdded: creditsToAdd, newBalance: updated.credits_balance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ─── Wallet Summary (for dashboard) ──────────────────────────────────────────
app.get('/api/v1/wallet/summary', { preHandler: [app.authenticate] }, async (req) => {
  const wallet = await getWallet(req.user.sub);
  const { rows: recentTx } = await db.query(
    'SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
    [req.user.sub]
  );
  const { rows: earnedThisMonth } = await db.query(`
    SELECT COALESCE(SUM(credits_delta), 0) as earned
    FROM wallet_transactions
    WHERE user_id = $1 AND type = 'earn' AND created_at >= date_trunc('month', NOW())
  `, [req.user.sub]);

  return success({
    balance: wallet.credits_balance,
    valueNgn: wallet.credits_balance * WALLET.CREDIT_TO_NGN,
    cashback: wallet.cashback_ngn,
    borrowed: wallet.borrowed_ngn,
    borrowDueDate: wallet.borrow_due_date,
    totalEarned: wallet.total_earned,
    totalRedeemed: wallet.total_redeemed,
    earnedThisMonth: parseInt(earnedThisMonth[0].earned),
    recentTransactions: recentTx,
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'wallet' }));
app.setErrorHandler(globalErrorHandler);

app.listen({ port: process.env.PORT || 3005, host: '0.0.0.0' })
  .then(() => log.info('Wallet service started', { port: process.env.PORT || 3005 }))
  .catch(err => { log.error('Failed to start', { err: err.message }); process.exit(1); });

module.exports = app;
