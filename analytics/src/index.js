// ═══════════════════════════════════════════════════════════════
// ANALYTICS SERVICE — Port 3007
// Spending history, reports, heatmaps, cost per GB
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const Fastify = require('fastify');
const { globalErrorHandler, AuthenticationError } = require('../shared/errors');
const { success, startOfMonth, endOfMonth, createLogger, formatDataSize } = require('../shared/utils');

const log = createLogger('analytics-service');
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

// ─── Spending Summary ─────────────────────────────────────────────────────────
app.get('/api/v1/analytics/spending/summary', { preHandler: [app.authenticate] }, async (req) => {
  const { period = 'month' } = req.query;
  const userId = req.user.sub;

  const dateRanges = {
    today: { start: new Date(new Date().setHours(0, 0, 0, 0)), end: new Date() },
    week: { start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), end: new Date() },
    month: { start: startOfMonth(), end: endOfMonth() },
    year: { start: new Date(new Date().getFullYear(), 0, 1), end: new Date() },
  };

  const { start, end } = dateRanges[period] || dateRanges.month;
  const prevStart = new Date(start.getTime() - (end - start));

  const [current, previous, byNetwork, budgetRes] = await Promise.all([
    db.query(`
      SELECT COALESCE(SUM(amount_ngn), 0) as total,
             COUNT(*) as purchases,
             COALESCE(SUM(data_mb), 0) as total_mb
      FROM recharges
      WHERE user_id = $1 AND status = 'completed' AND initiated_at BETWEEN $2 AND $3
    `, [userId, start, end]),
    db.query(`
      SELECT COALESCE(SUM(amount_ngn), 0) as total
      FROM recharges
      WHERE user_id = $1 AND status = 'completed' AND initiated_at BETWEEN $2 AND $3
    `, [userId, prevStart, start]),
    db.query(`
      SELECT network, COALESCE(SUM(amount_ngn), 0) as amount,
             COALESCE(SUM(data_mb), 0) as data_mb,
             COUNT(*) as purchases
      FROM recharges
      WHERE user_id = $1 AND status = 'completed' AND initiated_at BETWEEN $2 AND $3
      GROUP BY network ORDER BY amount DESC
    `, [userId, start, end]),
    db.query('SELECT amount_ngn FROM user_budgets WHERE user_id = $1 AND period = $2 AND is_active = TRUE LIMIT 1', [userId, 'monthly']),
  ]);

  const currentTotal = parseFloat(current.rows[0].total);
  const previousTotal = parseFloat(previous.rows[0].total);
  const totalMb = parseInt(current.rows[0].total_mb);
  const budget = parseFloat(budgetRes.rows[0]?.amount_ngn || 0);
  const costPerGb = totalMb > 0 ? currentTotal / (totalMb / 1024) : 0;
  const pctChange = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal * 100).toFixed(1) : 0;
  const totalByNetwork = currentTotal;

  return success({
    period, start, end,
    total: currentTotal,
    purchases: parseInt(current.rows[0].purchases),
    totalMb,
    costPerGb: Math.round(costPerGb),
    budget,
    budgetPct: budget > 0 ? Math.round((currentTotal / budget) * 100) : null,
    pctChange: parseFloat(pctChange),
    byNetwork: byNetwork.rows.map(r => ({
      ...r,
      amount: parseFloat(r.amount),
      pct: totalByNetwork > 0 ? Math.round((parseFloat(r.amount) / totalByNetwork) * 100) : 0,
    })),
  });
});

// ─── Spend by Time (Heatmap) ──────────────────────────────────────────────────
app.get('/api/v1/analytics/spending/by-time', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const { rows } = await db.query(`
    SELECT
      EXTRACT(DOW FROM initiated_at AT TIME ZONE 'Africa/Lagos')::int as day_of_week,
      EXTRACT(HOUR FROM initiated_at AT TIME ZONE 'Africa/Lagos')::int as hour_of_day,
      COUNT(*) as count,
      SUM(amount_ngn) as total_spend
    FROM recharges
    WHERE user_id = $1 AND status = 'completed' AND initiated_at >= $2
    GROUP BY day_of_week, hour_of_day
    ORDER BY day_of_week, hour_of_day
  `, [userId, start]);

  return success({
    heatmap: rows,
    period: '30 days',
    timezone: 'Africa/Lagos',
  });
});

// ─── Spend by App (from usage events - if collected) ─────────────────────────
app.get('/api/v1/analytics/spending/by-app', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  // This would query ClickHouse in production
  // Returning structured mock that matches the real schema for now
  return success({
    period: '30 days',
    note: 'App-level analytics require Android VpnService permission. Enable in app settings.',
    topApps: [],
    total: 0,
  });
});

// ─── Cost Per GB Trend ────────────────────────────────────────────────────────
app.get('/api/v1/analytics/cost-per-gb', { preHandler: [app.authenticate] }, async (req) => {
  const userId = req.user.sub;
  const { rows } = await db.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', initiated_at), 'Mon YYYY') as month,
      DATE_TRUNC('month', initiated_at) as month_date,
      SUM(amount_ngn) as total_spend,
      SUM(data_mb) as total_mb,
      CASE WHEN SUM(data_mb) > 0 THEN ROUND(SUM(amount_ngn) / (SUM(data_mb)::decimal / 1024), 0) ELSE 0 END as cost_per_gb
    FROM recharges
    WHERE user_id = $1 AND status = 'completed' AND initiated_at >= NOW() - INTERVAL '12 months'
    GROUP BY DATE_TRUNC('month', initiated_at)
    ORDER BY month_date ASC
  `, [userId]);

  const marketAvg = 700; // ₦700/GB market average
  return success({
    trend: rows.map(r => ({ ...r, marketAvg, savingsPct: r.cost_per_gb > 0 ? Math.round((1 - r.cost_per_gb / marketAvg) * 100) : 0 })),
    marketAvg,
  });
});

// ─── Monthly Report Generation ────────────────────────────────────────────────
app.get('/api/v1/analytics/report/:month', { preHandler: [app.authenticate] }, async (req) => {
  const { month } = req.params; // Format: "2026-06"
  const [year, mo] = month.split('-').map(Number);
  const start = new Date(year, mo - 1, 1);
  const end = new Date(year, mo, 0, 23, 59, 59);

  const [summary, byNetwork, scoreRes, twinRes] = await Promise.all([
    db.query(`SELECT SUM(amount_ngn) as total, SUM(data_mb) as total_mb, COUNT(*) as purchases FROM recharges WHERE user_id=$1 AND status='completed' AND initiated_at BETWEEN $2 AND $3`, [req.user.sub, start, end]),
    db.query(`SELECT network, SUM(amount_ngn) as amount FROM recharges WHERE user_id=$1 AND status='completed' AND initiated_at BETWEEN $2 AND $3 GROUP BY network`, [req.user.sub, start, end]),
    db.query(`SELECT overall_score, tier FROM connectivity_scores WHERE user_id=$1 AND calculated_at BETWEEN $2 AND $3 ORDER BY calculated_at DESC LIMIT 1`, [req.user.sub, start, end]),
    db.query(`SELECT daily_avg_mb, avg_recharge_amount_ngn, bundle_acceptance_rate FROM user_data_twins WHERE user_id=$1`, [req.user.sub]),
  ]);

  return success({
    month, period: { start, end },
    summary: { total: parseFloat(summary.rows[0]?.total || 0), totalMb: parseInt(summary.rows[0]?.total_mb || 0), purchases: parseInt(summary.rows[0]?.purchases || 0) },
    byNetwork: byNetwork.rows,
    score: scoreRes.rows[0],
    twin: twinRes.rows[0],
    generatedAt: new Date().toISOString(),
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'analytics' }));
app.setErrorHandler(globalErrorHandler);
app.listen({ port: process.env.PORT || 3007, host: '0.0.0.0' })
  .then(() => log.info('Analytics service started', { port: process.env.PORT || 3007 }))
  .catch(err => { log.error('Failed', { err: err.message }); process.exit(1); });

module.exports = app;
