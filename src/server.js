require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { requireAuth, login, logout } = require('./auth');
const googleAuth = require('./googleAuth');
const apiRoutes = require('./routes/api');
const { startScheduler } = require('./monitor');

const app = express();
app.use(express.json());
app.use(
  cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  })
);

app.post('/api/login', login);
app.post('/api/logout', logout);

app.get('/api/google-login-available', (req, res) => {
  res.json({ available: googleAuth.isConfigured() });
});

app.get('/auth/google', (req, res) => {
  if (!googleAuth.isConfigured()) {
    return res.status(500).send('Google login is not configured on this server yet.');
  }
  res.redirect(googleAuth.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  if (!googleAuth.isConfigured()) return res.status(500).send('Google login is not configured on this server yet.');
  if (req.query.error) return res.redirect('/login.html?error=google_cancelled');
  try {
    const payload = await googleAuth.verifyCallback(req.query.code);
    const allowed = (process.env.ALLOWED_GOOGLE_EMAIL || '').toLowerCase();
    if (!payload.email_verified || !allowed || payload.email.toLowerCase() !== allowed) {
      return res.redirect('/login.html?error=google_unauthorized');
    }
    req.session.loggedIn = true;
    req.session.username = payload.email;
    res.redirect('/');
  } catch (err) {
    console.error('[auth] Google callback failed:', err.message);
    res.redirect('/login.html?error=google_failed');
  }
});

app.use('/api', requireAuth, apiRoutes);

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/assets') || req.path === '/style.css') return next();
  if (!req.session || !req.session.loggedIn) return res.redirect('/login.html');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rock It Uptime Monitor listening on http://localhost:${PORT}`);
  startScheduler();
});
