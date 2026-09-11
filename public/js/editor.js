import { fetchDashboardConfig, saveDashboardConfig, fetchDashboardState } from './api.js';
import { componentBuilders } from './components/index.js';

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

let grid = null, dashboardConfig = null, currentTabId = null, unsaved = false;
let currentEditingBlock = null;  // block being edited in settings modal
let availableMetrics = [];       // metric names from dashboard state

function markUnsaved() { unsaved = true; document.getElementById('unsaved-indicator').classList.add('show'); }
function clearUnsaved() { unsaved = false; document.getElementById('unsaved-indicator').classList.remove('show'); }
function showLoading(msg) { let o = document.getElementById('loading-overlay'); if (!o) { o = document.createElement('div'); o.id = 'loading-overlay'; o.className = 'loading-overlay'; o.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p id="loading-message"></p></div>'; document.body.appendChild(o); } document.getElementById('loading-message').textContent = msg; o.style.display = 'flex'; }
function hideLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'none'; }

async function persistLayout() {
  if (!grid) return;
  var items = grid.getGridItems();
  var layout = [];
  items.forEach(function(el) {
    var n = el.gridstackNode;
    var block = { id: el.dataset.blockId, type: el.dataset.blockType, gridX: n.x, gridY: n.y, gridW: n.w, gridH: n.h, enabled: true, config: {} };
    var existing = null;
    var tabs = dashboardConfig.dashboards;
    for (var ti = 0; ti < tabs.length; ti++) {
      if (tabs[ti].id === currentTabId) {
        for (var li = 0; li < tabs[ti].layout.length; li++) {
          if (tabs[ti].layout[li].id === el.dataset.blockId) { existing = tabs[ti].layout[li]; break; }
        }
        break;
      }
    }
    if (existing) { block.config = existing.config; block.transparent = existing.transparent; block.bgColor = existing.bgColor; block.fontColor = existing.fontColor; block.fontSize = existing.fontSize; if (existing.metrics) block.metrics = existing.metrics; if (existing.cards) block.cards = existing.cards; if (existing.columns) block.columns = existing.columns; }
    layout.push(block);
  });
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; });
  if (tab) { tab.layout = layout; tab.name = document.getElementById('dash-name-input').value || tab.name; }
  try {
    await saveDashboardConfig(dashboardConfig);
    return true;
  } catch (e) {
    console.warn('Save failed:', e);
    return false;
  }
}

function refreshTabSelect() {
  var ts = document.getElementById('tab-select');
  ts.innerHTML = '';
  dashboardConfig.dashboards.forEach(function(db) {
    var o = document.createElement('option'); o.value = db.id; o.textContent = db.name; o.selected = db.id === currentTabId;
    ts.appendChild(o);
  });
}

// ── Settings Modal ──────────────────────────────────────────────────────

function showSettingsModal() {
  document.getElementById('settings-modal-overlay').style.display = 'flex';
}
function hideSettingsModal() {
  document.getElementById('settings-modal-overlay').style.display = 'none';
  currentEditingBlock = null;
}

/** Build a <select> dropdown with metric options */
function metricSelect(selectedName, existingId, extraOptions) {
  var id = existingId || ('ms_' + Math.random().toString(36).slice(2,8));
  var sel = '<select id="' + id + '" style="width:100%;padding:0.35rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;">';
  sel += '<option value="">-- select --</option>';
  for (var i = 0; i < availableMetrics.length; i++) {
    var m = availableMetrics[i];
    sel += '<option value="' + escHtml(m) + '"' + (m === selectedName ? ' selected' : '') + '>' + escHtml(m) + '</option>';
  }
  // Additive per-block overrides (e.g. computed 'battery_power' for chart-power) not present as live metrics.
  if (extraOptions) {
    for (var j = 0; j < extraOptions.length; j++) {
      var eo = extraOptions[j];
      if (availableMetrics.indexOf(eo.value) !== -1) continue;
      sel += '<option value="' + escHtml(eo.value) + '"' + (eo.value === selectedName ? ' selected' : '') + '>' + escHtml(eo.label) + '</option>';
    }
  }
  sel += '</select>';
  return sel;
}

/** Build common appearance fields: enabled, transparent, bgColor, fontColor, fontSize */
function buildAppearanceFields(block) {
  var config = block.config || {};
  var bgColor = block.bgColor || config.bgColor || '';
  var fontColor = block.fontColor || config.fontColor || '';
  var fontSize = block.fontSize || config.fontSize || '';
  var transparent = !!(block.transparent || config.transparent);
  return [
    '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">',
    '<legend style="font-weight:600;font-size:0.9rem;">Appearance</legend>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">',
    '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-enabled"' + (block.enabled !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-enabled">Enabled</label></span>',
    '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-transparent"' + (transparent ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-transparent">Transparent</label></span>',
    '<label style="font-size:0.85rem;">Bg Color <input type="color" id="modal-bgcolor" value="' + escHtml(bgColor) + '" data-dirty="false" style="display:block;width:100%;min-height:36px;margin-top:0.15rem;"></label>',
    '<label style="font-size:0.85rem;">Font Color <input type="color" id="modal-fontcolor" value="' + escHtml(fontColor) + '" data-dirty="false" style="display:block;width:100%;min-height:36px;margin-top:0.15rem;"></label>',
    '</div>',
    '<label style="font-size:0.85rem;display:block;margin-top:0.5rem;">Font Size <input type="text" id="modal-fontsize" value="' + escHtml(fontSize) + '" placeholder="e.g. 0.9rem" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>',
    '</fieldset>'
  ].join('\n');
}

/** Flow Card: metrics object with dropdowns */
function buildFlowCardForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['solar','battery_soc','battery_charge','battery_discharge','consumption','grid_import','grid_export'];
  var labels = {solar:'Solar',battery_soc:'Battery SoC',battery_charge:'Battery Charge',battery_discharge:'Battery Discharge',consumption:'Consumption',grid_import:'Grid Import',grid_export:'Grid Export'};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
    html += '<span style="width:100px;font-size:0.85rem;text-align:right;">' + labels[s] + '</span>';
    html += '<div style="flex:1;">' + metricSelect(metrics[s] || s, 'modal-metric-' + s) + '</div>';
    html += '</div>';
  }
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-showgauge"' + (cfg.showGauge !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-showgauge">Show solar gauge</label></span>';
  html += '</fieldset>';
  return html;
}

/** System Topology (flow-card-2) / Flow Card Square / Flow Card Square 2: same metrics shape */
function buildSystemTopologyForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['solar','grid_import','battery_charge','battery_soc','consumption','battery_discharge','grid_export'];
  var labels = {solar:'Solar',grid_import:'Grid Import',battery_charge:'Battery Charge',battery_soc:'Battery SoC',consumption:'Consumption',battery_discharge:'Battery Discharge',grid_export:'Grid Export'};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
    html += '<span style="width:100px;font-size:0.85rem;text-align:right;">' + labels[s] + '</span>';
    html += '<div style="flex:1;">' + metricSelect(metrics[s] || s, 'modal-metric-' + s) + '</div>';
    html += '</div>';
  }
  html += '<label style="font-size:0.85rem;display:block;margin-top:0.4rem;">Inverter Image URL <input type="text" id="modal-inverter-image" value="' + escHtml(cfg.inverter_image || '') + '" placeholder="https://..." style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</fieldset>';
  return html;
}

/** Multi-Value Card: metrics array */
function buildMultiValueForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Array</legend>';
  html += '<div id="mv-rows"></div>';
  html += '<button type="button" id="mv-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="mv-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderMultiValueRows(container) {
  var dataEl = container.querySelector('#mv-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#mv-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="mv-row" style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;">';
    html += '<input type="text" class="mv-label" value="' + escHtml(r.label || '') + '" placeholder="Label" style="flex:1;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += metricSelect(r.metric || '', 'mv-metric-' + i);
    html += '<input type="text" class="mv-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" style="width:60px;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<button type="button" class="mv-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove row">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  // Add row handler
  var addBtn = container.querySelector('#mv-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '' });
      dataEl.textContent = JSON.stringify(current);
      renderMultiValueRows(container);
    };
  }
  // Remove handlers
  container.querySelectorAll('.mv-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderMultiValueRows(container);
    };
  });
}

/** Bar Gauge: metrics array with min/max/color/gradient */
function buildBarGaugeForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Array</legend>';
  html += '<div id="bg-rows"></div>';
  html += '<button type="button" id="bg-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="bg-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarGaugeRows(container) {
  var dataEl = container.querySelector('#bg-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bg-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bg-row" style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem;margin-bottom:0.5rem;padding:0.4rem;border:1px solid var(--border);border-radius:0.3rem;">';
    html += '<input type="text" class="bg-label" value="' + escHtml(r.label || '') + '" placeholder="Label" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;grid-column:1/-1;">';
    html += '<div style="grid-column:1/-1;display:flex;gap:0.25rem;">';
    html += metricSelect(r.metric || '', 'bg-metric-' + i);
    html += '<input type="text" class="bg-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" style="width:60px;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '</div>';
    html += '<input type="number" class="bg-min" value="' + escHtml(r.min ?? 0) + '" placeholder="Min" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<input type="number" class="bg-max" value="' + escHtml(r.max ?? 100) + '" placeholder="Max" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<label style="font-size:0.8rem;display:flex;align-items:center;gap:0.2rem;">Color <input type="color" class="bg-color" value="' + escHtml(r.color || '') + '" style="width:36px;height:24px;"></label>';
    html += '<label style="font-size:0.8rem;display:flex;align-items:center;gap:0.2rem;">Grad <input type="text" class="bg-gradient" value="' + escHtml(r.gradient || '') + '" placeholder="#f00,#0f0" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;"></label>';
    html += '<button type="button" class="bg-remove row-remove-btn" data-idx="' + i + '" style="grid-column:1/-1;" aria-label="Remove row">✕ Remove</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bg-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '', min: 0, max: 100, color: '', gradient: '' });
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRows(container);
    };
  }
  container.querySelectorAll('.bg-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRows(container);
    };
  });
}

/** Bar Gauge Retro: same as bar gauge + segments */
function buildBarGaugeRetroForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Array</legend>';
  html += '<div id="bgr-rows"></div>';
  html += '<button type="button" id="bgr-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="bgr-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarGaugeRetroRows(container) {
  var dataEl = container.querySelector('#bgr-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bgr-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bgr-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.25rem;margin-bottom:0.5rem;padding:0.4rem;border:1px solid var(--border);border-radius:0.3rem;">';
    html += '<input type="text" class="bgr-label" value="' + escHtml(r.label || '') + '" placeholder="Label" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;grid-column:1/-1;">';
    html += '<div style="grid-column:1/-1;display:flex;gap:0.25rem;">';
    html += metricSelect(r.metric || '', 'bgr-metric-' + i);
    html += '<input type="text" class="bgr-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" style="width:60px;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '</div>';
    html += '<input type="number" class="bgr-min" value="' + escHtml(r.min ?? 0) + '" placeholder="Min" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<input type="number" class="bgr-max" value="' + escHtml(r.max ?? 100) + '" placeholder="Max" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<input type="number" class="bgr-segments" value="' + escHtml(r.segments || 10) + '" placeholder="Segments" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<label style="font-size:0.8rem;display:flex;align-items:center;gap:0.2rem;">C <input type="color" class="bgr-color" value="' + escHtml(r.color || '') + '" style="width:36px;height:24px;"></label>';
    html += '<label style="font-size:0.8rem;display:flex;align-items:center;gap:0.2rem;">Grad <input type="text" class="bgr-gradient" value="' + escHtml(r.gradient || '') + '" placeholder="#f00,#0f0" style="padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;"></label>';
    html += '<button type="button" class="bgr-remove row-remove-btn" data-idx="' + i + '" style="grid-column:1/-1;" aria-label="Remove row">✕ Remove</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bgr-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '', min: 0, max: 100, color: '', gradient: '', segments: 10 });
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRetroRows(container);
    };
  }
  container.querySelectorAll('.bgr-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRetroRows(container);
    };
  });
}

/** Gauge / Half Gauge / Half Gauge 2: single metric */
function buildGaugeForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Gauge Config</legend>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:60px;font-size:0.85rem;">Metric</span>';
  html += '<div style="flex:1;">' + metricSelect(cfg.metric || '', 'modal-metric-gauge') + '</div>';
  html += '</div>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-gauge-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.35rem;">';
  html += '<label style="font-size:0.85rem;">Min <input type="number" id="modal-gauge-min" value="' + escHtml(cfg.min ?? 0) + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<label style="font-size:0.85rem;">Max <input type="number" id="modal-gauge-max" value="' + escHtml(cfg.max ?? 100) + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</div>';
  html += '<label style="font-size:0.85rem;display:block;margin-top:0.35rem;">Color <input type="color" id="modal-gauge-color" value="' + escHtml(cfg.color || '#f59e0b') + '" style="display:block;width:100%;min-height:36px;margin-top:0.15rem;"></label>';
  html += '</fieldset>';
  return html;
}

/** Metric Cards: cards array */
function buildMetricCardsForm(block) {
  var cfg = block.config || {};
  var cards = block.cards || [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metric Cards</legend>';
  html += '<div id="mc-rows"></div>';
  html += '<button type="button" id="mc-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add Card</button>';
  html += '</fieldset>';
  html += '<script id="mc-data" type="application/json">' + JSON.stringify(cards).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderMetricCardsRows(container) {
  var dataEl = container.querySelector('#mc-data');
  var cards = [];
  try { cards = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#mc-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i] || {};
    html += '<div class="mc-row" style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;">';
    html += '<input type="text" class="mc-title" value="' + escHtml(c.title || '') + '" placeholder="Label" style="flex:1;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += metricSelect(c.metric || '', 'mc-metric-' + i);
    html += '<input type="text" class="mc-unit" value="' + escHtml(c.unit || '') + '" placeholder="Unit" style="width:60px;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<button type="button" class="mc-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#mc-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ title: '', metric: '', unit: '' });
      dataEl.textContent = JSON.stringify(current);
      renderMetricCardsRows(container);
    };
  }
  container.querySelectorAll('.mc-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderMetricCardsRows(container);
    };
  });
}

/** Data Tables: column toggles */
function buildDataTableForm(block) {
  var cfg = block.config || {};
  var columns = cfg.columns || [];
  var allColFields = ['consumption_kwh','solar_kwh','battery_charge_kwh','battery_discharge_kwh','grid_import_kwh','grid_export_kwh'];
  var colLabels = {consumption_kwh:'Load (kWh)',solar_kwh:'Solar PV (kWh)',battery_charge_kwh:'Battery Charged (kWh)',battery_discharge_kwh:'Battery Discharged (kWh)',grid_import_kwh:'Grid Used (kWh)',grid_export_kwh:'Grid Exported (kWh)'};
  var enabledFields = {};
  columns.forEach(function(c) { enabledFields[c.field] = true; });
  // If no columns configured, all are enabled
  if (columns.length === 0) {
    allColFields.forEach(function(f) { enabledFields[f] = true; });
  }
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Columns</legend>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-table-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.3rem;">';
  for (var i = 0; i < allColFields.length; i++) {
    var f = allColFields[i];
    html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" class="col-toggle" data-field="' + f + '"' + (enabledFields[f] ? ' checked' : '') + '><span class="slider"></span></label><label style="font-size:0.85rem;cursor:pointer;">' + colLabels[f] + '</label></span>';
  }
  html += '</div></fieldset>';
  return html;
}

/** Text Card: content textarea */
function buildTextCardForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Content</legend>';
  html += '<textarea id="modal-text-content" style="width:100%;min-height:120px;padding:0.5rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);font-size:0.85rem;resize:vertical;">' + escHtml(cfg.content || '') + '</textarea>';
  html += '</fieldset>';
  return html;
}

/** Text Metric: metric dropdown + optional friendly label + optional unit suffix */
function buildTextMetricForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Text Metric</legend>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Metric</span>';
  html += '<div style="flex:1;">' + metricSelect(cfg.metric || '', 'modal-metric-textmetric') + '</div>';
  html += '</div>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Label <input type="text" id="modal-textmetric-label" value="' + escHtml(cfg.label || '') + '" placeholder="Falls back to the metric key" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<label style="font-size:0.85rem;display:block;">Unit suffix <input type="text" id="modal-textmetric-unit" value="' + escHtml(cfg.unit || '') + '" placeholder="Optional; appended to numeric values only" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</fieldset>';
  return html;
}

/** Iframe Card: URL input */
function buildIframeCardForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Embed URL</legend>';
  html += '<label style="font-size:0.85rem;">URL <input type="text" id="modal-iframe-url" value="' + escHtml(cfg.url || '') + '" placeholder="https://..." style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</fieldset>';
  return html;
}

/** Battery Block: metrics map */
function buildBatteryBlockForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['soc','voltage','current','power','temperature'];
  var labels = {soc:'SoC',voltage:'Voltage',current:'Current',power:'Power',temperature:'Temperature'};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
    html += '<span style="width:100px;font-size:0.85rem;text-align:right;">' + labels[s] + '</span>';
    html += '<div style="flex:1;">' + metricSelect(metrics[s] || '', 'modal-metric-batt-' + s) + '</div>';
    html += '</div>';
  }
  html += '<label style="font-size:0.85rem;display:block;margin-top:0.4rem;">Title <input type="text" id="modal-batt-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</fieldset>';
  return html;
}

/** Grid Card: grid_status metric */
function buildGridCardForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Grid Status Config</legend>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Metric</span>';
  html += '<div style="flex:1;">' + metricSelect(metrics.grid_status || '', 'modal-metric-grid-status') + '</div>';
  html += '</div>';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-showtimeline"' + (cfg.showTimeline !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-showtimeline">Show timeline</label></span>';
  html += '</fieldset>';
  return html;
}

/** Chart Power / Chart Energy: datasets */
function buildChartForm(block, showFill) {
  var cfg = block.config || {};
  var datasets = cfg.datasets || [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Options</legend>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-chart-hidegrid"' + (cfg.hideGrid ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-chart-hidegrid">Hide Grid</label></span>';
  if (showFill) {
    html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-chart-fill"' + (cfg.fill !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-chart-fill">Fill Gradient</label></span>';
  }
  html += '</div></fieldset>';
  html += '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Datasets</legend>';
  html += '<div id="chart-rows"></div>';
  html += '<button type="button" id="chart-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add Dataset</button>';
  html += '<label style="font-size:0.85rem;display:block;margin-top:0.4rem;">Title <input type="text" id="modal-chart-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</fieldset>';
  html += '<script id="chart-data" type="application/json">' + JSON.stringify(datasets).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderChartRows(container, showUnit, extraOptions) {
  var dataEl = container.querySelector('#chart-data');
  var datasets = [];
  try { datasets = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#chart-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < datasets.length; i++) {
    var d = datasets[i] || {};
    html += '<div class="chart-row" style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;">';
    html += '<input type="text" class="chart-label" value="' + escHtml(d.label || '') + '" placeholder="Label" style="flex:1;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += metricSelect(d.metric || '', 'chart-metric-' + i, extraOptions);
    if (showUnit) {
      html += '<input type="text" class="chart-unit" value="' + escHtml(d.unit || '') + '" placeholder="Unit" title="Measurement unit (e.g. %, kWh, kW, V, hours)" style="width:4rem;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.8rem;">';
      html += '<input type="number" step="any" class="chart-scale" value="' + String(d.scale != null ? d.scale : 1) + '" placeholder="Scale" title="Multiply values by this factor (e.g. 0.001 for W->kW)" style="width:4.5rem;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.8rem;">';
    }
    html += '<label style="font-size:0.75rem;display:flex;align-items:center;gap:0.15rem;">C <input type="color" class="chart-color" value="' + escHtml(d.color || '#888888') + '" style="width:30px;height:20px;"></label>';
    html += '<button type="button" class="chart-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#chart-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', color: '#888888' });
      dataEl.textContent = JSON.stringify(current);
      renderChartRows(container, showUnit, extraOptions);
    };
  }
  container.querySelectorAll('.chart-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderChartRows(container, showUnit, extraOptions);
    };
  });
}

/** Forecast blocks / weather / savings: simple title + metric if applicable */
function buildSimpleForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Config</legend>';

  if (block.type === 'savings-summary') {
    html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
    html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
    html += '<span style="width:80px;font-size:0.85rem;">Metric</span>';
    html += '<div style="flex:1;">' + metricSelect(cfg.savings_metric || '', 'modal-simple-metric') + '</div>';
    html += '</div>';
  } else if (block.type === 'forecast-pvtoday') {
    html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Location Name <input type="text" id="modal-simple-title" value="' + escHtml(cfg.location_name || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
    html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
    html += '<span style="width:80px;font-size:0.85rem;">Metric</span>';
    html += '<div style="flex:1;">' + metricSelect((cfg.metrics || {}).generated || '', 'modal-simple-metric') + '</div>';
    html += '</div>';
  } else if (block.type === 'weather-block') {
    html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  } else if (block.type === 'forecast-banner' || block.type === 'forecast-info' || block.type === 'forecast-sparkline') {
    html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  } else {
    html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  }

  html += '</fieldset>';
  return html;
}

/** Switch Block: entity metric, source, label, action, on/off icons + colors */
function buildSwitchBlockForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">Toggle Switch Config</legend>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Entity</span>';
  html += '<div style="flex:1;">' + metricSelect(cfg.entity || '', 'modal-switch-entity') + '</div>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Source</span>';
  html += '<input type="text" id="modal-switch-source" value="' + escHtml(cfg.source || 'ha') + '" placeholder="ha" style="flex:1;padding:0.35rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;">';
  html += '</div>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Label <input type="text" id="modal-switch-label" value="' + escHtml(cfg.label || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Action <input type="text" id="modal-switch-action" value="' + escHtml(cfg.action || 'switch.toggle') + '" placeholder="switch.toggle" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">';
  html += '<label style="font-size:0.85rem;">On Color <input type="color" id="modal-switch-oncolor" value="' + escHtml(cfg.onColor || '') + '" data-dirty="false" style="display:block;width:100%;min-height:36px;margin-top:0.15rem;"></label>';
  html += '<label style="font-size:0.85rem;">Off Color <input type="color" id="modal-switch-offcolor" value="' + escHtml(cfg.offColor || '') + '" data-dirty="false" style="display:block;width:100%;min-height:36px;margin-top:0.15rem;"></label>';
  html += '<label style="font-size:0.85rem;">On Icon <input type="text" id="modal-switch-onicon" value="' + escHtml(cfg.onIcon || '') + '" placeholder="🔆" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<label style="font-size:0.85rem;">Off Icon <input type="text" id="modal-switch-officon" value="' + escHtml(cfg.offIcon || '') + '" placeholder="🔅" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '</div>';
  html += '</fieldset>';
  return html;
}

/** State Select Block: entity, source, label, action, display style, state-list editor */
function buildStateSelectForm(block) {
  var cfg = block.config || {};
  var states = Array.isArray(cfg.states) ? cfg.states : [];
  var html = '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">State Select Config</legend>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Entity</span>';
  html += '<div style="flex:1;">' + metricSelect(cfg.entity || '', 'modal-state-entity') + '</div>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Source</span>';
  html += '<input type="text" id="modal-state-source" value="' + escHtml(cfg.source || 'ha') + '" placeholder="ha" style="flex:1;padding:0.35rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;">';
  html += '</div>';
  html += '<label style="font-size:0.85rem;display:block;margin-bottom:0.35rem;">Label <input type="text" id="modal-state-label" value="' + escHtml(cfg.label || '') + '" style="display:block;width:100%;padding:0.35rem;margin-top:0.15rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;"></label>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Action</span>';
  html += '<input type="text" id="modal-state-action" value="' + escHtml(cfg.action || 'select.select_option') + '" placeholder="select.select_option" style="flex:1;padding:0.35rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;">';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">';
  html += '<span style="width:80px;font-size:0.85rem;">Display</span>';
  html += '<select id="modal-state-displaystyle" style="flex:1;padding:0.35rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;">';
  html += '<option value="buttons"' + (cfg.displayStyle !== 'dropdown' ? ' selected' : '') + '>Button group</option>';
  html += '<option value="dropdown"' + (cfg.displayStyle === 'dropdown' ? ' selected' : '') + '>Dropdown</option>';
  html += '</select>';
  html += '</div>';
  html += '</fieldset>';
  html += '<fieldset style="border:1px solid var(--border);border-radius:0.4rem;padding:0.75rem;margin-bottom:0.75rem;">';
  html += '<legend style="font-weight:600;font-size:0.9rem;">States</legend>';
  html += '<div id="state-rows"></div>';
  html += '<button type="button" id="state-add-row" style="background:var(--border);color:var(--text);border:none;padding:0.4rem 0.75rem;border-radius:0.4rem;cursor:pointer;font-size:0.85rem;margin-top:0.4rem;min-height:36px;">+ Add State</button>';
  html += '</fieldset>';
  html += '<script id="state-data" type="application/json">' + JSON.stringify(states).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderStateSelectRows(container) {
  var dataEl = container.querySelector('#state-data');
  var states = [];
  try { states = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#state-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < states.length; i++) {
    var st = states[i];
    var val = (st && typeof st === 'object') ? (st.value ?? '') : (st ?? '');
    var lbl = (st && typeof st === 'object' && st.label != null) ? st.label : val;
    var col = (st && typeof st === 'object' && st.color) ? st.color : '';
    html += '<div class="state-row" style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;">';
    html += '<input type="text" class="state-value" value="' + escHtml(String(val)) + '" placeholder="value" style="flex:1;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<input type="text" class="state-label" value="' + escHtml(String(lbl)) + '" placeholder="label" style="flex:1;padding:0.3rem;border:1px solid var(--border);border-radius:0.3rem;background:var(--bg);color:var(--text);min-height:36px;font-size:0.85rem;">';
    html += '<label style="font-size:0.75rem;display:flex;align-items:center;gap:0.15rem;">C <input type="color" class="state-color" value="' + escHtml(col || '#888888') + '" data-dirty="false" style="width:30px;height:20px;"></label>';
    html += '<button type="button" class="state-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;

  // Only persist a color if the user actually changed it
  rowsEl.querySelectorAll('.state-color').forEach(function(c) {
    c.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  });

  rowsEl.querySelectorAll('.state-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderStateSelectRows(container);
    };
  });

  var addBtn = container.querySelector('#state-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ value: '', label: '' });
      dataEl.textContent = JSON.stringify(current);
      renderStateSelectRows(container);
    };
  }
}

/** Main entry: build the settings form for a given block type */
function buildSettingsForm(block) {
  var type = block.type;
  var html = '';

  // Common appearance fields
  html += buildAppearanceFields(block);

  // Type-specific fields
  switch (type) {
    case 'flow-card':
      html += buildFlowCardForm(block);
      break;
    case 'flow-card-2':
    case 'flow-card-square':
    case 'flow-card-square-2':
      html += buildSystemTopologyForm(block);
      break;
    case 'multi-value':
      html += buildMultiValueForm(block);
      break;
    case 'bar-gauge':
      html += buildBarGaugeForm(block);
      break;
    case 'bar-gauge-retro':
      html += buildBarGaugeRetroForm(block);
      break;
    case 'gauge-card':
    case 'half-gauge':
    case 'half-gauge-2':
      html += buildGaugeForm(block);
      break;
    case 'metric-cards':
      html += buildMetricCardsForm(block);
      break;
    case 'data-table-daily':
    case 'data-table-monthly':
      html += buildDataTableForm(block);
      break;
    case 'text-card':
      html += buildTextCardForm(block);
      break;
    case 'text-metric':
      html += buildTextMetricForm(block);
      break;
    case 'iframe-card':
      html += buildIframeCardForm(block);
      break;
    case 'battery-block':
      html += buildBatteryBlockForm(block);
      break;
    case 'grid-card':
      html += buildGridCardForm(block);
      break;
    case 'chart-power':
      html += buildChartForm(block, true);
      break;
    case 'chart-metric':
      html += buildChartForm(block, true);
      break;
    case 'chart-energy':
      html += buildChartForm(block, false);
      break;
    case 'switch-block':
      html += buildSwitchBlockForm(block);
      break;
    case 'state-select':
      html += buildStateSelectForm(block);
      break;
    default:
      // forecast-*, weather-block, savings-summary, forecast-pvtoday etc.
      html += buildSimpleForm(block);
      break;
  }

  return html;
}

/** Read all form values from the modal and update the block's config */
function readSettingsForm(block) {
  var config = block.config || {};
  // Common appearance
  config.enabled = document.getElementById('modal-enabled')?.checked !== false;
  config.transparent = document.getElementById('modal-transparent')?.checked || false;
  config.bgColor = document.getElementById('modal-bgcolor')?.value || '';
  if (config.bgColor === '#000000' && document.getElementById('modal-bgcolor')?.dataset.dirty !== 'true') config.bgColor = '';
  config.fontColor = document.getElementById('modal-fontcolor')?.value || '';
  if (config.fontColor === '#000000' && document.getElementById('modal-fontcolor')?.dataset.dirty !== 'true') config.fontColor = '';
  config.fontSize = document.getElementById('modal-fontsize')?.value || '';

  // Apply common fields to block
  block.enabled = config.enabled;
  block.transparent = config.transparent;
  block.bgColor = config.bgColor;
  block.fontColor = config.fontColor;
  block.fontSize = config.fontSize;

  var type = block.type;

  switch (type) {
    case 'flow-card': {
      var slots = ['solar','battery_soc','battery_charge','battery_discharge','consumption','grid_import','grid_export'];
      var metrics = {};
      slots.forEach(function(s) {
        var el = document.getElementById('modal-metric-' + s);
        if (el) metrics[s] = el.value || s;
      });
      block.metrics = metrics;
      config.metrics = metrics;
      config.showGauge = document.getElementById('modal-showgauge')?.checked !== false;
      break;
    }
    case 'flow-card-2':
    case 'flow-card-square':
    case 'flow-card-square-2': {
      var fslots = ['solar','grid_import','battery_charge','battery_soc','consumption','battery_discharge','grid_export'];
      var fmetrics = {};
      fslots.forEach(function(s) {
        var el = document.getElementById('modal-metric-' + s);
        if (el) fmetrics[s] = el.value || s;
      });
      block.metrics = fmetrics;
      config.metrics = fmetrics;
      config.inverter_image = document.getElementById('modal-inverter-image')?.value || '';
      break;
    }
    case 'multi-value': {
      var mvData = document.getElementById('mv-data');
      var mvRows = [];
      try { mvRows = JSON.parse(mvData.textContent); } catch(e) {}
      // Read live inputs to update labels/units before saving
      var labelEls = document.querySelectorAll('.mv-label');
      var unitEls = document.querySelectorAll('.mv-unit');
      for (var i = 0; i < mvRows.length; i++) {
        if (labelEls[i]) mvRows[i].label = labelEls[i].value;
        var msel = document.getElementById('mv-metric-' + i);
        if (msel) mvRows[i].metric = msel.value;
        if (unitEls[i]) mvRows[i].unit = unitEls[i].value;
      }
      block.metrics = mvRows;
      config.metrics = mvRows;
      break;
    }
    case 'bar-gauge': {
      var bgData = document.getElementById('bg-data');
      var bgRows = [];
      try { bgRows = JSON.parse(bgData.textContent); } catch(e) {}
      var allLabels = document.querySelectorAll('.bg-label');
      var allUnits = document.querySelectorAll('.bg-unit');
      var allMins = document.querySelectorAll('.bg-min');
      var allMaxs = document.querySelectorAll('.bg-max');
      var allColors = document.querySelectorAll('.bg-color');
      var allGrads = document.querySelectorAll('.bg-gradient');
      for (var j = 0; j < bgRows.length; j++) {
        var labelEl = allLabels[j];
        if (labelEl) bgRows[j].label = labelEl.value;
        var msel2 = document.getElementById('bg-metric-' + j);
        if (msel2) bgRows[j].metric = msel2.value;
        var uel = allUnits[j];
        if (uel) bgRows[j].unit = uel.value;
        var minel = allMins[j];
        if (minel) bgRows[j].min = parseFloat(minel.value) || 0;
        var maxel = allMaxs[j];
        if (maxel) bgRows[j].max = parseFloat(maxel.value) || 100;
        var cel = allColors[j];
        if (cel) bgRows[j].color = cel.value;
        var gel = allGrads[j];
        if (gel) bgRows[j].gradient = gel.value;
      }
      block.metrics = bgRows;
      config.metrics = bgRows;
      break;
    }
    case 'bar-gauge-retro': {
      var bgrData = document.getElementById('bgr-data');
      var bgrRows = [];
      try { bgrRows = JSON.parse(bgrData.textContent); } catch(e) {}
      var allBgrLabels = document.querySelectorAll('.bgr-label');
      var allBgrUnits = document.querySelectorAll('.bgr-unit');
      var allBgrMins = document.querySelectorAll('.bgr-min');
      var allBgrMaxs = document.querySelectorAll('.bgr-max');
      var allBgrSegs = document.querySelectorAll('.bgr-segments');
      var allBgrColors = document.querySelectorAll('.bgr-color');
      var allBgrGrads = document.querySelectorAll('.bgr-gradient');
      for (var k = 0; k < bgrRows.length; k++) {
        var labelEl2 = allBgrLabels[k];
        if (labelEl2) bgrRows[k].label = labelEl2.value;
        var msel3 = document.getElementById('bgr-metric-' + k);
        if (msel3) bgrRows[k].metric = msel3.value;
        var uel2 = allBgrUnits[k];
        if (uel2) bgrRows[k].unit = uel2.value;
        var minel2 = allBgrMins[k];
        if (minel2) bgrRows[k].min = parseFloat(minel2.value) || 0;
        var maxel2 = allBgrMaxs[k];
        if (maxel2) bgrRows[k].max = parseFloat(maxel2.value) || 100;
        var selEl = allBgrSegs[k];
        if (selEl) bgrRows[k].segments = parseInt(selEl.value) || 10;
        var cel2 = allBgrColors[k];
        if (cel2) bgrRows[k].color = cel2.value;
        var gel2 = allBgrGrads[k];
        if (gel2) bgrRows[k].gradient = gel2.value;
      }
      block.metrics = bgrRows;
      config.metrics = bgrRows;
      break;
    }
    case 'gauge-card':
    case 'half-gauge':
    case 'half-gauge-2': {
      config.metric = document.getElementById('modal-metric-gauge')?.value || '';
      config.title = document.getElementById('modal-gauge-title')?.value || '';
      config.min = parseFloat(document.getElementById('modal-gauge-min')?.value) || 0;
      config.max = parseFloat(document.getElementById('modal-gauge-max')?.value) || 100;
      config.color = document.getElementById('modal-gauge-color')?.value || '#f59e0b';
      break;
    }
    case 'metric-cards': {
      var mcData = document.getElementById('mc-data');
      var mcRows = [];
      try { mcRows = JSON.parse(mcData.textContent); } catch(e) {}
      var allMcTitles = document.querySelectorAll('.mc-title');
      var allMcUnits = document.querySelectorAll('.mc-unit');
      for (var m = 0; m < mcRows.length; m++) {
        var tEl = allMcTitles[m];
        if (tEl) mcRows[m].title = tEl.value;
        var mmel = document.getElementById('mc-metric-' + m);
        if (mmel) mcRows[m].metric = mmel.value;
        var uel3 = allMcUnits[m];
        if (uel3) mcRows[m].unit = uel3.value;
      }
      block.cards = mcRows;
      break;
    }
    case 'data-table-daily':
    case 'data-table-monthly': {
      var toggles = document.querySelectorAll('.col-toggle');
      var cols = [];
      toggles.forEach(function(t) {
        if (t.checked) {
          var f = t.dataset.field;
          var labels = {consumption_kwh:'Load (kWh)',solar_kwh:'Solar PV (kWh)',battery_charge_kwh:'Battery Charged (kWh)',battery_discharge_kwh:'Battery Discharged (kWh)',grid_import_kwh:'Grid Used (kWh)',grid_export_kwh:'Grid Exported (kWh)'};
          cols.push({ field: f, label: labels[f] || f });
        }
      });
      block.columns = cols;
      config.columns = cols;
      config.title = document.getElementById('modal-table-title')?.value || '';
      break;
    }
    case 'text-card': {
      config.content = document.getElementById('modal-text-content')?.value || '';
      break;
    }
    case 'text-metric': {
      config.metric = document.getElementById('modal-metric-textmetric')?.value || '';
      config.label = document.getElementById('modal-textmetric-label')?.value || '';
      config.unit = document.getElementById('modal-textmetric-unit')?.value || '';
      break;
    }
    case 'iframe-card': {
      config.url = document.getElementById('modal-iframe-url')?.value || '';
      break;
    }
    case 'battery-block': {
      var bslots = ['soc','voltage','current','power','temperature'];
      var bmetrics = {};
      bslots.forEach(function(s) {
        var el = document.getElementById('modal-metric-batt-' + s);
        if (el) bmetrics[s] = el.value || '';
      });
      block.metrics = bmetrics;
      config.metrics = bmetrics;
      config.title = document.getElementById('modal-batt-title')?.value || '';
      break;
    }
    case 'grid-card': {
      config.metrics = config.metrics || {};
      config.metrics.grid_status = document.getElementById('modal-metric-grid-status')?.value || '';
      config.showTimeline = document.getElementById('modal-showtimeline')?.checked !== false;
      break;
    }
    case 'chart-power':
    case 'chart-energy':
    case 'chart-metric': {
      config.hideGrid = document.getElementById('modal-chart-hidegrid')?.checked || false;
      config.fill = document.getElementById('modal-chart-fill')?.checked !== false;
      var chData = document.getElementById('chart-data');
      var chRows = [];
      try { chRows = JSON.parse(chData.textContent); } catch(e) {}
      var allChartLabels = document.querySelectorAll('.chart-label');
      var allChartColors = document.querySelectorAll('.chart-color');
      for (var c = 0; c < chRows.length; c++) {
        var lEl = allChartLabels[c];
        if (lEl) chRows[c].label = lEl.value;
        var cmel = document.getElementById('chart-metric-' + c);
        if (cmel) chRows[c].metric = cmel.value;
        var ccel = allChartColors[c];
        if (ccel) chRows[c].color = ccel.value;
        var uels = document.querySelectorAll('.chart-unit'); if (uels[c]) chRows[c].unit = uels[c].value;
        var sels = document.querySelectorAll('.chart-scale'); if (sels[c]) chRows[c].scale = parseFloat(sels[c].value);
      }
      config.datasets = chRows;
      config.title = document.getElementById('modal-chart-title')?.value || '';
      break;
    }
    case 'switch-block': {
      config.entity = document.getElementById('modal-switch-entity')?.value || '';
      config.source = document.getElementById('modal-switch-source')?.value || 'ha';
      config.label = document.getElementById('modal-switch-label')?.value || '';
      config.action = document.getElementById('modal-switch-action')?.value || 'switch.toggle';
      var ocEl = document.getElementById('modal-switch-oncolor');
      config.onColor = ocEl?.value || '';
      if (config.onColor === '#000000' && ocEl?.dataset.dirty !== 'true') config.onColor = '';
      var ofEl = document.getElementById('modal-switch-offcolor');
      config.offColor = ofEl?.value || '';
      if (config.offColor === '#000000' && ofEl?.dataset.dirty !== 'true') config.offColor = '';
      config.onIcon = document.getElementById('modal-switch-onicon')?.value || '';
      config.offIcon = document.getElementById('modal-switch-officon')?.value || '';
      break;
    }
    case 'state-select': {
      config.entity = document.getElementById('modal-state-entity')?.value || '';
      config.source = document.getElementById('modal-state-source')?.value || 'ha';
      config.label = document.getElementById('modal-state-label')?.value || '';
      config.action = document.getElementById('modal-state-action')?.value || '';
      config.displayStyle = document.getElementById('modal-state-displaystyle')?.value || 'buttons';
      var stData = document.getElementById('state-data');
      var stRows = [];
      try { stRows = JSON.parse(stData.textContent); } catch(e) {}
      var allVals = document.querySelectorAll('.state-value');
      var allLbls = document.querySelectorAll('.state-label');
      var allCols = document.querySelectorAll('.state-color');
      var outStates = [];
      for (var s = 0; s < stRows.length; s++) {
        var vEl = allVals[s];
        if (!vEl) continue;
        var rowVal = vEl.value;
        var rowLbl = allLbls[s] ? allLbls[s].value : rowVal;
        if (!rowVal && !rowLbl) continue;
        var out = { value: rowVal, label: rowLbl };
        var colEl = allCols[s];
        if (colEl && colEl.dataset.dirty === 'true' && colEl.value) out.color = colEl.value;
        outStates.push(out);
      }
      config.states = outStates;
      break;
    }
    default: {
      // Simple blocks: forecast, savings, weather, pv today
      var titleEl = document.getElementById('modal-simple-title');
      if (titleEl) {
        if (type === 'forecast-pvtoday') config.location_name = titleEl.value;
        else config.title = titleEl.value;
      }
      var metEl = document.getElementById('modal-simple-metric');
      if (metEl) {
        if (type === 'savings-summary') config.savings_metric = metEl.value;
        else if (type === 'forecast-pvtoday') {
          config.metrics = config.metrics || {};
          config.metrics.generated = metEl.value;
        }
      }
      break;
    }
  }

  block.config = config;
}

/** Refresh the live grid item content after settings save */
function refreshGridItem(block) {
  var el = document.querySelector('.grid-stack-item[data-block-id="' + block.id + '"]');
  if (!el) return;
  // Remove old content div, rebuild
  var inner = el.querySelector('.grid-stack-item-content');
  if (!inner) return;
  // Keep delete and settings buttons, rebuild content
  var delBtn = inner.querySelector('.grid-item-delete');
  var settingsBtn = inner.querySelector('.grid-item-settings');
  // Clear inner
  inner.innerHTML = '';
  if (settingsBtn) inner.appendChild(settingsBtn);
  if (delBtn) inner.appendChild(delBtn);

  var builder = componentBuilders[block.type];
  if (typeof builder === 'function') {
    var content = builder(block);
    if (content) {
      var isForecastBlock = block.type === 'forecast-banner' || block.type === 'forecast-info' || block.type === 'forecast-sparkline' || block.type === 'weather-block';
      if (isForecastBlock) {
        content.style.display = '';
        if (!content.querySelector('.pv-days, .weather-section, .pv-sparkline-container, canvas')) {
          content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:0.9rem;gap:0.5rem;">☀️ ' + (block.type === 'forecast-banner' ? 'Solar Forecast Banner' : block.type === 'forecast-info' ? 'Solar Forecast Info' : 'Solar Forecast Sparkline') + '</div>';
        }
      }
      inner.appendChild(content);

      // Apply block styling (mirrors dashboard.js render loop)
      if (block.bgColor && block.bgColor !== '#ffffff') {
        content.style.setProperty('background-color', block.bgColor, 'important');
      }
      if (block.innerBgColor && block.innerBgColor !== '#ffffff') {
        content.style.setProperty('--card-bg', block.innerBgColor, 'important');
        content.style.setProperty('--bg', block.innerBgColor, 'important');
      }
      if (block.fontColor && block.fontColor !== '#000000') {
        content.style.setProperty('color', block.fontColor, 'important');
      }
      if (block.fontSize) {
        content.style.fontSize = block.fontSize;
      }
      if (block.transparent) {
        content.style.background = 'transparent';
        content.style.borderColor = 'transparent';
        content.style.boxShadow = 'none';
        content.style.setProperty('--card-bg', 'transparent');
        content.style.setProperty('--bg', 'transparent');
        content.querySelectorAll('.stat-card, .topo-node-circle, .chart-container, .fcs-inverter-icon, .fcs2-inv').forEach(el => {
          el.style.background = 'transparent';
          el.style.borderColor = 'transparent';
          el.style.boxShadow = 'none';
        });
      }
    }
  }
}

async function handleSettingsSave() {
  if (!currentEditingBlock) return;
  var statusEl = document.getElementById('settings-modal-status');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
  readSettingsForm(currentEditingBlock);
  var saved = await persistLayout();
  if (!saved) {
    console.error('Save failed — layout not persisted');
    if (statusEl) { statusEl.textContent = 'Save failed — your session may have expired. Please sign in and try again.'; statusEl.style.display = 'block'; }
    return;  // keep modal open
  }
  refreshGridItem(currentEditingBlock);
  markUnsaved();
  hideSettingsModal();
}

async function openSettingsModal(block) {
  // Re-resolve from the current layout — the closure may hold a stale
  // reference if persistLayout() replaced tab.layout after addBlockToGrid.
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; });
  if (tab) {
    var live = tab.layout.find(function(b) { return b.id === block.id; });
    if (live) block = live;
  }

  // Fetch available metrics for dropdowns
  try {
    var state = await fetchDashboardState();
    availableMetrics = state.metrics ? Object.keys(state.metrics).sort() : [];
  } catch (e) {
    console.warn('Could not fetch metrics for settings dropdown:', e);
    availableMetrics = [];
  }

  currentEditingBlock = block;
  var body = document.getElementById('settings-modal-body');
  body.innerHTML = buildSettingsForm(block);
  showSettingsModal();

  // Mark color inputs as dirty when user interacts with them
  var bgInput = document.getElementById('modal-bgcolor');
  var fgInput = document.getElementById('modal-fontcolor');
  if (bgInput) bgInput.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  if (fgInput) fgInput.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  ['modal-switch-oncolor', 'modal-switch-offcolor'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  });

  // Initialize dynamic row renderers after DOM is populated
  switch (block.type) {
    case 'multi-value':
      renderMultiValueRows(body);
      break;
    case 'bar-gauge':
      renderBarGaugeRows(body);
      break;
    case 'bar-gauge-retro':
      renderBarGaugeRetroRows(body);
      break;
    case 'metric-cards':
      renderMetricCardsRows(body);
      break;
    case 'chart-power':
      renderChartRows(body, false, [{ value: 'battery_power', label: 'Battery Power (net)' }]);
      break;
    case 'chart-energy':
      renderChartRows(body);
      break;
    case 'chart-metric':
      renderChartRows(body, true);
      break;
    case 'state-select':
      renderStateSelectRows(body);
      break;
  }
}

// ── END Settings Modal ──────────────────────────────────────────────────

/**
 * Build a single grid-stack-item DOM element for a block definition.
 * @param {object} block - block config {id, type, gridX, gridY, gridW, gridH, ...}
 * @returns {HTMLElement} the grid-stack-item element
 */
function buildGridItem(block) {
  var builder = componentBuilders[block.type];
  if (typeof builder !== 'function') return null;
  var content = builder(block);
  if (!content) return null;

  // Forecast blocks start hidden (display:none) while waiting for data.
  // In the editor, show a visible placeholder so users can see where blocks are placed.
  var isForecastBlock = block.type === 'forecast-banner' || block.type === 'forecast-info' || block.type === 'forecast-sparkline' || block.type === 'weather-block';
  if (isForecastBlock) {
    content.style.display = '';
    if (content.querySelector('.pv-days, .weather-section, .pv-sparkline-container, canvas')) {
      // Has real content structure — just make visible with placeholder data
      var pvValues = content.querySelectorAll('.pv-day-value, .fi-today-value');
      pvValues.forEach(function(el) { if (el && (el.textContent === '0 kWh' || el.textContent === '--')) el.textContent = '-- kWh'; });
      var weatherTemps = content.querySelectorAll('.weather-temp, .fi-weather-temp');
      weatherTemps.forEach(function(el) { if (el && el.textContent === '--°') el.textContent = '25°C'; });
    } else {
      // Empty/minimal content — show a stub
      content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary, #94a3b8);font-size:0.9rem;gap:0.5rem;">☀️ ' + (block.type === 'forecast-banner' ? 'Solar Forecast Banner' : block.type === 'forecast-info' ? 'Solar Forecast Info' : 'Solar Forecast Sparkline') + '</div>';
    }
  }

  var item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.dataset.blockId = block.id || ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
  item.dataset.blockType = block.type;
  item.setAttribute('gs-x', block.gridX ?? 0);
  item.setAttribute('gs-y', block.gridY ?? 0);
  item.setAttribute('gs-w', block.gridW ?? block.colSpan ?? 6);
  item.setAttribute('gs-h', block.gridH ?? Math.max(1, Math.round((block.rowSpan ?? 200) / 50)));
  item.setAttribute('gs-min-w', 2);
  item.setAttribute('gs-min-h', 1);

  var inner = document.createElement('div');
  inner.className = 'grid-stack-item-content';
  inner.style.padding = '0.5rem'; inner.style.fontSize = '0.8rem'; inner.style.position = 'relative';

  // Settings button (gear)
  var settingsBtn = document.createElement('button');
  settingsBtn.className = 'grid-item-settings';
  settingsBtn.innerHTML = '&#9881;';
  settingsBtn.style.cssText = 'position:absolute;top:4px;right:42px;z-index:10;';
  settingsBtn.setAttribute('aria-label', 'Block settings');
  settingsBtn.addEventListener('click', function(e) { e.stopPropagation(); openSettingsModal(block); });
  inner.appendChild(settingsBtn);

  // Delete button
  var delBtn = document.createElement('button');
  delBtn.className = 'grid-item-delete';
  delBtn.textContent = '\u2715';
  delBtn.style.cssText = 'position:absolute;top:4px;right:4px;z-index:10;';
  delBtn.setAttribute('aria-label', 'Delete block');
  delBtn.addEventListener('click', function(e) { e.stopPropagation(); grid.removeWidget(item); persistLayout(); markUnsaved(); });
  inner.appendChild(delBtn);
  inner.appendChild(content);
  item.appendChild(inner);
  return item;
}

/**
 * Add a single block to the active dashboard without rebuilding the entire grid.
 * @param {string} type - block type identifier
 */
function addBlockToGrid(type) {
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; });
  if (!tab) return;
  var newBlock = { id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), type: type, enabled: true, colSpan: 6, rowSpan: 200, config: {} };
  tab.layout.push(newBlock);
  var item = buildGridItem(newBlock);
  if (!item) return;

  // GridStack v11+ requires makeWidget() for HTMLElements
  grid.makeWidget(item);
  markUnsaved();
  persistLayout(); // auto-save after add
}

async function loadTab(tabId) {
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === tabId; });
  if (!tab) return;
  currentTabId = tabId;
  document.getElementById('dash-name-input').value = tab.name || '';
  refreshTabSelect();

  var container = document.getElementById('grid');
  container.innerHTML = '';
  if (grid) { grid.destroy(false); grid = null; }

  tab.layout.forEach(function(block) {
    if (block.enabled === false) return;
    var item = buildGridItem(block);
    if (item) container.appendChild(item);
  });

  grid = GridStack.init({ column: 12, cellHeight: 50, float: false, animate: true, resizable: { handles: 'e, se, s, sw, w' }, minRow: 1 }, container);
  grid.on('change', function() { markUnsaved(); });
  grid.on('dragstop', function() { persistLayout(); });
  grid.on('resizestop', function() { persistLayout(); });

  // Enable palette drops via GridStack's own drop handling
  grid.opts.acceptWidgets = function(el) { return true; };

  var dropZone = container.closest('.editor-grid-wrapper') || container;
  dropZone.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    var type = e.dataTransfer.getData('blockType');
    if (type) addBlockToGrid(type);
  });

  // Auth check for header buttons
  fetch('/api/auth/status')
    .then(function(r) { return r.json(); })
    .then(function(auth) {
      if (!auth.authenticated) {
        document.getElementById('save-btn').disabled = true;
        dropZone.style.opacity = '0.5';
        dropZone.style.pointerEvents = 'none';
      }
    }).catch(function() {});
}

async function initEditor() {
  showLoading('Loading editor...');
  try {
    dashboardConfig = await fetchDashboardConfig();
    if (!dashboardConfig.dashboards || !dashboardConfig.dashboards.length) {
      dashboardConfig.dashboards = [{ id: 'main', name: 'Main', layout: [] }];
      dashboardConfig.activeDashboard = 'main';
    }
    currentTabId = dashboardConfig.activeDashboard || dashboardConfig.dashboards[0].id;

    refreshTabSelect();
    document.getElementById('tab-select').addEventListener('change', function(e) {
      if (unsaved) { persistLayout(); clearUnsaved(); }
      loadTab(e.target.value);
    });
    document.getElementById('dash-name-input').addEventListener('change', function() { markUnsaved(); });

    // New Dashboard
    document.getElementById('new-dash-btn').addEventListener('click', function() {
      var id = 'db_' + Date.now();
      dashboardConfig.dashboards.push({ id: id, name: 'New Dashboard', layout: [] });
      dashboardConfig.activeDashboard = id;
      persistLayout(); clearUnsaved();
      loadTab(id);
    });

    // Delete Dashboard
    document.getElementById('delete-dash-btn').addEventListener('click', function() {
      if (dashboardConfig.dashboards.length <= 1) { alert('Cannot delete the last dashboard.'); return; }
      if (!confirm('Delete this dashboard and all its blocks?')) return;
      dashboardConfig.dashboards = dashboardConfig.dashboards.filter(function(db) { return db.id !== currentTabId; });
      currentTabId = dashboardConfig.dashboards[0].id;
      dashboardConfig.activeDashboard = currentTabId;
      saveDashboardConfig(dashboardConfig).catch(function(e) { console.warn(e); });
      loadTab(currentTabId);
    });

    // Palette — use addBlockToGrid instead of loadTab rebuild
    var palette = document.getElementById('available-blocks');
    var names = { 'flow-card':'\uD83D\uDD04 Flow Card','forecast-banner':'\u2600\uFE0F Forecast','forecast-sparkline':'\u2600\uFE0F Forecast Spark','forecast-info':'\u2600\uFE0F Forecast Info','metric-cards':'\uD83D\uDCCA Metric Cards','grid-card':'\uD83D\uDD0C Grid Card','chart-power':'\u26A1 Power Chart','chart-energy':'\uD83D\uDCC8 Energy Chart','chart-metric':'\u25C7 Metric Chart','savings-summary':'\uD83D\uDCB0 Savings','data-table-daily':'\uD83D\uDCCB Daily Table','data-table-monthly':'\uD83D\uDCC5 Monthly Table','weather-block':'\uD83C\uDF26\uFE0F Weather','battery-block':'\uD83D\uDD0B Battery','flow-card-2':'\uD83D\uDD04 Flow Card 2','multi-value':'\uD83D\uDCCA Multi-Value','gauge-card':'\uD83C\uDFAF Gauge','half-gauge':'\uD83C\uDFAF Half Gauge','half-gauge-2':'\uD83C\uDFAF Half Gauge 2','flow-card-square':'\uD83D\uDD04 Flow Sq','flow-card-square-2':'\uD83D\uDD04 Flow Sq 2','text-card':'\uD83D\uDCDD Text','text-metric':'\uD83D\uDCDD Text Metric','iframe-card':'\uD83C\uDF10 Embed','forecast-pvtoday':'\u2600\uFE0F PV Today','bar-gauge':'\uD83D\uDCCA Bar Gauge','bar-gauge-retro':'\uD83D\uDCCA Bar Retro','switch-block':'\uD83D\uDD18 Toggle Switch','state-select':'\uD83D\uDCCB State Select' };
    Object.entries(componentBuilders).forEach(function(entry) {
      var type = entry[0];
      var item = document.createElement('div');
      item.className = 'block-item'; item.textContent = names[type] || type; item.draggable = true; item.dataset.blockType = type;
      item.addEventListener('dragstart', function(e) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('blockType', type); });
      item.addEventListener('click', function() { addBlockToGrid(type); });
      palette.appendChild(item);
    });

    // Export/Import
    document.getElementById('export-btn').addEventListener('click', function() {
      var json = JSON.stringify(dashboardConfig, null, 2);
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'dashboard-config.json'; a.click();
    });
    document.getElementById('import-btn').addEventListener('click', function() {
      var input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.addEventListener('change', async function(e) {
        var file = e.target.files[0]; if (!file) return;
        try {
          var text = await file.text(); var imported = JSON.parse(text);
          if (!imported.dashboards) throw new Error('Invalid format');
          dashboardConfig = imported;
          currentTabId = dashboardConfig.dashboards[0]?.id;
          if (currentTabId) loadTab(currentTabId);
          refreshTabSelect();
          markUnsaved();
        } catch (err) { alert('Import failed: ' + err.message); }
      });
      input.click();
    });

    await loadTab(currentTabId);
    document.getElementById('save-btn').addEventListener('click', async function() { await persistLayout(); clearUnsaved(); var validTab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; }) ? currentTabId : dashboardConfig.dashboards[0]?.id || 'main'; window.location.href = '/?tab=' + encodeURIComponent(validTab); });

    // ── Settings Modal Event Bindings ──
    document.getElementById('settings-modal-close').addEventListener('click', hideSettingsModal);
    document.getElementById('settings-modal-cancel').addEventListener('click', hideSettingsModal);
    document.getElementById('settings-modal-save').addEventListener('click', handleSettingsSave);
    document.getElementById('settings-modal-overlay').addEventListener('click', function(e) { if (e.target === e.currentTarget) hideSettingsModal(); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && currentEditingBlock) hideSettingsModal(); });

    hideLoading();
  } catch (e) { hideLoading(); alert('Editor failed: ' + e.message); }
}

initEditor();
