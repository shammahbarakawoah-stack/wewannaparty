const express = require('express');
const router = express.Router();
const { getDb, saveDb, query } = require('../db');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const PAYBILL = '400200';
const ACCOUNT = '01102884553001';

// Generate unique booking number
function generateBookingNumber() {
  const prefix = 'WWP';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

// Generate secure QR payload (no DB IDs exposed)
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

// GET payment page
router.get('/payment', (req, res) => {
  const { amount, ticketType, qty } = req.query;
  res.render('payment', {
    paybill: PAYBILL,
    account: ACCOUNT,
    amount: amount || '3000',
    ticketType: ticketType || 'General Access',
    qty: qty || '1'
  });
});

// POST submit payment
router.post('/api/payment/submit', express.json(), async (req, res) => {
  try {
    const { mpesa_code, phone, amount_paid, full_name, ticket_type, qty, event_name, event_date, event_venue } = req.body;
    const amount = amount_paid || req.body.amount;

    if (!mpesa_code || !mpesa_code.trim()) {
      return res.json({ success: false, message: 'M-Pesa Confirmation Code is required.' });
    }
    if (!phone || !phone.trim()) {
      return res.json({ success: false, message: 'Phone number is required.' });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.json({ success: false, message: 'Valid amount is required.' });
    }

    const db = await getDb();
    const bookingNumber = generateBookingNumber();

    // Check if M-Pesa code already used
    const existing = query(`SELECT id FROM bookings WHERE mpesa_code = ?`, [mpesa_code.trim()]);
    if (existing.length > 0) {
      return res.json({ success: false, message: 'This M-Pesa Confirmation Code has already been used.' });
    }

    db.run(`INSERT INTO bookings (booking_number, event_name, event_date, event_venue, customer_name, phone, amount, mpesa_code, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, [
        bookingNumber,
        event_name || 'We"R Afro · TheMostWanted & Friends Africa Live Tour',
        event_date || '2026-08-29',
        event_venue || 'Uhuru Gardens, Nairobi',
        full_name || '',
        phone.trim(),
        parseFloat(amount),
        mpesa_code.trim()
      ]);
    saveDb();

    res.json({
      success: true,
      message: 'Thank you. Your payment has been received and is awaiting verification. Your tickets will be generated once payment has been confirmed.',
      bookingNumber
    });
  } catch (err) {
    console.error('Payment submit error:', err);
    res.json({ success: false, message: 'An error occurred. Please try again.' });
  }
});

// GET check booking status
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
    res.json({ success: false, message: 'Error fetching booking.' });
  }
});

// GET booking details (for customer lookup page)
router.get('/booking/lookup', (req, res) => {
  res.render('booking_lookup');
});

router.post('/api/booking/lookup', express.json(), async (req, res) => {
  try {
    const db = await getDb();
    const { phone, booking_number } = req.body;

    let bookings;
    if (booking_number) {
      bookings = query(`SELECT * FROM bookings WHERE booking_number = ?`, [booking_number.trim()]);
    } else if (phone) {
      bookings = query(`SELECT * FROM bookings WHERE phone = ? ORDER BY created_at DESC`, [phone.trim()]);
    } else {
      return res.json({ success: false, message: 'Provide phone number or booking number.' });
    }

    if (bookings.length === 0) {
      return res.json({ success: false, message: 'No bookings found.' });
    }

    // Get tickets for each booking
    for (let b of bookings) {
      b.tickets = query(`SELECT * FROM tickets WHERE booking_id = ?`, [b.id]);
    }

    res.json({ success: true, bookings });
  } catch (err) {
    console.error('Lookup error:', err);
    res.json({ success: false, message: 'Error looking up booking.' });
  }
});

// GET my tickets page
router.get('/my-tickets', (req, res) => {
  res.render('my_tickets');
});

module.exports = router;
module.exports.PAYBILL = PAYBILL;
module.exports.ACCOUNT = ACCOUNT;
module.exports.generateQRPayload = generateQRPayload;
module.exports.verifyQRPayload = verifyQRPayload;
