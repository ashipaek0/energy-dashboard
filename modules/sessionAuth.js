const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const PASSWORD_FILE = path.join(__dirname, '..', 'data', 'settings-password');

let storedSalt = null;
let storedHash = null;

function hashPasswordWithSalt(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const passwordEnvManaged = !!process.env.SETTINGS_PASSWORD;

if (passwordEnvManaged) {
  storedSalt = crypto.randomBytes(16).toString('hex');
  storedHash = hashPasswordWithSalt(process.env.SETTINGS_PASSWORD, storedSalt);
} else {
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      const content = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
      if (!content) throw new Error('Empty password file');
      if (content.includes(':')) {
        const [s, h] = content.split(':');
        storedSalt = s;
        storedHash = h;
      } else {
        // Migration: migrate legacy plaintext password to salted hash
        storedSalt = crypto.randomBytes(16).toString('hex');
        storedHash = hashPasswordWithSalt(content, storedSalt);
        fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
        fs.writeFileSync(PASSWORD_FILE, `${storedSalt}:${storedHash}`, { mode: 0o600 });
        console.log('🔒 Migrated settings password from plain text to salted hash');
      }
    } else {
      const initPw = crypto.randomBytes(8).toString('hex');
      storedSalt = crypto.randomBytes(16).toString('hex');
      storedHash = hashPasswordWithSalt(initPw, storedSalt);
      fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
      fs.writeFileSync(PASSWORD_FILE, `${storedSalt}:${storedHash}`, { mode: 0o600 });
      console.warn('⚠️  WARNING: No SETTINGS_PASSWORD provided in environment.');
      console.warn(`🔒  A random password has been generated and saved securely to data/settings-password`);
    }
  } catch (err) {
    const fallbackPw = crypto.randomBytes(8).toString('hex');
    storedSalt = crypto.randomBytes(16).toString('hex');
    storedHash = hashPasswordWithSalt(fallbackPw, storedSalt);
    console.error('Failed to persist settings password:', err.message);
  }
}

function verifyPassword(inputPassword) {
  if (typeof inputPassword !== 'string' || !storedSalt || !storedHash) return false;
  const computedHash = hashPasswordWithSalt(inputPassword, storedSalt);
  try {
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (_) {
    return false;
  }
}

function setSettingsPassword(pw) {
  if (passwordEnvManaged) {
    const err = new Error('Password is managed by environment');
    err.status = 403;
    throw err;
  }
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPasswordWithSalt(String(pw), newSalt);
  fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
  fs.writeFileSync(PASSWORD_FILE, `${newSalt}:${newHash}`, { mode: 0o600 });
  storedSalt = newSalt;
  storedHash = newHash;
  return true;
}

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/login');
  }
}

// Rate limiter for login attempts only (10 per minute)
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts, please try again later' }
});

// CSRF protection (skip for login endpoint & webhook)
const csrfProtection = (req, res, next) => {
  if (req.originalUrl === '/api/login' || req.originalUrl.startsWith('/api/pvoutput/webhook') || req.originalUrl === '/api/wizard/password') {
    return next();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const reqHeader = req.headers['x-requested-with'];
    const origin = req.headers['origin'];
    const host = req.headers['host'];

    // Enforce Origin matching if present
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'CSRF protection: Origin mismatch' });
        }
      } catch (_) {
        return res.status(403).json({ error: 'CSRF protection: Invalid Origin header' });
      }
    }

    if (!reqHeader || reqHeader !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};

module.exports = {
  isAuthenticated,
  loginLimiter,
  csrfProtection,
  passwordEnvManaged,
  verifyPassword,
  setSettingsPassword
};

