#!/usr/bin/env node
/**
 * Epilykos Phase 2c — metric-bound text card (`text-metric`) behavioural test.
 *
 * Run:  node tests/text-metric-card.test.js   (also picked up by `npm test`)
 *
 * Why this shape
 * --------------
 * The repo has no frontend test runner (no devDependencies, no jsdom, no headless
 * browser) so the component cannot be imported the normal way:
 *   - `public/js/components/textMetricCard.js` is an ES module;
 *   - the repo's package.json has no `"type": "module"`, so Node treats a `.js`
 *     file as CommonJS and `require()`ing it throws on the `export` keyword;
 *   - the fixture runner (test/run-all.js) only picks up `*.test.js` files, so a
 *     `.mjs` fixture would never run.
 *
 * The component deliberately has ZERO imports, so its real source is loaded here as
 * a `data:` URL ES module (data: URLs are always parsed as ESM) and the *actual
 * exported functions* are exercised against a ~50-line DOM stub. Nothing is
 * installed, nothing is mocked away at the logic level: `buildTextMetricCard`,
 * `updateTextMetricCard` and `formatMetricValue` run for real.
 *
 * The stub throws if `innerHTML` is ever assigned, so the XSS invariant
 * ("textContent only") is a hard behavioural assertion, not a source grep.
 *
 * NOT covered here (needs a real browser — see the Phase 2c report): CSS layout /
 * grid interaction, theme switching, WebSocket-driven repaint, and the editor UI.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Minimal DOM stub ────────────────────────────────────────────────────
// Models exactly what the component touches: createElement, appendChild,
// className, dataset, style, textContent, querySelector(All) by class.
function createDocument() {
  const created = [];

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.style = {};
      this.className = '';
      this._text = '';
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text; }
    // Any innerHTML write is a defect: the card must use textContent only.
    set innerHTML(_v) { throw new Error('innerHTML was assigned — XSS invariant violated'); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    _classes() { return String(this.className).split(/\s+/).filter(Boolean); }
    _descendants(out) {
      for (const c of this.children) { out.push(c); c._descendants(out); }
      return out;
    }
    querySelector(sel) { const m = this.querySelectorAll(sel); return m.length ? m[0] : null; }
    querySelectorAll(sel) {
      const cls = sel.charAt(0) === '.' ? sel.slice(1) : null;
      return this._descendants([]).filter(e => !cls || e._classes().indexOf(cls) !== -1);
    }
  }

  const stub = {
    createElement(tag) { const e = new El(tag); created.push(e); return e; },
    // Document-level lookups see only detached roots (what buildTextMetricCard returns).
    querySelectorAll(sel) {
      const cls = sel.charAt(0) === '.' ? sel.slice(1) : null;
      return created.filter(e => e.parentNode === null && (!cls || e._classes().indexOf(cls) !== -1));
    }
  };
  return { stub, created };
}

// ── tiny assertion harness (fixtures are plain-node assert scripts) ─────
let failures = 0;
let passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  \u2713 ' + name); }
  catch (e) { failures++; console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'expected truthy'); }

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'textMetricCard.js');

(async function main() {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  if (/(^|\n)\s*import\s/.test(src)) {
    console.error('textMetricCard.js gained an import; the data:-URL loader can no longer resolve it.');
    process.exit(1);
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { buildTextMetricCard, updateTextMetricCard, formatMetricValue, EMPTY_VALUE, NO_METRIC_TEXT } = mod;

  console.log('text-metric card \u2014 formatMetricValue (AC-2c.1)');
  check('number renders as its plain value (no toFixed)', () =>
    eq(formatMetricValue({ value: 4200, type: 'number' }).text, '4200'));
  check('number keeps an explicit unit suffix', () =>
    eq(formatMetricValue({ value: 4200, type: 'number' }, ' W').text, '4200 W'));
  check('blank unit adds no trailing space', () =>
    eq(formatMetricValue({ value: 7, type: 'number' }, '  ').text, '7'));
  check('NaN number falls back to the empty token', () =>
    eq(formatMetricValue({ value: NaN, type: 'number' }).text, EMPTY_VALUE));
  check('Infinity falls back to the empty token', () =>
    eq(formatMetricValue({ value: Infinity, type: 'number' }).text, EMPTY_VALUE));
  check('string renders verbatim', () =>
    eq(formatMetricValue({ value: 'Charging', type: 'string' }).text, 'Charging'));
  check('string is trimmed', () =>
    eq(formatMetricValue({ value: '  FAULT  ', type: 'string' }).text, 'FAULT'));
  check('on / true -> On', () => {
    eq(formatMetricValue({ value: 'on', type: 'boolean' }).text, 'On');
    eq(formatMetricValue({ value: 'true', type: 'boolean' }).text, 'On');
  });
  check('off / false -> Off', () => {
    eq(formatMetricValue({ value: 'off', type: 'boolean' }).text, 'Off');
    eq(formatMetricValue({ value: 'false', type: 'boolean' }).text, 'Off');
  });
  check('boolean JS value -> On/Off', () => {
    eq(formatMetricValue({ value: true, type: 'boolean' }).text, 'On');
    eq(formatMetricValue({ value: false, type: 'boolean' }).text, 'Off');
  });
  check('boolean tokens are wrapped even without a declared type', () =>
    eq(formatMetricValue({ value: 'ON' }).text, 'On'));
  check('empty / whitespace string -> empty token', () => {
    eq(formatMetricValue({ value: '', type: 'string' }).text, EMPTY_VALUE);
    eq(formatMetricValue({ value: '   ', type: 'string' }).text, EMPTY_VALUE);
  });
  check('missing entry / null / undefined -> empty token', () => {
    eq(formatMetricValue(undefined).text, EMPTY_VALUE);
    eq(formatMetricValue(null).text, EMPTY_VALUE);
    eq(formatMetricValue({ value: null }).text, EMPTY_VALUE);
    eq(formatMetricValue({ value: undefined }).text, EMPTY_VALUE);
  });
  check('object value never renders "[object Object]"', () =>
    eq(formatMetricValue({ value: { a: 1 } }).text, EMPTY_VALUE));
  check('empty states are flagged muted, real values are not', () => {
    ok(formatMetricValue(undefined).muted === true, 'missing should be muted');
    ok(formatMetricValue({ value: 'Charging' }).muted === false, 'string should not be muted');
    ok(formatMetricValue({ value: 1 }).muted === false, 'number should not be muted');
  });
  check('no result ever contains NaN/undefined/null/[object Object]', () => {
    const samples = [{ value: NaN }, { value: undefined }, { value: null }, { value: {} },
      { value: '' }, { value: 'x' }, { value: 0 }, { value: Infinity }];
    for (const s of samples) {
      const t = formatMetricValue(s).text;
      ok(t.indexOf('NaN') === -1, 'NaN leaked: ' + t);
      ok(t.indexOf('undefined') === -1, 'undefined leaked: ' + t);
      ok(t.indexOf('null') === -1, 'null leaked: ' + t);
      ok(t.indexOf('[object') === -1, '[object Object] leaked: ' + t);
      ok(t.length > 0, 'blank output');
    }
  });

  console.log('text-metric card \u2014 builder (AC-2c.2/.3/.5/.6)');
  const { stub, created } = createDocument();
  global.document = stub;

  check('container is a text-metric-card and carries metric+unit in dataset', () => {
    const card = buildTextMetricCard({ id: 'b1', config: { metric: 'inverter_state', label: 'Inverter', unit: 'V' } });
    ok(card._classes().indexOf('text-metric-card') !== -1, 'missing text-metric-card class');
    eq(card.dataset.blockId, 'b1');
    eq(card.dataset.metricMap, JSON.stringify({ metric: 'inverter_state', unit: 'V' }));
  });
  check('configured label is shown, over the raw key', () => {
    const card = buildTextMetricCard({ id: 'b1', config: { metric: 'inverter_state', label: 'Inverter' } });
    eq(card.querySelector('.text-metric-label').textContent, 'Inverter');
  });
  check('label falls back to the raw metric key (no friendly-name helper exists)', () => {
    const card = buildTextMetricCard({ id: 'b2', config: { metric: 'inverter_state' } });
    eq(card.querySelector('.text-metric-label').textContent, 'inverter_state');
  });
  check('no metric configured -> muted placeholder in the value slot', () => {
    const card = buildTextMetricCard({ id: 'b3', config: {} });
    eq(card.querySelector('.text-metric-value').textContent, NO_METRIC_TEXT);
    eq(card.querySelector('.text-metric-label'), null);
  });
  check('metric configured but no state yet -> empty token, not blank', () => {
    const card = buildTextMetricCard({ id: 'b4', config: { metric: 'm' } });
    eq(card.querySelector('.text-metric-value').textContent, EMPTY_VALUE);
  });
  check('user-typed label is written as text, never parsed as markup', () => {
    const card = buildTextMetricCard({ id: 'b5', config: { metric: 'm', label: '<img src=x onerror=alert(1)>' } });
    const label = card.querySelector('.text-metric-label');
    eq(label.textContent, '<img src=x onerror=alert(1)>');
    eq(label.children.length, 0, 'label must have no element children');
  });
  check('styling uses theme tokens only \u2014 no hardcoded hex', () => {
    const card = buildTextMetricCard({ id: 'b6', config: { metric: 'm' } });
    const val = card.querySelector('.text-metric-value');
    ok(card.style.cssText.indexOf('#') === -1, 'container style has a hex colour');
    ok(val.style.cssText.indexOf('#') === -1, 'value style has a hex colour');
    ok(val.style.color.indexOf('var(--') === 0, 'value colour is not a theme token: ' + val.style.color);
  });
  check('long text: wrap rules + grid-safe shrink allowlist', () => {
    const card = buildTextMetricCard({ id: 'b7', config: { metric: 'm' } });
    const val = card.querySelector('.text-metric-value');
    ok(/overflow-wrap\s*:\s*anywhere/.test(val.style.cssText), 'no overflow-wrap');
    ok(/word-break\s*:\s*break-word/.test(val.style.cssText), 'no word-break');
    ok(/min-width\s*:\s*0/.test(card.style.cssText), 'container cannot shrink (min-width:0 missing)');
    ok(/overflow\s*:\s*hidden/.test(card.style.cssText), 'container does not clip residue');
  });

  console.log('text-metric card \u2014 updater (AC-2c.1/.2/.4/.7)');
  let val;
  const mk = (config) => { const c = buildTextMetricCard({ id: 'u', config: config }); val = c.querySelector('.text-metric-value'); return c; };

  check('string metric renders the live value', () => {
    mk({ metric: 'inverter_state' });
    updateTextMetricCard({ metrics: { inverter_state: { value: 'Charging', type: 'string' } } });
    eq(val.textContent, 'Charging');
  });
  check('XSS payload renders as literal text with no element children', () => {
    mk({ metric: 'evil' });
    updateTextMetricCard({ metrics: { evil: { value: '<img src=x onerror=alert(1)>', type: 'string' } } });
    eq(val.textContent, '<img src=x onerror=alert(1)>');
    eq(val.children.length, 0, 'value element must have no element children');
  });
  check('boolean metric renders On/Off, not lowercase raw', () => {
    mk({ metric: 'grid_relay' });
    updateTextMetricCard({ metrics: { grid_relay: { value: 'on', type: 'boolean' } } });
    eq(val.textContent, 'On');
    updateTextMetricCard({ metrics: { grid_relay: { value: 'false', type: 'boolean' } } });
    eq(val.textContent, 'Off');
  });
  check('numeric metric renders the plain value (+ configured suffix)', () => {
    mk({ metric: 'power', unit: 'W' });
    updateTextMetricCard({ metrics: { power: { value: 4200, type: 'number' } } });
    eq(val.textContent, '4200 W');
  });
  check('value flips number -> text -> boolean in place (no reload)', () => {
    mk({ metric: 'm' });
    updateTextMetricCard({ metrics: { m: { value: 12, type: 'number' } } });
    eq(val.textContent, '12');
    updateTextMetricCard({ metrics: { m: { value: 'FAULT', type: 'string' } } });
    eq(val.textContent, 'FAULT');
    updateTextMetricCard({ metrics: { m: { value: 'off', type: 'boolean' } } });
    eq(val.textContent, 'Off');
  });
  check('value flips has-value -> no-value and back', () => {
    mk({ metric: 'm' });
    updateTextMetricCard({ metrics: { m: { value: 'Charging' } } });
    eq(val.textContent, 'Charging');
    updateTextMetricCard({ metrics: { m: { value: 'Charging' } } }); // same value, idempotent
    eq(val.textContent, 'Charging');
  });
  check('metric configured but absent from state -> empty token, muted, no throw', () => {
    mk({ metric: 'ghost' });
    updateTextMetricCard({ metrics: { other: { value: 1 } } });
    eq(val.textContent, EMPTY_VALUE);
    ok(val.style.color.indexOf('--text-secondary') !== -1, 'empty state must be muted');
  });
  check('metric present with value null -> the same empty token', () => {
    mk({ metric: 'm' });
    updateTextMetricCard({ metrics: { m: { value: null, type: 'string' } } });
    eq(val.textContent, EMPTY_VALUE);
  });
  check('no metric configured stays on the placeholder through updates', () => {
    mk({});
    updateTextMetricCard({ metrics: { m: { value: 'x' } } });
    eq(val.textContent, NO_METRIC_TEXT);
  });
  check('real values are not muted (theme token differs from the empty state)', () => {
    mk({ metric: 'm' });
    updateTextMetricCard({ metrics: { m: { value: 'Charging' } } });
    ok(val.style.color.indexOf('--text') !== -1 && val.style.color.indexOf('--text-secondary') === -1,
      'live value should use var(--text), got ' + val.style.color);
  });
  check('malformed / missing state objects never throw', () => {
    mk({ metric: 'm' });
    updateTextMetricCard(undefined);
    updateTextMetricCard({});
    updateTextMetricCard({ metrics: null });
  });
  check('malformed dataset.metricMap degrades to the placeholder, no throw', () => {
    const card = mk({ metric: 'm' });
    card.dataset.metricMap = 'not-json{';
    updateTextMetricCard({ metrics: { m: { value: 'x' } } });
    eq(card.querySelector('.text-metric-value').textContent, NO_METRIC_TEXT);
  });
  check('multiple cards update independently from one state push', () => {
    const a = buildTextMetricCard({ id: 'a', config: { metric: 'solar_temp' } });
    const b = buildTextMetricCard({ id: 'b', config: { metric: 'battery_mode' } });
    updateTextMetricCard({ metrics: { solar_temp: { value: 42, type: 'number' }, battery_mode: { value: 'Charging', type: 'string' } } });
    eq(a.querySelector('.text-metric-value').textContent, '42');
    eq(b.querySelector('.text-metric-value').textContent, 'Charging');
  });
  check('card is addressable after a second update (stable DOM node)', () => {
    const card = buildTextMetricCard({ id: 'z', config: { metric: 'm' } });
    const first = card.querySelector('.text-metric-value');
    updateTextMetricCard({ metrics: { m: { value: 1 } } });
    updateTextMetricCard({ metrics: { m: { value: 2 } } });
    ok(card.querySelector('.text-metric-value') === first, 'value node was replaced');
    eq(first.textContent, '2');
  });

  console.log('text-metric card \u2014 wiring contract (AC-2c.8; source-level, not behavioural)');
  // The card cannot be rendered in Node (no jsdom/browser), so the end-to-end
  // registration is asserted as a contract over the touched files: registry entry,
  // updater dispatch, palette label, and editor form <-> serialize field ids.
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const indexSrc = read('public/js/components/index.js');
  const updaterSrc = read('public/js/updater.js');
  const editorSrc = read('public/js/editor.js');

  check('builder is registered in componentBuilders', () =>
    ok(/'text-metric':\s*buildTextMetricCard/.test(indexSrc), 'no registry entry in components/index.js'));
  check('builder module is imported and exports both builder and updater', () => {
    ok(/from '\.\/textMetricCard\.js'/.test(indexSrc), 'no import in components/index.js');
    ok(/export function buildTextMetricCard/.test(src), 'buildTextMetricCard not exported');
    ok(/export function updateTextMetricCard/.test(src), 'updateTextMetricCard not exported');
  });
  check('updateWithState dispatches the updater (the "never receives data" gate)', () =>
    ok(/blockTypes\.has\('text-metric'\)\)\s*updateTextMetricCard\(state\)/.test(updaterSrc),
      'no dispatch line in public/js/updater.js'));
  check('palette label is "\uD83D\uDCDD Text Metric" and text-card keeps "\uD83D\uDCDD Text"', () => {
    // editor.js stores the palette labels as \uXXXX escape text — decode before matching.
    const pal = editorSrc.replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    ok(/'text-metric':'\uD83D\uDCDD Text Metric'/.test(pal), 'missing text-metric palette label');
    ok(/'text-card':'\uD83D\uDCDD Text'/.test(pal), 'static text-card palette label changed');
  });
  check('editor form case, serialize case and field ids agree', () => {
    ok(/case 'text-metric':\s*\n\s*html \+= buildTextMetricForm\(block\)/.test(editorSrc), 'no form case');
    ok(/case 'text-metric': \{[\s\S]*?config\.metric = document\.getElementById\('modal-metric-textmetric'\)/.test(editorSrc),
      'serialize case does not read modal-metric-textmetric');
    ok(/metricSelect\(cfg\.metric \|\| '', 'modal-metric-textmetric'\)/.test(editorSrc),
      'form does not render the modal-metric-textmetric select');
    ok(/config\.label = document\.getElementById\('modal-textmetric-label'\)/.test(editorSrc), 'label not serialized');
    ok(/id="modal-textmetric-label"/.test(editorSrc), 'label input id missing');
    ok(/config\.unit = document\.getElementById\('modal-textmetric-unit'\)/.test(editorSrc), 'unit not serialized');
    ok(/id="modal-textmetric-unit"/.test(editorSrc), 'unit input id missing');
  });
  check('dashboard.js hasMetric gate is NOT extended to text-metric (Chart.js stays off)', () => {
    const dashSrc = read('public/js/dashboard.js');
    ok(/const hasMetric = active\.layout\.some\(b => b\.type === 'chart-metric'\);/.test(dashSrc),
      'dashboard.js:323 hasMetric gate changed');
    ok(dashSrc.indexOf("'text-metric'") === -1, 'text-metric leaked into dashboard.js');
  });
  check('existing static text-card is untouched', () => {
    const cardSrc = read('public/js/components/textCard.js');
    ok(/container\.textContent = config\.content \|\| '';/.test(cardSrc), 'textCard content line changed');
    ok(/export function updateTextCard\(state\) \{ \/\* static \*\/ \}/.test(cardSrc), 'textCard no-op updater changed');
    ok(/export function buildTextCard\(block = \{\}\)/.test(cardSrc), 'textCard builder changed');
  });

  console.log('');
  console.log('text-metric card: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('text-metric card test crashed: ' + (e && e.stack || e));
  process.exit(1);
});
