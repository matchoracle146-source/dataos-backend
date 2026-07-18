const { Pool } = require('pg');

// ─── Postgres Connection Factory ──────────────────────────────────────────────
// Railway's internal DATABASE_URL (private network, service-to-service) does NOT
// require SSL and does not present a publicly-verifiable certificate — setting
// rejectUnauthorized:true against it will hang/fail connections.
//
// Railway's PUBLIC database URL (if you connect from outside Railway, e.g. a
// local machine or a different host) DOES support SSL but with Railway's own
// cert chain, so rejectUnauthorized must stay false unless you've pinned their CA.
//
// Rule used here: trust DATABASE_SSL env var if explicitly set; otherwise
// default to no strict verification, since this connects over Railway's
// private network in production by default.
function createDbPool(options = {}) {
  const sslMode = process.env.DATABASE_SSL; // 'true' | 'false' | undefined

  let ssl = false;
  if (sslMode === 'true') {
    ssl = { rejectUnauthorized: false };
  } else if (sslMode === 'require-strict') {
    ssl = { rejectUnauthorized: true };
  }

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    ...options,
  });
}

module.exports = { createDbPool };
