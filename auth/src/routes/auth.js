const { z } = require('zod');
const AuthController = require('../controllers/auth');
const { ValidationError } = require('../../../shared/errors');

// ─── Validation Schemas ───────────────────────────────────────────────────────
const schemas = {
  requestOtp: z.object({
    phone: z.string().min(10).max(15),
    purpose: z.enum(['login', 'register', 'reset']).default('login'),
  }),
  verifyOtp: z.object({
    phone: z.string().min(10).max(15),
    otp: z.string().length(6).regex(/^\d{6}$/),
    device: z.object({
      deviceId: z.string().max(255),
      deviceName: z.string().max(100).optional(),
      platform: z.enum(['android', 'ios', 'web']),
      osVersion: z.string().max(20).optional(),
      appVersion: z.string().max(20).optional(),
    }),
  }),
  refresh: z.object({
    refreshToken: z.string().min(32),
  }),
  registerBiometric: z.object({
    publicKey: z.string().min(50),
    deviceId: z.string().max(255),
    biometricType: z.enum(['fingerprint', 'face', 'iris']),
  }),
  verifyBiometric: z.object({
    challenge: z.string().min(16),
    signature: z.string().min(10),
    deviceId: z.string().max(255),
  }),
};

const validate = (schema) => (data) => {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError('Invalid request', result.error.flatten());
  return result.data;
};

// ─── Routes ──────────────────────────────────────────────────────────────────
async function authRoutes(fastify) {
  const ctrl = new AuthController(fastify);

  // Request OTP
  fastify.post('/request-otp', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.body?.phone || req.ip },
    },
    handler: async (req, reply) => {
      const body = validate(schemas.requestOtp)(req.body);
      const result = await ctrl.requestOtp(body, req.ip);
      return reply.status(200).send(result);
    },
  });

  // Verify OTP
  fastify.post('/verify-otp', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.body?.phone || req.ip },
    },
    handler: async (req, reply) => {
      const body = validate(schemas.verifyOtp)(req.body);
      const result = await ctrl.verifyOtp(body, req.ip);
      return reply.status(200).send(result);
    },
  });

  // Refresh token
  fastify.post('/refresh', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { refreshToken } = validate(schemas.refresh)(req.body);
      const deviceId = req.headers['x-device-id'];
      const result = await ctrl.refreshToken(refreshToken, deviceId, req.ip);
      return reply.status(200).send(result);
    },
  });

  // Logout
  fastify.delete('/logout', {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      await ctrl.logout(req.user, req.body?.everywhere === true);
      return reply.status(204).send();
    },
  });

  // Register biometric key
  fastify.post('/biometric/register', {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const body = validate(schemas.registerBiometric)(req.body);
      const result = await ctrl.registerBiometric(req.user.sub, body);
      return reply.status(200).send(result);
    },
  });

  // Biometric challenge (get challenge to sign)
  fastify.get('/biometric/challenge', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { phone } = req.query;
      if (!phone) throw new ValidationError('phone is required', null);
      const result = await ctrl.getBiometricChallenge(phone);
      return reply.status(200).send(result);
    },
  });

  // Verify biometric signature
  fastify.post('/biometric/verify', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = validate(schemas.verifyBiometric)(req.body);
      const result = await ctrl.verifyBiometric(body, req.ip);
      return reply.status(200).send(result);
    },
  });

  // Get active sessions
  fastify.get('/sessions', {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      const sessions = await ctrl.getSessions(req.user.sub);
      return reply.status(200).send(sessions);
    },
  });

  // Revoke specific session
  fastify.delete('/sessions/:sessionId', {
    preHandler: [fastify.authenticate],
    handler: async (req, reply) => {
      await ctrl.revokeSession(req.user.sub, req.params.sessionId);
      return reply.status(204).send();
    },
  });
}

module.exports = authRoutes;
