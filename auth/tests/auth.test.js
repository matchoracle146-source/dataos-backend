// ═══════════════════════════════════════════════════════════════
// Auth Service — Test Suite
// Run: npm test --workspace=services/auth
// ═══════════════════════════════════════════════════════════════
'use strict';

// Mock dependencies before requiring app
jest.mock('../src/utils/db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../src/utils/redis', () => ({
  client: {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('../src/utils/sms', () => ({
  sendOTP: jest.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

const {
  normalizePhone,
  detectNetwork,
  generateOTP,
  hashValue,
  verifyHash,
  maskPhone,
} = require('../../../shared/utils');

// ─── Unit Tests: Utilities ────────────────────────────────────
describe('Shared Utilities', () => {

  describe('normalizePhone', () => {
    test('converts 080... to +23480...', () => {
      expect(normalizePhone('08031234567')).toBe('+2348031234567');
    });

    test('handles already normalized +234...', () => {
      expect(normalizePhone('+2348031234567')).toBe('+2348031234567');
    });

    test('strips spaces and dashes', () => {
      expect(normalizePhone('0803 123 4567')).toBe('+2348031234567');
    });

    test('handles 234... prefix', () => {
      expect(normalizePhone('2348031234567')).toBe('+2348031234567');
    });
  });

  describe('detectNetwork', () => {
    test('detects MTN 0803 prefix', () => {
      expect(detectNetwork('+2348031234567')).toBe('MTN');
    });

    test('detects Airtel 0802 prefix', () => {
      expect(detectNetwork('+2348021234567')).toBe('AIRTEL');
    });

    test('detects Glo 0805 prefix', () => {
      expect(detectNetwork('+2348051234567')).toBe('GLO');
    });

    test('detects 9mobile 0809 prefix', () => {
      expect(detectNetwork('+2348091234567')).toBe('9MOBILE');
    });

    test('returns null for unknown prefix', () => {
      expect(detectNetwork('+2341234567890')).toBeNull();
    });
  });

  describe('generateOTP', () => {
    test('generates 6-digit OTP by default', () => {
      const otp = generateOTP();
      expect(otp).toMatch(/^\d{6}$/);
    });

    test('generates custom length OTP', () => {
      const otp = generateOTP(8);
      expect(otp).toHaveLength(8);
    });

    test('generates different OTPs each time', () => {
      const otp1 = generateOTP();
      const otp2 = generateOTP();
      // Not strictly guaranteed but probability of collision is 1/1,000,000
      expect(otp1).not.toBe(otp2);
    });
  });

  describe('hashValue / verifyHash', () => {
    test('hashes a value and verifies it correctly', () => {
      const value = 'test-secret-123';
      const { hash, salt } = hashValue(value);
      expect(verifyHash(value, hash, salt)).toBe(true);
    });

    test('rejects wrong value', () => {
      const { hash, salt } = hashValue('correct-value');
      expect(verifyHash('wrong-value', hash, salt)).toBe(false);
    });

    test('produces different hashes for same value with different salts', () => {
      const value = 'test-value';
      const { hash: h1, salt: s1 } = hashValue(value);
      const { hash: h2, salt: s2 } = hashValue(value);
      expect(h1).not.toBe(h2);
      expect(s1).not.toBe(s2);
    });

    test('uses provided salt', () => {
      const value = 'test-value';
      const salt = 'fixed-salt-12345';
      const { hash: h1 } = hashValue(value, salt);
      const { hash: h2 } = hashValue(value, salt);
      expect(h1).toBe(h2);
    });
  });

  describe('maskPhone', () => {
    test('masks middle digits of phone number', () => {
      const masked = maskPhone('+2348031234567');
      expect(masked).toContain('+234');
      expect(masked).toContain('XXX');
    });
  });
});

// ─── Unit Tests: OTP Flow ─────────────────────────────────────
describe('OTP Flow', () => {
  const db = require('../src/utils/db');
  const redis = require('../src/utils/redis');
  const sms = require('../src/utils/sms');
  const AuthController = require('../src/controllers/auth');

  let ctrl;
  let mockFastify;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFastify = {
      jwt: {
        sign: jest.fn().mockReturnValue('mock.access.token'),
      },
      decorate: jest.fn(),
    };
    ctrl = new AuthController(mockFastify);

    // Default mock: rate limit not exceeded
    redis.client.incr.mockResolvedValue(1);
    redis.client.expire.mockResolvedValue(1);
  });

  describe('requestOtp', () => {
    test('sends OTP successfully for valid Nigerian phone', async () => {
      db.query.mockResolvedValue({ rows: [] });

      const result = await ctrl.requestOtp(
        { phone: '08031234567', purpose: 'login' },
        '192.168.1.1'
      );

      expect(sms.sendOTP).toHaveBeenCalledWith('+2348031234567', expect.any(String));
      expect(result.data.expiresIn).toBe(60);
      expect(result.data.phone).toContain('XXX');
    });

    test('throws RateLimitError when OTP requested too many times', async () => {
      redis.client.incr.mockResolvedValue(6); // Exceeds limit of 5

      await expect(
        ctrl.requestOtp({ phone: '08031234567', purpose: 'login' }, '192.168.1.1')
      ).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });

      expect(sms.sendOTP).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    test('verifies correct OTP and returns tokens', async () => {
      const otp = '123456';
      const { hash, salt } = hashValue(otp);

      // Mock: OTP exists in DB
      db.query
        .mockResolvedValueOnce({ rows: [{
          id: 'otp-id-1',
          otp_hash: hash,
          otp_salt: salt,
          attempts: 0,
          max_attempts: 3,
          expires_at: new Date(Date.now() + 60000),
        }]})
        // Update attempts
        .mockResolvedValueOnce({ rows: [] })
        // Mark verified
        .mockResolvedValueOnce({ rows: [] })
        // Get or create user
        .mockResolvedValueOnce({ rows: [{
          id: 'user-123',
          phone: '+2348031234567',
          phone_hash: 'hash',
          country_code: 'NG',
          kyc_level: 0,
          status: 'active',
          created_at: new Date(),
        }]})
        // Upsert device
        .mockResolvedValueOnce({ rows: [] })
        // Insert refresh token
        .mockResolvedValueOnce({ rows: [] });

      const result = await ctrl.verifyOtp({
        phone: '08031234567',
        otp,
        device: {
          deviceId: 'device-123',
          platform: 'android',
          deviceName: 'Test Device',
        },
      }, '192.168.1.1');

      expect(result.data.accessToken).toBe('mock.access.token');
      expect(result.data.refreshToken).toBeDefined();
      expect(result.data.user.id).toBe('user-123');
    });

    test('throws AuthenticationError for wrong OTP', async () => {
      const { hash, salt } = hashValue('654321'); // Different OTP stored

      db.query.mockResolvedValueOnce({ rows: [{
        id: 'otp-id-1',
        otp_hash: hash,
        otp_salt: salt,
        attempts: 0,
        max_attempts: 3,
        expires_at: new Date(Date.now() + 60000),
      }]}).mockResolvedValueOnce({ rows: [] }); // Update attempts

      await expect(
        ctrl.verifyOtp({
          phone: '08031234567',
          otp: '000000', // Wrong OTP
          device: { deviceId: 'device-123', platform: 'android' },
        }, '192.168.1.1')
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });

    test('throws AuthenticationError when OTP expired', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // No valid OTP found

      await expect(
        ctrl.verifyOtp({
          phone: '08031234567',
          otp: '123456',
          device: { deviceId: 'device-123', platform: 'android' },
        }, '192.168.1.1')
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });

    test('throws when max attempts exceeded', async () => {
      const { hash, salt } = hashValue('654321');

      db.query.mockResolvedValueOnce({ rows: [{
        id: 'otp-id-1',
        otp_hash: hash,
        otp_salt: salt,
        attempts: 3, // Already at max
        max_attempts: 3,
        expires_at: new Date(Date.now() + 60000),
      }]});

      await expect(
        ctrl.verifyOtp({
          phone: '08031234567',
          otp: '123456',
          device: { deviceId: 'device-123', platform: 'android' },
        }, '192.168.1.1')
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });
  });

  describe('refreshToken', () => {
    test('issues new token pair on valid refresh', async () => {
      const rawToken = 'valid-refresh-token-abc123';
      const { hashToken } = require('../../../shared/utils');

      db.query
        .mockResolvedValueOnce({ rows: [{
          id: 'token-id-1',
          user_id: 'user-123',
          device_id: 'device-123',
          family: 'family-abc',
          status: 'active',
          kyc_level: 0,
          country_code: 'NG',
        }]})
        // Revoke current
        .mockResolvedValueOnce({ rows: [] })
        // Get user for new token
        .mockResolvedValueOnce({ rows: [{ id: 'user-123', kyc_level: 0, country_code: 'NG' }]})
        // Insert new refresh token
        .mockResolvedValueOnce({ rows: [] });

      const result = await ctrl.refreshToken(rawToken, 'device-123', '192.168.1.1');

      expect(result.data.accessToken).toBe('mock.access.token');
      expect(result.data.refreshToken).toBeDefined();
      expect(result.data.refreshToken).not.toBe(rawToken); // Should be rotated
    });

    test('throws on device mismatch (token theft detection)', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{
          id: 'token-id-1',
          user_id: 'user-123',
          device_id: 'original-device', // Different device
          family: 'family-abc',
          status: 'active',
        }]})
        .mockResolvedValueOnce({ rows: [] }); // Revoke family

      await expect(
        ctrl.refreshToken('some-token', 'different-device', '192.168.1.1')
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });
  });
});

// ─── Integration Tests: Constants ─────────────────────────────
describe('Constants and Error Classes', () => {
  const {
    AuthenticationError,
    ValidationError,
    NotFoundError,
    RateLimitError,
    TelecomError,
    InsufficientBalanceError,
  } = require('../../../shared/errors');

  test('AuthenticationError has correct status', () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTHENTICATION_REQUIRED');
    expect(err.isOperational).toBe(true);
  });

  test('ValidationError carries details', () => {
    const err = new ValidationError('Invalid input', { field: 'phone' });
    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual({ field: 'phone' });
  });

  test('NotFoundError formats resource name', () => {
    const err = new NotFoundError('SIM card');
    expect(err.message).toBe('SIM card not found');
    expect(err.statusCode).toBe(404);
  });

  test('RateLimitError includes retryAfter', () => {
    const err = new RateLimitError(120);
    expect(err.statusCode).toBe(429);
    expect(err.details.retryAfter).toBe(120);
  });

  test('TelecomError includes network info', () => {
    const err = new TelecomError('MTN', 'balance', 'API unavailable');
    expect(err.statusCode).toBe(503);
    expect(err.details.network).toBe('MTN');
    expect(err.details.method).toBe('balance');
  });

  test('InsufficientBalanceError includes amounts', () => {
    const err = new InsufficientBalanceError(500, 200, 'NGN');
    expect(err.statusCode).toBe(402);
    expect(err.details.required).toBe(500);
    expect(err.details.available).toBe(200);
  });
});

// ─── Unit Tests: Data Utilities ───────────────────────────────
describe('Data Utilities', () => {
  const {
    formatDataSize,
    parseMbFromText,
    parseNairaFromText,
    isValidNigerianPhone,
    isValidUUID,
    sanitizeInput,
    startOfMonth,
    endOfMonth,
    daysUntil,
  } = require('../../../shared/utils');

  describe('formatDataSize', () => {
    test('formats MB correctly', () => {
      expect(formatDataSize(500)).toBe('500MB');
    });

    test('formats GB correctly', () => {
      expect(formatDataSize(2048)).toBe('2.0GB');
    });

    test('formats fractional GB', () => {
      expect(formatDataSize(1536)).toBe('1.5GB');
    });
  });

  describe('parseMbFromText', () => {
    test('parses GB text to MB', () => {
      expect(parseMbFromText('4.2GB')).toBe(4300.8);
    });

    test('parses MB text directly', () => {
      expect(parseMbFromText('512MB')).toBe(512);
    });

    test('is case-insensitive', () => {
      expect(parseMbFromText('1.5gb')).toBe(1536);
    });

    test('returns 0 for unrecognized text', () => {
      expect(parseMbFromText('no data here')).toBe(0);
    });
  });

  describe('parseNairaFromText', () => {
    test('parses simple amount', () => {
      expect(parseNairaFromText('₦1,500')).toBe(1500);
    });

    test('parses amount with N prefix', () => {
      expect(parseNairaFromText('N2000')).toBe(2000);
    });

    test('handles decimal amounts', () => {
      expect(parseNairaFromText('₦3,500.50')).toBe(3500.50);
    });
  });

  describe('isValidNigerianPhone', () => {
    test('validates correct MTN number', () => {
      expect(isValidNigerianPhone('+2348031234567')).toBe(true);
    });

    test('rejects non-Nigerian number', () => {
      expect(isValidNigerianPhone('+14155551234')).toBe(false);
    });

    test('rejects too short number', () => {
      expect(isValidNigerianPhone('+234803123')).toBe(false);
    });
  });

  describe('isValidUUID', () => {
    test('validates correct UUIDv4', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    test('rejects invalid UUID', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
    });
  });

  describe('sanitizeInput', () => {
    test('strips HTML tags', () => {
      expect(sanitizeInput('<script>alert("xss")</script>Hello')).toBe('Hello');
    });

    test('trims whitespace', () => {
      expect(sanitizeInput('  hello  ')).toBe('hello');
    });

    test('enforces maxLen', () => {
      expect(sanitizeInput('a'.repeat(200), 10)).toHaveLength(10);
    });
  });

  describe('Date utilities', () => {
    test('startOfMonth returns first day', () => {
      const start = startOfMonth();
      expect(start.getDate()).toBe(1);
      expect(start.getHours()).toBe(0);
    });

    test('endOfMonth returns last day', () => {
      const end = endOfMonth();
      const next = new Date(end);
      next.setDate(next.getDate() + 1);
      expect(next.getDate()).toBe(1);
    });

    test('daysUntil future date', () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      expect(daysUntil(future)).toBeGreaterThanOrEqual(6);
      expect(daysUntil(future)).toBeLessThanOrEqual(7);
    });

    test('daysUntil past date returns 0', () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(daysUntil(past)).toBe(0);
    });
  });
});
