// ─── Shared Types ────────────────────────────────────────────────────────────

// Network identifiers
const NETWORKS = {
  MTN: 'MTN',
  AIRTEL: 'AIRTEL',
  GLO: 'GLO',
  NINE_MOBILE: '9MOBILE',
};

// KYC levels
const KYC_LEVELS = { NONE: 0, PHONE: 1, NIN: 2, BVN: 3 };

// Score tiers
const SCORE_TIERS = {
  NEEDS_WORK: { min: 0, max: 499, label: 'NEEDS WORK', creditLimit: 0 },
  FAIR:       { min: 500, max: 599, label: 'FAIR', creditLimit: 0 },
  GOOD:       { min: 600, max: 699, label: 'GOOD', creditLimit: 200 },
  GREAT:      { min: 700, max: 799, label: 'GREAT', creditLimit: 500 },
  EXCELLENT:  { min: 800, max: 850, label: 'EXCELLENT', creditLimit: 1000 },
};

const getScoreTier = (score) =>
  Object.values(SCORE_TIERS).find(t => score >= t.min && score <= t.max) || SCORE_TIERS.NEEDS_WORK;

// Wallet constants
const WALLET = {
  CREDIT_TO_NGN: 0.5,        // 1 Credit = ₦0.50
  MIN_REDEEM: 100,            // Minimum credits to redeem
  MAX_REDEEM_PER_TX: 2000,   // Max credits per transaction
  BORROW_INTEREST_7D: 0.05,  // 5% fee within 7 days
  BORROW_INTEREST_14D: 0.10, // 10% fee 7-14 days
};

// Bundle categories
const BUNDLE_CATEGORIES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  SOCIAL: 'social',
  NIGHT: 'night',
  DATA_ONLY: 'data_only',
};

// Risk levels
const RISK_LEVELS = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

// Event types (Kafka topics)
const EVENTS = {
  USER_REGISTERED: 'user.registered',
  SIM_ADDED: 'sim.added',
  SIM_REMOVED: 'sim.removed',
  BALANCE_UPDATED: 'balance.updated',
  BALANCE_LOW: 'balance.low',
  BUNDLE_PURCHASED: 'bundle.purchased',
  PURCHASE_FAILED: 'purchase.failed',
  BUDGET_THRESHOLD: 'budget.threshold_reached',
  DATA_EXHAUSTION_PREDICTED: 'data.exhaustion_predicted',
  DATA_EXPIRY_WARNING: 'data.expiry_warning',
  SCORE_RECALCULATED: 'score.recalculated',
  CREDIT_EARNED: 'credit.earned',
  CREDIT_BORROWED: 'credit.borrowed',
  CREDIT_REPAID: 'credit.repaid',
  TWIN_UPDATE_REQUIRED: 'twin.recalculate_required',
  AI_INSIGHT_GENERATED: 'ai.insight_generated',
  REFERRAL_ACTIVATED: 'referral.activated',
  ACHIEVEMENT_EARNED: 'achievement.earned',
};

// HTTP Status codes
const HTTP = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

// Currency config
const CURRENCIES = {
  NG: { code: 'NGN', symbol: '₦', minor: 100 },
  GH: { code: 'GHS', symbol: '₵', minor: 100 },
  KE: { code: 'KES', symbol: 'KSh', minor: 100 },
};

module.exports = {
  NETWORKS,
  KYC_LEVELS,
  SCORE_TIERS,
  getScoreTier,
  WALLET,
  BUNDLE_CATEGORIES,
  RISK_LEVELS,
  EVENTS,
  HTTP,
  CURRENCIES,
};
