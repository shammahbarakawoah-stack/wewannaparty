const express = require('express');
const router = express.Router();
const { getDb, saveDb, query } = require('../db');
const { adminAuth } = require('../middleware/auth');
const { generateQRPayload, verifyQRPayload } = require('./payments');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function generateTicketNumber() {
  return 'TKT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function generateQRSecret() {
  return crypto.randomBytes(32).toString('hex');
}

router.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !sanitize(username)) {
      return res.render('admin_login', { error: 'Username is required.' });
    }
    if (!password || !sanitize(password)) {
      return res.render('admin_login', { error: 'Password is required.' });
    }

    const bcrypt = require('bcryptjs');
    const db = await getDb();
    const admins = query(`SELECT * FROM admins WHERE username = ?`, [sanitize(username)]);
    if (admins.length === 0) {
      return res.render('admin_login', { error: 'Invalid credentials.' });
    }
    const admin = admins[0];

    const match = bcrypt.compareSync(password, admin.password_hash);
    if (!match) {
      return res.render('admin_login', { error: 'Invalid credentials.' });
    }

    const { generateToken } = require('../middleware/auth');
    req.session.adminToken = generateToken({ id: admin.id, username: admin.username, role: admin.role });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('admin_login', { error: 'An error occurred.' });
  }
});

router.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

router.get('/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const pending = query(`SELECT COUNT(*) as cnt FROM bookings WHERE payment_status = 'pending'`);
    const approved = query(`SELECT COUNT(*) as cnt FROM bookings WHERE payment_status = 'paid'`);
    const totalTickets = query(`SELECT COUNT(*) as cnt FROM tickets`);
    const totalRevenue = query(`SELECT COALESCE(SUM(amount), 0) as total FROM bookings WHERE payment_status = 'paid'`);

    const pCount = pending[0]?.cnt || 0;
    const aCount = approved[0]?.cnt || 0;
    const tCount = totalTickets[0]?.cnt || 0;
    const revenue = totalRevenue[0]?.total || 0;

    res.render('admin_dashboard', {
      admin: req.admin,
      pendingCount: pCount,
      approvedCount: aCount,
      totalTickets: tCount,
      totalRevenue: revenue
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.send('Error loading dashboard.');
  }
});

router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const bookings = query(`SELECT * FROM bookings ORDER BY created_at DESC`);

    res.render('admin_payments', { admin: req.admin, bookings, filter: req.query.status || 'all' });
  } catch (err) {
    console.error('Payments error:', err);
    res.send('Error loading payments.');
  }
});

router.post('/admin/api/payment/:id/approve', adminAuth, async (req, res) => {
  console.log('[APPROVE] POST /admin/api/payment/:id/approve - booking ID:', req.params.id);
  try {
    const db = await getDb();
    const bookingId = parseInt(req.params.id, 10);

    if (!bookingId || isNaN(bookingId)) {
      console.log('[APPROVE] Invalid booking ID');
      return res.json({ success: false, message: 'Invalid booking ID.' });
    }

    const bResult = query(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (bResult.length === 0) {
      console.log('[APPROVE] Booking not found:', bookingId);
      return res.json({ success: false, message: 'Booking not found.' });
    }
    const booking = bResult[0];
    console.log('[APPROVE] Found booking:', booking.booking_number, 'status:', booking.payment_status, 'ticket_type:', booking.ticket_type, 'qty:', booking.qty);

    if (booking.payment_status === 'paid') {
      console.log('[APPROVE] Payment already approved');
      return res.json({ success: false, message: 'Payment already approved.' });
    }

    const existingTickets = query(`SELECT id FROM tickets WHERE booking_id = ?`, [bookingId]);
    if (existingTickets.length > 0) {
      console.log('[APPROVE] Tickets already exist for this booking');
      return res.json({ success: false, message: 'Tickets have already been generated for this booking.' });
    }

    console.log('[APPROVE] Updating payment status to paid...');
    db.run(`UPDATE bookings SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?`, [bookingId]);

    const ticketType = booking.ticket_type || 'General Access';
    const qty = booking.qty || 1;
    console.log('[APPROVE] Generating', qty, 'ticket(s) of type:', ticketType);

    const tickets = [];
    for (let i = 0; i < qty; i++) {
      const ticketNumber = generateTicketNumber();
      const qrSecret = generateQRSecret();
      const qrPayload = generateQRPayload(ticketNumber, qrSecret);
      const qrHash = crypto.createHash('sha256').update(qrPayload).digest('hex');

      console.log('[APPROVE] Inserting ticket', i + 1, '- number:', ticketNumber);
      db.run(`INSERT INTO tickets (ticket_number, booking_id, event_name, ticket_type, holder_name, qr_payload, qr_hash, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'unused')`, [ticketNumber, bookingId, booking.event_name, ticketType, booking.customer_name, qrPayload, qrHash]);
      tickets.push({ ticketNumber, qrPayload });
    }

    console.log('[APPROVE] Persisting database...');
    saveDb();
    console.log('[APPROVE] Approval complete, tickets:', tickets.map(t => t.ticketNumber));

    res.json({
      success: true,
      message: 'Payment approved and tickets generated.',
      tickets: tickets.map(t => t.ticketNumber)
    });
  } catch (err) {
    console.error('[APPROVE] ERROR:', err.message, err.stack);
    res.json({ success: false, message: 'Error approving payment.' });
  }
});

router.post('/admin/api/payment/:id/reject', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const bookingId = parseInt(req.params.id, 10);

    if (!bookingId || isNaN(bookingId)) {
      return res.json({ success: false, message: 'Invalid booking ID.' });
    }

    const reason = sanitize(req.body.reason || 'Payment verification failed.');

    const bResult = query(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (bResult.length === 0) {
      return res.json({ success: false, message: 'Booking not found.' });
    }

    db.run(`UPDATE bookings SET payment_status = 'rejected', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?`, [reason, bookingId]);
    saveDb();

    res.json({ success: true, message: 'Payment rejected.' });
  } catch (err) {
    console.error('Reject error:', err);
    res.json({ success: false, message: 'Error rejecting payment.' });
  }
});

router.get('/admin/tickets', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const search = req.query.search || '';

    let sqlStr = `SELECT t.*, b.booking_number, b.phone, b.customer_name as b_customer
      FROM tickets t JOIN bookings b ON t.booking_id = b.id`;
    let params = [];

    if (search) {
      sqlStr += ` WHERE t.ticket_number LIKE ? OR b.booking_number LIKE ? OR t.qr_payload LIKE ? OR b.phone LIKE ? OR b.customer_name LIKE ?`;
      const s = `%${search}%`;
      params = [s, s, s, s, s];
    }
    sqlStr += ` ORDER BY t.created_at DESC`;

    const tickets = query(sqlStr, params);

    res.render('admin_tickets', { admin: req.admin, tickets, search });
  } catch (err) {
    console.error('Tickets error:', err);
    res.send('Error loading tickets.');
  }
});

router.post('/admin/api/ticket/:id/cancel', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const existing = query(`SELECT id FROM tickets WHERE id = ?`, [ticketId]);
    if (existing.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }

    db.run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, [ticketId]);
    saveDb();

    res.json({ success: true, message: 'Ticket cancelled.' });
  } catch (err) {
    res.json({ success: false, message: 'Error cancelling ticket.' });
  }
});

router.post('/admin/api/ticket/:id/reissue', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const result = query(`SELECT * FROM tickets WHERE id = ?`, [ticketId]);
    if (result.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }

    const ticket = result[0];

    const newTicketNumber = generateTicketNumber();
    const newSecret = generateQRSecret();
    const newPayload = generateQRPayload(newTicketNumber, newSecret);
    const newHash = crypto.createHash('sha256').update(newPayload).digest('hex');

    db.run(`UPDATE tickets SET ticket_number = ?, qr_payload = ?, qr_hash = ?, status = 'unused', checked_in_at = NULL, checked_in_by = NULL, device_used = NULL WHERE id = ?`, [newTicketNumber, newPayload, newHash, ticketId]);
    saveDb();

    res.json({ success: true, message: 'Ticket reissued.', ticketNumber: newTicketNumber });
  } catch (err) {
    res.json({ success: false, message: 'Error reissuing ticket.' });
  }
});

router.get('/admin/scanner', adminAuth, (req, res) => {
  res.render('admin_scanner', { admin: req.admin });
});

router.post('/admin/api/scan', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const { qr_data } = req.body;
    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    if (!qr_data || !sanitize(qr_data)) {
      return res.json({ success: false, message: 'No QR data provided.' });
    }

    const parsedQR = verifyQRPayload(qr_data);
    if (!parsedQR) {
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (0, 'invalid', ?, ?, ?)`, [scannedBy, deviceInfo, 'Invalid QR code format scanned']);
      saveDb();
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    const result = query(`SELECT t.*, b.booking_number, b.phone, b.event_name FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.qr_payload = ?`, [qr_data]);

    if (result.length === 0) {
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (0, 'invalid', ?, ?, ?)`, [scannedBy, deviceInfo, 'Invalid QR code scanned']);
      saveDb();
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    const ticket = result[0];

    if (ticket.ticket_number !== parsedQR.ticketNumber) {
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (?, 'invalid', ?, ?, ?)`, [ticket.id, scannedBy, deviceInfo, 'QR payload ticket number mismatch']);
      saveDb();
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    if (ticket.status === 'cancelled') {
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (?, 'cancelled', ?, ?, ?)`, [ticket.id, scannedBy, deviceInfo, 'Attempted scan of cancelled ticket']);
      saveDb();
      return res.json({ success: false, message: 'Cancelled Ticket', code: 'cancelled' });
    }

    if (ticket.status === 'used') {
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (?, 're-scan', ?, ?, ?)`, [ticket.id, scannedBy, deviceInfo, `Already used - first check-in: ${ticket.checked_in_at}`]);
      saveDb();
      return res.json({
        success: false,
        message: 'This ticket has already been used.',
        code: 'used',
        firstCheckedIn: ticket.checked_in_at,
        ticket: {
          ticketNumber: ticket.ticket_number,
          eventName: ticket.event_name,
          holderName: ticket.holder_name,
          ticketType: ticket.ticket_type,
          bookingNumber: ticket.booking_number
        }
      });
    }

    res.json({
      success: true,
      message: 'Valid Ticket',
      code: 'valid',
      ticket: {
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        eventName: ticket.event_name,
        holderName: ticket.holder_name,
        ticketType: ticket.ticket_type,
        bookingNumber: ticket.booking_number,
        status: ticket.status
      }
    });
  } catch (err) {
    console.error('Scan error:', err);
    res.json({ success: false, message: 'Error scanning ticket.' });
  }
});

router.post('/admin/api/ticket/:id/checkin', adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    const result = query(`SELECT t.*, b.payment_status FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.id = ?`, [ticketId]);
    if (result.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }

    const ticket = result[0];

    if (ticket.payment_status !== 'paid') {
      return res.json({ success: false, message: 'Associated booking payment is not approved.' });
    }

    if (ticket.status !== 'unused') {
      return res.json({ success: false, message: 'Ticket has already been used or cancelled.' });
    }

    db.run(`UPDATE tickets SET status = 'used', checked_in_at = datetime('now'), checked_in_by = ?, device_used = ? WHERE id = ? AND status = 'unused'`, [scannedBy, deviceInfo, ticketId]);

    db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (?, 'check-in', ?, ?, 'Successful check-in')`, [ticketId, scannedBy, deviceInfo]);
    saveDb();

    res.json({ success: true, message: 'Check-in successful.' });
  } catch (err) {
    console.error('Check-in error:', err);
    res.json({ success: false, message: 'Error checking in ticket.' });
  }
});

module.exports = router;
