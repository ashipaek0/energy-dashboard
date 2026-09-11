export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function getDayName(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

/**
 * Shared numeric predicate for metric values (issue #61 Phase 2, decision D1).
 *
 * Returns true iff `v` is a real, finite JS number. This is a *value-shape*
 * guard, deliberately not keyed on the declared `entry.type`: a stale or
 * mis-declared `value_type` can never make a string value look numeric, so
 * `Math.round(v) -> not-a-number` is impossible at every call site.
 *
 * Deliberately false for numeric-looking strings ('123', '3.5'): the write path
 * routes genuinely numeric payloads to the REAL column, so a numeric-looking
 * string can only mean "this metric is declared text" (D7).
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isNumericValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Render a NON-NUMERIC metric value for display (issue #61 Phase 2, decisions
 * D2/D7). Never returns a not-a-number, undefined or null literal.
 *
 * - booleans and the four stored boolean tokens (`on`/`off`/`true`/`false`,
 *   which the write path lowercases) map to the Title-case pair `On` / `Off`;
 * - strings are returned verbatim (original case), so `'Charging'` -> `'Charging'`;
 * - missing values (`undefined`/`null`) return the `--` placeholder;
 * - non-finite numbers and objects return the `--` placeholder rather than
 *   leaking a not-a-number value or `[object Object]` into the DOM.
 *
 * The caller must write the result with `textContent`/`escapeHtml`, never
 * `innerHTML`.
 *
 * @param {*} v
 * @returns {string}
 */
export function formatValueText(v) {
  if (v === undefined || v === null) return '--';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '--';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'object') return '--';
  const s = String(v);
  const lower = s.trim().toLowerCase();
  if (lower === 'on' || lower === 'true') return 'On';
  if (lower === 'off' || lower === 'false') return 'Off';
  return s;
}
