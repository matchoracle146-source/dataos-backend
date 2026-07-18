// ─── Database Connection ──────────────────────────────────────────────────────
const { createDbPool } = require('../../../shared/utils/db-client');

const pool = createDbPool();

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = db;
