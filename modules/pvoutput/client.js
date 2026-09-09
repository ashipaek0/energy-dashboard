/**
 * PVOutput HTTP Client — uses the native global fetch with auth headers and form encoding.
 *
 * Every request includes X-Pvoutput-Apikey and X-Pvoutput-SystemId headers.
 * Per the PVOutput API spec, rate-limit headers are only returned when the
 * request carries X-Rate-Limit: 1 — so every request opts in (AC-9), otherwise
 * updateFromHeaders would never see live remaining/reset values.
 *
 * 403 Exceeded responses are detected at this single choke point (D4): the
 * body pattern triggers rateLimiter.handleRateLimitExceeded() BEFORE the
 * error is thrown, so lockouts teach the limiter instead of hammering it.
 *
 * POST bodies are application/x-www-form-urlencoded (PVOutput does not accept JSON).
 *
 * @module pvoutput/client
 */
const { URLSearchParams } = require('url');
const { updateFromHeaders, handleRateLimitExceeded, isRateLimitError } = require('./rateLimiter');

const BASE_URL = 'https://pvoutput.org/service/r2/';

class PVOutputClient {
  constructor(apiKey, systemId) {
    this.apiKey = apiKey;
    this.systemId = systemId;
  }

  _headers() {
    return {
      'X-Pvoutput-Apikey': this.apiKey,
      'X-Pvoutput-SystemId': this.systemId,
      // Opt in to rate-limit response headers (PVOutput returns them only on request)
      'X-Rate-Limit': '1'
    };
  }

  _updateRateLimit(headers, pool) {
    updateFromHeaders(pool || 'general', headers);
  }

  /** Shared response handling: rate headers first, then the 403-Exceeded choke point. */
  async _handleResponse(res, pool) {
    this._updateRateLimit(res.headers, pool);
    const text = await res.text();
    if (!res.ok) {
      if (isRateLimitError(text)) {
        // AC-7/D1: prefer the server's X-Rate-Limit-Reset when present.
        const rst = parseInt(res.headers.get('x-rate-limit-reset'), 10);
        handleRateLimitExceeded(pool || 'general', Number.isNaN(rst) ? undefined : rst);
      }
      throw new Error(`PVOutput ${res.status}: ${text.slice(0, 200)}`);
    }
    return text;
  }

  /** GET request — returns response body text. */
  async get(endpoint, params = {}, pool = 'general') {
    const url = new URL(endpoint, BASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString(), { headers: this._headers(), signal: AbortSignal.timeout(15000) });
    return this._handleResponse(res, pool);
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
    return this._handleResponse(res, pool);
  }
}

module.exports = { PVOutputClient };
