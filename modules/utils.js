const net = require('net');
const dns = require('dns');
const { logger } = require('./logger');

// Rate-limit unresolvable parse warnings per entity (called every 30s poll cycle)
const lastParseWarns = new Map(); // key -> last warn timestamp
const PARSE_WARN_WINDOW = 5 * 60 * 1000;
function warnParseRateLimited(key, message) {
  const now = Date.now();
  if (!key || now - (lastParseWarns.get(key) || 0) > PARSE_WARN_WINDOW) {
    logger.warn(message);
    if (key) lastParseWarns.set(key, now);
  }
}

/**
 * Parse a grid state value into a binary state.
 * @param {*} state - numeric (0/1/2.5) or text ('on'/'off', 'true'/'false',
 *                    '1'/'0', 'open'/'closed', 'unlocked'/'locked')
 * @returns {number|null} 1 = ON, 0 = OFF, null = unresolvable.
 *   'unavailable'/'unknown'/null/undefined/unrecognized → null (NOT a phantom
 *   OFF), so callers can distinguish "measured zero" from "no data".
 */
function parseGridState(state, warnKey, warnFn) {
  const doWarn = warnFn ? (msg) => warnFn(warnKey, msg) : (msg) => warnParseRateLimited(warnKey, msg);
  if (state === null || state === undefined) {
    doWarn('parseGridState: null/undefined state treated as unresolvable');
    return null;
  }
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  if (str === '' || str === 'unavailable' || str === 'unknown') {
    doWarn(`parseGridState: state '${str || String(state)}' is unresolvable (not OFF/ON)`);
    return null;
  }
  if (str === 'on' || str === 'true' || str === '1' || str === 'open' || str === 'unlocked') return 1;
  if (str === 'off' || str === 'false' || str === '0' || str === 'closed' || str === 'locked') return 0;
  doWarn(`parseGridState: unrecognized state '${str}' treated as unresolvable`);
  return null;
}

/**
 * Check if an IP address is private or local.
 * @param {string} ip - IP string (v4 or v6)
 * @returns {boolean}
 */
function isPrivateOrLocalIp(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('fe80:')) return true;
  return false;
}

/**
 * Split an IPv6 literal into eight 16-bit groups (handles '::' compression and
 * embedded dotted-quad IPv4 like ::ffff:127.0.0.1). Returns null if malformed.
 * @param {string} ip
 * @returns {number[]|null}
 */
function ipv6Groups(ip) {
  let s = String(ip).toLowerCase();
  const m = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const hi = ((+m[2] << 8) | +m[3]).toString(16).padStart(4, '0');
    const lo = ((+m[4] << 8) | +m[5]).toString(16).padStart(4, '0');
    s = m[1] + hi + ':' + lo;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const groups = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  while (groups.length < 8 - tail.length) groups.push(0);
  for (const g of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  if (groups.length !== 8) return null;
  return groups;
}

/**
 * Decide whether an IP literal is blocked for server-side fetches.
 * Blocked: loopback (127.0.0.0/8, ::1, ::ffff:127.0.0.0/104), link-local
 * (169.254.0.0/16 incl. metadata 169.254.169.254, fe80::/10), unspecified
 * (0.0.0.0, ::). When allowPrivate is false, RFC1918 (10/8, 172.16/12,
 * 192.168/16) and ULA (fc00::/7) are blocked too. IPv4-mapped IPv6
 * (::ffff:a.b.c.d) is re-checked as IPv4.
 * @param {string} ip
 * @param {boolean} allowPrivate
 * @returns {boolean} true when the address must NOT be fetched
 */
function isBlockedIp(ip, allowPrivate) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    if ((n >>> 24) === 127) return true;      // loopback 127.0.0.0/8
    if (n === 0) return true;                 // unspecified 0.0.0.0
    if ((n >>> 16) === 0xa9fe) return true;   // link-local 169.254.0.0/16 (incl. metadata)
    if (!allowPrivate) {
      if ((n >>> 24) === 10) return true;     // RFC1918 10/8
      if ((n >>> 20) === 0xac1) return true;  // RFC1918 172.16/12 (172.16.0.0 – 172.31.255.255)
      if ((n >>> 16) === 0xc0a8) return true; // RFC1918 192.168/16
    }
    return false;
  }
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable IPv6 literal — fail closed
  if (g.every(x => x === 0)) return true;     // unspecified ::
  if (g[5] === 0xffff && g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    // IPv4-mapped ::ffff:a.b.c.d — re-check as IPv4 (covers ::ffff:127.0.0.0/104)
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIp(v4, allowPrivate);
  }
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // loopback ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 (fe80:–febf:)
  if (!allowPrivate && (g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (fc00:–fdff:)
  return false;
}

/**
 * SSRF guard (#70): validate a client-supplied URL before the server fetches it.
 * @param {string} url raw URL from client
 * @param {object} [opts] { allowPrivate: boolean }
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 *   On ok, returns a normalized URL string. Scheme must be http:/https:.
 *   Literal IPs and hostnames are checked against blocked ranges
 *   (loopback, link-local/metadata, unspecified); when allowPrivate is false
 *   RFC1918/ULA are also blocked. Hostnames are DNS-resolved (all A/AAAA) and
 *   every resolved address must pass the same checks (kills simple DNS
 *   rebinding). DNS failure or any blocked address → { ok: false }.
 */
async function assertSafeFetchUrl(url, opts) {
  const allowPrivate = !!(opts && opts.allowPrivate);
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { ok: false, error: 'Invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'URL scheme not allowed' };
  }
  // u.hostname includes brackets for IPv6 literals ('[::1]') — strip them.
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) !== 0) {
    if (isBlockedIp(hostname, allowPrivate)) return { ok: false, error: 'Host not allowed' };
    return { ok: true, url: u.toString() };
  }
  // Hostname: resolve every A/AAAA record and require ALL of them to be allowed
  // (a single blocked address — classic DNS-rebinding answer — rejects the URL).
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    return { ok: false, error: 'Invalid host' };
  }
  if (!addrs || addrs.length === 0) return { ok: false, error: 'Invalid host' };
  for (const a of addrs) {
    if (isBlockedIp(a.address, allowPrivate)) return { ok: false, error: 'Host not allowed' };
  }
  return { ok: true, url: u.toString() };
}

/**
 * SSRF guard (#71): validate a client-supplied MQTT broker URL before
 * mqtt.connect(). mqtt@5 silently downgrades unknown schemes to a raw TCP
 * dial, so the scheme MUST be exactly mqtt: or mqtts:. Non-empty hostname.
 * Credentials in the URL (user:pass@) are allowed (broker URLs commonly
 * carry them). Returns {ok:true, url} normalized or {ok:false, error}.
 */
function assertSafeBrokerUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Invalid broker URL' }; }
  if (u.protocol !== 'mqtt:' && u.protocol !== 'mqtts:') return { ok: false, error: 'Broker URL scheme not allowed (use mqtt:// or mqtts://)' };
  if (!u.hostname) return { ok: false, error: 'Broker host required' };
  return { ok: true, url: u.toString() };
}

/**
 * Validate a hostname string (no IPs, RFC-compliant labels).
 * @param {string} value
 * @returns {boolean}
 */
function isValidHostname(value) {
  if (value.length > 253) return false;
  const labels = value.split('.');
  return labels.every(label =>
    /^[a-zA-Z0-9-]{1,63}$/.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

module.exports = { parseGridState, isPrivateOrLocalIp, isBlockedIp, isValidHostname, assertSafeFetchUrl, assertSafeBrokerUrl, warnParseRateLimited };
