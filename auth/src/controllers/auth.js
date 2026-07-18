const crypto = require('crypto');
const db = require('../utils/db');
const redis = require('../utils/redis');
const smsService = require('../utils/sms');
const {
  normalizePhone, detectNetwork, generateOTP,
  hashValue, verifyHash, generateSecureToken, hashToken,
  maskPhone, success, createLogger,
} = require('../../../shared/utils');
const {
  AuthenticationError, ConflictError, NotFoundError,
  RateLimitError, ValidationError,
} = require('../../../shared/errors');

const log = createLogger('auth-controller');
const OTP_TTL = 60; // seconds
const REFRESH_TOKEN_TTL_DAYS = 30;

class AuthController {
  constructor(fastify) {
    this.fastify = fastify;
    // Bind authenticate decorator
    fastify.decorate('authenticate', async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch (err) {
        throw new AuthenticationError('Invalid or expired token');
      }
    });
  }

  async requestOtp(body, ipAddress) {
    const phone = normalizePhone(body.phone);

    // Check if too many OTPs in last 10 min
    const recentAttempts = await redis.client.incr(`otp:rate:${phone}`);
    if (recentAttempts === 1) await redis.client.expire(`otp:rate:${phone}`, 600);
    if (recentAttempts > 5) throw new RateLimitError(300);

    // Generate OTP
    const otp = generateOTP(6);
    const { hash, salt } = hashValue(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL * 1000);

    // Store OTP attempt
    await db.query(`
      INSERT INTO otp_attempts (phone, otp_hash, otp_salt, purpose, expires_at, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [phone, hash, salt, body.purpose, expiresAt, ipAddress]);

    // Send OTP via SMS
    await smsService.sendOTP(phone, otp);

    log.info('OTP sent', { phone: maskPhone(phone) });

    return success({
      message: 'OTP sent successfully',
      phone: maskPhone(phone),
      expiresIn: OTP_TTL,
      network: detectNetwork(phone),
    });
  }

  async verifyOtp(body, ipAddress) {
    const phone = normalizePhone(body.phone);

    // Get latest valid OTP
    const { rows } = await db.query(`
      SELECT * FROM otp_attempts
      WHERE phone = $1
        AND expires_at > NOW()
        AND verified_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `, [phone]);

    if (!rows.length) throw new AuthenticationError('OTP expired or not found. Request a new one.');

    const attempt = rows[0];

    // Check attempt count
    if (attempt.attempts >= attempt.max_attempts) {
      throw new AuthenticationError('Too many failed attempts. Request a new OTP.');
    }

    // Increment attempts
    await db.query(`UPDATE otp_attempts SET attempts = attempts + 1 WHERE id = $1`, [attempt.id]);

    // Verify OTP
    const isValid = verifyHash(body.otp, attempt.otp_hash, attempt.otp_salt);
    if (!isValid) throw new AuthenticationError('Invalid OTP. Please try again.');

    // Mark OTP as verified
    await db.query(`UPDATE otp_attempts SET verified_at = NOW() WHERE id = $1`, [attempt.id]);

    // Get or create user
    const user = await this._getOrCreateUser(phone);

    // Register/update device
    await this._upsertDevice(user.id, body.device, ipAddress);

    // Issue tokens
    const tokens = await this._issueTokens(user, body.device.deviceId);

    log.info('User authenticated', { userId: user.id, phone: maskPhone(phone) });

    return success({
      user: this._sanitizeUser(user),
      ...tokens,
      isNewUser: user.is_new,
    });
  }

  async refreshToken(rawToken, deviceId, ipAddress) {
    const tokenHash = hashToken(rawToken);

    const { rows } = await db.query(`
      SELECT rt.*, u.id as user_id, u.status, u.kyc_level, u.country_code
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1
        AND rt.expires_at > NOW()
        AND rt.revoked_at IS NULL
    `, [tokenHash]);

    if (!rows.length) throw new AuthenticationError('Invalid or expired refresh token');

    const token = rows[0];

    // Device binding check
    if (token.device_id && deviceId && token.device_id !== deviceId) {
      // Revoke entire family (token theft detection)
      await db.query(`
        UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'device_mismatch'
        WHERE family = $1
      `, [token.family]);
      log.warn('Token family revoked — device mismatch', { family: token.family });
      throw new AuthenticationError('Security alert: token reuse detected. Please log in again.');
    }

    if (token.status !== 'active') throw new AuthenticationError('Account suspended');

    // Rotate: revoke current, issue new
    await db.query(`
      UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'rotated'
      WHERE id = $1
    `, [token.id]);

    const user = await db.query('SELECT * FROM users WHERE id = $1', [token.user_id]);
    const tokens = await this._issueTokens(user.rows[0], deviceId || token.device_id, token.family);

    return success(tokens);
  }

  async logout(jwtUser, everywhere = false) {
    if (everywhere) {
      await db.query(`
        UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'logout_all'
        WHERE user_id = $1 AND revoked_at IS NULL
      `, [jwtUser.sub]);
    } else {
      await db.query(`
        UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'logout'
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
      `, [jwtUser.sub, jwtUser.deviceId]);
    }
  }

  async registerBiometric(userId, body) {
    // Store public key in device record
    await db.query(`
      UPDATE user_devices
      SET biometric_public_key = $1, biometric_type = $2, is_trusted = TRUE, trust_score = LEAST(trust_score + 30, 100)
      WHERE user_id = $3 AND device_id = $4
    `, [body.publicKey, body.biometricType, userId, body.deviceId]);

    return success({ message: 'Biometric registered successfully' });
  }

  async getBiometricChallenge(phone) {
    const normalized = normalizePhone(phone);
    const { rows } = await db.query('SELECT id FROM users WHERE phone = $1', [normalized]);
    if (!rows.length) throw new NotFoundError('User');

    const challenge = generateSecureToken(16);
    await redis.client.setex(`bio:challenge:${normalized}`, 60, challenge);

    return success({ challenge, expiresIn: 60 });
  }

  async verifyBiometric(body, ipAddress) {
    // In production: verify ECDSA signature against stored public key
    // This is the structure; signature verification uses crypto.verify()
    const { rows: deviceRows } = await db.query(`
      SELECT ud.*, u.id as user_id, u.status, u.kyc_level, u.country_code, u.phone
      FROM user_devices ud
      JOIN users u ON u.id = ud.user_id
      WHERE ud.device_id = $1 AND ud.biometric_public_key IS NOT NULL
    `, [body.deviceId]);

    if (!deviceRows.length) throw new AuthenticationError('Biometric not registered for this device');

    const device = deviceRows[0];
    const storedChallenge = await redis.client.get(`bio:challenge:${device.phone}`);
    if (!storedChallenge || storedChallenge !== body.challenge) {
      throw new AuthenticationError('Invalid or expired challenge');
    }

    // Verify signature (ECDSA P-256)
    const isValid = crypto.verify(
      'SHA256',
      Buffer.from(body.challenge),
      { key: device.biometric_public_key, format: 'pem' },
      Buffer.from(body.signature, 'base64')
    );

    if (!isValid) throw new AuthenticationError('Biometric verification failed');

    await redis.client.del(`bio:challenge:${device.phone}`);

    const user = { id: device.user_id, status: device.status, kyc_level: device.kyc_level, country_code: device.country_code };
    const tokens = await this._issueTokens(user, body.deviceId);

    return success({ ...tokens, biometric: true });
  }

  async getSessions(userId) {
    const { rows } = await db.query(`
      SELECT rt.id, rt.device_id, rt.created_at, rt.expires_at, ud.device_name, ud.platform, ud.last_seen_at
      FROM refresh_tokens rt
      LEFT JOIN user_devices ud ON ud.device_id = rt.device_id AND ud.user_id = rt.user_id
      WHERE rt.user_id = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
      ORDER BY rt.created_at DESC
    `, [userId]);

    return success(rows);
  }

  async revokeSession(userId, sessionId) {
    const { rowCount } = await db.query(`
      UPDATE refresh_tokens SET revoked_at = NOW(), revoke_reason = 'user_revoked'
      WHERE id = $1 AND user_id = $2
    `, [sessionId, userId]);

    if (!rowCount) throw new NotFoundError('Session');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  async _getOrCreateUser(phone) {
    const { hash: phoneHash } = hashValue(phone, process.env.PHONE_HASH_SECRET);
    const { rows } = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (rows.length) return { ...rows[0], is_new: false };

    // Create new user
    const { rows: newRows } = await db.query(`
      INSERT INTO users (phone, phone_hash, country_code)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [phone, phoneHash, 'NG']);

    log.info('New user created', { userId: newRows[0].id });
    return { ...newRows[0], is_new: true };
  }

  async _upsertDevice(userId, device, ipAddress) {
    await db.query(`
      INSERT INTO user_devices (user_id, device_id, device_name, platform, os_version, app_version, last_seen_at, trust_score)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), 30)
      ON CONFLICT (user_id, device_id) DO UPDATE SET
        device_name = EXCLUDED.device_name,
        os_version = EXCLUDED.os_version,
        app_version = EXCLUDED.app_version,
        last_seen_at = NOW(),
        trust_score = LEAST(user_devices.trust_score + 5, 100)
    `, [userId, device.deviceId, device.deviceName, device.platform, device.osVersion, device.appVersion]);
  }

  async _issueTokens(user, deviceId, family = null) {
    // Access token (JWT, 15 min)
    const accessToken = this.fastify.jwt.sign({
      sub: user.id,
      country: user.country_code,
      kycLevel: user.kyc_level,
      deviceId,
    });

    // Refresh token (opaque, 30 days)
    const rawRefresh = generateSecureToken(32);
    const refreshHash = hashToken(rawRefresh);
    const tokenFamily = family || generateSecureToken(16);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await db.query(`
      INSERT INTO refresh_tokens (user_id, device_id, token_hash, family, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [user.id, deviceId, refreshHash, tokenFamily, expiresAt]);

    return { accessToken, refreshToken: rawRefresh, expiresIn: 900 };
  }

  _sanitizeUser(user) {
    return {
      id: user.id,
      phone: maskPhone(user.phone),
      countryCode: user.country_code,
      kycLevel: user.kyc_level,
      status: user.status,
      createdAt: user.created_at,
    };
  }
}

module.exports = AuthController;
