const express = require('express');
const router = express.Router();
const { getDb, saveDb, query } = require('../db');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const PAYBILL = '400200';
const ACCOUNT = '01102884553001';

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function generateBookingNumber() {
  const prefix = 'WWP';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function generateQRPayload(ticketNumber, secret) {
  const timestamp = Date.now();
  const payload = `${ticketNumber}:${timestamp}:${secret}`;
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const data = `${ticketNumber}:${timestamp}:${hash.slice(0, 16)}`;
  return Buffer.from(data).toString('base64');
}

function verifyQRPayload(qrData) {
  try {
    const decoded = Buffer.from(qrData, 'base64').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    return { ticketNumber: parts[0], timestamp: parts[1], hash: parts[2] };
  } catch {
    return null;
  }
}

router.get('/payment', (req, res) => {
  const { amount, ticketType, qty, success, booking, error } = req.query;
  res.render('payment', {
    paybill: PAYBILL,
    account: ACCOUNT,
    amount: amount || '3000',
    ticketType: ticketType || 'General Access',
    qty: qty || '1',
    success: success === '1',
    bookingNumber: booking || '',
    error: error || '',
    eventName: 'WeR Afro \u00B7 TheMostWanted & Friends Africa Live Tour',
    eventDate: '2026-08-29',
    eventVenue: 'Uhuru Gardens, Nairobi'
  });
});

router.post('/api/payment/submit', async (req, res) => {
  console.log('[PAYMENT] POST /api/payment/submit - request received');
  try {
    const { mpesa_code, phone, amount_paid, amount: bodyAmount, full_name, ticket_type, qty, event_name, event_date, event_venue, email } = req.body;
    console.log('[PAYMENT] Body received:', JSON.stringify({ mpesa_code, phone, bodyAmount, full_name, email, ticket_type, qty, event_name, event_date, event_venue }));
    const parsedAmount = parseFloat(bodyAmount || amount_paid || 0);

    const sanitizedCode = sanitize(mpesa_code || '');
    const sanitizedPhone = sanitize(phone || '');
    const sanitizedName = sanitize(full_name || '');
    const sanitizedEmail = (email || '').trim().toLowerCase();
    console.log('[PAYMENT] Sanitized - code:', sanitizedCode, 'phone:', sanitizedPhone, 'name:', sanitizedName, 'email:', sanitizedEmail, 'amount:', parsedAmount);

    function isJson() { return !!req.is('json'); }
    function jsonOrRedirect(msg, urlMsg) {
      if (isJson()) return res.json({ success: false, message: msg });
      return res.redirect('/payment?error=' + encodeURIComponent(urlMsg || msg));
    }

    if (!sanitizedCode) {
      console.log('[PAYMENT] Validation failed: missing M-Pesa code');
      return jsonOrRedirect('M-Pesa Confirmation Code is required.');
    }
    if (!/^[a-zA-Z0-9]+$/.test(sanitizedCode)) {
      console.log('[PAYMENT] Validation failed: non-alphanumeric code');
      return jsonOrRedirect('M-Pesa Confirmation Code must be alphanumeric.');
    }
    if (sanitizedCode.length > 30) {
      console.log('[PAYMENT] Validation failed: code too long');
      return jsonOrRedirect('M-Pesa Confirmation Code must be at most 30 characters.');
    }

    if (!sanitizedPhone) {
      console.log('[PAYMENT] Validation failed: missing phone');
      return jsonOrRedirect('Phone number is required.');
    }
    const phoneDigits = sanitizedPhone.replace(/[\s-]/g, '');
    if (!/^(?:\+254|0)\d{9}$/.test(phoneDigits)) {
      console.log('[PAYMENT] Validation failed: invalid phone format:', phoneDigits);
      return jsonOrRedirect('Please enter a valid phone number (+254 or 0 prefix).');
    }

    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      console.log('[PAYMENT] Validation failed: invalid amount:', parsedAmount);
      return jsonOrRedirect('A valid positive amount is required.');
    }

    if (sanitizedName.length > 100) {
      console.log('[PAYMENT] Validation failed: name too long');
      return jsonOrRedirect('Full name must be at most 100 characters.');
    }

    if (!sanitizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedEmail)) {
      console.log('[PAYMENT] Validation failed: invalid email');
      return jsonOrRedirect('A valid email address is required.');
    }

    console.log('[PAYMENT] Validation passed, getting database...');
    const db = await getDb();
    const bookingNumber = generateBookingNumber();
    console.log('[PAYMENT] Generated booking number:', bookingNumber);

    console.log('[PAYMENT] Checking for duplicate M-Pesa code:', sanitizedCode);
    const existing = query(`SELECT id FROM bookings WHERE mpesa_code = ?`, [sanitizedCode]);
    if (existing.length > 0) {
      console.log('[PAYMENT] Duplicate M-Pesa code detected');
      return jsonOrRedirect('This M-Pesa Confirmation Code has already been used.');
    }

    console.log('[PAYMENT] Checking for recent duplicate payment');
    const recentDupe = query(`SELECT id FROM bookings WHERE phone = ? AND amount = ? AND created_at >= datetime('now', '-5 minutes')`, [sanitizedPhone, parsedAmount]);
    if (recentDupe.length > 0) {
      console.log('[PAYMENT] Recent duplicate payment detected');
      return jsonOrRedirect('A similar payment was submitted recently. Please wait for confirmation.');
    }

    console.log('[PAYMENT] Inserting booking into database...');
    const sanitizedTicketType = sanitize(ticket_type || 'General Access');
    const sanitizedQty = parseInt(qty, 10) || 1;
    db.run(`INSERT INTO bookings (booking_number, event_name, event_date, event_venue, customer_name, phone, email, amount, mpesa_code, ticket_type, qty, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, [
        bookingNumber,
        event_name || 'We"R Afro · TheMostWanted & Friends Africa Live Tour',
        event_date || '2026-08-29',
        event_venue || 'Uhuru Gardens, Nairobi',
        sanitizedName,
        sanitizedPhone,
        sanitizedEmail,
        parsedAmount,
        sanitizedCode,
        sanitizedTicketType,
        sanitizedQty
      ]);
    console.log('[PAYMENT] Database insert completed');

    console.log('[PAYMENT] Persisting database to disk...');
    saveDb();
    console.log('[PAYMENT] Database persisted successfully');

    console.log('[PAYMENT] Success - booking created:', bookingNumber);
    if (isJson()) {
      return res.json({
        success: true,
        message: 'Payment received successfully. Your payment is under review. You will receive your ticket once payment has been verified.',
        bookingNumber
      });
    }
    res.redirect('/payment?success=1&booking=' + encodeURIComponent(bookingNumber));
  } catch (err) {
    console.error('[PAYMENT] ERROR:', err.message, err.stack);
    return jsonOrRedirect('An error occurred. Please try again.');
  }
});

router.head('/api/booking/test', (req, res) => {
  res.status(200).end();
});

router.get('/api/booking/test', (req, res) => {
  res.json({ success: true, message: 'Backend is online.' });
});

router.get('/api/booking/:bookingNumber', async (req, res) => {
  try {
    const db = await getDb();
    const rows = query(`SELECT booking_number, payment_status FROM bookings WHERE booking_number = ?`, [req.params.bookingNumber]);
    if (rows.length === 0) {
      return res.json({ success: false, message: 'Booking not found.' });
    }
    const row = rows[0];
    res.json({ success: true, bookingNumber: row.booking_number, status: row.payment_status });
  } catch (err) {
    console.error('[BOOKING] Error fetching booking:', err.message, err.stack);
    res.json({ success: false, message: 'Error fetching booking.' });
  }
});

router.get('/booking/lookup', (req, res) => {
  res.render('booking_lookup');
});

router.post('/api/booking/lookup', async (req, res) => {
  try {
    const db = await getDb();
    const { phone, booking_number } = req.body;

    const sanitizedPhone = sanitize(phone || '');
    const sanitizedBookingNumber = sanitize(booking_number || '');

    let bookings;
    if (sanitizedBookingNumber) {
      bookings = query(`SELECT * FROM bookings WHERE booking_number = ?`, [sanitizedBookingNumber]);
    } else if (sanitizedPhone) {
      bookings = query(`SELECT * FROM bookings WHERE phone = ? ORDER BY created_at DESC`, [sanitizedPhone]);
    } else {
      return res.json({ success: false, message: 'Provide phone number or booking number.' });
    }

    if (bookings.length === 0) {
      return res.json({ success: false, message: 'No bookings found.' });
    }

    for (let b of bookings) {
      b.tickets = query(`SELECT * FROM tickets WHERE booking_id = ?`, [b.id]);
    }

    res.json({ success: true, bookings });
  } catch (err) {
    console.error('Lookup error:', err);
    res.json({ success: false, message: 'Error looking up booking.' });
  }
});

router.get('/my-tickets', (req, res) => {
  res.redirect('/booking/lookup');
});

module.exports = router;
module.exports.PAYBILL = PAYBILL;
module.exports.ACCOUNT = ACCOUNT;
module.exports.generateQRPayload = generateQRPayload;
module.exports.verifyQRPayload = verifyQRPayload;
