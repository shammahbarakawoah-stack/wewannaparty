require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb, getDb, saveDb, query } = require('./db');
const QRCode = require('qrcode');
const cors = require('cors');

let helmet;
try { helmet = require('helmet'); } catch (e) {}
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for session
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers
if (helmet) app.use(helmet());

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'wewannaparty-session-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(cors());

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Redirect /index.html to /
app.get('/index.html', (req, res) => {
  res.redirect(301, '/');
});

// Static files
app.use(express.static(path.join(__dirname, '..')));

// Routes
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
app.use('/', paymentRoutes);
app.use('/', adminRoutes);

// Rate limiting for payment submit endpoint
if (rateLimit) {
  const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { success: false, message: 'Too many requests, please try again later.' } });
  app.use('/api/payment/submit', paymentLimiter);
}

// API: Get QR code image for a ticket
app.get('/api/ticket/:id/qr', async (req, res) => {
  try {
    const db = await getDb();
    const tickets = query(`SELECT * FROM tickets WHERE id = ?`, [req.params.id]);
    if (tickets.length === 0) {
      return res.json({ success: false, message: 'Ticket not found.' });
    }
    const ticket = tickets[0];

    const qrImage = await QRCode.toDataURL(ticket.qr_payload, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
      color: { dark: '#B00000', light: '#FFFFFF00' }
    });

    res.json({ success: true, qrImage, ticketNumber: ticket.ticket_number });
  } catch (err) {
    res.json({ success: false, message: 'Error generating QR.' });
  }
});

// API: Get QR image direct (for customer viewing)
app.get('/api/ticket/:id/qr-image', async (req, res) => {
  try {
    const db = await getDb();
    const tickets = query(`SELECT * FROM tickets WHERE id = ?`, [req.params.id]);
    if (tickets.length === 0) {
      return res.status(404).send('Ticket not found.');
    }
    const ticket = tickets[0];

    const qrImage = await QRCode.toDataURL(ticket.qr_payload, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
      color: { dark: '#B00000', light: '#FFFFFF00' }
    });

    const html = `<!DOCTYPE html>
    <html><head><title>Ticket QR - ${ticket.ticket_number}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0A0A0A; font-family:sans-serif; flex-direction:column; padding:20px; }
      .card { background:#111; border:1px solid #222; border-radius:16px; padding:32px; text-align:center; max-width:400px; width:100%; }
      img { max-width:280px; width:100%; border-radius:12px; margin-bottom:16px; }
      h2 { color:#fff; font-size:18px; margin-bottom:4px; }
      .ticket-num { font-family:monospace; font-size:13px; color:#B00000; margin-bottom:8px; }
      .info { color:#888; font-size:12px; line-height:1.6; }
      .btn { display:inline-block; margin-top:16px; padding:10px 24px; background:#B00000; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; text-decoration:none; }
      @media print { .btn, .no-print { display:none; } body { background:#fff; } .card { background:#fff; border-color:#ddd; } h2 { color:#000; } .info { color:#666; } }
    </style></head>
    <body>
      <div class="card">
        <img src="${qrImage}" alt="QR Code" />
        <h2>${ticket.event_name}</h2>
        <div class="ticket-num">${ticket.ticket_number}</div>
        <div class="info">
          <p>Holder: ${ticket.holder_name || 'N/A'}</p>
          <p>Type: ${ticket.ticket_type}</p>
          <p>Status: ${ticket.status}</p>
        </div>
        <div class="no-print" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px;">
          <button class="btn" onclick="window.print()">Print</button>
          <a class="btn" href="${qrImage}" download="ticket-${ticket.ticket_number}.png">Download QR</a>
        </div>
      </div>
    </body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error generating QR page.');
  }
});

// API: Download ticket as PDF (simplified - generates an HTML page for printing)
app.get('/api/ticket/:id/download', async (req, res) => {
  try {
    const db = await getDb();
    const tickets = query(`SELECT t.*, b.booking_number, b.phone, b.event_name, b.event_date, b.event_venue
      FROM tickets t JOIN bookings b ON t.booking_id = b.id WHERE t.id = ?`, [req.params.id]);
    if (tickets.length === 0) {
      return res.status(404).send('Ticket not found.');
    }
    const ticket = tickets[0];

    const qrImage = await QRCode.toDataURL(ticket.qr_payload, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 300,
      color: { dark: '#B00000', light: '#FFFFFF00' }
    });

    const html = `<!DOCTYPE html>
    <html><head><title>Ticket - ${ticket.ticket_number}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:'Inter',sans-serif; background:#fff; padding:20px; }
      .ticket { max-width:600px; margin:0 auto; border:2px solid #B00000; border-radius:16px; overflow:hidden; }
      .header { background:#B00000; color:#fff; padding:24px; text-align:center; }
      .header h1 { font-size:20px; margin-bottom:4px; }
      .header p { font-size:12px; opacity:0.8; }
      .body { padding:24px; }
      .row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:13px; }
      .row:last-child { border-bottom:none; }
      .label { color:#888; }
      .value { font-weight:600; color:#111; }
      .qr-section { text-align:center; padding:20px 0; }
      .qr-section img { max-width:200px; }
      .footer { text-align:center; padding:16px; font-size:11px; color:#888; border-top:1px solid #eee; }
      .status-badge { display:inline-block; padding:4px 12px; border-radius:100px; font-size:11px; font-weight:600; }
      .status-unused { background:#e8f5e9; color:#2e7d32; }
      @media print { body { padding:0; } }
    </style></head>
    <body>
      <div class="ticket">
        <div class="header">
          <h1>${ticket.event_name}</h1>
          <p>${ticket.event_date} · ${ticket.event_venue}</p>
        </div>
        <div class="body">
          <div class="qr-section">
            <img src="${qrImage}" alt="QR Code" />
          </div>
          <div class="row"><span class="label">Ticket Number</span><span class="value">${ticket.ticket_number}</span></div>
          <div class="row"><span class="label">Booking Number</span><span class="value">${ticket.booking_number}</span></div>
          <div class="row"><span class="label">Ticket Type</span><span class="value">${ticket.ticket_type}</span></div>
          <div class="row"><span class="label">Holder Name</span><span class="value">${ticket.holder_name || 'N/A'}</span></div>
          <div class="row"><span class="label">Purchase Date</span><span class="value">${ticket.created_at}</span></div>
          <div class="row">
            <span class="label">Status</span>
            <span class="value"><span class="status-badge status-${ticket.status}">${ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1)}</span></span>
          </div>
        </div>
        <div class="footer">WeWannaParty · Africa's Ticketing Platform</div>
      </div>
      <div style="text-align:center;margin-top:16px;">
        <button onclick="window.print()" style="padding:10px 24px;background:#B00000;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Print Ticket</button>
      </div>
    </body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error generating ticket.');
  }
});

// Redirect old index.html "Get Tickets" button goes to payment page
app.get('/event/wer-afro', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  } catch (err) {
    res.status(500).send('Error serving page.');
  }
});

// 404 handler - must be after all routes
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html><head><title>404 - Page Not Found</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0A0A0A; font-family:sans-serif; flex-direction:column; padding:20px; }
  .card { background:#111; border:1px solid #222; border-radius:16px; padding:48px; text-align:center; max-width:400px; width:100%; }
  h1 { color:#B00000; font-size:64px; margin-bottom:8px; }
  h2 { color:#fff; font-size:18px; margin-bottom:16px; }
  p { color:#888; font-size:13px; margin-bottom:24px; }
  a { display:inline-block; padding:10px 24px; background:#B00000; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; text-decoration:none; }
</style></head>
<body><div class="card"><h1>404</h1><h2>Page Not Found</h2><p>The page you're looking for doesn't exist.</p><a href="/">Go Home</a></div></body></html>`);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send(`<!DOCTYPE html>
<html><head><title>500 - Server Error</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0A0A0A; font-family:sans-serif; flex-direction:column; padding:20px; }
  .card { background:#111; border:1px solid #222; border-radius:16px; padding:48px; text-align:center; max-width:400px; width:100%; }
  h1 { color:#B00000; font-size:48px; margin-bottom:8px; }
  h2 { color:#fff; font-size:18px; margin-bottom:16px; }
  p { color:#888; font-size:13px; margin-bottom:24px; }
  a { display:inline-block; padding:10px 24px; background:#B00000; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; text-decoration:none; }
</style></head>
<body><div class="card"><h1>500</h1><h2>Something went wrong</h2><p>An unexpected error occurred. Please try again later.</p><a href="/">Go Home</a></div></body></html>`);
});

// Initialize database and start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`WeWannaParty Ticketing System running on http://localhost:${PORT}`);
    console.log(`Admin login: http://localhost:${PORT}/admin/login`);
    console.log(`Event page: http://localhost:${PORT}/`);
  });
}

start();
