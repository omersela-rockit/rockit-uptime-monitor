const bcrypt = require('bcryptjs');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login.html');
}

function login(req, res) {
  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const hash = process.env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    return res.status(500).json({ error: 'Server not configured: ADMIN_PASSWORD_HASH missing in .env' });
  }
  if (username !== validUser || !bcrypt.compareSync(password || '', hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.loggedIn = true;
  req.session.username = username;
  res.json({ ok: true });
}

function logout(req, res) {
  req.session = null;
  res.json({ ok: true });
}

module.exports = { requireAuth, login, logout };
