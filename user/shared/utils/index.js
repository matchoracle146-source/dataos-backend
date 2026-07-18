const crypto = require('crypto');

// ─── Data Conversion ──────────────────────────────────────────────────────────
const mbToGb = (mb) => (mb / 1024).toFixed(2);
const gbToMb = (gb) => Math.round(gb * 1024);

const formatDataSize = (mb) => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
};

const formatNaira = (amount) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(amount);

// ─── Phone Number Utilities ───────────────────────────────────────────────────
const normalizePhone = (phone, countryCode = '234') => {
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = countryCode + clean.slice(1);
  if (!clean.startsWith(countryCode)) clean = countryCode + clean;
  return '+' + clean;
};

const maskPhone = (phone) => {
  const digits = phone.replace(/\D/g, '');
  return `+${digits.slice(0, 3)} ${digits.slice(3, 6)}XXX XXXX`;
};

const detectNetwork = (msisdn) => {
  const digits = msisdn.replace(/\D/g, '');
  const prefix3 = digits.slice(3, 6);
  const prefix4 = digits.slice(3, 7);

  const MTN = ['803','806','703','706','813','816','810','814','903','906'];
  const AIRTEL = ['802','808','708','812','701','901','902','904','907'];
  const GLO = ['805','807','705','815','811','905'];
  const NINE_MOBILE = ['809','818','817','908','909'];

  if (MTN.includes(prefix3)) return 'MTN';
  if (AIRTEL.includes(prefix3)) return 'AIRTEL';
  if (GLO.includes(prefix3)) return 'GLO';
  if (NINE_MOBILE.includes(prefix3)) return '9MOBILE';
  return null;
};

// ─── Security Utilities ───────────────────────────────────────────────────────
const generateOTP = (length = 6) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

const hashValue = (value, salt) => {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', s).update(value).digest('hex');
  return { hash, salt: s };
};

const verifyHash = (value, hash, salt) => {
  const computed = crypto.createHmac('sha256', salt).update(value).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
};

const generateSecureToken = (bytes = 32) =>
  crypto.randomBytes(bytes).toString('hex');

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

// ─── Response Builder ─────────────────────────────────────────────────────────
const success = (data, meta = {}) => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), ...meta },
});

const paginated = (items, total, page, limit, meta = {}) => ({
  success: true,
  data: items,
  pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  meta: { timestamp: new Date().toISOString(), ...meta },
});

// ─── Date Utilities ───────────────────────────────────────────────────────────
const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const daysUntil = (date) =>
  Math.max(0, Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24)));

const startOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const endOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

const isNigerianHoliday = (date) => {
  const d = new Date(date);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const holidays = [
    [1, 1], [1, 2], [5, 1], [6, 12], [10, 1], [10, 2], [12, 25], [12, 26]
  ];
  return holidays.some(([m, dy]) => m === month && dy === day);
};

// ─── USSD Parser Utilities ────────────────────────────────────────────────────
const parseMbFromText = (text) => {
  const gbMatch = text.match(/([\d.]+)\s*GB/i);
  if (gbMatch) return parseFloat(gbMatch[1]) * 1024;
  const mbMatch = text.match(/([\d.]+)\s*MB/i);
  if (mbMatch) return parseFloat(mbMatch[1]);
  return 0;
};

const parseNairaFromText = (text) => {
  const match = text.match(/[₦N]?\s*([\d,]+\.?\d*)/);
  if (match) return parseFloat(match[1].replace(/,/g, ''));
  return 0;
};

// ─── Validation Helpers ───────────────────────────────────────────────────────
const isValidNigerianPhone = (phone) =>
  /^\+?234[7-9]\d{9}$/.test(phone.replace(/\s/g, ''));

const isValidUUID = (str) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

const sanitizeInput = (str, maxLen = 500) =>
  String(str || '').trim().slice(0, maxLen).replace(/<[^>]*>/g, '');

// ─── Retry Utility ────────────────────────────────────────────────────────────
const retry = async (fn, maxAttempts = 3, delayMs = 1000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
};

// ─── Logger ──────────────────────────────────────────────────────────────────
const createLogger = (service) => ({
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', service, msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', service, msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', service, msg, ...data, ts: new Date().toISOString() })),
  debug: (msg, data) => process.env.NODE_ENV !== 'production' && console.debug(JSON.stringify({ level: 'debug', service, msg, ...data, ts: new Date().toISOString() })),
});

module.exports = {
  mbToGb, gbToMb, formatDataSize, formatNaira,
  normalizePhone, maskPhone, detectNetwork,
  generateOTP, hashValue, verifyHash, generateSecureToken, hashToken,
  success, paginated,
  addDays, daysUntil, startOfMonth, endOfMonth, isNigerianHoliday,
  parseMbFromText, parseNairaFromText,
  isValidNigerianPhone, isValidUUID, sanitizeInput,
  retry, createLogger,
};
