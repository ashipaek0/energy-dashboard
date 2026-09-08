/**
 * PVOutput HTTP Client — uses the native global fetch with auth headers and form encoding.
 *
 * Every request includes X-Pvoutput-Apikey and X-Pvoutput-SystemId headers.
 * POST bodies are application/x-www-form-urlencoded (PVOutput does not accept JSON).
 * Rate limit headers are extracted from every response and fed to the rate limiter.
 *
 * @module pvoutput/client
 */
const { URLSearchParams } = require('url');
const { updateFromHeaders } = require('./rateLimiter');

const BASE_URL = 'https://pvoutput.org/service/r2/';

class PVOutputClient {
  constructor(apiKey, systemId) {
    this.apiKey = apiKey;
    this.systemId = systemId;
  }

  _headers() {
    return {
      'X-Pvoutput-Apikey': this.apiKey,
      'X-Pvoutput-SystemId': this.systemId
    };
  }

  _updateRateLimit(headers, pool) {
    updateFromHeaders(pool || 'general', headers);
  }

  /** GET request — returns response body text. */
  async get(endpoint, params = {}, pool = 'general') {
    const url = new URL(endpoint, BASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString(), { headers: this._headers(), signal: AbortSignal.timeout(15000) });
    this._updateRateLimit(res.headers, pool);
    const text = await res.text();
    if (!res.ok) throw new Error(`PVOutput ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }

  /** POST request with form-encoded body. */
  async post(endpoint, formData, pool = 'general') {
    const url = new URL(endpoint, BASE_URL);
    const body = new URLSearchParams();
    Object.entries(formData).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
    });
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000)
    });
    this._updateRateLimit(res.headers, pool);
    const text = await res.text();
    if (!res.ok) throw new Error(`PVOutput ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }
}

module.exports = { PVOutputClient };
