const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@wewannaparty.com';
const FROM_NAME = process.env.FROM_NAME || 'WeWannaParty';

function createTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendTicketEmail(booking, tickets) {
  const transport = createTransport();
  if (!transport || !booking.email) {
    console.log('[EMAIL] Skipping - no SMTP config or no email:', { hasSMTP: !!SMTP_HOST, email: booking.email });
    return false;
  }

  const qrImages = [];
  for (const t of tickets) {
    try {
      const QRCode = require('qrcode');
      const url = await QRCode.toDataURL(t.qr_payload, { errorCorrectionLevel: 'H', margin: 1, width: 300 });
      qrImages.push({ ticketNumber: t.ticketNumber, url });
    } catch (e) {
      console.error('[EMAIL] QR generation error for', t.ticketNumber, e.message);
    }
  }

  const ticketsHtml = tickets.map((t, i) => {
    const qr = qrImages[i];
    const qrImg = qr ? `<img src="${qr.url}" alt="QR Code" style="width:160px;height:160px;display:block;margin:12px auto;" />` : '';
    return `<div style="background:#1a1a1a;border-radius:8px;padding:20px;margin-bottom:16px;text-align:center;border:1px solid #333;">
      <div style="font-size:13px;color:#B00000;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${t.ticketNumber}</div>
      <div style="font-size:16px;color:#fff;font-weight:600;margin-bottom:4px;">${booking.event_name}</div>
      <div style="font-size:13px;color:#999;margin-bottom:4px;">${booking.ticket_type}</div>
      <div style="font-size:12px;color:#666;">Holder: ${booking.customer_name || 'N/A'}</div>
      ${qrImg}
    </div>`;
  }).join('');

  const msg = {
    to: booking.email,
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    subject: `Your Tickets - ${booking.event_name}`,
    html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="text-align:center;padding-bottom:24px;">
        <div style="font-size:22px;font-weight:800;color:#B00000;">WeWannaParty</div>
      </td></tr>
      <tr><td style="background:#111;border-radius:12px;padding:32px;border:1px solid #222;">
        <h1 style="font-size:20px;color:#fff;margin:0 0 8px;">Your Tickets Are Ready!</h1>
        <p style="font-size:14px;color:#999;margin:0 0 24px;line-height:1.6;">
          Your payment has been verified. Below are your tickets for <strong style="color:#fff;">${booking.event_name}</strong>.
        </p>

        <div style="background:#0A0A0A;border-radius:8px;padding:16px;margin-bottom:24px;">
          <table width="100%" cellpadding="6">
            <tr><td style="font-size:12px;color:#666;width:90px;">Event</td><td style="font-size:13px;color:#fff;">${booking.event_name}</td></tr>
            <tr><td style="font-size:12px;color:#666;">Date</td><td style="font-size:13px;color:#fff;">${booking.event_date}</td></tr>
            <tr><td style="font-size:12px;color:#666;">Venue</td><td style="font-size:13px;color:#fff;">${booking.event_venue}</td></tr>
            <tr><td style="font-size:12px;color:#666;">Booking</td><td style="font-size:13px;color:#fff;font-family:monospace;">${booking.booking_number}</td></tr>
            <tr><td style="font-size:12px;color:#666;">Tickets</td><td style="font-size:13px;color:#fff;">${booking.qty} x ${booking.ticket_type}</td></tr>
          </table>
        </div>

        ${ticketsHtml}

        <p style="font-size:12px;color:#666;margin:24px 0 0;line-height:1.6;text-align:center;">
          You can also view your tickets anytime:<br />
          <a href="https://${process.env.DOMAIN || 'kolawewannaparty.onrender.com'}/booking/lookup" style="color:#B00000;text-decoration:none;font-weight:600;">My Tickets</a>
        </p>
      </td></tr>
      <tr><td style="text-align:center;padding-top:16px;">
        <p style="font-size:11px;color:#444;">WeWannaParty &mdash; Africa's entertainment ticketing platform</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`
  };

  try {
    await transport.sendMail(msg);
    console.log('[EMAIL] Tickets sent to', booking.email);
    return true;
  } catch (err) {
    console.error('[EMAIL] Send failed:', err.message);
    return false;
  }
}

module.exports = { sendTicketEmail };
