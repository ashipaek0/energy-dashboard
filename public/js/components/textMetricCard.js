/**
 * textMetricCard — a METRIC-BOUND text card (type key `text-metric`).
 *
 * NOT to be confused with the static note card `textCard.js` (`text-card`), which
 * renders user-typed `config.content` and whose updater is an explicit no-op.
 * This card is bound to a metric and renders that metric's CURRENT value from
 * dashboard state, refreshing on every state push (see updater.js).
 *
 * Block config: { metric: '<metric key>', label: '<optional friendly name>', unit: '<optional suffix>' }
 *
 * NOTE: this module intentionally has ZERO imports. Every DOM write below goes
 * through textContent on elements created with createElement — never innerHTML —
 * so a hostile metric value (or label) is rendered as literal text and cannot
 * execute. Mirrors the invariant called out in textCard.js.
 */

/** Muted placeholder for a block that has no metric configured yet (AC-2c.4a). */
export const NO_METRIC_TEXT = 'Configure a metric';

/** Token for "metric configured, but there is no value to show" (AC-2c.4b/c/d). */
export const EMPTY_VALUE = '\u2014'; // em dash

/**
 * Boolean presentation: the write path lowercases booleans (ha.js and siblings),
 * so the four stored tokens map to a single Title-case pair (AC-2c.1 / C2).
 */
const BOOLEAN_LABELS = { on: 'On', true: 'On', off: 'Off', false: 'Off' };

/**
 * Format a metric entry's value as display text.
 * @param {object|undefined} entry - state.metrics[metric] ({ value, type, unit, ... })
 * @param {string} [unit] - user-configured suffix; appended only for numeric values (C4)
 * @returns {{ text: string, muted: boolean }} `muted` marks the defined empty/no-data state.
 *
 * Rules (AC-2c.1):
 *   number  -> plain String(v), no toFixed; non-finite (NaN/Infinity) -> empty token
 *   string  -> trimmed, verbatim; 'on'/'true'/'off'/'false' tokens -> On/Off
 *   boolean -> On/Off
 *   absent / null / undefined / '' / object -> empty token (never blank, never '[object Object]')
 */
export function formatMetricValue(entry, unit) {
  if (!entry || entry.value === undefined || entry.value === null) {
    return { text: EMPTY_VALUE, muted: true };
  }
  const v = entry.value;

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { text: EMPTY_VALUE, muted: true };
    const suffix = String(unit || '').trim();
    return { text: suffix ? String(v) + ' ' + suffix : String(v), muted: false };
  }

  if (typeof v === 'boolean') return { text: v ? 'On' : 'Off', muted: false };

  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return { text: EMPTY_VALUE, muted: true };
    const lower = trimmed.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_LABELS, lower)) {
      return { text: BOOLEAN_LABELS[lower], muted: false };
    }
    return { text: trimmed, muted: false };
  }

  // Objects, arrays, functions — never render '[object Object]'.
  return { text: EMPTY_VALUE, muted: true };
}

/** Write a formatted result into the value element. textContent only — never innerHTML. */
function applyValue(valEl, result) {
  valEl.textContent = result.text;
  // Theme tokens only — no hardcoded colours (AC-2c.5).
  valEl.style.color = result.muted ? 'var(--text-secondary)' : 'var(--text)';
  valEl.style.fontStyle = result.muted ? 'italic' : 'normal';
}

export function buildTextMetricCard(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const label = config.label || metric;
  const unit = config.unit || '';

  const container = document.createElement('div');
  container.className = 'text-metric-card stat-card';
  container.dataset.blockId = block.id || '';
  // The updater re-reads this off the live DOM node, so a config change only
  // needs a re-render — same convention as gaugeCard/multiValueCard.
  container.dataset.metricMap = JSON.stringify({ metric: metric, unit: unit });
  // Grid safety (AC-2c.6): never wider than the block, allow shrinking, clip residue.
  container.style.cssText = 'min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;height:100%;';

  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'stat-label text-metric-label';
    // Label is user text -> textContent (never innerHTML).
    labelEl.textContent = label;
    container.appendChild(labelEl);
  }

  const valEl = document.createElement('div');
  valEl.className = 'stat-value text-metric-value';
  // Long strings wrap inside the block instead of stretching the grid.
  valEl.style.cssText = 'overflow-wrap:anywhere;word-break:break-word;white-space:normal;max-width:100%;';
  container.appendChild(valEl);

  // Initial paint (builder runs before any state has arrived).
  applyValue(valEl, metric
    ? { text: EMPTY_VALUE, muted: true }
    : { text: NO_METRIC_TEXT, muted: true });

  return container;
}

export function updateTextMetricCard(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.text-metric-card').forEach(container => {
    let cfg = {};
    try { cfg = JSON.parse(container.dataset.metricMap || '{}'); } catch (e) { cfg = {}; }
    const valEl = container.querySelector('.text-metric-value');
    if (!valEl) return;
    const metric = cfg.metric || '';
    if (!metric) {
      // (a) no metric configured
      applyValue(valEl, { text: NO_METRIC_TEXT, muted: true });
      return;
    }
    // (b) value == null, (c) absent from state, (d) no longer in the catalogue —
    // all resolve to the same defined empty token; none of them throw.
    applyValue(valEl, formatMetricValue(metrics[metric], cfg.unit));
  });
}
