require('dotenv').config();
const Fastify = require('fastify');
const { globalErrorHandler } = require('../shared/errors');
const { createLogger } = require('../shared/utils');

const log = createLogger('auth-service');

const app = Fastify({
  logger: process.env.NODE_ENV !== 'test',
  trustProxy: true,
  genReqId: () => require('uuid').v4(),
});

// ─── Plugins ─────────────────────────────────────────────────────────────────
app.register(require('@fastify/helmet'), {
  contentSecurityPolicy: false,
});

app.register(require('@fastify/cors'), {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID', 'X-Request-ID'],
});

app.register(require('@fastify/rate-limit'), {
  global: false,
  redis: require('./utils/redis').client,
});

app.register(require('@fastify/jwt'), {
  secret: { private: process.env.JWT_PRIVATE_KEY, public: process.env.JWT_PUBLIC_KEY },
  sign: { algorithm: 'RS256', expiresIn: '15m', issuer: 'dataos-auth' },
  verify: { algorithms: ['RS256'], issuer: 'dataos-auth' },
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.register(require('./routes/auth'), { prefix: '/api/v1/auth' });

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'auth', ts: new Date().toISOString() }));
app.get('/ready', async () => {
  const db = require('./utils/db');
  await db.query('SELECT 1');
  return { status: 'ready' };
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.setErrorHandler(globalErrorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.listen({ port: process.env.PORT || 3001, host: '0.0.0.0' });
    log.info('Auth service started', { port: process.env.PORT || 3001 });
  } catch (err) {
    log.error('Failed to start auth service', { err: err.message });
    process.exit(1);
  }
};

start();
module.exports = app;
