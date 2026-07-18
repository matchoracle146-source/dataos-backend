// ═══════════════════════════════════════════════════════════════
// DataOS — Database Seed Script
// Run: node scripts/seed.js
// Seeds: bundle catalog, challenges, admin user, test data
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://dataos:dataos_dev_pass@localhost:5432/dataos',
});

const log = (msg) => console.log(`[SEED] ${msg}`);

// ─── MTN Bundle Catalog ───────────────────────────────────────
const mtnBundles = [
  { name: 'Daily 200MB', data_mb: 200, bonus_mb: 0, validity_days: 1, price_ngn: 200, bundle_code: '200MB1D', ussd_code: '*131*1*1#', category: 'daily' },
  { name: 'Daily 500MB', data_mb: 500, bonus_mb: 0, validity_days: 1, price_ngn: 300, bundle_code: '500MB1D', ussd_code: '*131*1*2#', category: 'daily' },
  { name: 'Daily 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 1, price_ngn: 500, bundle_code: '1GB1D', ussd_code: '*131*1*3#', category: 'daily' },
  { name: 'Weekly 2GB', data_mb: 2048, bonus_mb: 0, validity_days: 7, price_ngn: 1000, bundle_code: '2GB7D', ussd_code: '*131*2*1#', category: 'weekly' },
  { name: 'Weekly 5GB', data_mb: 5120, bonus_mb: 0, validity_days: 7, price_ngn: 1500, bundle_code: '5GB7D', ussd_code: '*131*2*2#', category: 'weekly' },
  { name: 'Monthly 10GB', data_mb: 10240, bonus_mb: 0, validity_days: 30, price_ngn: 2000, bundle_code: '10GB30D', ussd_code: '*131*3*1#', category: 'monthly' },
  { name: 'Monthly 20GB', data_mb: 20480, bonus_mb: 5120, validity_days: 30, price_ngn: 3000, bundle_code: '20GB30D', ussd_code: '*131*3*2#', category: 'monthly' },
  { name: 'Monthly 40GB', data_mb: 40960, bonus_mb: 10240, validity_days: 30, price_ngn: 3500, bundle_code: '40GB30D', ussd_code: '*131*3*3#', category: 'monthly' },
  { name: 'Monthly 75GB', data_mb: 76800, bonus_mb: 20480, validity_days: 30, price_ngn: 5000, bundle_code: '75GB30D', ussd_code: '*131*3*4#', category: 'monthly' },
  { name: 'Monthly 120GB', data_mb: 122880, bonus_mb: 30720, validity_days: 30, price_ngn: 8000, bundle_code: '120GB30D', ussd_code: '*131*3*5#', category: 'monthly' },
  { name: 'Night 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 1, price_ngn: 25, bundle_code: 'NIGHT1GB', ussd_code: '*131*4*1#', category: 'night' },
  { name: 'Night 5GB', data_mb: 5120, bonus_mb: 0, validity_days: 7, price_ngn: 100, bundle_code: 'NIGHT5GB', ussd_code: '*131*4*2#', category: 'night' },
  { name: 'Social Bundle 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 7, price_ngn: 300, bundle_code: 'SOC1GB', ussd_code: '*131*5*1#', category: 'social' },
];

const airtelBundles = [
  { name: 'Daily 200MB', data_mb: 200, bonus_mb: 0, validity_days: 1, price_ngn: 200, bundle_code: 'A200MB', ussd_code: '*141*2*1#', category: 'daily' },
  { name: 'Daily 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 1, price_ngn: 500, bundle_code: 'A1GB1D', ussd_code: '*141*2*2#', category: 'daily' },
  { name: 'Weekly 1.5GB', data_mb: 1536, bonus_mb: 0, validity_days: 7, price_ngn: 1000, bundle_code: 'A1G5W', ussd_code: '*141*3*1#', category: 'weekly' },
  { name: 'Weekly 4GB', data_mb: 4096, bonus_mb: 0, validity_days: 7, price_ngn: 1500, bundle_code: 'A4GBW', ussd_code: '*141*3*2#', category: 'weekly' },
  { name: 'Monthly 10GB', data_mb: 10240, bonus_mb: 0, validity_days: 30, price_ngn: 2000, bundle_code: 'A10GM', ussd_code: '*141*4*1#', category: 'monthly' },
  { name: 'Monthly 20GB', data_mb: 20480, bonus_mb: 0, validity_days: 30, price_ngn: 2500, bundle_code: 'A20GM', ussd_code: '*141*4*2#', category: 'monthly' },
  { name: 'Monthly 30GB', data_mb: 30720, bonus_mb: 0, validity_days: 30, price_ngn: 3500, bundle_code: 'A30GM', ussd_code: '*141*4*3#', category: 'monthly' },
  { name: 'Monthly 50GB', data_mb: 51200, bonus_mb: 0, validity_days: 30, price_ngn: 5000, bundle_code: 'A50GM', ussd_code: '*141*4*4#', category: 'monthly' },
  { name: 'Night Owl 3GB', data_mb: 3072, bonus_mb: 0, validity_days: 7, price_ngn: 200, bundle_code: 'ANIGHT', ussd_code: '*141*5*1#', category: 'night', is_promotional: true },
  { name: 'SmartTalk 2GB', data_mb: 2048, bonus_mb: 0, validity_days: 14, price_ngn: 1200, bundle_code: 'ASMART', ussd_code: '*141*6*1#', category: 'social' },
];

const gloBundles = [
  { name: 'Daily 350MB', data_mb: 350, bonus_mb: 0, validity_days: 1, price_ngn: 200, bundle_code: 'G350MB', ussd_code: '*127*54#', category: 'daily' },
  { name: 'Daily 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 1, price_ngn: 500, bundle_code: 'G1GBD', ussd_code: '*127*57#', category: 'daily' },
  { name: 'Weekly 2.9GB', data_mb: 2970, bonus_mb: 0, validity_days: 7, price_ngn: 1000, bundle_code: 'G29W', ussd_code: '*127*52#', category: 'weekly' },
  { name: 'Monthly 7.5GB', data_mb: 7680, bonus_mb: 0, validity_days: 30, price_ngn: 2000, bundle_code: 'G75M', ussd_code: '*127*58#', category: 'monthly' },
  { name: 'Monthly 15GB', data_mb: 15360, bonus_mb: 0, validity_days: 30, price_ngn: 3000, bundle_code: 'G15M', ussd_code: '*127*53#', category: 'monthly' },
  { name: 'Monthly 30GB', data_mb: 30720, bonus_mb: 0, validity_days: 30, price_ngn: 5000, bundle_code: 'G30M', ussd_code: '*127*55#', category: 'monthly' },
  { name: 'Glo Social 3GB', data_mb: 3072, bonus_mb: 0, validity_days: 14, price_ngn: 400, bundle_code: 'GLOSOC', ussd_code: '*127*59#', category: 'social' },
];

const nineMobileBundles = [
  { name: 'EasyCliq 200MB', data_mb: 200, bonus_mb: 0, validity_days: 1, price_ngn: 200, bundle_code: 'E200MB', ussd_code: '*229*2*6#', category: 'daily' },
  { name: 'EasyCliq 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 1, price_ngn: 500, bundle_code: 'E1GBD', ussd_code: '*229*2*7#', category: 'daily' },
  { name: 'EasyCliq 2.5GB', data_mb: 2560, bonus_mb: 0, validity_days: 7, price_ngn: 1000, bundle_code: 'E25W', ussd_code: '*229*2*8#', category: 'weekly' },
  { name: 'EasyCliq 11GB', data_mb: 11264, bonus_mb: 0, validity_days: 30, price_ngn: 2000, bundle_code: 'E11M', ussd_code: '*229*2*10#', category: 'monthly' },
  { name: 'EasyCliq 22GB', data_mb: 22528, bonus_mb: 0, validity_days: 30, price_ngn: 3500, bundle_code: 'E22M', ussd_code: '*229*2*11#', category: 'monthly' },
  { name: 'EasyCliq 40GB', data_mb: 40960, bonus_mb: 0, validity_days: 30, price_ngn: 5000, bundle_code: 'E40M', ussd_code: '*229*2*12#', category: 'monthly' },
  { name: '9mobile Social 1GB', data_mb: 1024, bonus_mb: 0, validity_days: 7, price_ngn: 300, bundle_code: 'E9SOC', ussd_code: '*229*3*1#', category: 'social' },
];

// ─── Seed Functions ───────────────────────────────────────────
async function seedBundles() {
  log('Seeding bundle catalog...');

  const allBundles = [
    ...mtnBundles.map(b => ({ ...b, network: 'MTN' })),
    ...airtelBundles.map(b => ({ ...b, network: 'AIRTEL' })),
    ...gloBundles.map(b => ({ ...b, network: 'GLO' })),
    ...nineMobileBundles.map(b => ({ ...b, network: '9MOBILE' })),
  ];

  for (const bundle of allBundles) {
    await db.query(`
      INSERT INTO bundle_catalog (
        network, name, data_mb, bonus_mb, validity_days, price_ngn,
        bundle_code, ussd_code, category, is_promotional, is_active, country_code
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,'NG')
      ON CONFLICT DO NOTHING
    `, [
      bundle.network, bundle.name, bundle.data_mb, bundle.bonus_mb || 0,
      bundle.validity_days, bundle.price_ngn, bundle.bundle_code,
      bundle.ussd_code, bundle.category, bundle.is_promotional || false,
    ]);
  }

  const { rows } = await db.query('SELECT COUNT(*) FROM bundle_catalog');
  log(`Bundle catalog: ${rows[0].count} bundles seeded`);
}

async function seedChallenges() {
  log('Seeding challenges...');
  const challenges = [
    { key: 'daily_streak_7', title: '7-Day Streak', description: 'Open DataOS every day for 7 days', credits_reward: 150, duration_days: 7, target_count: 7, challenge_type: 'streak' },
    { key: 'daily_streak_30', title: '30-Day Streak', description: 'Open DataOS every day for 30 days', credits_reward: 500, duration_days: 30, target_count: 30, challenge_type: 'streak' },
    { key: 'budget_hero_14', title: 'Budget Hero', description: 'Stay within budget for 14 consecutive days', credits_reward: 300, duration_days: 14, target_count: 14, challenge_type: 'budget' },
    { key: 'budget_hero_30', title: 'Budget Master', description: 'Stay within budget for a full month', credits_reward: 600, duration_days: 30, target_count: 30, challenge_type: 'budget' },
    { key: 'connect_3_sims', title: 'Power User', description: 'Connect 3 SIM cards to DataOS', credits_reward: 200, duration_days: 30, target_count: 3, challenge_type: 'sims' },
    { key: 'refer_1', title: 'First Referral', description: 'Refer your first friend to DataOS', credits_reward: 100, duration_days: 90, target_count: 1, challenge_type: 'referral' },
    { key: 'refer_5', title: 'Referral Champion', description: 'Refer 5 friends who activate DataOS', credits_reward: 2500, duration_days: 90, target_count: 5, challenge_type: 'referral' },
    { key: 'ai_chat_10', title: 'AI Explorer', description: 'Have 10 conversations with DataOS AI', credits_reward: 100, duration_days: 30, target_count: 10, challenge_type: 'ai_usage' },
    { key: 'save_2000', title: 'Money Saver', description: 'Save ₦2,000 in data spending vs last month', credits_reward: 400, duration_days: 30, target_count: 2000, challenge_type: 'savings' },
    { key: 'buy_via_dataos_5', title: 'DataOS Shopper', description: 'Buy 5 data bundles via DataOS', credits_reward: 200, duration_days: 60, target_count: 5, challenge_type: 'purchase' },
    { key: 'community_30', title: 'Community Star', description: 'Submit network reports for 30 days', credits_reward: 200, duration_days: 30, target_count: 30, challenge_type: 'community' },
    { key: 'watch_ads_10', title: 'Ad Watcher', description: 'Watch 10 reward ads this week', credits_reward: 100, duration_days: 7, target_count: 10, challenge_type: 'ad_watch' },
  ];

  for (const c of challenges) {
    await db.query(`
      INSERT INTO challenges (key, title, description, credits_reward, duration_days, target_count, challenge_type, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
      ON CONFLICT (key) DO UPDATE SET
        title=$2, description=$3, credits_reward=$4, duration_days=$5,
        target_count=$6, challenge_type=$7
    `, [c.key, c.title, c.description, c.credits_reward, c.duration_days, c.target_count, c.challenge_type]);
  }
  log(`Challenges seeded: ${challenges.length}`);
}

async function seedTestUsers() {
  if (process.env.NODE_ENV === 'production') {
    log('Skipping test user seed in production');
    return;
  }

  log('Seeding test users...');

  const testUsers = [
    { phone: '+2348030000001', display_name: 'Tunde Adekunle', kyc_level: 2 },
    { phone: '+2348160000002', display_name: 'Ngozi Okonkwo', kyc_level: 1 },
    { phone: '+2348050000003', display_name: 'Emeka Chukwu', kyc_level: 3 },
  ];

  for (const user of testUsers) {
    const { rows } = await db.query(`
      INSERT INTO users (phone, phone_hash, kyc_level)
      VALUES ($1, MD5($1), $2)
      ON CONFLICT (phone) DO UPDATE SET kyc_level = EXCLUDED.kyc_level
      RETURNING id
    `, [user.phone, user.kyc_level]);

    const userId = rows[0].id;

    await db.query(`
      INSERT INTO user_profiles (user_id, display_name, language, onboarding_done)
      VALUES ($1, $2, 'en', TRUE)
      ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name
    `, [userId, user.display_name]);

    // Add test SIM cards
    const sims = [
      { network: 'MTN', msisdn: user.phone, nickname: 'Primary', is_primary: true, monthly_budget: 8000 },
      { network: 'AIRTEL', msisdn: user.phone.replace('+23480', '+23481'), nickname: 'Secondary', is_primary: false, monthly_budget: 4000 },
    ];

    for (const sim of sims) {
      await db.query(`
        INSERT INTO sim_cards (user_id, msisdn, msisdn_hash, network, nickname, is_primary, monthly_budget)
        VALUES ($1, $2, MD5($2), $3, $4, $5, $6)
        ON CONFLICT (user_id, msisdn_hash) DO NOTHING
      `, [userId, sim.msisdn, sim.network, sim.nickname, sim.is_primary, sim.monthly_budget]);
    }

    // Add initial score
    await db.query(`
      INSERT INTO connectivity_scores (user_id, overall_score, budget_score, efficiency_score, reliability_score, access_score, tier)
      VALUES ($1, 650, 75, 68, 85, 70, 'GOOD')
      ON CONFLICT DO NOTHING
    `, [userId]);

    // Add test wallet credits
    await db.query(`
      UPDATE wallets SET credits_balance = 500, total_earned = 500 WHERE user_id = $1
    `, [userId]);

    // Add test recharge history
    const networks = ['MTN', 'AIRTEL'];
    for (let i = 0; i < 6; i++) {
      const daysAgo = i * 5;
      const network = networks[i % 2];
      await db.query(`
        INSERT INTO recharges (user_id, sim_id, amount_ngn, data_mb, payment_method, status, network, initiated_at, completed_at)
        SELECT $1, sc.id, $2, $3, 'wallet_credits', 'completed', $4, NOW() - INTERVAL '${daysAgo} days', NOW() - INTERVAL '${daysAgo} days'
        FROM sim_cards sc WHERE sc.user_id = $1 AND sc.network = $4
        LIMIT 1
        ON CONFLICT DO NOTHING
      `, [userId, [2000, 3500, 1000, 2500, 1500, 3000][i], [2048, 3584, 1024, 2560, 1536, 3072][i], network]);
    }

    // Add data twin
    await db.query(`
      INSERT INTO user_data_twins (
        user_id, daily_avg_mb, weekly_avg_mb, monthly_avg_mb,
        avg_recharge_interval_days, recharge_trigger_mb, preferred_recharge_hour,
        avg_recharge_amount_ngn, preferred_network, churn_risk_score,
        bundle_acceptance_rate, savings_sensitivity, model_version, data_points
      ) VALUES ($1, 1200, 8400, 36000, 8.5, 200, 20, 2200, 'MTN', 0.12, 0.65, 'medium', '1.0', 45)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    log(`Test user seeded: ${user.display_name} (${userId})`);
  }
}

async function seedConsentTemplates() {
  log('Seeding consent types...');
  // These are just documentation — actual records created per user on signup
  const consentTypes = [
    'community_intelligence',
    'marketing_communications',
    'ml_training_data',
    'analytics_tracking',
    'third_party_sharing',
  ];
  log(`Consent types defined: ${consentTypes.join(', ')}`);
}

// ─── Main ─────────────────────────────────────────────────────
async function seed() {
  log('Starting DataOS database seed...');
  log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  try {
    await db.query('BEGIN');

    await seedBundles();
    await seedChallenges();
    await seedTestUsers();
    await seedConsentTemplates();

    await db.query('COMMIT');
    log('✅ Database seeded successfully!');

    // Summary
    const tables = ['users', 'sim_cards', 'bundle_catalog', 'challenges', 'wallets'];
    for (const table of tables) {
      const { rows } = await db.query(`SELECT COUNT(*) FROM ${table}`);
      log(`  ${table}: ${rows[0].count} rows`);
    }

  } catch (err) {
    await db.query('ROLLBACK');
    console.error('[SEED ERROR]', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

seed();
