const Redis = require('ioredis');

// ─── Redis Connection Factory ─────────────────────────────────────────────────
// Supports two connection styles:
//   1. REDIS_URL (Railway, Heroku, most managed Redis providers)
//      e.g. redis://default:password@host:port
//   2. Discrete REDIS_HOST / REDIS_PORT / REDIS_PASSWORD (local Docker Compose)
//
// Railway's Redis plugin injects REDIS_URL automatically — no manual mapping needed.
function createRedisClient(options = {}) {
  const { lazyConnect = false } = options;

  if (process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect,
    });
  }

  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    lazyConnect,
  });
}

module.exports = { createRedisClient };
