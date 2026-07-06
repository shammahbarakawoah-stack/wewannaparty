const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set. PostgreSQL connection string required.');
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

async function query(sql, params) {
  const client = getPool();
  const result = await client.query(sql, params);
  return result.rows;
}

async function initDb() {
  const client = getPool();

  await client.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      booking_number TEXT UNIQUE NOT NULL,
      event_name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_venue TEXT NOT NULL,
      customer_name TEXT,
      phone TEXT NOT NULL,
      email TEXT,
      amount DOUBLE PRECISION NOT NULL,
      mpesa_code TEXT NOT NULL,
      ticket_type TEXT DEFAULT 'General Access',
      qty INTEGER DEFAULT 1,
      payment_status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_number TEXT UNIQUE NOT NULL,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      event_name TEXT NOT NULL,
      ticket_type TEXT NOT NULL,
      holder_name TEXT,
      qr_payload TEXT UNIQUE NOT NULL,
      qr_hash TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'unused',
      checked_in_at TIMESTAMP,
      checked_in_by TEXT,
      device_used TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      scanned_by TEXT,
      device_info TEXT,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migrate existing databases: add columns if missing
  try {
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ticket_type TEXT DEFAULT 'General Access'`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS qty INTEGER DEFAULT 1`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS email TEXT`);
  } catch (e) {
    console.error('[DB] Migration error:', e.message);
  }

  // Create or update default admin
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('Alwayswinning254', 10);
  await client.query(
    `INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'superadmin')
     ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
    ['shammah', hash]
  );
}

module.exports = { getPool, query, initDb };
