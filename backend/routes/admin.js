const express = require('express');
const router = express.Router();
const { getDb, saveDb, query } = require('../db');
const { adminAuth } = require('../middleware/auth');
const { generateQRPayload } = require('./payments');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Helper: generate unique ticket number
function generateTicketNumber() {
  return 'TKT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

// Helper: generate secure random secret for QR
function generateQRSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// GET admin login
router.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

router.post('/admin/login', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const db = await getDb();
    const admins = query(`SELECT * FROM admins WHERE username = ?`, [req.body.username]);
    if (admins.length === 0) {
      return res.render('admin_login', { error: 'Invalid credentials.' });
    }
    const admin = admins[0];

    const match = bcrypt.compareSync(req.body.password, admin.password_hash);
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

// GET admin logout
router.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// GET admin dashboard
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

// GET admin payments page
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

// POST approve payment
router.post('/admin/api/payment/:id/approve', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const bookingId = req.params.id;

    // Get booking
    const bResult = query(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (bResult.length === 0) {
      return res.json({ success: false, message: 'Booking not found.' });
    }
    const booking = bResult[0];

    if (booking.payment_status === 'paid') {
      return res.json({ success: false, message: 'Payment already approved.' });
    }

    // Mark booking as paid
    db.run(`UPDATE bookings SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?`, [bookingId]);

    // Generate tickets
    const ticketTypes = ['General Access', 'Priority Access', 'Duo', 'Squad Pass (X5)'];
    // Determine ticket type and qty from booking (stored as JSON in a metadata field, or use defaults)
    const ticketType = 'General Access';
    const qty = 1;

    const tickets = [];
    for (let i = 0; i < qty; i++) {
      const ticketNumber = generateTicketNumber();
      const qrSecret = generateQRSecret();
      const qrPayload = generateQRPayload(ticketNumber, qrSecret);
      const qrHash = crypto.createHash('sha256').update(qrPayload).digest('hex');

      db.run(`INSERT INTO tickets (ticket_number, booking_id, event_name, ticket_type, holder_name, qr_payload, qr_hash, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'unused')`, [ticketNumber, bookingId, booking.event_name, ticketType, booking.customer_name, qrPayload, qrHash]);
      tickets.push({ ticketNumber, qrPayload });
    }

    saveDb();

    res.json({
      success: true,
      message: 'Payment approved and tickets generated.',
      tickets: tickets.map(t => t.ticketNumber)
    });
  } catch (err) {
    console.error('Approve error:', err);
    res.json({ success: false, message: 'Error approving payment.' });
  }
});

// POST reject payment
router.post('/admin/api/payment/:id/reject', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const bookingId = req.params.id;
    const reason = req.body.reason || 'Payment verification failed.';

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

// GET admin tickets page
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

// POST cancel ticket
router.post('/admin/api/ticket/:id/cancel', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;

    db.run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, [ticketId]);
    saveDb();

    res.json({ success: true, message: 'Ticket cancelled.' });
  } catch (err) {
    res.json({ success: false, message: 'Error cancelling ticket.' });
  }
});

// POST reissue ticket
router.post('/admin/api/ticket/:id/reissue', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;

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

// GET admin scanner page
router.get('/admin/scanner', adminAuth, (req, res) => {
  res.render('admin_scanner', { admin: req.admin });
});

// POST verify QR code (scan endpoint)
router.post('/admin/api/scan', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const { qr_data } = req.body;
    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    if (!qr_data) {
      return res.json({ success: false, message: 'No QR data provided.' });
    }

    // Find ticket by QR payload
    const result = query(`SELECT t.*, b.booking_number, b.phone, b.event_name FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.qr_payload = ?`, [qr_data]);

    if (result.length === 0) {
      // Log invalid scan
      db.run(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (0, 'invalid', ?, ?, ?)`, [scannedBy, deviceInfo, 'Invalid QR code scanned']);
      saveDb();
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    const ticket = result[0];

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

    // Valid ticket - ready for check-in
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

// POST check-in ticket
router.post('/admin/api/ticket/:id/checkin', express.json(), adminAuth, async (req, res) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;
    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    const result = query(`SELECT * FROM tickets WHERE id = ?`, [ticketId]);
    if (result.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
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
