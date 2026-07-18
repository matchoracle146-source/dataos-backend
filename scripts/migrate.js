// ═══════════════════════════════════════════════════════════════
// DataOS — Migration Runner
// Run: node scripts/migrate.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://dataos:dataos_dev_pass@localhost:5432/dataos',
});

const log = (msg) => console.log(`[MIGRATE] ${msg}`);

async function migrate() {
  log('Starting migrations...');

  // Create migrations tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '../database/migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    const { rows } = await db.query(
      'SELECT id FROM schema_migrations WHERE filename = $1', [file]
    );

    if (rows.length) {
      log(`Skipping (already applied): ${file}`);
      skipped++;
      continue;
    }

    log(`Applying: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await db.query('COMMIT');
      log(`✅ Applied: ${file}`);
      applied++;
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`[MIGRATE ERROR] Failed on ${file}:`, err.message);
      process.exit(1);
    }
  }

  log(`Done. Applied: ${applied}, Skipped: ${skipped}`);
  await db.end();
}

migrate();
