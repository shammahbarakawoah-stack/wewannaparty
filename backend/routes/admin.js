const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { adminAuth } = require('../middleware/auth');
const { generateQRPayload, verifyQRPayload } = require('./payments');
const { sendTicketEmail } = require('../email');
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
    const admins = await query(`SELECT * FROM admins WHERE username = $1`, [sanitize(username)]);
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
    console.error('[ADMIN] Login error:', err.message, err.stack);
    res.render('admin_login', { error: 'An error occurred.' });
  }
});

router.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

router.get('/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const pending = await query(`SELECT COUNT(*)::int as cnt FROM bookings WHERE payment_status = 'pending'`);
    const approved = await query(`SELECT COUNT(*)::int as cnt FROM bookings WHERE payment_status = 'paid'`);
    const totalTickets = await query(`SELECT COUNT(*)::int as cnt FROM tickets`);
    const totalRevenue = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM bookings WHERE payment_status = 'paid'`);

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
    console.error('[ADMIN] Dashboard error:', err.message, err.stack);
    res.send('Error loading dashboard.');
  }
});

router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const bookings = await query(`SELECT * FROM bookings ORDER BY created_at DESC`);

    res.render('admin_payments', { admin: req.admin, bookings, filter: req.query.status || 'all' });
  } catch (err) {
    console.error('[ADMIN] Payments error:', err.message, err.stack);
    res.send('Error loading payments.');
  }
});

router.post('/admin/api/payment/:id/approve', adminAuth, async (req, res) => {
  console.log('[APPROVE] POST /admin/api/payment/:id/approve - booking ID:', req.params.id);
  try {
    const bookingId = parseInt(req.params.id, 10);

    if (!bookingId || isNaN(bookingId)) {
      console.log('[APPROVE] Invalid booking ID');
      return res.json({ success: false, message: 'Invalid booking ID.' });
    }

    const bResult = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
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

    const existingTickets = await query(`SELECT id FROM tickets WHERE booking_id = $1`, [bookingId]);
    if (existingTickets.length > 0) {
      console.log('[APPROVE] Tickets already exist for this booking');
      return res.json({ success: false, message: 'Tickets have already been generated for this booking.' });
    }

    console.log('[APPROVE] Updating payment status to paid...');
    await query(`UPDATE bookings SET payment_status = 'paid', updated_at = NOW() WHERE id = $1`, [bookingId]);

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
      await query(`INSERT INTO tickets (ticket_number, booking_id, event_name, ticket_type, holder_name, qr_payload, qr_hash, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'unused')`, [ticketNumber, bookingId, booking.event_name, ticketType, booking.customer_name, qrPayload, qrHash]);
      tickets.push({ ticketNumber, qrPayload });
    }

    console.log('[APPROVE] Approval complete, tickets:', tickets.map(t => t.ticketNumber));

    // Send email with tickets (non-blocking)
    sendTicketEmail(booking, tickets).then(sent => {
      console.log('[APPROVE] Email sent:', sent);
    });

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
    const bookingId = parseInt(req.params.id, 10);

    if (!bookingId || isNaN(bookingId)) {
      return res.json({ success: false, message: 'Invalid booking ID.' });
    }

    const reason = sanitize(req.body.reason || 'Payment verification failed.');

    const bResult = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    if (bResult.length === 0) {
      return res.json({ success: false, message: 'Booking not found.' });
    }

    await query(`UPDATE bookings SET payment_status = 'rejected', rejection_reason = $1, updated_at = NOW() WHERE id = $2`, [reason, bookingId]);

    res.json({ success: true, message: 'Payment rejected.' });
  } catch (err) {
    console.error('[ADMIN] Reject error:', err.message, err.stack);
    res.json({ success: false, message: 'Error rejecting payment.' });
  }
});

router.get('/admin/tickets', adminAuth, async (req, res) => {
  try {
    const search = req.query.search || '';

    let sqlStr = `SELECT t.*, b.booking_number, b.phone, b.customer_name as b_customer
      FROM tickets t JOIN bookings b ON t.booking_id = b.id`;
    let params = [];

    if (search) {
      sqlStr += ` WHERE t.ticket_number LIKE $1 OR b.booking_number LIKE $1 OR t.qr_payload LIKE $1 OR b.phone LIKE $1 OR b.customer_name LIKE $1`;
      params = [`%${search}%`];
    }
    sqlStr += ` ORDER BY t.created_at DESC`;

    const tickets = await query(sqlStr, params);

    res.render('admin_tickets', { admin: req.admin, tickets, search });
  } catch (err) {
    console.error('[ADMIN] Tickets error:', err.message, err.stack);
    res.send('Error loading tickets.');
  }
});

router.post('/admin/api/ticket/:id/cancel', adminAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const existing = await query(`SELECT id FROM tickets WHERE id = $1`, [ticketId]);
    if (existing.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }

    await query(`UPDATE tickets SET status = 'cancelled' WHERE id = $1`, [ticketId]);

    res.json({ success: true, message: 'Ticket cancelled.' });
  } catch (err) {
    console.error('[ADMIN] Cancel error:', err.message, err.stack);
    res.json({ success: false, message: 'Error cancelling ticket.' });
  }
});

router.post('/admin/api/ticket/:id/reissue', adminAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const result = await query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
    if (result.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }

    const ticket = result[0];

    const newTicketNumber = generateTicketNumber();
    const newSecret = generateQRSecret();
    const newPayload = generateQRPayload(newTicketNumber, newSecret);
    const newHash = crypto.createHash('sha256').update(newPayload).digest('hex');

    await query(`UPDATE tickets SET ticket_number = $1, qr_payload = $2, qr_hash = $3, status = 'unused', checked_in_at = NULL, checked_in_by = NULL, device_used = NULL WHERE id = $4`, [newTicketNumber, newPayload, newHash, ticketId]);

    res.json({ success: true, message: 'Ticket reissued.', ticketNumber: newTicketNumber });
  } catch (err) {
    console.error('[ADMIN] Reissue error:', err.message, err.stack);
    res.json({ success: false, message: 'Error reissuing ticket.' });
  }
});

router.get('/admin/scanner', adminAuth, (req, res) => {
  res.render('admin_scanner', { admin: req.admin });
});

router.post('/admin/api/scan', adminAuth, async (req, res) => {
  try {
    const { qr_data } = req.body;
    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    if (!qr_data || !sanitize(qr_data)) {
      return res.json({ success: false, message: 'No QR data provided.' });
    }

    const parsedQR = verifyQRPayload(qr_data);
    if (!parsedQR) {
      await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (0, 'invalid', $1, $2, $3)`, [scannedBy, deviceInfo, 'Invalid QR code format scanned']);
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    const result = await query(`SELECT t.*, b.booking_number, b.phone, b.event_name FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.qr_payload = $1`, [qr_data]);

    if (result.length === 0) {
      await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES (0, 'invalid', $1, $2, $3)`, [scannedBy, deviceInfo, 'Invalid QR code scanned']);
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    const ticket = result[0];

    if (ticket.ticket_number !== parsedQR.ticketNumber) {
      await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES ($1, 'invalid', $2, $3, $4)`, [ticket.id, scannedBy, deviceInfo, 'QR payload ticket number mismatch']);
      return res.json({ success: false, message: 'Invalid Ticket', code: 'invalid' });
    }

    if (ticket.status === 'cancelled') {
      await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES ($1, 'cancelled', $2, $3, $4)`, [ticket.id, scannedBy, deviceInfo, 'Attempted scan of cancelled ticket']);
      return res.json({ success: false, message: 'Cancelled Ticket', code: 'cancelled' });
    }

    if (ticket.status === 'used') {
      await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES ($1, 're-scan', $2, $3, $4)`, [ticket.id, scannedBy, deviceInfo, `Already used - first check-in: ${ticket.checked_in_at}`]);
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
    console.error('[ADMIN] Scan error:', err.message, err.stack);
    res.json({ success: false, message: 'Error scanning ticket.' });
  }
});

router.post('/admin/api/ticket/:id/checkin', adminAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);

    if (!ticketId || isNaN(ticketId)) {
      return res.json({ success: false, message: 'Invalid ticket ID.' });
    }

    const scannedBy = req.admin.username;
    const deviceInfo = req.headers['user-agent'] || 'unknown';

    const result = await query(`SELECT t.*, b.payment_status FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.id = $1`, [ticketId]);
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

    await query(`UPDATE tickets SET status = 'used', checked_in_at = NOW(), checked_in_by = $1, device_used = $2 WHERE id = $3 AND status = 'unused'`, [scannedBy, deviceInfo, ticketId]);

    await query(`INSERT INTO scan_logs (ticket_id, action, scanned_by, device_info, details) VALUES ($1, 'check-in', $2, $3, 'Successful check-in')`, [ticketId, scannedBy, deviceInfo]);

    res.json({ success: true, message: 'Check-in successful.' });
  } catch (err) {
    console.error('[ADMIN] Check-in error:', err.message, err.stack);
    res.json({ success: false, message: 'Error checking in ticket.' });
  }
});

module.exports = router;
