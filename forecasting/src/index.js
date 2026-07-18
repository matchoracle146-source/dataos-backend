// ═══════════════════════════════════════════════════════════════
// FORECASTING SERVICE — Port 3008
// Data exhaustion, monthly cost, recharge calendar, savings
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const { globalErrorHandler, AuthenticationError, NotFoundError } = require('../shared/errors');
const { success, createLogger, startOfMonth, addDays, isNigerianHoliday } = require('../shared/utils');

const log = createLogger('forecasting-service');
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

// ─── Core Forecasting Engine ──────────────────────────────────────────────────

class ForecastingEngine {
  // Predict data exhaustion for a SIM
  async predictExhaustion(simId, currentBalanceMb, twin, balanceHistory) {
    // Estimate hourly burn rate from recent history
    let burnRateMbPerHour = twin?.daily_avg_mb ? twin.daily_avg_mb / 24 : 41.7; // default ~1GB/day

    // Refine using recent balance drops
    if (balanceHistory.length >= 2) {
      const recentDrops = [];
      for (let i = 1; i < Math.min(balanceHistory.length, 10); i++) {
        const drop = parseFloat(balanceHistory[i-1].balance_mb) - parseFloat(balanceHistory[i].balance_mb);
        const hours = (new Date(balanceHistory[i].fetched_at) - new Date(balanceHistory[i-1].fetched_at)) / (1000 * 60 * 60);
        if (drop > 0 && hours > 0 && hours < 24) recentDrops.push(drop / hours);
      }
      if (recentDrops.length) burnRateMbPerHour = recentDrops.reduce((s, x) => s + x, 0) / recentDrops.length;
    }

    // Apply Nigerian context adjustments
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    // Time-of-day multiplier (peak hours = higher usage)
    const hourlyMultiplier = (hour >= 20 && hour <= 23) ? 1.4 :
                             (hour >= 7 && hour <= 9) ? 1.2 :
                             (hour >= 0 && hour <= 5) ? 0.5 : 1.0;
    // Weekend multiplier
    const weekendMultiplier = (dayOfWeek === 0 || dayOfWeek === 6) ? 1.3 : 1.0;

    const adjustedBurnRate = burnRateMbPerHour * hourlyMultiplier * weekendMultiplier;
    const hoursUntilExhaustion = currentBalanceMb / Math.max(adjustedBurnRate, 0.1);
    const exhaustionDate = new Date(Date.now() + hoursUntilExhaustion * 60 * 60 * 1000);

    // Confidence intervals (±20%)
    const lowerHours = hoursUntilExhaustion * 0.8;
    const upperHours = hoursUntilExhaustion * 1.2;

    return {
      simId,
      predictedExhaustionDate: exhaustionDate,
      hoursRemaining: Math.round(hoursUntilExhaustion),
      daysRemaining: Math.round(hoursUntilExhaustion / 24 * 10) / 10,
      burnRateMbPerHour: Math.round(adjustedBurnRate * 10) / 10,
      confidenceLower: new Date(Date.now() + lowerHours * 60 * 60 * 1000),
      confidenceUpper: new Date(Date.now() + upperHours * 60 * 60 * 1000),
      confidencePct: 0.82,
      currentBalanceMb,
      modelVersion: '2.1',
    };
  }

  // Project monthly cost
  async projectMonthlyCost(userId, currentSpend, twin) {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;

    // Get last 3 months avg for better projection
    const { rows: historicalRes } = await db.query(`
      SELECT DATE_TRUNC('month', initiated_at) as month,
             SUM(amount_ngn) as total
      FROM recharges
      WHERE user_id = $1 AND status = 'completed'
        AND initiated_at >= NOW() - INTERVAL '3 months'
        AND DATE_TRUNC('month', initiated_at) < DATE_TRUNC('month', NOW())
      GROUP BY month ORDER BY month DESC
    `, [userId]);

    let projectedTotal;
    if (historicalRes.length >= 2) {
      // Weighted: 50% current pace + 50% historical avg
      const historicalAvg = historicalRes.reduce((s, r) => s + parseFloat(r.total), 0) / historicalRes.length;
      const currentPace = currentSpend * (daysInMonth / dayOfMonth);
      projectedTotal = (currentPace * 0.5) + (historicalAvg * 0.5);
    } else {
      projectedTotal = currentSpend * (daysInMonth / dayOfMonth);
    }

    // Month-end factors (Nigerian salary days: 25th-31st cause spending spikes)
    const isMonthEndPeriod = dayOfMonth >= 25;
    if (isMonthEndPeriod) projectedTotal *= 1.1;

    const budget = await db.query('SELECT amount_ngn FROM user_budgets WHERE user_id = $1 AND period = $2 AND is_active = TRUE LIMIT 1', [userId, 'monthly']);
    const budgetAmount = parseFloat(budget.rows[0]?.amount_ngn || 0);

    return {
      currentSpend,
      projectedTotal: Math.round(projectedTotal),
      daysElapsed: dayOfMonth,
      daysRemaining,
      daysInMonth,
      budget: budgetAmount,
      projectedOverBudget: budgetAmount > 0 ? Math.max(0, projectedTotal - budgetAmount) : null,
      isOnTrack: budgetAmount > 0 ? projectedTotal <= budgetAmount * 1.05 : true,
      historicalMonths: historicalRes.length,
    };
  }

  // Predict next recharge dates
  async predictRecharges(userId, sims, balances, twin) {
    const predictions = [];

    for (const sim of sims) {
      const balance = balances.find(b => b.sim_id === sim.id);
      if (!balance) continue;

      const burnRatePerDay = twin?.daily_avg_mb || 1000;
      const daysOfData = parseFloat(balance.balance_mb) / burnRatePerDay;
      const predictedRechargeDate = addDays(new Date(), daysOfData);

      // Predict amount based on twin
      const predictedAmount = twin?.avg_recharge_amount_ngn || 2000;

      // Check expiry — recharge might be forced by expiry before data runs out
      const expiryDate = balance.expiry_date ? new Date(balance.expiry_date) : null;
      const rechargeDate = expiryDate && expiryDate < predictedRechargeDate ? expiryDate : predictedRechargeDate;

      const reason = expiryDate && expiryDate < predictedRechargeDate ? 'Expiry-forced' : 'Data depleted';

      predictions.push({
        simId: sim.id,
        network: sim.network,
        nickname: sim.nickname,
        predictedDate: rechargeDate,
        predictedAmountNgn: Math.round(predictedAmount),
        reason,
        urgency: daysOfData < 3 ? 'HIGH' : daysOfData < 7 ? 'MEDIUM' : 'LOW',
        balanceRemainingMb: parseFloat(balance.balance_mb),
      });
    }

    return predictions.sort((a, b) => new Date(a.predictedDate) - new Date(b.predictedDate));
  }

  // Savings opportunities
  async findSavingsOpportunities(userId, sims, balances, twin) {
    const opportunities = [];

    // Check each SIM's cost efficiency vs best available
    for (const sim of sims) {
      const { rows: bestBundle } = await db.query(`
        SELECT * FROM bundle_catalog
        WHERE network = $1 AND is_active = TRUE
        ORDER BY cost_per_gb ASC LIMIT 1
      `, [sim.network]);

      if (!bestBundle.length) continue;

      // Get user's last purchase for this network
      const { rows: lastPurchase } = await db.query(`
        SELECT amount_ngn, data_mb FROM recharges
        WHERE sim_id = $1 AND status = 'completed'
        ORDER BY initiated_at DESC LIMIT 1
      `, [sim.id]);

      if (lastPurchase.length) {
        const lastCostPerGb = lastPurchase[0].data_mb > 0
          ? parseFloat(lastPurchase[0].amount_ngn) / (parseInt(lastPurchase[0].data_mb) / 1024)
          : 0;
        const bestCostPerGb = parseFloat(bestBundle[0].cost_per_gb);
        const savingsPerGb = lastCostPerGb - bestCostPerGb;

        if (savingsPerGb > 50) {
          const monthlyGb = (twin?.monthly_avg_mb || 30000) / 1024;
          opportunities.push({
            type: 'BUNDLE_SWITCH',
            network: sim.network,
            simId: sim.id,
            title: `Switch to ${sim.network} ${bestBundle[0].name}`,
            description: `Save ₦${Math.round(savingsPerGb)}/GB — that's ₦${Math.round(savingsPerGb * monthlyGb)}/month`,
            savingsNgn: Math.round(savingsPerGb * monthlyGb),
            savingsPerGb: Math.round(savingsPerGb),
            recommendedBundle: bestBundle[0],
            priority: savingsPerGb > 200 ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    // Check expiry waste
    for (const balance of balances) {
      if (balance.expiry_date) {
        const daysToExpiry = Math.ceil((new Date(balance.expiry_date) - Date.now()) / (1000 * 60 * 60 * 24));
        const burnRatePerDay = (twin?.daily_avg_mb || 1000);
        const projectedUseBeforeExpiry = burnRatePerDay * daysToExpiry;
        const unusedMb = Math.max(0, parseFloat(balance.balance_mb) - projectedUseBeforeExpiry);

        if (unusedMb > 500) {
          const wasteValue = unusedMb * 0.7; // ₦0.70/MB approximate value
          opportunities.push({
            type: 'EXPIRY_WASTE',
            simId: balance.sim_id,
            network: balance.network,
            title: `${Math.round(unusedMb / 1024 * 10) / 10}GB will expire unused`,
            description: `Use it before ${new Date(balance.expiry_date).toDateString()} to avoid losing ₦${Math.round(wasteValue)}`,
            savingsNgn: Math.round(wasteValue),
            unusedMb: Math.round(unusedMb),
            expiryDate: balance.expiry_date,
            priority: daysToExpiry <= 2 ? 'CRITICAL' : daysToExpiry <= 5 ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    return opportunities.sort((a, b) => b.savingsNgn - a.savingsNgn);
  }
}

const engine = new ForecastingEngine();

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/v1/forecast/exhaustion/:simId', { preHandler: [app.authenticate] }, async (req) => {
  const { simId } = req.params;
  const userId = req.user.sub;

  const cacheKey = `forecast:exhaustion:${simId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return success({ ...JSON.parse(cached), fromCache: true });

  const [simRes, balanceRes, twinRes, historyRes] = await Promise.all([
    db.query('SELECT * FROM sim_cards WHERE id = $1 AND user_id = $2', [simId, userId]),
    db.query('SELECT * FROM sim_balances WHERE sim_id = $1 ORDER BY fetched_at DESC LIMIT 1', [simId]),
    db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]),
    db.query('SELECT balance_mb, fetched_at FROM sim_balances WHERE sim_id = $1 ORDER BY fetched_at DESC LIMIT 20', [simId]),
  ]);

  if (!simRes.rows.length) throw new NotFoundError('SIM card');
  if (!balanceRes.rows.length) throw new NotFoundError('Balance data. Fetch balance first.');

  const forecast = await engine.predictExhaustion(
    simId,
    parseFloat(balanceRes.rows[0].balance_mb),
    twinRes.rows[0],
    historyRes.rows
  );

  // Persist forecast
  await db.query(`
    INSERT INTO forecasts (user_id, sim_id, forecast_type, predicted_date, confidence_pct, model_version)
    VALUES ($1, $2, 'exhaustion', $3, $4, $5)
  `, [userId, simId, forecast.predictedExhaustionDate, forecast.confidencePct, forecast.modelVersion]);

  await redis.setex(cacheKey, 3600, JSON.stringify(forecast));
  return success(forecast);
});

app.get('/api/v1/forecast/monthly-cost', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const { rows: spendRes } = await db.query(`
    SELECT COALESCE(SUM(amount_ngn), 0) as total FROM recharges
    WHERE user_id = $1 AND status = 'completed' AND initiated_at >= date_trunc('month', NOW())
  `, [userId]);
  const { rows: twinRes } = await db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]);

  const projection = await engine.projectMonthlyCost(userId, parseFloat(spendRes[0].total), twinRes[0]);
  return success(projection);
});

app.get('/api/v1/forecast/recharge-calendar', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const [simsRes, balancesRes, twinRes] = await Promise.all([
    db.query('SELECT * FROM sim_cards WHERE user_id = $1 AND is_active = TRUE', [userId]),
    db.query(`
      SELECT DISTINCT ON (sb.sim_id) sb.*, sc.network, sc.nickname
      FROM sim_balances sb JOIN sim_cards sc ON sc.id = sb.sim_id
      WHERE sc.user_id = $1 ORDER BY sb.sim_id, sb.fetched_at DESC
    `, [userId]),
    db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]),
  ]);

  const predictions = await engine.predictRecharges(userId, simsRes.rows, balancesRes.rows, twinRes.rows[0]);
  return success({ predictions, generatedAt: new Date().toISOString() });
});

app.get('/api/v1/forecast/savings', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const [simsRes, balancesRes, twinRes] = await Promise.all([
    db.query('SELECT * FROM sim_cards WHERE user_id = $1 AND is_active = TRUE', [userId]),
    db.query(`
      SELECT DISTINCT ON (sb.sim_id) sb.*, sc.network, sc.nickname
      FROM sim_balances sb JOIN sim_cards sc ON sc.id = sb.sim_id
      WHERE sc.user_id = $1 ORDER BY sb.sim_id, sb.fetched_at DESC
    `, [userId]),
    db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]),
  ]);

  const opportunities = await engine.findSavingsOpportunities(userId, simsRes.rows, balancesRes.rows, twinRes.rows[0]);
  const totalPotentialSavings = opportunities.reduce((s, o) => s + o.savingsNgn, 0);

  return success({ opportunities, totalPotentialSavings, generatedAt: new Date().toISOString() });
});

// Scenario: "what if I reduce usage by X%?"
app.post('/api/v1/forecast/scenario', { preHandler: [app.authenticate] }, async (req) => {
  const { reductionPct = 20 } = req.body;
  const userId = req.user.sub;

  const { rows: twinRes } = await db.query('SELECT * FROM user_data_twins WHERE user_id = $1', [userId]);
  const twin = twinRes[0];
  if (!twin) throw new NotFoundError('Data twin. Use DataOS for a few days first.');

  const currentMonthlyMb = twin.monthly_avg_mb || 30000;
  const reducedMb = currentMonthlyMb * (1 - reductionPct / 100);

  const { rows: cheapestBundle } = await db.query(`
    SELECT * FROM bundle_catalog WHERE is_active = TRUE ORDER BY cost_per_gb ASC LIMIT 1
  `);
  const costPerMb = cheapestBundle.length ? parseFloat(cheapestBundle[0].price_ngn) / parseInt(cheapestBundle[0].data_mb) : 0.7;

  const currentCost = currentMonthlyMb * costPerMb;
  const reducedCost = reducedMb * costPerMb;

  return success({
    scenario: `Reduce usage by ${reductionPct}%`,
    current: { monthlyMb: Math.round(currentMonthlyMb), estimatedCost: Math.round(currentCost) },
    projected: { monthlyMb: Math.round(reducedMb), estimatedCost: Math.round(reducedCost) },
    savings: { monthly: Math.round(currentCost - reducedCost), annual: Math.round((currentCost - reducedCost) * 12) },
  });
});

app.get('/health', async () => ({ status: 'ok', service: 'forecasting' }));
app.setErrorHandler(globalErrorHandler);
app.listen({ port: process.env.PORT || 3008, host: '0.0.0.0' })
  .then(() => log.info('Forecasting service started', { port: process.env.PORT || 3008 }))
  .catch(err => { log.error('Failed', { err: err.message }); process.exit(1); });

module.exports = app;
