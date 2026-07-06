const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'wewannaparty-secure-jwt-secret-key-2026';

function adminAuth(req, res, next) {
  const token = req.session?.adminToken;
  if (!token) {
    return res.redirect('/admin/login');
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    req.session.destroy();
    return res.redirect('/admin/login');
  }
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

module.exports = { adminAuth, generateToken, JWT_SECRET };
