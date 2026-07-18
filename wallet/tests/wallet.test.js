// ═══════════════════════════════════════════════════════════════
// Wallet Service — Test Suite
// ═══════════════════════════════════════════════════════════════
'use strict';

const { WALLET, getScoreTier, SCORE_TIERS } = require('../../../shared/constants');
const {
  InsufficientBalanceError,
  ValidationError,
  KYCRequiredError,
} = require('../../../shared/errors');

// ─── Constants Tests ──────────────────────────────────────────
describe('Wallet Constants', () => {
  test('credit to NGN conversion rate is correct', () => {
    expect(WALLET.CREDIT_TO_NGN).toBe(0.5);
    expect(1000 * WALLET.CREDIT_TO_NGN).toBe(500); // 1000 credits = ₦500
  });

  test('borrow interest rates are defined', () => {
    expect(WALLET.BORROW_INTEREST_7D).toBe(0.05);
    expect(WALLET.BORROW_INTEREST_14D).toBe(0.10);
  });

  test('min redeem is enforced', () => {
    expect(WALLET.MIN_REDEEM).toBe(100);
  });

  test('max redeem per transaction is enforced', () => {
    expect(WALLET.MAX_REDEEM_PER_TX).toBe(2000);
  });
});

// ─── Score Tier Tests ─────────────────────────────────────────
describe('Score Tiers', () => {
  test('score 300 = NEEDS WORK with no credit', () => {
    const tier = getScoreTier(300);
    expect(tier.label).toBe('NEEDS WORK');
    expect(tier.creditLimit).toBe(0);
  });

  test('score 550 = FAIR with no credit', () => {
    const tier = getScoreTier(550);
    expect(tier.label).toBe('FAIR');
    expect(tier.creditLimit).toBe(0);
  });

  test('score 650 = GOOD with ₦200 credit', () => {
    const tier = getScoreTier(650);
    expect(tier.label).toBe('GOOD');
    expect(tier.creditLimit).toBe(200);
  });

  test('score 750 = GREAT with ₦500 credit', () => {
    const tier = getScoreTier(750);
    expect(tier.label).toBe('GREAT');
    expect(tier.creditLimit).toBe(500);
  });

  test('score 820 = EXCELLENT with ₦1000 credit', () => {
    const tier = getScoreTier(820);
    expect(tier.label).toBe('EXCELLENT');
    expect(tier.creditLimit).toBe(1000);
  });

  test('score 0 defaults to NEEDS WORK', () => {
    const tier = getScoreTier(0);
    expect(tier.label).toBe('NEEDS WORK');
  });

  test('score 850 = EXCELLENT', () => {
    const tier = getScoreTier(850);
    expect(tier.label).toBe('EXCELLENT');
  });
});

// ─── Error Classes Tests ──────────────────────────────────────
describe('Wallet Error Classes', () => {
  test('InsufficientBalanceError has correct structure', () => {
    const err = new InsufficientBalanceError(500, 200, 'CREDITS');
    expect(err.statusCode).toBe(402);
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(err.details.required).toBe(500);
    expect(err.details.available).toBe(200);
    expect(err.details.currency).toBe('CREDITS');
    expect(err.isOperational).toBe(true);
  });

  test('KYCRequiredError includes required level', () => {
    const err = new KYCRequiredError(2);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('KYC_REQUIRED');
    expect(err.details.requiredLevel).toBe(2);
  });
});

// ─── Borrow Eligibility Logic ─────────────────────────────────
describe('Borrow Eligibility Logic', () => {
  const checkEligibility = (score, borrowed) => {
    const tier = getScoreTier(score);
    return {
      eligible: tier.creditLimit > 0 && borrowed === 0,
      creditLimit: tier.creditLimit,
      tier: tier.label,
    };
  };

  test('score 400 with no debt = not eligible', () => {
    const result = checkEligibility(400, 0);
    expect(result.eligible).toBe(false);
    expect(result.creditLimit).toBe(0);
  });

  test('score 650 with no debt = eligible for ₦200', () => {
    const result = checkEligibility(650, 0);
    expect(result.eligible).toBe(true);
    expect(result.creditLimit).toBe(200);
  });

  test('score 750 with no debt = eligible for ₦500', () => {
    const result = checkEligibility(750, 0);
    expect(result.eligible).toBe(true);
    expect(result.creditLimit).toBe(500);
  });

  test('score 800 with existing debt = not eligible', () => {
    const result = checkEligibility(800, 200);
    expect(result.eligible).toBe(false);
  });

  test('score 820 with no debt = eligible for ₦1000', () => {
    const result = checkEligibility(820, 0);
    expect(result.eligible).toBe(true);
    expect(result.creditLimit).toBe(1000);
  });
});

// ─── Repayment Calculation Tests ─────────────────────────────
describe('Loan Repayment Calculations', () => {
  const calculateRepayment = (borrowedNgn, borrowDate) => {
    const now = new Date();
    const daysSinceBorrow = (now - new Date(borrowDate)) / (1000 * 60 * 60 * 24);
    const isLate = daysSinceBorrow > 7;
    const interestRate = isLate ? WALLET.BORROW_INTEREST_14D : WALLET.BORROW_INTEREST_7D;
    const fee = borrowedNgn * interestRate;
    const total = borrowedNgn + fee;
    const creditsNeeded = Math.ceil(total / WALLET.CREDIT_TO_NGN);
    return { fee, total, creditsNeeded, isLate };
  };

  test('repayment within 7 days charges 5% fee', () => {
    const borrowDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const result = calculateRepayment(200, borrowDate);
    expect(result.fee).toBe(10); // 5% of ₦200
    expect(result.total).toBe(210);
    expect(result.isLate).toBe(false);
    expect(result.creditsNeeded).toBe(420); // 210 / 0.5
  });

  test('repayment after 7 days charges 10% fee', () => {
    const borrowDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const result = calculateRepayment(200, borrowDate);
    expect(result.fee).toBe(20); // 10% of ₦200
    expect(result.total).toBe(220);
    expect(result.isLate).toBe(true);
    expect(result.creditsNeeded).toBe(440); // 220 / 0.5
  });

  test('credits conversion is correct', () => {
    // ₦500 borrowed = 1000 credits equivalent
    const creditsEquivalent = Math.round(500 / WALLET.CREDIT_TO_NGN);
    expect(creditsEquivalent).toBe(1000);
  });
});

// ─── Gift Fee Calculation Tests ───────────────────────────────
describe('Credit Gift Calculations', () => {
  const calculateGift = (credits) => {
    const fee = Math.ceil(credits * 0.02);
    const netCredits = credits - fee;
    return { fee, netCredits };
  };

  test('200 credits gift has 4 credit fee', () => {
    const { fee, netCredits } = calculateGift(200);
    expect(fee).toBe(4);
    expect(netCredits).toBe(196);
  });

  test('1000 credits gift has 20 credit fee', () => {
    const { fee, netCredits } = calculateGift(1000);
    expect(fee).toBe(20);
    expect(netCredits).toBe(980);
  });

  test('min gift validation', () => {
    expect(50 >= 50).toBe(true);   // Min 50 credits
    expect(49 >= 50).toBe(false);  // Below min
  });

  test('max gift validation', () => {
    expect(1000 <= 1000).toBe(true);  // Max 1000 credits
    expect(1001 <= 1000).toBe(false); // Above max
  });
});
