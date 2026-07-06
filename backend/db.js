const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.sqlite');

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// sql.js exec() does NOT support bind parameters. Use this for parameterized SELECT queries.
function query(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function initDb() {
  const SQL = await initSqlJs();

  // Always load fresh
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_number TEXT UNIQUE NOT NULL,
    event_name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_venue TEXT NOT NULL,
    customer_name TEXT,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    mpesa_code TEXT NOT NULL,
    payment_status TEXT DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE NOT NULL,
    booking_id INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    ticket_type TEXT NOT NULL,
    holder_name TEXT,
    qr_payload TEXT UNIQUE NOT NULL,
    qr_hash TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'unused',
    checked_in_at TEXT,
    checked_in_by TEXT,
    device_used TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    scanned_by TEXT,
    device_info TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  )`);

  // Create default admin if not exists
  const bcrypt = require('bcryptjs');
  const existing = db.exec("SELECT id FROM admins WHERE username = 'admin'");
  if (existing.length === 0 || existing[0].values.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hash, 'superadmin']);
    console.log('Default admin created');
  } else {
    console.log('Admin already exists');
  }

  // Verify
  const verify = db.exec("SELECT id, username FROM admins");
  console.log('Admins after init:', JSON.stringify(verify));

  saveDb();
  console.log('Database saved to:', DB_PATH);
}

module.exports = { getDb, saveDb, initDb, query };
