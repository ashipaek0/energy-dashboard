/**
 * Authentication and Session Management Routes
 *
 * Handles admin login, session logout, authentication status checks,
 * and setup wizard password configuration.
 *
 * @module routes/auth
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig } = require('../modules/database');
const { loginLimiter, passwordEnvManaged, verifyPassword, setSettingsPassword, isAuthenticated } = require('../modules/sessionAuth');

const router = express.Router();

// Admin login
router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && verifyPassword(password)) {
    req.session.authenticated = true;
    logger.info('User logged in successfully');
    return res.json({ success: true });
  }
  logger.warn('Failed login attempt');
  res.status(401).json({ error: 'Invalid password' });
});

// Admin logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  logger.info('User logged out');
  res.redirect('/');
});

// Auth status (public, returns session state)
router.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Setup wizard status
router.get('/wizard/status', (req, res) => {
  try {
    const completed = getConfig('setup_wizard_completed') === 'true';
    const keys = ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices'];
    let hasDataSource = false;
    for (const k of keys) {
      const v = JSON.parse(getConfig(k) || '[]');
      if (Array.isArray(v) && v.length > 0) { hasDataSource = true; break; }
    }
    res.json({ needsSetup: !completed, completed, hasDataSource, passwordEnvManaged });
  } catch (err) {
    logger.error('Error in /api/wizard/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reveal password info ONLY when not env-managed and not yet completed
router.get('/wizard/password', (req, res) => {
  if (!passwordEnvManaged && getConfig('setup_wizard_completed') !== 'true') {
    return res.json({ configured: true });
  }
  res.status(403).json({ error: 'Password is managed by environment or setup already complete' });
});

// Set initial admin password
router.post('/wizard/password', (req, res) => {
  const { password } = req.body;
  if (passwordEnvManaged) {
    if (getConfig('setup_wizard_completed') === 'true') {
      return res.status(403).json({ error: 'Password is managed by environment' });
    }
    if (req.session) req.session.authenticated = true;
    return res.json({ success: true });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    setSettingsPassword(password);
    if (req.session) req.session.authenticated = true;
    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Complete setup wizard
router.post('/wizard/complete', isAuthenticated, (req, res) => {
  setConfig('setup_wizard_completed', 'true');
  res.json({ success: true });
});

module.exports = router;
