// settings.js – fixed to use /api/metrics/list for immediate dropdown updates
// Apply source subnav labels from the shared module (single source of truth) — corrects any HTML drift.
(function () {
  if (!window.EPILYKOS_LABELS || !window.EPILYKOS_LABELS.subnav) return;
  var labels = window.EPILYKOS_LABELS.subnav;
  document.querySelectorAll('.subnav-btn').forEach(function (btn) {
    var id = btn.getAttribute('data-subtab');
    if (id && labels[id]) btn.textContent = labels[id];
  });
})();
const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const backupStatus = document.getElementById('backup-status');
let usedDashboardMetrics = [];
let allMetrics = []; // array of { name, unit, value?, timestamp? }

function showStatus(element, msg, type) {
  element.textContent = msg;
  element.className = `status ${type}`;
  if (type !== 'info') {
    setTimeout(() => { element.textContent = ''; element.className = 'status'; }, 5000);
  }
}
function showStatusHtml(element, msg, type) {
  element.innerHTML = msg;
  element.className = `status ${type}`;
  if (type !== 'info') {
    setTimeout(() => { element.innerHTML = ''; element.className = 'status'; }, 5000);
  }
}

// ── Utility helpers ────────────────────────────────────────────────────
function showConfirm(message) {
  // Centralized confirm() wrapper — replace body with custom modal later
  return confirm(message);
}

// ── Load existing settings ─────────────────────────────────────────────────
async function loadSettings() {
  try {
    // FIRST: fetch all metrics (including those without data)
    const metricsRes = await fetch('/api/metrics/list');
    if (metricsRes.ok) {
      allMetrics = await metricsRes.json();
      allMetrics.sort((a,b) => a.name.localeCompare(b.name));
    }

    // THEN fetch all settings
    const res = await fetch('/api/settings');
    const data = await res.json();
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('ha_devices') || key.startsWith('mqtt_devices') || key.startsWith('modbus_devices') || key.startsWith('rs232_devices') || key.startsWith('tuya_devices') || key === 'dashboard_config' || key === 'external_sources' || key === 'bms_devices' || key === 'bms_banks' || key === 'dongle_config' || key === 'pvoutput_config' || key === 'pvoutput_stats_cache' || key === 'pvoutput_rate_limit_state') continue;
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') input.checked = value === 'true';
        else input.value = value;
      }
    }
    buildHaDeviceList(JSON.parse(data.ha_devices || '[]'));
    buildMqttDeviceList(JSON.parse(data.mqtt_devices || '[]'));
    buildModbusDeviceList(JSON.parse(data.modbus_devices || '[]'));
    buildExternalSourceList(JSON.parse(data.external_sources || '[]'));
    buildBmsDeviceList(JSON.parse(data.bms_devices || '[]'));
    buildBmsWiredDeviceList(JSON.parse(data.bms_devices || '[]'));
    buildBmsBankList(JSON.parse(data.bms_banks || '[]'));
    buildRs232DeviceList(JSON.parse(data.rs232_devices || '[]'));
    buildDongleDeviceList(JSON.parse(data.dongle_config || '[]'));
    buildPvoutputConfig(data.pvoutput_config ? JSON.parse(data.pvoutput_config) : {});
    if (data.tuya_cloud) {
      try {
        const cloud = JSON.parse(data.tuya_cloud);
        const regionEl = document.getElementById('tuya-cloud-region');
        if (regionEl && cloud.region) regionEl.value = cloud.region;
        const accessIdEl = document.getElementById('tuya-cloud-access-id');
        if (accessIdEl) accessIdEl.value = cloud.access_id || '';
        const accessSecretEl = document.getElementById('tuya-cloud-access-secret');
        if (accessSecretEl) accessSecretEl.value = cloud.access_secret || '';
        const deviceIdEl = document.getElementById('tuya-cloud-device-id');
        if (deviceIdEl) deviceIdEl.value = cloud.device_id || '';
      } catch {}
    }
    buildTuyaDeviceList(JSON.parse(data.tuya_devices || '[]'));
    // Auto-match LAN IPs for existing devices
    autoMatchTuyaLanIps();
    const dashConfig = data.dashboard_config ? JSON.parse(data.dashboard_config) : null;
    buildDashboardEditor(dashConfig);
    populateDashboardSelects(dashConfig, data.desktop_dashboard, data.mobile_dashboard);

    usedDashboardMetrics = [];
    if (dashConfig && dashConfig.dashboards) {
      dashConfig.dashboards.forEach(db => {
        db.layout.forEach(block => {
          if (block.type === 'metric-cards' && block.cards) {
            block.cards.forEach(card => {
              if (card.metric && !usedDashboardMetrics.includes(card.metric)) usedDashboardMetrics.push(card.metric);
            });
          }
        });
      });
      usedDashboardMetrics.sort();
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
    showStatus(saveStatus, 'Failed to load settings', 'error');
  }
  syncAllMetricDropdowns();
}

// ---------- Helper: Create metric dropdown ----------
function createMetricDropdown(selectedMetric = '', excludeMetrics = []) {
  const select = document.createElement('select');
  select.className = 'metric-name';
  select.title = selectedMetric || 'Select a metric';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select Metric --';
  select.appendChild(emptyOpt);
  for (const metric of allMetrics) {
    // Skip metrics already mapped elsewhere unless it's the current selection
    if (excludeMetrics.includes(metric.name) && metric.name !== selectedMetric) continue;
    const opt = document.createElement('option');
    opt.value = metric.name;
    opt.textContent = metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
    if (metric.name === selectedMetric) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

// Helper: collect all currently-used metrics across ALL source types (MQTT + HA + External/REST)
function getAllUsedMetrics() {
  const used = new Set();
  document.querySelectorAll('.device-card .metric-row .metric-name').forEach(sel => {
    if (sel.value) used.add(sel.value);
  });
  return used;
}

// Rebuild all metric dropdowns in a single MQTT/HA device card, respecting used metrics (per-card scope)
function refreshMqttDropdowns(card) {
  const used = new Set();
  card.querySelectorAll('.metric-row .metric-name').forEach(sel => {
    if (sel.value) used.add(sel.value);
  });
  card.querySelectorAll('.metric-row .metric-name').forEach(sel => {
    const currentVal = sel.value;
    const excludeOthers = Array.from(used).filter(m => m !== currentVal);
    sel.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- Select Metric --';
    sel.appendChild(emptyOpt);
    for (const metric of allMetrics) {
      if (excludeOthers.includes(metric.name)) continue;
      const opt = document.createElement('option');
      opt.value = metric.name;
      opt.textContent = metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
      if (metric.name === currentVal) opt.selected = true;
      sel.appendChild(opt);
    }
  });
}

// Rebuild ALL metric dropdowns across all source types (MQTT + HA + External) with global exclusion
function syncAllMetricDropdowns() {
  const used = getAllUsedMetrics();
  document.querySelectorAll('.device-card .metric-row .metric-name').forEach(sel => {
    const currentVal = sel.value;
    const excludeOthers = Array.from(used).filter(m => m !== currentVal);
    sel.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- Select Metric --';
    sel.appendChild(emptyOpt);
    for (const metric of allMetrics) {
      if (excludeOthers.includes(metric.name)) continue;
      const opt = document.createElement('option');
      opt.value = metric.name;
      opt.textContent = metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
      if (metric.name === currentVal) opt.selected = true;
      sel.appendChild(opt);
    }
  });
}

// Generate metric options as HTML string (for innerHTML-based config panels)
function generateMetricOptionsHtml(selectedMetric, label) {
  let html = `<option value="">-- ${escapeHtml(label || 'Select metric')} --</option>`;
  for (const m of allMetrics) {
    const sel = selectedMetric === m.name ? ' selected' : '';
    const unitStr = m.unit ? ` (${escapeHtml(m.unit)})` : '';
    html += `<option value="${escapeHtml(m.name)}"${sel}>${escapeHtml(m.name)}${unitStr}</option>`;
  }
  return html;
}

// Helper to refresh all metric dropdowns after a new metric is created
async function refreshAllMetricDropdowns() {
  const res = await fetch('/api/metrics/list');
  if (res.ok) {
    allMetrics = await res.json();
    allMetrics.sort((a,b) => a.name.localeCompare(b.name));
  }
  syncAllMetricDropdowns();
}

// ======================== HOME ASSISTANT ========================
let haDeviceCounter = 0;
function buildHaDeviceList(devices) {
  const container = document.getElementById('ha-devices-container');
  container.innerHTML = '';
  haDeviceCounter = 0;
  devices.forEach((dev, idx) => renderHaDevice(dev, idx));
  refreshAllMetricDropdowns();
}

function renderHaDevice(device, idx) {
  const container = document.getElementById('ha-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="ha_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap" style="margin:0 1rem;"><label class="toggle-switch"><input type="checkbox" name="ha_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-ha">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <input type="text" name="ha_devices[${idx}][url]" placeholder="http://homeassistant.local:8123" value="${escapeHtml(device.url || '')}">
      <input type="password" name="ha_devices[${idx}][token]" placeholder="Access Token" value="${escapeHtml(device.token || '')}">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⏱</span> Polling</div>
    <div class="form-row">
      <input type="number" name="ha_devices[${idx}][poll_interval]" placeholder="Poll Interval (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn fetch-ha-entities">Fetch Entities</button>
      <span class="test-status" id="ha-entities-status-${idx}"></span>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Entity Mappings</div>
    <div class="mappings-section" id="ha-mappings-${idx}">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="ha-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="ha-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-ha-metric" data-device="${idx}">
        + Add Metric Mapping
        <span class="metric-help-icon">?</span>
      </button>
    </div>
  `;
  container.appendChild(card);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'metric-tooltip';
  tooltipEl.style.display = 'none';
  card.appendChild(tooltipEl);

  const removeHaBtn = card.querySelector('[data-action="remove-ha"]');
  if (removeHaBtn) removeHaBtn.addEventListener('click', () => {
    if (showConfirm('Remove this Home Assistant device and all its entity mappings?')) {
      card.remove();
      reindexHa();
      refreshAllMetricDropdowns();
    }
  });

  card.querySelector('.fetch-ha-entities').addEventListener('click', async function() {
    const statusEl = document.getElementById(`ha-entities-status-${idx}`);
    const url = card.querySelector(`[name="ha_devices[${idx}][url]"]`).value;
    const token = card.querySelector(`[name="ha_devices[${idx}][token]"]`).value;
    if (!url || !token) {
      showStatus(statusEl, 'URL and token required', 'error');
      return;
    }
    showStatus(statusEl, 'Fetching...', 'info');
    try {
      // AC-25: enriched catalog (friendly_name / unit / state / domain). Items
      // are display-only — mapping values stay plain entity_id strings.
      const items = await fetchHaEntityCatalog(url, token);
      card._haCatalog = items;
      // Legacy-compatible refresh of the entity pickers on SAVED and blank
      // add-rows (values preserved; options now carry friendly labels). Expose
      // rows are rebuilt below with their own enriched labels.
      const byId = new Map(items.map(it => [haEntityIdOf(it), it]));
      card.querySelectorAll('.mappings-list select.entity-select').forEach(select => {
        const currentVal = select.value;
        select.innerHTML = '<option value="">-- Select entity --</option>';
        items.forEach(ent => {
          const id = haEntityIdOf(ent);
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = haEntityLabelText(ent);
          select.appendChild(opt);
        });
        if (currentVal) {
          if (byId.has(currentVal)) select.value = currentVal;
          else {
            // Entity no longer in the 8-domain catalog — keep it selectable so
            // an existing mapping is never silently dropped by a refresh.
            const keep = document.createElement('option');
            keep.value = currentVal;
            keep.textContent = currentVal + ' (kept)';
            select.appendChild(keep);
            select.value = currentVal;
          }
        }
      });
      if (!items.length) {
        showStatus(statusEl, 'No entities found in the 8 supported HA domains', 'info');
        return;
      }
      // AC-25: expose-all rows with a domain filter over the last fetch.
      ensureHaDomainToolbar(card);
      const added = renderHaCatalogRows(card);
      const domains = new Set(items.map(it => haDomainOf(it)).filter(Boolean));
      showStatus(statusEl, `Loaded ${items.length} entities across ${domains.size} domains — ${added} catalog rows` + (added ? '' : ' (everything already mapped)'), 'success');
    } catch (e) {
      showStatus(statusEl, e.message, 'error');
    }
  });

  card.querySelector('.add-ha-metric').addEventListener('click', () => {
    const used = getAllUsedMetrics();
    addHaMetricRow(device, idx, '', '', Array.from(used));
    refreshAllMetricDropdowns();
    // Defensive: strip comma-containing options that may have leaked into entity selects
    setTimeout(() => {
      card.querySelectorAll('.mappings-list select.entity-select option').forEach(o => {
        if (o.value && o.value.includes(',')) o.remove();
      });
    }, 100);
  });

  const helpIcon = card.querySelector('.metric-help-icon');
  if (helpIcon) {
    helpIcon.addEventListener('mouseenter', (e) => {
      const text = allMetrics.map(m => m.name).join(', ');
      if (!text) return;
      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = 'Available metrics: ' + text;
      tooltip.style.display = 'block';
      const rect = helpIcon.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      tooltip.style.left = (rect.left - cardRect.left + 20) + 'px';
      tooltip.style.top = (rect.top - cardRect.top - 30) + 'px';
    });
    helpIcon.addEventListener('mouseleave', () => {
      const tooltip = card.querySelector('.metric-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  const mappingsList = card.querySelector('.mappings-list');
  renderHaMappings(device.entities || {}, idx, mappingsList);
  haDeviceCounter++;
}

function renderHaMappings(entities, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(entities).forEach(([metric, entityId]) => {
    addHaMetricRow({}, deviceIdx, container, metric, entityId);
  });
  if (Object.keys(entities).length === 0) addHaMetricRow({}, deviceIdx, container);
}

// ── Entity action configuration (AC-7.3) ──────────────────────────────
function actionLabel(name) {
  const labels = {
    toggle: 'Toggle', turn_on: 'Turn On', turn_off: 'Turn Off', brightness: 'Brightness',
    set_temperature: 'Set Temperature', set_mode: 'Set Mode', set_fan_mode: 'Set Fan Mode',
    open_cover: 'Open', close_cover: 'Close', stop_cover: 'Stop', set_speed: 'Set Speed'
  };
  return labels[name] || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function updateActionsSummary(row) {
  const summaryEl = row.querySelector('.ha-actions-summary');
  if (!summaryEl) return;
  let actions = [];
  try { actions = row.dataset.actions ? JSON.parse(row.dataset.actions) : []; } catch { actions = []; }
  summaryEl.textContent = actions.length ? 'Actions: ' + actions.map(actionLabel).join(', ') : '';
}

// Render the Configure Actions panel (checkboxes + modes/state metadata).
function renderActionsPanel(actionsEl, row, data, selected) {
  const panel = document.createElement('div');
  panel.className = 'ha-actions-panel';
  panel.style.cssText = 'margin-top:0.4rem;padding:0.5rem 0.6rem;border:1px solid #444;border-radius:6px;background:rgba(0,0,0,0.25);min-width:220px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:0.35rem;';
  title.textContent = 'Actions for ' + (row.querySelector('.entity-select').value || 'entity');
  panel.appendChild(title);
  const actionNames = data.actions || [];
  if (actionNames.length) {
    actionNames.forEach(name => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;margin:0.2rem 0;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.className = 'ha-action-cb';
      cb.checked = selected.includes(name);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(actionLabel(name)));
      panel.appendChild(label);
    });
  } else {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:0.75rem;color:var(--text-secondary);';
    none.textContent = 'No actions available for this entity.';
    panel.appendChild(none);
  }
  const meta = [];
  const m = data.modes || {};
  if (m.hvac_modes && m.hvac_modes.length) meta.push('HVAC: ' + m.hvac_modes.join(', '));
  if (m.fan_modes && m.fan_modes.length) meta.push('Fan: ' + m.fan_modes.join(', '));
  if (m.min_temp != null && m.max_temp != null) meta.push('Temp: ' + m.min_temp + '–' + m.max_temp);
  if (data.currentState && data.currentState.state !== undefined && data.currentState.state !== null) meta.push('State: ' + data.currentState.state);
  if (meta.length) {
    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:0.7rem;color:var(--text-secondary);margin-top:0.4rem;';
    metaEl.textContent = meta.join(' · ');
    panel.appendChild(metaEl);
  }
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'fetch-btn';
  doneBtn.textContent = '✓ Apply';
  doneBtn.style.cssText = 'margin-top:0.5rem;font-size:0.75rem;padding:0.2rem 0.6rem;';
  doneBtn.addEventListener('click', () => {
    const chosen = Array.from(panel.querySelectorAll('.ha-action-cb:checked')).map(cb => cb.value);
    row.dataset.actions = chosen.length ? JSON.stringify(chosen) : '';
    updateActionsSummary(row);
    panel.remove();
  });
  panel.appendChild(doneBtn);
  actionsEl.appendChild(panel);
}

function addHaMetricRow(device, deviceIdx, container, metric = '', entityId = '', excludeMetrics = []) {
  if (!container) container = document.getElementById(`ha-mappings-list-${deviceIdx}`);
  if (!container) return;
  // Mapping values may be a plain entity_id string (backward compat) or an
  // object { entityId, actions: [...] } carrying configured actions (AC-7.3).
  let initialActions = [];
  if (entityId && typeof entityId === 'object' && !Array.isArray(entityId)) {
    initialActions = Array.isArray(entityId.actions) ? entityId.actions : [];
    entityId = entityId.entityId || '';
  }
  const row = document.createElement('div');
  row.className = 'metric-row';
  if (initialActions.length) row.dataset.actions = JSON.stringify(initialActions);
  const metricSelect = createMetricDropdown(metric, excludeMetrics);
  const entitySelect = document.createElement('select');
  entitySelect.className = 'entity-select';
  entitySelect.title = entityId || 'Select entity';
  entitySelect.innerHTML = '<option value="">-- Select entity --</option>';
  if (entityId) {
    const opt = document.createElement('option');
    opt.value = entityId;
    opt.textContent = entityId;
    opt.selected = true;
    entitySelect.appendChild(opt);
  }
  // Defensive: strip any options containing commas (pollution from dead data-tooltip etc.)
  entitySelect.querySelectorAll('option').forEach(o => {
    if (o.value && o.value.includes(',')) o.remove();
  });
  const actionsEl = document.createElement('div');
  actionsEl.className = 'ha-entity-actions';
  actionsEl.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:0.35rem;margin-top:0.25rem;';
  const cfgBtn = document.createElement('button');
  cfgBtn.type = 'button';
  cfgBtn.className = 'fetch-btn configure-actions-btn';
  cfgBtn.textContent = '⚙ Configure Actions';
  cfgBtn.style.cssText = 'font-size:0.7rem;padding:0.15rem 0.5rem;';
  cfgBtn.addEventListener('click', async () => {
    const entityId = entitySelect.value;
    const card = row.closest('.device-card');
    if (!entityId) {
      const warn = document.createElement('span');
      warn.textContent = 'Select an entity first';
      warn.style.cssText = 'color:#f66;font-size:0.7rem;';
      actionsEl.appendChild(warn);
      setTimeout(() => warn.remove(), 3000);
      return;
    }
    // SSRF guard (#69): send the device name, not url/token — the server
    // resolves the device from its own config.
    const device = card ? card.querySelector('input[name$="[name]"]')?.value || card.dataset.index : '';
    if (!device) {
      const warn = document.createElement('span');
      warn.textContent = 'Device name required';
      warn.style.cssText = 'color:#f66;font-size:0.7rem;';
      actionsEl.appendChild(warn);
      setTimeout(() => warn.remove(), 3000);
      return;
    }
    const oldPanel = actionsEl.querySelector('.ha-actions-panel');
    if (oldPanel) oldPanel.remove();
    cfgBtn.disabled = true;
    cfgBtn.textContent = 'Loading…';
    try {
      // POST /api/ha/entity-actions (AC-7.4) — CSRF header required for POSTs.
      const res = await fetch('/api/ha/entity-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ device, entityId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load actions');
      let selected = [];
      try { selected = row.dataset.actions ? JSON.parse(row.dataset.actions) : []; } catch { selected = []; }
      renderActionsPanel(actionsEl, row, data, selected);
    } catch (e) {
      const err = document.createElement('span');
      err.textContent = e.message;
      err.style.cssText = 'color:#f66;font-size:0.7rem;';
      actionsEl.appendChild(err);
      setTimeout(() => err.remove(), 4000);
    } finally {
      cfgBtn.disabled = false;
      cfgBtn.textContent = '⚙ Configure Actions';
    }
  });
  actionsEl.appendChild(cfgBtn);
  const summaryEl = document.createElement('span');
  summaryEl.className = 'ha-actions-summary';
  summaryEl.style.cssText = 'font-size:0.7rem;color:var(--text-secondary);';
  actionsEl.appendChild(summaryEl);
  entitySelect.addEventListener('change', function() {
    // Actions are per-entity: reset them when the entity changes.
    row.dataset.actions = '';
    const panel = actionsEl.querySelector('.ha-actions-panel');
    if (panel) panel.remove();
    updateActionsSummary(row);
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshAllMetricDropdowns();
  });
  metricSelect.addEventListener('change', () => {
    refreshAllMetricDropdowns();
  });
  row.appendChild(metricSelect);
  row.appendChild(entitySelect);
  row.appendChild(actionsEl);
  row.appendChild(removeBtn);
  container.appendChild(row);
  updateActionsSummary(row);
  return row;
}

// ── HA enriched entity catalog (issue #108 wave 5, AC-25) ────────────────
// Fetch Entities now pulls the enriched catalog (GET /api/ha/entities — the
// 8-domain projection with friendly_name/unit/state enrichment) and renders
// expose-all rows: empty metric dropdown + entity <select> whose option reads
// "friendly_name (unit) - entity_id - <state>". A domain filter <select>
// re-renders those rows from the last fetch. The existing add-row entity-<select>
// flow, '⚙ Configure Actions' and the {entityId, actions} value round-trip are
// all preserved — expose rows use the SAME row anatomy as addHaMetricRow, so
// the unchanged save collector persists {userMetric: entity_id} byte-identically
// (actions only when configured). Expose rows never touch saved mappings and
// never remove rows that already carry a metric.
const HA_ENTITY_DOMAINS = ['sensor', 'binary_sensor', 'switch', 'light', 'climate', 'fan', 'cover', 'input_boolean'];

function haEntityIdOf(e) {
  if (!e) return '';
  if (typeof e.entity_id === 'string') return e.entity_id;
  if (e.id !== undefined && e.id !== null) return String(e.id);
  return '';
}

function haDomainOf(e) {
  const id = haEntityIdOf(e);
  return id ? id.split('.')[0] : '';
}

// "friendly_name (unit) - sensor.x - <state>" — AC-25 chip/option text.
function haEntityLabelText(e) {
  const id = haEntityIdOf(e);
  const name = (e && (e.label || e.name)) || id;
  const unit = (e && e.unit_of_measurement !== undefined && e.unit_of_measurement !== null && e.unit_of_measurement !== '') ? ` (${e.unit_of_measurement})` : '';
  let state = '';
  if (e && e.state !== undefined && e.state !== null && e.state !== '') state = String(e.state);
  return `${name}${unit} - ${id}${state ? ` - ${state}` : ''}`;
}

async function fetchHaEntityCatalog(url, token) {
  // Enriched endpoint (wave 2): items [{ id: entity_id, entity_id, domain,
  // label: friendly_name, name, unit_of_measurement, device_class, state,
  // attributes, kind: 'ha' }] for the same 8 domains. The legacy string-array
  // /api/ha-device-entities endpoint stays untouched for the setup.js wizard.
  const res = await fetch(`/api/ha/entities?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || `HA fetch failed (HTTP ${res.status})`);
  return Array.isArray(data) ? data : [];
}

// Domain filter <select> (all + the 8 catalog domains). Created lazily on the
// first successful fetch; re-render keeps only the expose rows, never rows that
// carry a mapping.
function ensureHaDomainToolbar(card) {
  if (!card || !card.querySelector) return null;
  let existing = card.querySelector('.ha-catalog-toolbar .ha-domain-filter');
  if (existing) return existing;
  const listEl = card.querySelector('.mappings-section .mappings-list');
  if (!listEl) return null;
  const bar = document.createElement('div');
  bar.className = 'ha-catalog-toolbar';
  bar.style.cssText = 'display:flex;align-items:center;gap:0.5rem;margin:0 0 0.5rem;flex-wrap:wrap;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:0.75em;color:var(--text-muted);white-space:nowrap;';
  lbl.textContent = 'Catalog domain:';
  const sel = document.createElement('select');
  sel.className = 'ha-domain-filter';
  sel.style.cssText = 'font-size:0.8rem;padding:0.3rem 0.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;';
  const addOpt = (v, t) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  };
  addOpt('all', 'All domains');
  HA_ENTITY_DOMAINS.forEach(d => addOpt(d, d));
  sel.value = (card && card._haDomain) || 'all';
  sel.addEventListener('change', () => {
    card._haDomain = sel.value;
    renderHaCatalogRows(card);
  });
  const count = document.createElement('span');
  count.className = 'ha-catalog-count';
  count.style.cssText = 'font-size:0.72em;color:var(--text-secondary);';
  bar.appendChild(lbl);
  bar.appendChild(sel);
  bar.appendChild(count);
  listEl.before(bar);
  return sel;
}

// One expose-all row for a catalog entity: the addHaMetricRow anatomy (metric
// dropdown + entity <select> + Configure Actions + remove) with the entity
// pre-bound and its option text enriched. Marked data-ha-expose="1" so
// re-renders can replace the unmapped rows while never dropping mapped ones.
function addHaCatalogRow(card, listEl, ent, excludeMetrics) {
  const id = haEntityIdOf(ent);
  if (!id || !listEl) return null;
  const row = addHaMetricRow({}, card ? (card.dataset.index || 0) : 0, listEl, '', id, excludeMetrics || []);
  if (!row) return null;
  row.dataset.haExpose = '1';
  row._catalogEntity = ent || null;
  const label = haEntityLabelText(ent);
  const es = row.querySelector('.entity-select');
  if (es) {
    const opt = Array.from(es.options).find(o => o.value === id);
    if (opt) opt.textContent = label;
    es.title = label;
  }
  const metricSelect = row.querySelector('.metric-name');
  if (metricSelect && window.CatalogUI && typeof window.CatalogUI.createInlineMetricControl === 'function') {
    window.CatalogUI.createInlineMetricControl(haAdapter, row, metricSelect, () => row._catalogEntity || null);
  }
  return row;
}

// Re-render the expose rows from the card's last fetch (card._haCatalog),
// honoring card._haDomain. Mapped rows are never dropped or duplicated: stale
// expose rows that now carry a metric + entity become regular mapped rows
// (marker removed); the rest are replaced by fresh rows for the current
// domain, skipping entities already mapped on this card.
function renderHaCatalogRows(card) {
  const listEl = card ? card.querySelector('.mappings-section .mappings-list') : null;
  if (!card || !listEl) return 0;
  Array.from(listEl.querySelectorAll('.metric-row[data-ha-expose="1"]')).forEach(row => {
    const ms = row.querySelector('.metric-name');
    const es = row.querySelector('.entity-select');
    if (ms && ms.value && es && es.value) row.removeAttribute('data-ha-expose');
    else row.remove();
  });
  const mappedEntities = new Set();
  listEl.querySelectorAll('.metric-row').forEach(row => {
    const ms = row.querySelector('.metric-name');
    const es = row.querySelector('.entity-select');
    if (ms && ms.value && es && es.value) mappedEntities.add(es.value);
  });
  const items = (card && Array.isArray(card._haCatalog)) ? card._haCatalog : [];
  const domain = (card && card._haDomain) || 'all';
  const filtered = (domain === 'all' ? items : items.filter(it => haDomainOf(it) === domain))
    .filter(it => haEntityIdOf(it))
    .sort((a, b) => {
      const d = haDomainOf(a).localeCompare(haDomainOf(b));
      return d !== 0 ? d : haEntityIdOf(a).localeCompare(haEntityIdOf(b));
    });
  const used = Array.from(getAllUsedMetrics());
  let added = 0;
  filtered.forEach(ent => {
    const id = haEntityIdOf(ent);
    if (!id || mappedEntities.has(id)) return;
    addHaCatalogRow(card, listEl, ent, used);
    added++;
  });
  const countEl = card.querySelector('.ha-catalog-count');
  if (countEl) {
    countEl.textContent = domain === 'all'
      ? `${filtered.length} entities across all domains — ${added} expose rows added, ${mappedEntities.size} already mapped`
      : `${filtered.length} entities in "${domain}" — ${added} expose rows added, ${mappedEntities.size} already mapped`;
  }
  refreshAllMetricDropdowns();
  updateMappingSaveNote(card);
  return added;
}

function reindexHa() {
  const cards = document.querySelectorAll('#ha-devices-container .device-card');
  haDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    const nameInput = card.querySelector('.device-header input[type="text"]');
    if (nameInput) nameInput.name = `ha_devices[${i}][name]`;
    const enableCb = card.querySelector('.device-header input[type="checkbox"]');
    if (enableCb) enableCb.name = `ha_devices[${i}][enabled]`;
    const urlInput = card.querySelector(`input[name$="[url]"]`);
    if (urlInput) urlInput.name = `ha_devices[${i}][url]`;
    const tokenInput = card.querySelector(`input[name$="[token]"]`);
    if (tokenInput) tokenInput.name = `ha_devices[${i}][token]`;
    const pollInput = card.querySelector(`input[name$="[poll_interval]"]`);
    if (pollInput) pollInput.name = `ha_devices[${i}][poll_interval]`;
    const addBtn = card.querySelector('.add-ha-metric');
    if (addBtn) addBtn.dataset.device = i;
    haDeviceCounter++;
  });
}

const addHaBtn = document.getElementById('add-ha-device');
if (addHaBtn) addHaBtn.addEventListener('click', () => {
  const idx = haDeviceCounter;
  renderHaDevice({ name: '', url: '', token: '', enabled: true, poll_interval: 30, entities: {} }, idx);
});

// ======================== MQTT ========================
let mqttDeviceCounter = 0;
function buildMqttDeviceList(devices) {
  const container = document.getElementById('mqtt-devices-container');
  container.innerHTML = '';
  mqttDeviceCounter = 0;
  devices.forEach((dev, idx) => renderMqttDevice(dev, idx));
  refreshAllMetricDropdowns();
}

function renderMqttDevice(device, idx) {
  const container = document.getElementById('mqtt-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="mqtt_devices[${idx}][name]" placeholder="Broker Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap" style="margin:0 1rem;"><label class="toggle-switch"><input type="checkbox" name="mqtt_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-mqtt">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][broker]" placeholder="mqtt://broker.local:1883" value="${escapeHtml(device.broker || '')}">
    </div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][username]" placeholder="Username" value="${escapeHtml(device.username || '')}">
      <input type="password" name="mqtt_devices[${idx}][password]" placeholder="Password" value="${escapeHtml(device.password || '')}">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🧪</span> Test</div>
    <div class="test-row">
      <button type="button" class="fetch-btn test-mqtt-broker">Test Broker</button>
      <span class="test-status" id="mqtt-broker-status-${idx}"></span>
    </div>
    <div class="test-row">
      <input type="text" class="test-topic-input" placeholder="Test Topic">
      <button type="button" class="fetch-btn test-mqtt-topic-btn">Test Topic</button>
      <span class="test-status" id="mqtt-topic-status-${idx}"></span>
    </div>
    <div class="test-row">
      <button type="button" class="fetch-btn discover-mqtt-topics">🔍 Discover Topics</button>
      <span class="test-status" id="mqtt-discover-status-${idx}"></span>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Topic Mappings</div>
    <div class="mappings-section">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="mqtt-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="mqtt-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-mqtt-metric" data-device="${idx}">
        + Add Metric Mapping
        <span class="metric-help-icon">?</span>
      </button>
    </div>
  `;
  container.appendChild(card);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'metric-tooltip';
  tooltipEl.style.display = 'none';
  card.appendChild(tooltipEl);

  const removeMqttBtn = card.querySelector('[data-action="remove-mqtt"]');
  if (removeMqttBtn) removeMqttBtn.addEventListener('click', () => {
    if (showConfirm('Remove this MQTT broker and all its topic mappings?')) {
      card.remove();
      reindexMqtt();
      refreshAllMetricDropdowns();
    }
  });

  card.querySelector('.test-mqtt-broker').addEventListener('click', async function(e) {
    e.preventDefault();
    const statusEl = document.getElementById(`mqtt-broker-status-${idx}`);
    const broker = card.querySelector('[name^="mqtt_devices"][name$="[broker]"]').value.trim();
    const username = card.querySelector('[name^="mqtt_devices"][name$="[username]"]').value.trim();
    const password = card.querySelector('[name^="mqtt_devices"][name$="[password]"]').value.trim();
    if (!broker) {
      showStatus(statusEl, 'Enter a broker URL first', 'error');
      return;
    }
    showStatus(statusEl, 'Testing...', 'info');
    try {
      const params = new URLSearchParams({ broker });
      if (username) params.set('username', username);
      if (password) params.set('password', password);
      const res = await fetch(`/api/test-mqtt?${params.toString()}`);
      const data = await res.json();
      if (res.ok) showStatus(statusEl, data.message, 'success');
      else showStatus(statusEl, data.error || 'Test failed', 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  card.querySelector('.test-mqtt-topic-btn').addEventListener('click', async function(e) {
    e.preventDefault();
    const statusEl = document.getElementById(`mqtt-topic-status-${idx}`);
    const topic = card.querySelector('.test-topic-input').value.trim();
    if (!topic) {
      showStatus(statusEl, 'Enter a topic', 'error');
      return;
    }
    const broker = card.querySelector('[name^="mqtt_devices"][name$="[broker]"]').value.trim();
    const username = card.querySelector('[name^="mqtt_devices"][name$="[username]"]').value.trim();
    const password = card.querySelector('[name^="mqtt_devices"][name$="[password]"]').value.trim();
    if (!broker) {
      showStatus(statusEl, 'Enter a broker URL first', 'error');
      return;
    }
    showStatus(statusEl, 'Waiting for message...', 'info');
    try {
      const params = new URLSearchParams({ topic, broker });
      if (username) params.set('username', username);
      if (password) params.set('password', password);
      const res = await fetch(`/api/test-mqtt-topic?${params.toString()}`);
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `Received: ${data.value ?? data.raw}`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  card.querySelector('.discover-mqtt-topics').addEventListener('click', async function(e) {
    e.preventDefault();
    const statusEl = document.getElementById(`mqtt-discover-status-${idx}`);
    const mappingsContainer = card.querySelector('.mappings-list');
    const broker = card.querySelector('[name^="mqtt_devices"][name$="[broker]"]').value.trim();
    const username = card.querySelector('[name^="mqtt_devices"][name$="[username]"]').value.trim();
    const password = card.querySelector('[name^="mqtt_devices"][name$="[password]"]').value.trim();
    if (!broker) {
      showStatus(statusEl, 'Enter a broker URL first', 'error');
      return;
    }
    showStatus(statusEl, 'Listening for 15s...', 'info');
    try {
      const params = new URLSearchParams({ broker });
      if (username) params.set('username', username);
      if (password) params.set('password', password);
      const res = await fetch(`/api/mqtt-discover-topics?${params.toString()}`);
      const data = await res.json();
      const entries = Array.isArray(data && data.entries) ? data.entries : [];
      const topicsOnly = Array.isArray(data && data.topics) ? data.topics : [];
      if (res.ok && (entries.length || topicsOnly.length)) {
        // Collect existing topic→metric mappings before modifying DOM
        const existingTopics = new Set();
        mappingsContainer.querySelectorAll('.metric-row .topic-input').forEach(ti => {
          if (ti && ti.value) existingTopics.add(ti.value);
        });
        // AC-26/a5e9c01: add rows for newly discovered topics — additive only,
        // never remove or duplicate existing rows, never clear mapped rows.
        const globalUsed = getAllUsedMetrics();
        let added = 0;
        const discovered = entries.length
          ? entries.map(en => ({ topic: (en && en.topic != null) ? String(en.topic) : '', sample: (en && en.sample) || null }))
          : topicsOnly.map(t => ({ topic: String(t), sample: null }));
        discovered.forEach(en => {
          if (!en.topic || existingTopics.has(en.topic)) return; // already mapped — keep
          existingTopics.add(en.topic);
          addMqttDiscoveryRow(idx, mappingsContainer, en.topic, en.sample, Array.from(globalUsed));
          added++;
        });
        showStatus(statusEl, `Found ${data.count != null ? data.count : discovered.length} topics` + (added ? ` (${added} new)` : ' — all already mapped'), 'success');
        refreshAllMetricDropdowns();
        updateMappingSaveNote(mappingsContainer.closest('.device-card'));
      } else if (res.ok) {
        showStatus(statusEl, 'No topics found on broker', 'info');
      } else {
        showStatus(statusEl, data.error || 'Discovery failed', 'error');
      }
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  const mappingsList = card.querySelector('.mappings-list');

  card.querySelector('.add-mqtt-metric').addEventListener('click', () => {
    const used = getAllUsedMetrics();
    addMqttMetricRow(device, idx, mappingsList, '', '', Array.from(used));
    refreshAllMetricDropdowns();
  });

  const helpIcon = card.querySelector('.metric-help-icon');
  if (helpIcon) {
    helpIcon.addEventListener('mouseenter', (e) => {
      const text = allMetrics.map(m => m.name).join(', ');
      if (!text) return;
      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = 'Available metrics: ' + text;
      tooltip.style.display = 'block';
      const rect = helpIcon.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      tooltip.style.left = (rect.left - cardRect.left + 20) + 'px';
      tooltip.style.top = (rect.top - cardRect.top - 30) + 'px';
    });
    helpIcon.addEventListener('mouseleave', () => {
      const tooltip = card.querySelector('.metric-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });
  }
  renderMqttMappings(device.topics || {}, idx, mappingsList);
  // AC-26: on card render, re-hydrate additive catalog rows from the broker's
  // persisted discovery window (cache-backed; saved mappings are never touched).
  const brokerVal = card.querySelector('[name^="mqtt_devices"][name$="[broker]"]')?.value?.trim();
  if (brokerVal) hydrateMqttDiscoveryCache(card, idx, brokerVal);
  mqttDeviceCounter++;
}

function renderMqttMappings(topics, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(topics).forEach(([metric, topic]) => {
    addMqttMetricRow({}, deviceIdx, container, metric, topic, []);
  });
  if (Object.keys(topics).length === 0) addMqttMetricRow({}, deviceIdx, container);
}

function addMqttMetricRow(device, deviceIdx, container, metric = '', topic = '', excludeMetrics = [], sampleText = '') {
  if (!container) container = document.getElementById(`mqtt-mappings-list-${deviceIdx}`);
  if (!container) return null;
  const row = document.createElement('div');
  row.className = 'metric-row';
  const metricSelect = createMetricDropdown(metric, excludeMetrics);
  const topicInput = document.createElement('input');
  topicInput.type = 'text';
  topicInput.className = 'topic-input';
  topicInput.placeholder = 'topic';
  topicInput.value = topic;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshAllMetricDropdowns();
  });
  // When the metric selection changes, refresh globally
  metricSelect.addEventListener('change', () => {
    refreshAllMetricDropdowns();
  });
  row.appendChild(metricSelect);
  row.appendChild(topicInput);
  if (sampleText) {
    const chip = makeSampleChip('mqtt-sample', sampleText);
    if (chip) row.appendChild(chip);
  }
  row.appendChild(removeBtn);
  container.appendChild(row);
  return row;
}

// ── MQTT discovery catalog (issue #108 wave 5, AC-26) ────────────────────
// Sample chips (shared with the REST/external card): "topic = sample (type)".
function makeSampleChip(cls, text) {
  if (!text) return null;
  const chip = document.createElement('span');
  chip.className = cls;
  chip.textContent = text;
  chip.title = text;
  chip.style.cssText = 'flex:0 1 auto;max-width:38%;min-width:0;font-size:0.74em;padding:0.15rem 0.55rem;border:1px solid #39414f;border-radius:999px;background:rgba(120,145,190,0.08);color:var(--text-secondary,#93a1b5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  return chip;
}

function mqttSampleText(topic, sample) {
  let out = String(topic == null ? '' : topic);
  if (sample && typeof sample === 'object') {
    const type = sample.type ? String(sample.type) : '';
    let val = sample.value;
    if (type === 'string' && sample.raw !== undefined && sample.raw !== null) val = sample.raw;
    const vs = String(val == null ? '' : val);
    out = `${out} = ${vs}${type ? ` (${type})` : ''}`;
  }
  return out;
}

// One cache/discovery row: metric dropdown + topic input prefilled + sample
// chip. Same .metric-row DOM contract as addMqttMetricRow, so the collector
// persists only rows with a chosen metric AND topic; mapped rows keep polling.
function addMqttDiscoveryRow(deviceIdx, container, topic, sample, excludeMetrics) {
  const t = String(topic == null ? '' : topic);
  if (!t || !container) return null;
  const row = addMqttMetricRow({}, deviceIdx, container, '', t, excludeMetrics || [], mqttSampleText(t, sample));
  if (!row) return null;
  row._catalogEntity = (sample && typeof sample === 'object') ? { topic: t, sample } : { topic: t, sample: null };
  // AC-38: cache/discovery rows are catalog rows — the save collector stamps
  // _catalogV2 when a card persists one (manual '+ Add Mapping' rows via
  // addMqttMetricRow carry no data-catalog and stay legacy-stamped).
  row.dataset.catalog = '1';
  const metricSelect = row.querySelector('.metric-name');
  if (metricSelect && window.CatalogUI && typeof window.CatalogUI.createInlineMetricControl === 'function') {
    window.CatalogUI.createInlineMetricControl(mqttAdapter, row, metricSelect, () => row._catalogEntity || null);
  }
  return row;
}

// AC-26: on card render, re-hydrate rows from the persisted discovery window
// for this broker (GET /api/mqtt-discovery-cache — no listening). Additive:
// never removes or duplicates rows that already exist (saved mappings win).
async function hydrateMqttDiscoveryCache(card, idx, broker) {
  try {
    const res = await fetch(`/api/mqtt-discovery-cache?broker=${encodeURIComponent(broker)}`);
    const data = await res.json();
    if (!res.ok || !data || !Array.isArray(data.entries) || !data.entries.length) return;
    const mappingsContainer = (card ? card.querySelector('.mappings-list') : null) || document.getElementById(`mqtt-mappings-list-${idx}`);
    if (!mappingsContainer) return;
    const existingTopics = new Set();
    mappingsContainer.querySelectorAll('.metric-row .topic-input').forEach(ti => {
      if (ti && ti.value) existingTopics.add(ti.value);
    });
    const used = getAllUsedMetrics();
    let added = 0;
    data.entries.slice()
      .sort((a, b) => String(a && a.topic).localeCompare(String(b && b.topic)))
      .forEach(en => {
        const topic = (en && en.topic != null) ? String(en.topic) : '';
        if (!topic || existingTopics.has(topic)) return;
        existingTopics.add(topic);
        addMqttDiscoveryRow(idx, mappingsContainer, topic, (en && en.sample) || null, Array.from(used));
        added++;
      });
    if (!added) return;
    refreshAllMetricDropdowns();
    updateMappingSaveNote(mappingsContainer.closest('.device-card'));
    const statusEl = document.getElementById(`mqtt-discover-status-${idx}`);
    if (statusEl) {
      statusEl.textContent = `Cache: ${data.entries.length} topics from the last discovery window (${added} added)`;
      statusEl.className = 'status info';
    }
  } catch (e) {
    // Discovery cache hydration is best-effort — a missing/empty cache is fine.
  }
}

function reindexMqtt() {
  const cards = document.querySelectorAll('#mqtt-devices-container .device-card');
  mqttDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    mqttDeviceCounter++;
  });
}

const addMqttBtn = document.getElementById('add-mqtt-device');
if (addMqttBtn) addMqttBtn.addEventListener('click', () => {
  const idx = mqttDeviceCounter;
  renderMqttDevice({ name: '', broker: '', username: '', password: '', enabled: true, topics: {} }, idx);
});

// ======================== MODBUS ========================
let modbusDeviceCounter = 0;
function buildModbusDeviceList(devices) {
  const container = document.getElementById('modbus-devices-container');
  container.innerHTML = '';
  modbusDeviceCounter = 0;
  devices.forEach((dev, idx) => renderModbusDevice(dev, idx));
}

function renderModbusDevice(device, idx) {
  const modbusTransportLabels = (window.EPILYKOS_LABELS && window.EPILYKOS_LABELS.transportModbus) || { tcp: 'TCP (Modbus-TCP)', serial: 'Serial (RS485 / Modbus-RTU)' };
  const container = document.getElementById('modbus-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="modbus_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="modbus_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-modbus">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <select name="modbus_devices[${idx}][transport]" class="modbus-transport-select">
        <option value="tcp" ${device.transport === 'tcp' ? 'selected' : ''}>${modbusTransportLabels.tcp}</option>
        <option value="serial" ${device.transport === 'serial' ? 'selected' : ''}>${modbusTransportLabels.serial}</option>
      </select>
      <select name="modbus_devices[${idx}][profile]" class="modbus-profile-select">
        <option value="">-- Select profile --</option>
      </select>
    </div>
    <div class="modbus-tcp-fields" style="${device.transport === 'tcp' ? '' : 'display:none;'}">
      <div class="form-row">
        <input type="text" name="modbus_devices[${idx}][host]" placeholder="Host/IP" value="${escapeHtml(device.host || '')}">
        <input type="number" name="modbus_devices[${idx}][port]" placeholder="Port" value="${device.port || 502}">
      </div>
    </div>
    <div class="modbus-serial-fields" style="${device.transport === 'serial' ? '' : 'display:none;'}">
      <div class="form-row">
        <input type="text" name="modbus_devices[${idx}][serial_path]" placeholder="Serial path (e.g., /dev/ttyUSB0)" value="${escapeHtml(device.serial_path || '/dev/ttyUSB0')}">
        <input type="number" name="modbus_devices[${idx}][serial_baud]" placeholder="Baud rate" value="${device.serial_baud || 9600}">
      </div>
      <div class="form-row">
        <input type="number" name="modbus_devices[${idx}][serial_data_bits]" placeholder="Data bits" value="${device.serial_data_bits || 8}">
        <select name="modbus_devices[${idx}][serial_parity]">
          <option value="none" ${device.serial_parity === 'none' ? 'selected' : ''}>None</option>
          <option value="even" ${device.serial_parity === 'even' ? 'selected' : ''}>Even</option>
          <option value="odd" ${device.serial_parity === 'odd' ? 'selected' : ''}>Odd</option>
        </select>
      </div>
      <div class="form-row">
        <input type="number" name="modbus_devices[${idx}][serial_stop_bits]" placeholder="Stop bits" value="${device.serial_stop_bits || 1}">
      </div>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⚙️</span> Configuration</div>
    <div class="form-row">
      <input type="number" name="modbus_devices[${idx}][unit]" placeholder="Unit ID" value="${device.unit || 1}">
      <input type="number" name="modbus_devices[${idx}][poll_interval]" placeholder="Poll (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn test-modbus">Test Modbus</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Register Mappings</div>
    <div class="mappings-section">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="modbus-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="modbus-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn load-modbus-registers" data-device="${idx}">
        📥 Load Profile Registers
      </button>
      <button type="button" class="fetch-btn fetch-modbus-entities" data-device="${idx}" style="display:none;">
        📋 Fetch Profile Entities
      </button>
      <button type="button" class="fetch-btn add-modbus-mapping" data-device="${idx}" style="display:none;">
        + Add Mapping
      </button>
    </div>
  `;
  container.appendChild(card);
  // AC-29: remember the STORED device (mappings-key presence decides the
  // implicit→explicit-none flip warning on save). Brand-new cards carry
  // _newCard and are never warned.
  card._origDevice = (!device || device._newCard) ? null : device;
  const transportSelect = card.querySelector('.modbus-transport-select');
  const tcpFields = card.querySelector('.modbus-tcp-fields');
  const serialFields = card.querySelector('.modbus-serial-fields');
  transportSelect.addEventListener('change', (e) => {
    const isTcp = e.target.value === 'tcp';
    tcpFields.style.display = isTcp ? '' : 'none';
    serialFields.style.display = isTcp ? 'none' : '';
  });
  const profileSelect = card.querySelector('.modbus-profile-select');
  fetch('/api/modbus/profiles').then(r => r.json()).then(profiles => {
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === device.profile) opt.selected = true;
      profileSelect.appendChild(opt);
    });
  });
  const removeModbusBtn = card.querySelector('[data-action="remove-modbus"]');
  if (removeModbusBtn) removeModbusBtn.addEventListener('click', () => {
    if (showConfirm('Remove this Modbus device and all its register mappings?')) {
      card.remove();
      reindexModbus();
    }
  });
  card.querySelector('.test-modbus').addEventListener('click', async function() {
    const statusEl = document.createElement('span');
    statusEl.className = 'test-status';
    this.after(statusEl);
    const dev = {
      transport: transportSelect.value,
      host: card.querySelector('input[name$="[host]"]')?.value,
      port: card.querySelector('input[name$="[port]"]')?.value,
      serial_path: card.querySelector('input[name$="[serial_path]"]')?.value,
      serial_baud: card.querySelector('input[name$="[serial_baud]"]')?.value,
      serial_data_bits: card.querySelector('input[name$="[serial_data_bits]"]')?.value,
      serial_parity: card.querySelector('select[name$="[serial_parity]"]')?.value,
      serial_stop_bits: card.querySelector('input[name$="[serial_stop_bits]"]')?.value,
      unit: card.querySelector('input[name$="[unit]"]')?.value,
    };
    try {
      const res = await fetch('/api/test-modbus', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(dev) });
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `OK: ${data.value}`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });
  modbusDeviceCounter++;
  // Profile change → reset to the explicit catalog UI (AC-21): the mapping
  // list shows a hint (nothing is auto-created or pre-bound), the legacy
  // 'Load Profile Registers' button stays alongside Fetch/Add for the
  // import-style flow.
  profileSelect.addEventListener('change', () => {
    const profileId = profileSelect.value;
    const mappingsList = card.querySelector('.mappings-list');
    if (!mappingsList) return;
    if (mappingsList.children.length > 0 && !showConfirm('Changing profile will replace existing register mappings. Continue?')) {
      profileSelect.value = device.profile || '';
      return;
    }
    card._modbusEntities = null;
    if (!profileId) {
      CatalogUI.applyMode(modbusRegister, card, false);
      mappingsList.innerHTML = '';
      updateMappingSaveNote(card);
      return;
    }
    CatalogUI.applyMode(modbusRegister, card, true);
    mappingsList.innerHTML = '';
    mappingsList.appendChild(modbusRegisterResetNote());
    updateMappingSaveNote(card);
  });
  // Load button click — retained legacy path (imports the profile's register
  // defaults into pre-bound rows).
  card.querySelector('.load-modbus-registers').addEventListener('click', () => {
    const mappingsList = card.querySelector('.mappings-list');
    loadModbusRegisterMappings(profileSelect.value, idx, mappingsList).then(() => updateMappingSaveNote(card));
  });
  // Catalog flows: one empty-dropdown row per profile register (fetch) or a
  // blank entity-picker row (+ Add Mapping). Zero auto-creation.
  card.querySelector('.fetch-modbus-entities').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    CatalogUI.fetchAndRender(modbusRegister, card.querySelector('.mappings-list'), card.querySelector('.fetch-modbus-entities'), { profileId });
  });
  card.querySelector('.add-modbus-mapping').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    CatalogUI.addRow(modbusRegister, card, { profileId });
  });
  // Restore saved mappings on initial load (adapter-driven, resolves saved
  // addresses against the profile entity catalog). Blank cards start in the
  // Load-only state until a profile is chosen.
  if (device.profile) {
    const mappingsList = card.querySelector('.mappings-list');
    const hasMappings = device.mappings && Object.keys(device.mappings).length > 0;
    if (hasMappings) mappingsList.innerHTML = '<div class="note">Loading saved mappings…</div>';
    initModbusCardMappings(card, device.profile, device.mappings || {}, mappingsList);
  } else if (window.CatalogUI) {
    CatalogUI.applyMode(modbusRegister, card, false);
  }
}

function modbusRegisterResetNote() {
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'No mappings yet — “Fetch Profile Entities” lists every register for this profile (metrics are never auto-created), “+ Add Mapping” adds a single row, or “Load Profile Registers” imports the profile defaults.';
  return note;
}

// Async initialiser for a Modbus card: catalog mode + restore saved mappings
// through the shared component (chip rows, metric dropdowns pre-selected).
// NOTE: the shared component (catalog-ui.js) loads AFTER this file, so nothing
// here may touch CatalogUI before the first await yields.
async function initModbusCardMappings(card, profileId, savedMappings, mappingsList) {
  if (!profileId) return;
  if (!mappingsList) mappingsList = card.querySelector('.mappings-list');
  if (!mappingsList) return;
  const profileSel = card.querySelector('.modbus-profile-select');
  const profileStillSelected = () => {
    if (!profileSel) return true;
    return profileSel.value === '' || profileSel.value === profileId;
  };
  let entities = [];
  try {
    entities = await fetchModbusProfileEntities(profileId);
    card._modbusEntities = entities;
  } catch (e) {
    card._modbusEntities = [];
  }
  if (!profileStillSelected()) return;
  if (window.CatalogUI) CatalogUI.applyMode(modbusRegister, card, true);
  if (savedMappings && Object.keys(savedMappings).length > 0) {
    CatalogUI.renderSaved(modbusRegister, savedMappings, entities, mappingsList);
  } else {
    mappingsList.innerHTML = '';
    mappingsList.appendChild(modbusRegisterResetNote());
  }
  updateMappingSaveNote(card);
}

function reindexModbus() {
  const cards = document.querySelectorAll('#modbus-devices-container .device-card');
  modbusDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    modbusDeviceCounter++;
  });
}
const addModbusBtn = document.getElementById('add-modbus-device');
if (addModbusBtn) addModbusBtn.addEventListener('click', () => {
  const idx = modbusDeviceCounter;
  renderModbusDevice({ name: '', host: '', port: 502, unit: 1, poll_interval: 30, enabled: true, profile: '', transport: 'tcp', _newCard: true }, idx);
});

// ---------- Modbus register mapping helpers ----------
async function loadModbusRegisterMappings(profileId, deviceIdx, container) {
  container.innerHTML = '';
  container.innerHTML = '<div class="note">Loading profile...</div>';
  try {
    const res = await fetch(`/api/modbus/profile/${encodeURIComponent(profileId)}`);
    if (!res.ok) {
      container.innerHTML = '<div class="note" style="color:var(--error);">Profile not found</div>';
      return;
    }
    const profile = await res.json();
    const mappings = {};
    profile.registers.forEach(r => {
      // Metric-first: { metricName → address } (matches HA/MQTT pattern)
      if (r.metric) mappings[r.metric] = String(r.address);
    });
    renderModbusMappings(profileId, mappings, container);
  } catch (e) {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load profile</div>';
  }
}

function renderModbusMappings(profileId, mappings, container) {
  container.innerHTML = '';
  if (!mappings || Object.keys(mappings).length === 0) {
    container.innerHTML = '<div class="note">No registers in this profile.</div>';
    return;
  }
  // We need the profile registers for labels — fetch if not already loaded
  fetch(`/api/modbus/profile/${encodeURIComponent(profileId)}`).then(r => r.json()).then(profile => {
    const regMap = {};
    profile.registers.forEach(r => { regMap[String(r.address)] = r; });

    Object.entries(mappings).sort(([a], [b]) => parseInt(a) - parseInt(b) || a.localeCompare(b)).forEach(([metricName, address]) => {
      const reg = regMap[address];
      const label = reg ? reg.label || `Register ${address}` : `Register ${address}`;
      const typeInfo = reg ? `[${reg.type}, scale=${reg.scale}, ${reg.unit}]` : '';
      const row = document.createElement('div');
      row.className = 'metric-row';
      row.dataset.address = address;
      // AC-29: legacy Load rows stamp the same row-state contract as CatalogUI
      // rows (prevMetric + cleared flag when flipped back to empty).
      stampRowMetricState(row, metricName);

      const descSpan = document.createElement('span');
      descSpan.className = 'register-desc';
      descSpan.textContent = `${label} (Addr ${address}) ${typeInfo}`;
      descSpan.style.flex = '1';
      descSpan.style.fontSize = '0.85em';
      descSpan.style.overflow = 'hidden';
      descSpan.style.textOverflow = 'ellipsis';
      descSpan.style.whiteSpace = 'nowrap';

      const metricSelect = createMetricDropdown(metricName || '', getAllUsedMetrics ? Array.from(getAllUsedMetrics()) : []);
      metricSelect.className = 'metric-name';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn remove-metric';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        const cardEl = row.closest('.device-card');
        row.remove();
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
        updateMappingSaveNote(cardEl);
      });

      metricSelect.addEventListener('change', () => {
        syncRowClearedFlag(row, metricSelect);
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
      });

      row.appendChild(metricSelect);
      row.appendChild(descSpan);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });
    if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    updateMappingSaveNote(container.closest ? container.closest('.device-card') : null);
  }).catch(() => {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load register details</div>';
  });
}

// ── RS232 Field Mapping Helpers ────────────────────────────────────────

async function loadRs232Mappings(profileId, deviceIdx, container) {
  container.innerHTML = '';
  container.innerHTML = '<div class="note">Loading profile fields...</div>';
  try {
    const res = await fetch(`/api/rs232/profile/${encodeURIComponent(profileId)}`);
    if (!res.ok) {
      container.innerHTML = '<div class="note" style="color:var(--error);">Profile not found</div>';
      return;
    }
    const profile = await res.json();
    const mappings = {};

    // Query/response profiles: fields nested inside commands[]
    if (profile.commands && profile.commands.length > 0) {
      for (const cmd of profile.commands) {
        for (const field of (cmd.fields || [])) {
          const key = `${cmd.name}:${field.index}`;
          if (field.metric) mappings[field.metric] = key;
        }
      }
    }

    // Streaming profiles (VE.Direct): fields at profile level, keyed by label
    if (profile.fields && profile.fields.length > 0 && !profile.commands) {
      for (const field of profile.fields) {
        const key = field.label;
        const metricName = field.metric_prefix
          ? `${field.metric_prefix}_${field.metric}`
          : field.metric;
        if (metricName) mappings[metricName] = key;
      }
    }

    renderRs232Mappings(profileId, mappings, container);
  } catch (e) {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load RS232 profile</div>';
  }
}

function renderRs232Mappings(profileId, savedMappings, container) {
  container.innerHTML = '';
  if (!savedMappings || Object.keys(savedMappings).length === 0) {
    container.innerHTML = '<div class="note">No fields in this profile.</div>';
    return;
  }

  // Fetch profile to get field details (label, scale, unit)
  fetch(`/api/rs232/profile/${encodeURIComponent(profileId)}`).then(r => r.json()).then(profile => {
    // Build reverse lookup: key → field info
    const fieldMap = {};

    if (profile.commands && profile.commands.length > 0) {
      for (const cmd of profile.commands) {
        for (const field of (cmd.fields || [])) {
          const key = `${cmd.name}:${field.index}`;
          fieldMap[key] = { label: field.label, scale: field.scale, unit: field.unit, cmdName: cmd.name };
        }
      }
    }

    if (profile.fields && profile.fields.length > 0 && !profile.commands) {
      for (const field of profile.fields) {
        const key = field.label;
        fieldMap[key] = { label: field.label, scale: field.scale, unit: field.unit, type: field.type };
      }
    }

    // Sort by source key: query profiles by cmd then index, streaming by label
    const entries = Object.entries(savedMappings).sort(([, a], [, b]) => {
      const aCmd = a && a.includes(':') ? a.split(':')[0] : '';
      const bCmd = b && b.includes(':') ? b.split(':')[0] : '';
      if (aCmd !== bCmd) return aCmd.localeCompare(bCmd);
      const aIdx = a && a.includes(':') ? parseInt(a.split(':')[1]) : 0;
      const bIdx = b && b.includes(':') ? parseInt(b.split(':')[1]) : 0;
      return aIdx - bIdx;
    });

    entries.forEach(([metricName, sourceKey]) => {
      const info = fieldMap[sourceKey];
      const label = info ? info.label : sourceKey;
      const typeInfo = info
        ? (info.type ? `[${info.type}, scale=${info.scale ?? 1}, ${info.unit || ''}]` : `[scale=${info.scale ?? 1}, ${info.unit || ''}]`)
        : '';
      const row = document.createElement('div');
      row.className = 'metric-row';
      row.dataset.address = sourceKey;
      // AC-29: legacy Load rows stamp the same row-state contract as CatalogUI rows.
      stampRowMetricState(row, metricName);

      const descSpan = document.createElement('span');
      descSpan.className = 'register-desc';
      descSpan.textContent = `${label} (Key: ${sourceKey}) ${typeInfo}`;
      descSpan.style.flex = '1';
      descSpan.style.fontSize = '0.85em';
      descSpan.style.overflow = 'hidden';
      descSpan.style.textOverflow = 'ellipsis';
      descSpan.style.whiteSpace = 'nowrap';

      const metricSelect = createMetricDropdown(
        metricName,
        getAllUsedMetrics ? Array.from(getAllUsedMetrics()) : []
      );
      metricSelect.className = 'metric-name';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn remove-metric';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        const cardEl = row.closest('.device-card');
        row.remove();
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
        updateMappingSaveNote(cardEl);
      });

      metricSelect.addEventListener('change', () => {
        syncRowClearedFlag(row, metricSelect);
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
      });

      row.appendChild(metricSelect);
      row.appendChild(descSpan);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });

    if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    updateMappingSaveNote(container.closest ? container.closest('.device-card') : null);
  }).catch(() => {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load RS232 field details</div>';
  });
}

let rs232DeviceCounter = 0;
let availableRs232Ports = [];
// Profile list cache ({id,name,protocol}) — protocol drives which rs232 family
// adapter a card uses (register / ascii / vedirect / solax).
let rs232ProfilesCache = [];

function buildRs232DeviceList(devices) {
  const container = document.getElementById('rs232-devices-container');
  if (!container) return;
  container.innerHTML = '';
  rs232DeviceCounter = 0;
  fetch('/api/rs232/ports').then(r => r.json()).then(ports => {
    availableRs232Ports = Array.isArray(ports) ? ports : [];
    devices.forEach((dev, idx) => renderRs232Device(dev, idx));
  }).catch(() => {
    availableRs232Ports = [];
    devices.forEach((dev, idx) => renderRs232Device(dev, idx));
  });
}

function renderRs232Device(device, idx) {
  const container = document.getElementById('rs232-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="rs232_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="rs232_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-rs232">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][serial_path]" class="rs232-port-select">
        <option value="">-- Select serial port --</option>
        ${availableRs232Ports.map(p =>
          `<option value="${escapeHtml(p.path)}" ${p.path === device.serial_path ? 'selected' : ''}>${escapeHtml(p.friendlyName)}</option>`
        ).join('')}
        <option value="custom" ${device.serial_path && !availableRs232Ports.some(p => p.path === device.serial_path) ? 'selected' : ''}>Custom path...</option>
      </select>
    </div>
    <div class="form-row rs232-custom-path" style="${device.serial_path && !availableRs232Ports.some(p => p.path === device.serial_path) ? '' : 'display:none;'}">
      <input type="text" name="rs232_devices[${idx}][custom_path]" placeholder="/dev/ttyUSB0" value="${escapeHtml(device.serial_path || '/dev/ttyUSB0')}">
    </div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][baud]">
        ${[300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b =>
          `<option value="${b}" ${(parseInt(device.baud) || 9600) == b ? 'selected' : ''}>${b} baud</option>`
        ).join('')}
      </select>
      <select name="rs232_devices[${idx}][parity]">
        <option value="none" ${(device.parity || 'none') === 'none' ? 'selected' : ''}>None</option>
        <option value="even" ${device.parity === 'even' ? 'selected' : ''}>Even</option>
        <option value="odd" ${device.parity === 'odd' ? 'selected' : ''}>Odd</option>
      </select>
      <select name="rs232_devices[${idx}][data_bits]">
        <option value="7" ${parseInt(device.data_bits) === 7 ? 'selected' : ''}>7 bits</option>
        <option value="8" ${(parseInt(device.data_bits) || 8) === 8 ? 'selected' : ''}>8 bits</option>
      </select>
      <select name="rs232_devices[${idx}][stop_bits]">
        <option value="1" ${(parseInt(device.stop_bits) || 1) === 1 ? 'selected' : ''}>1 stop</option>
        <option value="2" ${parseInt(device.stop_bits) === 2 ? 'selected' : ''}>2 stop</option>
      </select>
      <input type="number" name="rs232_devices[${idx}][modbus_unit_id]" placeholder="Modbus Unit ID" value="${device.modbus_unit_id || 5}" style="width:120px;" title="Modbus Unit ID">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⚙️</span> Configuration</div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][profile]" class="rs232-profile-select">
        <option value="">-- Select profile --</option>
      </select>
      <input type="number" name="rs232_devices[${idx}][timeout]" placeholder="Timeout (ms)" value="${device.timeout || 5000}" style="width:140px;">
      <button type="button" class="fetch-btn test-rs232">Test RS232</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Field Mappings</div>
    <div class="mappings-section">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="rs232-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="rs232-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn load-rs232-fields" data-device="${idx}">
        📥 Load Profile Fields
      </button>
      <button type="button" class="fetch-btn fetch-rs232-entities" data-device="${idx}" style="display:none;">
        📋 Fetch Profile Entities
      </button>
      <button type="button" class="fetch-btn add-rs232-mapping" data-device="${idx}" style="display:none;">
        + Add Mapping
      </button>
    </div>
  `;
  container.appendChild(card);
  // AC-29: stored-device capture (see renderModbusDevice).
  card._origDevice = (!device || device._newCard) ? null : device;

  const portSelect = card.querySelector('.rs232-port-select');
  const customPathDiv = card.querySelector('.rs232-custom-path');
  portSelect.addEventListener('change', e => {
    customPathDiv.style.display = e.target.value === 'custom' ? '' : 'none';
  });

  const profileSelect = card.querySelector('.rs232-profile-select');
  fetch('/api/rs232/profiles').then(r => r.json()).then(profiles => {
    rs232ProfilesCache = Array.isArray(profiles) ? profiles : rs232ProfilesCache;
    profiles.forEach(p => {
      if (/bms/i.test(String(p.id) + ' ' + String(p.name))) return;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.protocol})`;
      if (p.id === device.profile) opt.selected = true;
      profileSelect.appendChild(opt);
    });
    // Profile change → family-adapter dispatch (#108 wave 4, AC-22): apply the
    // profile's serial defaults, reset the mapping list to the explicit
    // catalog UI (nothing auto-created/pre-bound). The legacy 'Load Profile
    // Fields' button stays alongside Fetch/Add.
    profileSelect.addEventListener('change', () => {
      const mappingsList = card.querySelector('.mappings-list');
      if (!mappingsList) return;
      if (mappingsList.children.length > 0 && !showConfirm('Changing profile will replace existing field mappings. Continue?')) {
        profileSelect.value = device.profile || '';
        return;
      }
      const profileId = profileSelect.value;
      card._rs232Entities = null;
      if (!profileId) {
        CatalogUI.applyMode(CatalogUI.adapter('rs232Ascii'), card, false);
        mappingsList.innerHTML = '';
        updateMappingSaveNote(card);
        return;
      }
      // Apply profile defaults (serial params + modbus unit id) so e.g. the
      // Anern renders at its 2400 baud / unit id 5 without manual tuning.
      fetch(`/api/rs232/profile/${encodeURIComponent(profileId)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(profile => {
          if (profile && profile.defaults) {
            const d = profile.defaults;
            const baudSelect = card.querySelector('select[name$="[baud]"]');
            if (baudSelect && d.baud != null) baudSelect.value = String(d.baud);
            const dataBits = card.querySelector('select[name$="[data_bits]"]');
            if (dataBits && d.dataBits != null) dataBits.value = String(d.dataBits);
            const stopBits = card.querySelector('select[name$="[stop_bits]"]');
            if (stopBits && d.stopBits != null) stopBits.value = String(d.stopBits);
            const parity = card.querySelector('select[name$="[parity]"]');
            if (parity && d.parity != null) parity.value = d.parity;
          }
          const unitIdInput = card.querySelector('input[name$="[modbus_unit_id]"]');
          if (unitIdInput && profile && profile.default_unit_id != null) unitIdInput.value = profile.default_unit_id;
        })
        .catch(() => {})
        .finally(() => {
          const meta = rs232ProfilesCache.find(x => x.id === profileId) || null;
          const adapter = CatalogUI.adapter(rs232FamilyAdapterKey(meta) || 'rs232Ascii');
          CatalogUI.applyMode(adapter, card, true);
          mappingsList.innerHTML = '';
          mappingsList.appendChild(rs232ResetNote());
          updateMappingSaveNote(card);
        });
    });
  });

  const removeRs232Btn = card.querySelector('[data-action="remove-rs232"]');
  if (removeRs232Btn) removeRs232Btn.addEventListener('click', () => {
    if (showConfirm('Remove this RS232 device?')) {
      card.remove();
      reindexRs232();
    }
  });

  card.querySelector('.test-rs232').addEventListener('click', async function() {
    const statusEl = document.createElement('span');
    statusEl.className = 'test-status';
    this.after(statusEl);
    const dev = collectRs232Config(card);
    try {
      const res = await fetch('/api/test-rs232', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(dev),
      });
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `OK: ${Object.keys(data.metrics || {}).length} metrics`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  rs232DeviceCounter++;

  // Load button click — retained legacy path (imports the profile's field
  // defaults into pre-bound rows; covers query/ascii + vedirect families).
  card.querySelector('.load-rs232-fields').addEventListener('click', () => {
    const mappingsList = card.querySelector('.mappings-list');
    loadRs232Mappings(profileSelect.value, idx, mappingsList).then(() => updateMappingSaveNote(card));
  });

  // Catalog flows: one empty-dropdown row per profile entity (fetch) or a
  // blank entity-picker row (+ Add Mapping). Zero auto-creation.
  card.querySelector('.fetch-rs232-entities').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    const meta = rs232ProfilesCache.find(x => x.id === profileId) || null;
    const adapter = CatalogUI.adapter(rs232FamilyAdapterKey(meta) || 'rs232Ascii');
    CatalogUI.fetchAndRender(adapter, card.querySelector('.mappings-list'), card.querySelector('.fetch-rs232-entities'), { profileId });
  });
  card.querySelector('.add-rs232-mapping').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    const meta = rs232ProfilesCache.find(x => x.id === profileId) || null;
    const adapter = CatalogUI.adapter(rs232FamilyAdapterKey(meta) || 'rs232Ascii');
    CatalogUI.addRow(adapter, card, { profileId });
  });

  // Restore saved mappings on initial load (family-adapter driven, resolves
  // saved values against the profile entity catalog). Blank cards start in the
  // Load-only state until a profile is chosen.
  if (device.profile) {
    const mappingsList = card.querySelector('.mappings-list');
    const hasMappings = device.mappings && Object.keys(device.mappings).length > 0;
    if (hasMappings) mappingsList.innerHTML = '<div class="note">Loading saved mappings…</div>';
    initRs232CardMappings(card, device.profile, device.mappings || {}, mappingsList);
  } else if (window.CatalogUI) {
    CatalogUI.applyMode(CatalogUI.adapter('rs232Ascii'), card, false);
  }
}

function rs232ResetNote() {
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'No mappings yet — “Fetch Profile Entities” lists every field for this profile (metrics are never auto-created), “+ Add Mapping” adds a single row, or “Load Profile Fields” imports the profile defaults.';
  return note;
}

// Pick the rs232 family adapter from fetched entities when the profile-list
// metadata is unavailable (entities carry the projection kind).
function rs232AdapterFromEntities(entities) {
  const first = (Array.isArray(entities) && entities[0]) || null;
  if (!first || !window.CatalogUI) return CatalogUI.adapter('rs232Ascii');
  const kind = String(first.kind || '').toLowerCase();
  if (kind === 'register') return CatalogUI.adapter('rs232Register');
  if (kind === 'vedirect') return CatalogUI.adapter('rs232Vedirect');
  if (kind === 'binary') return CatalogUI.adapter('rs232Solax');
  return CatalogUI.adapter('rs232Ascii');
}

// Async initialiser for an RS232 card: family-adapter mode + restore saved
// mappings through the shared component (chip rows, metric dropdowns
// pre-selected, handles resolved against the catalog).
async function initRs232CardMappings(card, profileId, savedMappings, mappingsList) {
  if (!profileId) return;
  if (!mappingsList) mappingsList = card.querySelector('.mappings-list');
  if (!mappingsList) return;
  const profileSel = card.querySelector('.rs232-profile-select');
  const profileStillSelected = () => {
    if (!profileSel) return true;
    return profileSel.value === '' || profileSel.value === profileId;
  };
  let entities = [];
  try {
    entities = await fetchRs232ProfileEntities(profileId);
    card._rs232Entities = entities;
  } catch (e) {
    card._rs232Entities = [];
  }
  if (!profileStillSelected()) return;
  const meta = rs232ProfilesCache.find(x => x.id === profileId) || null;
  let adapter = meta ? CatalogUI.adapter(rs232FamilyAdapterKey(meta)) : null;
  if (!adapter) adapter = rs232AdapterFromEntities(entities);
  if (!adapter) adapter = CatalogUI.adapter('rs232Ascii');
  CatalogUI.applyMode(adapter, card, true);
  if (savedMappings && Object.keys(savedMappings).length > 0) {
    CatalogUI.renderSaved(adapter, savedMappings, entities, mappingsList);
  } else {
    mappingsList.innerHTML = '';
    mappingsList.appendChild(rs232ResetNote());
  }
  updateMappingSaveNote(card);
}

function reindexRs232() {
  const cards = document.querySelectorAll('#rs232-devices-container .device-card');
  rs232DeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    rs232DeviceCounter++;
  });
}

function collectRs232Config(card) {
  const dev = {};
  dev.name = card.querySelector('.device-header input[type="text"]').value;
  dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
  const portSelect = card.querySelector('.rs232-port-select');
  const customPath = card.querySelector('input[name$="[custom_path]"]')?.value;
  dev.serial_path = portSelect.value === 'custom' ? (customPath || '/dev/ttyUSB0') : portSelect.value;
  dev.baud = parseInt(card.querySelector('select[name$="[baud]"]').value) || 9600;
  dev.modbus_unit_id = parseInt(card.querySelector('input[name$="[modbus_unit_id]"]')?.value) || 5;
  dev.parity = card.querySelector('select[name$="[parity]"]').value || 'none';
  dev.data_bits = parseInt(card.querySelector('select[name$="[data_bits]"]').value) || 8;
  dev.stop_bits = parseInt(card.querySelector('select[name$="[stop_bits]"]').value) || 1;
  dev.profile = card.querySelector('.rs232-profile-select').value;
  dev.timeout = parseInt(card.querySelector('input[name$="[timeout]"]').value) || 5000;
  // Collect field mappings
  dev.mappings = {};
  card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
    const key = row.dataset.address;
    const metricName = row.querySelector('.metric-name').value;
    if (key && metricName) dev.mappings[metricName] = key;
  });
  // AC-38: catalog-mode saves (fetch/+Add/restore rows) carry data-catalog;
  // legacy 'Load Profile Fields' rows never do.
  if (cardHasCatalogRows(card)) dev._catalogV2 = true;
  return dev;
}

document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('add-rs232-device');
  if (addBtn) addBtn.addEventListener('click', () => {
    const idx = rs232DeviceCounter;
    renderRs232Device({
      name: '', serial_path: '', baud: 9600, data_bits: 8,
      stop_bits: 1, parity: 'none', profile: '', timeout: 5000,
      enabled: true, _newCard: true,
    }, idx);
  });
});

// ======================== EXTERNAL REST SOURCES ========================
let externalSourceCounter = 0;
function buildExternalSourceList(sources) {
  const container = document.getElementById('external-sources-container');
  if (!container) return;
  container.innerHTML = '';
  externalSourceCounter = 0;
  sources.forEach((src, idx) => renderExternalSource(src, idx));
  refreshAllMetricDropdowns();
}
function renderExternalSource(source, idx) {
  const container = document.getElementById('external-sources-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="external_sources[${idx}][name]" placeholder="Source Name (e.g., WeatherAPI)" value="${escapeHtml(source.name || '')}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="external_sources[${idx}][enabled]" ${source.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-external">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🌐</span> Endpoint</div>
    <div class="form-row">
      <input type="text" name="external_sources[${idx}][url]" placeholder="https://api.example.com/v1/data?key=..." value="${escapeHtml(source.url || '')}" style="font-family:monospace;font-size:0.82em;">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Mappings <span style="font-weight:normal;font-size:0.8em;color:var(--text-muted);">— for each row: pick a metric, then enter the JSON path in the response to extract its value</span></div>
    <div class="mappings-section">
      <div class="mappings-filter-bar" style="display:flex;gap:0.5rem;align-items:center;">
        <span style="font-size:0.75em;color:var(--text-muted);white-space:nowrap;">Metric</span>
        <span style="flex:1;font-size:0.75em;color:var(--text-muted);">JSON path in response</span>
        <span style="width:60px;"></span>
      </div>
      <div class="mappings-list" id="external-mappings-list-${idx}"></div>
      <div class="form-row" style="gap:0.5rem;align-items:center;margin-top:0.3rem;">
        <button type="button" class="fetch-btn add-external-metric" data-device="${idx}" style="flex:none;">+ Add Mapping</button>
        <button type="button" class="fetch-btn fetch-external-fields" data-device="${idx}" style="flex:none;">📋 Fetch Fields</button>
        <span class="test-status" id="external-fields-status-${idx}"></span>
      </div>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🧪</span> Test Path <span style="font-weight:normal;font-size:0.8em;color:var(--text-muted);">— enter a JSON path and test it against the URL above</span></div>
    <div class="test-row" style="display:flex;gap:0.5rem;align-items:center;margin-top:0.3rem;">
      <input type="text" class="test-jsonpath" placeholder="e.g. current.temp_c" style="flex:1;font-family:monospace;font-size:0.85em;">
      <button type="button" class="fetch-btn test-external" style="white-space:nowrap;">Test Path</button>
      <span class="test-status" id="external-test-status-${idx}"></span>
    </div>
  `;
  container.appendChild(card);
  const removeExtBtn = card.querySelector('[data-action="remove-external"]');
  if (removeExtBtn) removeExtBtn.addEventListener('click', () => {
    if (showConfirm('Remove this external source and all its metric mappings?')) {
      card.remove();
      reindexExternal();
      refreshAllMetricDropdowns();
    }
  });
  const mappingsList = card.querySelector('.mappings-list');
  renderExternalMappings(source.mappings || {}, idx, mappingsList);
  card.querySelector('.add-external-metric').addEventListener('click', () => {
    const used = getAllUsedMetrics();
    addExternalMetricRow(idx, mappingsList, '', '', Array.from(used));
    refreshAllMetricDropdowns();
  });
  // AC-27: "Fetch Fields" — flatten the live JSON document into one row per
  // scalar leaf (.jsonpath prefilled + sample/type chip). Re-fetch replaces
  // only the unmapped leaf rows; rows that gained a metric stay (they are
  // mappings now), and saved mappings/manual rows are never touched.
  card.querySelector('.fetch-external-fields').addEventListener('click', async () => {
    const statusEl = document.getElementById(`external-fields-status-${idx}`);
    const url = card.querySelector('input[name$="[url]"]').value;
    if (!url) { showStatus(statusEl, 'URL required', 'error'); return; }
    showStatus(statusEl, 'Fetching fields…', 'info');
    try {
      const res = await fetch('/api/external/fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || `Fields fetch failed (HTTP ${res.status})`);
      const leaves = Array.isArray(data && data.leaves) ? data.leaves : [];
      // Drop unmapped leaf rows from a previous fetch; keep rows that now hold
      // a metric (they are real mappings and must survive a re-fetch).
      mappingsList.querySelectorAll('.metric-row[data-external-leaf="1"]').forEach(row => {
        const ms = row.querySelector('.metric-name');
        if (ms && ms.value) row.removeAttribute('data-external-leaf');
        else row.remove();
      });
      // Never duplicate a path already present in ANY row (manual or mapped).
      const presentPaths = new Set();
      mappingsList.querySelectorAll('.metric-row .jsonpath').forEach(inp => {
        const p = (inp && inp.value) ? inp.value.trim() : '';
        if (p) presentPaths.add(p);
      });
      const used = getAllUsedMetrics();
      let added = 0;
      leaves.forEach(leaf => {
        const path = (leaf && leaf.path !== undefined) ? String(leaf.path).trim() : '';
        if (!path || presentPaths.has(path)) return;
        presentPaths.add(path);
        addExternalLeafRow(idx, mappingsList, leaf, Array.from(used));
        added++;
      });
      showStatus(statusEl,
        `Fetched ${data.leafCount != null ? data.leafCount : leaves.length} ${(data.leafCount || leaves.length) === 1 ? 'leaf' : 'leaves'}`
        + (data.truncated ? ' (truncated by caps)' : '')
        + (added ? ` — ${added} new field rows` : ' — all fields already listed'),
        'success');
      refreshAllMetricDropdowns();
      updateMappingSaveNote(mappingsList.closest('.device-card'));
    } catch (e) {
      showStatus(statusEl, e.message, 'error');
    }
  });
  const testBtn = card.querySelector('.test-external');
  const testPathInput = card.querySelector('.test-jsonpath');
  const testStatus = card.querySelector(`#external-test-status-${idx}`);
  testBtn.addEventListener('click', async () => {
    const url = card.querySelector('input[name$="[url]"]').value;
    const jsonPath = testPathInput.value.trim();
    if (!url) { showStatus(testStatus, 'URL required', 'error'); return; }
    showStatus(testStatus, 'Testing...', 'info');
    try {
      const res = await fetch('/api/test-external', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ url, jsonPath }) });
      const data = await res.json();
      if (res.ok) {
        const val = data.value;
        const isObj = typeof val === 'object' && val !== null;
        if (isObj) {
          const keys = Object.keys(val).slice(0, 5).join(', ');
          showStatus(testStatus, `Path resolves to an object. Drill deeper — try adding .${keys.split(',')[0]} to your path`, 'warn');
        } else {
          showStatus(testStatus, `${jsonPath || '(root)'} = ${val}`, 'success');
        }
      } else {
        showStatus(testStatus, data.error, 'error');
      }
    } catch (err) {
      showStatus(testStatus, err.message, 'error');
    }
  });
  externalSourceCounter++;
}
function renderExternalMappings(mappings, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(mappings).forEach(([metric, jsonPath]) => {
    addExternalMetricRow(deviceIdx, container, metric, jsonPath);
  });
  if (Object.keys(mappings).length === 0) addExternalMetricRow(deviceIdx, container);
}
function addExternalMetricRow(deviceIdx, container, metric = '', jsonPath = '', excludeMetrics = []) {
  const row = document.createElement('div');
  row.className = 'metric-row';
  const metricSelect = createMetricDropdown(metric, excludeMetrics);
  const jsonPathInput = document.createElement('input');
  jsonPathInput.type = 'text';
  jsonPathInput.className = 'jsonpath';
  jsonPathInput.placeholder = 'e.g. current.temp_c';
  jsonPathInput.value = jsonPath;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshAllMetricDropdowns();
  });
  metricSelect.addEventListener('change', () => {
    refreshAllMetricDropdowns();
  });
  row.appendChild(metricSelect);
  row.appendChild(jsonPathInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
  return row;
}

// ── REST/external leaf catalog (issue #108 wave 5, AC-27) ────────────────
// "Fetch Fields" → POST /api/external/fields {url} → one row per flattened
// scalar leaf: .jsonpath prefilled with the leaf path + a sample/type chip.
// Manual rows and the Test Path flow are unchanged; re-fetch replaces ONLY the
// unmapped leaf rows (data-external-leaf="1") — saved mappings are never
// touched, and leaf paths already present in any row are never duplicated.
function externalLeafSampleText(leaf) {
  const path = (leaf && leaf.path !== undefined) ? String(leaf.path) : '';
  let vs = '';
  let type = '';
  if (leaf) {
    if (leaf.sample !== undefined && leaf.sample !== null) vs = String(leaf.sample);
    else if (leaf.value !== undefined && leaf.value !== null) vs = String(leaf.value);
    if (leaf.type !== undefined && leaf.type !== null) type = String(leaf.type);
  }
  return `${path} = ${vs}${type ? ` (${type})` : ''}`;
}

function addExternalLeafRow(deviceIdx, container, leaf, excludeMetrics) {
  const path = (leaf && leaf.path !== undefined) ? String(leaf.path) : '';
  if (!path || !container) return null;
  const row = addExternalMetricRow(deviceIdx, container, '', path, excludeMetrics || []);
  if (!row) return null;
  row.dataset.externalLeaf = '1';
  row._catalogLeaf = leaf || null;
  const chip = makeSampleChip('jsonpath-sample', externalLeafSampleText(leaf));
  const removeBtn = row.querySelector('.remove-metric');
  if (chip && removeBtn) row.insertBefore(chip, removeBtn);
  const metricSelect = row.querySelector('.metric-name');
  if (metricSelect && window.CatalogUI && typeof window.CatalogUI.createInlineMetricControl === 'function') {
    window.CatalogUI.createInlineMetricControl(externalAdapter, row, metricSelect, () => row._catalogLeaf || null);
  }
  return row;
}

function reindexExternal() {
  const cards = document.querySelectorAll('#external-sources-container .device-card');
  externalSourceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    externalSourceCounter++;
  });
}
const addExternalBtn = document.getElementById('add-external-source');
if (addExternalBtn) addExternalBtn.addEventListener('click', () => {
  const idx = externalSourceCounter;
  renderExternalSource({ name: '', url: '', enabled: true, mappings: {} }, idx);
});

// ======================== BLUETOOTH BMS (with scan button, dynamic bridge URL) ========================
let bmsDeviceCounter = 0;

// ── BMS Scan Modal ─────────────────────────────────────
let bmsScanTargetIdx = -1;
let bmsScanTimestamp = 0;
let bmsScanInterval = null;

const bmsScanModal = document.getElementById('bms-scan-modal');
const bmsScanList = document.getElementById('bms-scan-list');
const bmsScanStatus = document.getElementById('bms-scan-status');
const bmsScanCacheBadge = document.getElementById('bms-scan-cache-badge');

function closeBmsScanModal() {
  if (!bmsScanModal) return;
  bmsScanModal.style.display = 'none';
  if (bmsScanTargetIdx >= 0) {
    const statusEl = document.getElementById(`bms-test-status-${bmsScanTargetIdx}`);
    if (statusEl && statusEl.textContent.includes('Scanning')) {
      statusEl.innerHTML = '';
      statusEl.className = 'test-status';
    }
  }
}

function openBmsScanModal(idx) {
  bmsScanTargetIdx = idx;
  bmsScanModal.style.display = 'flex';
  bmsScanList.innerHTML = '';
  bmsScanCacheBadge.textContent = '';
  runBmsScan(true);
}

async function runBmsScan(force) {
  bmsScanStatus.innerHTML = '<span class="bms-scan-spinner"></span>Scanning for BLE devices...';
  bmsScanList.innerHTML = '';
  bmsScanCacheBadge.textContent = '';

  try {
    const url = force ? '/api/bms/scan?force=1' : '/api/bms/scan';
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), credentials: 'include' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      bmsScanStatus.textContent = err.error || 'Scan failed';
      bmsScanList.innerHTML = '<div class="bms-scan-empty">Scan failed — bridge may be unreachable</div>';
      return;
    }
    const devices = await res.json();
    bmsScanTimestamp = Date.now();

    if (!devices.length) {
      bmsScanStatus.textContent = 'No BLE devices found';
      bmsScanList.innerHTML = '<div class="bms-scan-empty">No devices discovered in range.<br>Ensure Bluetooth is enabled on the server.</div>';
      bmsScanCacheBadge.textContent = 'Scanned just now';
      return;
    }

    bmsScanStatus.textContent = `Found ${devices.length} device${devices.length !== 1 ? 's' : ''}`;
    bmsScanCacheBadge.textContent = 'Scanned just now';

    // Sort by RSSI (strongest first)
    devices.sort((a, b) => b.rssi - a.rssi);

    bmsScanList.innerHTML = devices.map(d => {
      const rssiPct = Math.min(100, Math.max(0, ((d.rssi + 100) / 60) * 100));
      const strength = d.rssi > -60 ? 'strong' : d.rssi > -75 ? 'medium' : 'weak';
      const isBms = d.name && /bms|jk|jbd|daly/i.test(d.name);
      const bmsTag = isBms
        ? '<span class="bms-scan-bms-tag match">BMS</span>'
        : '<span class="bms-scan-bms-tag unknown">?</span>';
      return `<div class="bms-scan-device" data-address="${escapeHtml(d.address)}">
        <div class="bms-scan-rssi-bar"><div class="bms-scan-rssi-fill ${strength}" style="width:${rssiPct}%"></div></div>
        <span class="bms-scan-rssi-db">${d.rssi} dB</span>
        <span class="bms-scan-mac">${escapeHtml(d.address)}</span>
        <span class="bms-scan-name">${escapeHtml(d.name || 'Unknown')}</span>
        ${bmsTag}
      </div>`;
    }).join('');

    // Click to select
    bmsScanList.querySelectorAll('.bms-scan-device').forEach(row => {
      row.addEventListener('click', () => selectBmsDevice(row.dataset.address));
    });

  } catch (err) {
    bmsScanStatus.textContent = `Scan failed: ${err.message}`;
    bmsScanList.innerHTML = '<div class="bms-scan-empty">Network error or timeout</div>';
  }
}

function selectBmsDevice(address) {
  if (bmsScanTargetIdx < 0) return;
  const card = document.querySelector(`#bms-devices-container .device-card[data-index="${bmsScanTargetIdx}"]`);
  if (card) {
    const input = card.querySelector('input[name$="[address]"]');
    if (input) input.value = address;
  }
  const statusEl = document.getElementById(`bms-test-status-${bmsScanTargetIdx}`);
  if (statusEl) showStatus(statusEl, `Selected ${address}`, 'success');
  closeBmsScanModal();
}

// Cache badge freshness ticker
bmsScanInterval = setInterval(() => {
  if (bmsScanModal && bmsScanModal.style.display === 'flex' && bmsScanTimestamp) {
    const age = Math.round((Date.now() - bmsScanTimestamp) / 1000);
    bmsScanCacheBadge.textContent = `Scanned ${age}s ago`;
  }
}, 5000);

// Modal event listeners (DOM is ready — settings.html loads before this script)
if (bmsScanModal) {
  bmsScanModal.querySelector('.bms-scan-close').addEventListener('click', closeBmsScanModal);
  bmsScanModal.querySelector('.bms-scan-cancel').addEventListener('click', closeBmsScanModal);
  bmsScanModal.querySelector('.bms-scan-refresh').addEventListener('click', () => runBmsScan(true));
  bmsScanModal.addEventListener('click', (e) => { if (e.target === bmsScanModal) closeBmsScanModal(); });
}
function buildBmsDeviceList(devices) {
  const container = document.getElementById('bms-devices-container');
  if (!container) return;
  container.innerHTML = '';
  bmsDeviceCounter = 0;
  if (bmsScanInterval) { clearInterval(bmsScanInterval); bmsScanInterval = null; }
  devices.forEach((dev, idx) => renderBmsDevice(dev, idx));
}
function renderBmsDevice(device, idx) {
  const container = document.getElementById('bms-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="bms_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="bms-status-dot" id="bms-status-${idx}" title="Checking..."></span>
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="bms_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-bms">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <input type="text" name="bms_devices[${idx}][address]" placeholder="MAC Address (e.g., AA:BB:CC:DD:EE:FF)" value="${escapeHtml(device.address || '')}" style="width:100%;">
    </div>
    <div class="form-row" style="gap:0.5rem;">
      <button type="button" class="fetch-btn scan-bms" data-device="${idx}" style="flex:1;">🔍 Scan</button>
      <button type="button" class="fetch-btn test-bms" style="flex:1;">Test Connection</button>
      <span class="test-status" id="bms-test-status-${idx}"></span>
    </div>
    <div class="note">MAC address can be found by scanning with a phone BLE scanner or using the bridge's /devices endpoint.</div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Metric Mappings</div>
    <div class="mappings-section">
      <div class="mappings-list" id="bms-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn load-bms-metrics" data-device="${idx}" style="margin-top:0.25rem;">
        📥 Load BMS Metrics
      </button>
    </div>
  `;
  container.appendChild(card);
  const removeBmsBtn = card.querySelector('[data-action="remove-bms"]');
  if (removeBmsBtn) removeBmsBtn.addEventListener('click', () => {
    if (showConfirm('Remove this BMS device and all its metric mappings?')) {
      card.remove();
      reindexBms();
    }
  });

  // Scan button – opens modal device picker
  card.querySelector('.scan-bms').addEventListener('click', () => {
    showStatus(document.getElementById(`bms-test-status-${idx}`), 'Scanning for BLE devices...', 'info');
    openBmsScanModal(idx);
  });

  // Test connection button – uses backend proxy to reach BMS bridge
  card.querySelector('.test-bms').addEventListener('click', async () => {
    const statusEl = document.getElementById(`bms-test-status-${idx}`);
    const address = card.querySelector('input[name$="[address]"]').value.trim();
    if (!address) {
      showStatus(statusEl, 'MAC address required', 'error');
      return;
    }
    showStatus(statusEl, 'Testing connection...', 'info');
    try {
      const res = await fetch(`/api/bms/test?address=${encodeURIComponent(address)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        showStatus(statusEl, `OK - ${Object.keys(data).length} metrics`, 'success');
        // Refresh connection status dot
        const dotEl = card.querySelector(`#bms-status-${idx}`);
        const nameInput = card.querySelector(`input[name="bms_devices[${idx}][name]"]`);
        if (dotEl && nameInput && nameInput.value.trim()) {
          refreshBmsDeviceStatus(nameInput.value.trim(), dotEl);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        showStatus(statusEl, err.error || `Error`, 'error');
      }
    } catch (err) {
      showStatus(statusEl, `Failed: ${err.message}`, 'error');
    }
  });

  // Load BMS metrics for mapping
  card.querySelector('.load-bms-metrics').addEventListener('click', async () => {
    const nameInput = card.querySelector('input[name$="[name]"]');
    const deviceName = nameInput ? nameInput.value.trim() : '';
    if (!deviceName) {
      const statusEl = document.getElementById(`bms-test-status-${idx}`);
      showStatus(statusEl, 'Enter a Device Name first', 'error');
      return;
    }
    const mappingsList = card.querySelector('.mappings-list');
    if (mappingsList.children.length > 0 && !showConfirm('Loading metrics will replace existing mappings. Continue?')) return;
    try {
      const res = await fetch(`/api/bms/device-metrics/${encodeURIComponent(deviceName)}`, { credentials: 'include' });
      if (!res.ok) { mappingsList.innerHTML = '<div class="note" style="color:var(--error);">Failed to load metrics</div>'; return; }
      const keys = await res.json();
      if (!keys.length) { mappingsList.innerHTML = '<div class="note">No metrics found. Poll the device first or enter keys manually.</div>'; return; }
      // Build initial mappings object — preselected if device already has mappings
      const existing = device.mappings || {};
      const mappings = {};
      const values = {};
      keys.forEach(item => {
        const k = typeof item === 'string' ? item : item.key;
        mappings[k] = existing[k] || '';
        values[k] = (typeof item === 'object' && item.value != null) ? item.value : null;
      });
      renderBmsMappings(idx, mappingsList, mappings, values);
    } catch (err) {
      mappingsList.textContent = 'Error: ' + err.message;
      mappingsList.className = 'note';
      mappingsList.style.color = 'var(--error)';
    }
  });

  // Restore saved mappings on initial load (values unavailable until re-polled)
  if (device.mappings && Object.keys(device.mappings).length > 0) {
    const mappingsList = card.querySelector('.mappings-list');
    renderBmsMappings(idx, mappingsList, device.mappings, {});
  }

  bmsDeviceCounter++;

  // Initial status check
  const statusDot = card.querySelector(`#bms-status-${idx}`);
  const deviceName = card.querySelector(`input[name="bms_devices[${idx}][name]"]`).value;
  if (deviceName) refreshBmsDeviceStatus(deviceName, statusDot);
}
function reindexBms() {
  const cards = document.querySelectorAll('#bms-devices-container .device-card');
  bmsDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    bmsDeviceCounter++;
  });
}

// ======================== WIRED BMS (RS485/RS232) ========================
let bmsWiredDeviceCounter = 0;
let availableBmsWiredPorts = [];

function buildBmsWiredDeviceList(devices) {
  const container = document.getElementById('bms-wired-devices-container');
  if (!container) return;
  container.innerHTML = '';
  bmsWiredDeviceCounter = 0;
  fetch('/api/rs232/ports').then(r => r.json()).then(ports => {
    availableBmsWiredPorts = Array.isArray(ports) ? ports : [];
    devices.forEach((dev, idx) => renderBmsWiredDevice(dev, idx));
  }).catch(() => {
    availableBmsWiredPorts = [];
    devices.forEach((dev, idx) => renderBmsWiredDevice(dev, idx));
  });
}

function renderBmsWiredDevice(device, idx) {
  const container = document.getElementById('bms-wired-devices-container');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;

  const isCustomPort = !!device.serial_path && !availableBmsWiredPorts.some(p => p.path === device.serial_path);
  const inputPath = isCustomPort ? device.serial_path : (device.serial_path || '');
  const pathIsCustom = (device.serial_path || '') === 'custom' || isCustomPort;

  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="bms_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="bms_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-bms-wired">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <select name="bms_devices[${idx}][serial_path]" class="bms-wired-port-select" style="flex:1;">
        <option value="">-- Select or type port --</option>
        ${availableBmsWiredPorts.map(p =>
          `<option value="${escapeHtml(p.path)}" ${p.path === device.serial_path ? 'selected' : ''}>${escapeHtml(p.friendlyName || p.path)}</option>`
        ).join('')}
        <option value="custom" ${pathIsCustom ? 'selected' : ''}>Custom path...</option>
      </select>
      <input type="number" name="bms_devices[${idx}][baud]" placeholder="Baud" value="${device.baud || 9600}" style="width:130px;" title="Baud rate">
    </div>
    <div class="form-row bms-wired-custom-path" style="gap:0.5rem;display:${pathIsCustom ? '' : 'none'};">
      <input type="text" name="bms_devices[${idx}][custom_path]" placeholder="/dev/ttyUSB0" value="${escapeHtml(inputPath || '/dev/ttyUSB0')}" style="flex:1;">
    </div>
    <div class="form-row">
      <select name="bms_devices[${idx}][data_bits]">
        <option value="8" ${(parseInt(device.data_bits) || 8) === 8 ? 'selected' : ''}>8 bits</option>
        <option value="7" ${parseInt(device.data_bits) === 7 ? 'selected' : ''}>7 bits</option>
        <option value="6" ${parseInt(device.data_bits) === 6 ? 'selected' : ''}>6 bits</option>
        <option value="5" ${parseInt(device.data_bits) === 5 ? 'selected' : ''}>5 bits</option>
      </select>
      <select name="bms_devices[${idx}][parity]">
        <option value="none" ${(device.parity || 'none') === 'none' ? 'selected' : ''}>None</option>
        <option value="even" ${device.parity === 'even' ? 'selected' : ''}>Even</option>
        <option value="odd" ${device.parity === 'odd' ? 'selected' : ''}>Odd</option>
      </select>
      <select name="bms_devices[${idx}][stop_bits]">
        <option value="1" ${(parseInt(device.stop_bits) || 1) === 1 ? 'selected' : ''}>1 stop</option>
        <option value="2" ${parseInt(device.stop_bits) === 2 ? 'selected' : ''}>2 stop</option>
      </select>
      <input type="number" name="bms_devices[${idx}][modbus_unit_id]" placeholder="Unit ID" value="${device.modbus_unit_id || 1}" style="width:110px;" title="Modbus Unit ID">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⚙️</span> Configuration</div>
    <div class="form-row">
      <select name="bms_devices[${idx}][profile]" class="bms-wired-profile-select" style="flex:1;">
        <option value="">-- Select profile --</option>
      </select>
      <input type="number" name="bms_devices[${idx}][timeout]" placeholder="Timeout (ms)" value="${device.timeout || 5000}" style="width:140px;" title="Timeout in milliseconds">
      <button type="button" class="fetch-btn test-bms-wired">Test Connection</button>
      <span class="test-status"></span>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Metric Mappings</div>
    <div class="mappings-section">
      <div class="mappings-list"></div>
      <button type="button" class="fetch-btn load-bms-wired-metrics" style="margin-top:0.25rem;">
        📥 Load BMS Metrics
      </button>
    </div>
  `;
  container.appendChild(card);

  const portSelect = card.querySelector('.bms-wired-port-select');
  const customPathDiv = card.querySelector('.bms-wired-custom-path');
  if (portSelect) portSelect.addEventListener('change', e => {
    customPathDiv.style.display = e.target.value === 'custom' ? '' : 'none';
  });

  const profileSelect = card.querySelector('.bms-wired-profile-select');
  fetch('/api/rs232/profiles').then(r => r.json()).then(profiles => {
    (profiles || []).forEach(p => {
      const idStr = String(p.id);
      const nameStr = String(p.name || '');
      if (!/bms/i.test(`${idStr} ${nameStr}`)) return;
      const opt = document.createElement('option');
      opt.value = idStr;
      opt.textContent = p.name;
      if (String(device.profile) === idStr) opt.selected = true;
      profileSelect.appendChild(opt);
    });
  }).catch(() => {});

  const removeBtn = card.querySelector('[data-action="remove-bms-wired"]');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    if (showConfirm('Remove this wired BMS device and all its metric mappings?')) {
      card.remove();
      reindexBmsWired();
    }
  });

  card.querySelector('.test-bms-wired').addEventListener('click', async () => {
    const statusEl = card.querySelector('.test-status');
    const cfg = collectBmsWiredConfig(card);
    showStatus(statusEl, 'Testing connection...', 'info');
    try {
      const res = await fetch('/api/bms-wired/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify(cfg),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        let n = 0;
        if (data && data.metrics && typeof data.metrics === 'object') n = Object.keys(data.metrics).length;
        else if (data && data.metricCount != null) n = data.metricCount;
        else if (data && typeof data === 'object') n = Object.keys(data).length;
        showStatus(statusEl, `OK - ${n} metrics`, 'success');
      } else {
        showStatus(statusEl, data.error || 'Error', 'error');
      }
    } catch (err) {
      showStatus(statusEl, `Failed: ${err.message}`, 'error');
    }
  });

  card.querySelector('.load-bms-wired-metrics').addEventListener('click', async () => {
    const profileValue = profileSelect ? profileSelect.value : '';
    const statusEl = card.querySelector('.test-status');
    if (!profileValue) {
      showStatus(statusEl, 'Select a profile first', 'error');
      return;
    }
    const mappingsList = card.querySelector('.mappings-list');
    if (mappingsList.children.length > 0 && !showConfirm('Loading metrics will replace existing mappings. Continue?')) return;
    try {
      const res = await fetch(`/api/bms-wired/fields/${encodeURIComponent(profileValue)}`, { credentials: 'include' });
      if (!res.ok) { mappingsList.innerHTML = '<div class="note" style="color:var(--error);">Failed to load metrics</div>'; return; }
      const fields = await res.json();
      if (!Array.isArray(fields) || fields.length === 0) { mappingsList.innerHTML = '<div class="note">No fields found for this profile.</div>'; return; }
      const existing = device.mappings || {};
      const mappings = {};
      fields.forEach(f => { if (f.field != null) mappings[String(f.field)] = existing[String(f.field)] || ''; });
      renderBmsWiredMappings(idx, mappingsList, mappings, fields);
    } catch (err) {
      mappingsList.textContent = 'Error: ' + err.message;
      mappingsList.className = 'note';
      mappingsList.style.color = 'var(--error)';
    }
  });

  if (device.mappings && Object.keys(device.mappings).length > 0) {
    renderBmsWiredMappings(idx, card.querySelector('.mappings-list'), device.mappings, []);
  }

  bmsWiredDeviceCounter++;
}

function reindexBmsWired() {
  const cards = document.querySelectorAll('#bms-wired-devices-container .device-card');
  bmsWiredDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    bmsWiredDeviceCounter++;
  });
}

function renderBmsWiredMappings(deviceIdx, container, mappings, fieldsInfo) {
  const infoMap = {};
  (fieldsInfo || []).forEach(f => { if (f && f.field != null) infoMap[String(f.field)] = f; });
  container.innerHTML = '';
  const entries = Object.entries(mappings || {});
  if (entries.length === 0) {
    container.innerHTML = '<div class="note">No mappings configured. Click "Load BMS Metrics" to get started.</div>';
    return;
  }
  entries.sort(([a], [b]) => String(a).localeCompare(String(b))).forEach(([bmsKey, metricName]) => {
    const info = infoMap[String(bmsKey)] || {};
    const row = document.createElement('div');
    row.className = 'metric-row';
    row.dataset.bmsKey = String(bmsKey);

    const keyLabel = document.createElement('span');
    keyLabel.className = 'register-desc';
    const label = info.label ? info.label : String(bmsKey);
    keyLabel.textContent = info.unit ? `${label} (${info.unit})` : label;
    keyLabel.style.cssText = 'flex:0 0 220px; font-size:0.85em; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

    const metricSelect = createMetricDropdown(metricName || '', Array.from(getAllUsedMetrics()));
    metricSelect.className = 'metric-name';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn remove-metric';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      row.remove();
      if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    });

    metricSelect.addEventListener('change', () => {
      if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    });

    row.appendChild(keyLabel);
    row.appendChild(metricSelect);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function collectBmsWiredConfig(card) {
  const dev = {};
  dev.name = card.querySelector('.device-header input[type="text"]').value;
  dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
  const portSelect = card.querySelector('.bms-wired-port-select');
  const customPath = card.querySelector('input[name$="[custom_path]"]')?.value;
  dev.serial_path = portSelect && portSelect.value === 'custom' ? (customPath || '/dev/ttyUSB0') : (portSelect ? portSelect.value : '');
  dev.baud = parseInt(card.querySelector('input[name$="[baud]"]').value) || 9600;
  dev.data_bits = parseInt(card.querySelector('select[name$="[data_bits]"]').value) || 8;
  dev.parity = card.querySelector('select[name$="[parity]"]').value || 'none';
  dev.stop_bits = parseInt(card.querySelector('select[name$="[stop_bits]"]').value) || 1;
  dev.modbus_unit_id = parseInt(card.querySelector('input[name$="[modbus_unit_id]"]')?.value) || 1;
  dev.profile = card.querySelector('.bms-wired-profile-select').value;
  dev.timeout = parseInt(card.querySelector('input[name$="[timeout]"]').value) || 5000;
  dev.mappings = {};
  card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
    const bmsKey = row.dataset.bmsKey;
    const metricName = row.querySelector('.metric-name').value;
    if (bmsKey && metricName) dev.mappings[bmsKey] = metricName;
  });
  return dev;
}

// Render metric mapping rows for a BMS device
function renderBmsMappings(deviceIdx, container, mappings, values) {
  values = values || {};
  container.innerHTML = '';
  if (!mappings || Object.keys(mappings).length === 0) {
    container.innerHTML = '<div class="note">No mappings configured. Click "Load BMS Metrics" to get started.</div>';
    return;
  }
  Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b)).forEach(([bmsKey, metricName]) => {
    const row = document.createElement('div');
    row.className = 'metric-row';
    row.dataset.bmsKey = bmsKey;

    // BMS key label with optional value
    const keyLabel = document.createElement('span');
    keyLabel.className = 'register-desc';
    const val = values[bmsKey];
    if (val != null) {
      if (typeof val === 'number') {
        keyLabel.textContent = `${bmsKey}: ${Number.isInteger(val) ? val : val.toFixed(2)}`;
      } else {
        keyLabel.textContent = `${bmsKey}: ${String(val)}`;
      }
    } else {
      keyLabel.textContent = bmsKey;
    }
    keyLabel.style.cssText = 'flex:0 0 220px; font-size:0.85em; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

    // Metric dropdown
    const metricSelect = createMetricDropdown(metricName || '', getAllUsedMetrics ? Array.from(getAllUsedMetrics()) : []);
    metricSelect.className = 'metric-name';

    // ✕ button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn remove-metric';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      row.remove();
      if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    });

    metricSelect.addEventListener('change', () => {
      if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    });

    row.appendChild(keyLabel);
    row.appendChild(metricSelect);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

// Poll BMS connection status and update indicator dots
async function refreshBmsDeviceStatus(deviceName, dotEl) {
  if (!deviceName) return;
  try {
    const res = await fetch(`/api/bms/device-status?name=${encodeURIComponent(deviceName)}`, { credentials: 'include' });
    if (!res.ok) throw new Error('API error');
    const status = await res.json();
    if (status.connected) {
      dotEl.style.backgroundColor = '#22c55e';
      dotEl.title = `Connected — ${status.metricCount} metrics, last seen ${status.lastSeen ? new Date(status.lastSeen * 1000).toLocaleTimeString() : 'unknown'}`;
    } else {
      dotEl.style.backgroundColor = '#ef4444';
      dotEl.title = status.metricCount > 0
        ? `Disconnected — ${status.metricCount} metrics (stale), last seen ${status.lastSeen ? new Date(status.lastSeen * 1000).toLocaleTimeString() : 'unknown'}`
        : 'Disconnected — no data';
    }
  } catch {
    dotEl.style.backgroundColor = '#6b7280';
    dotEl.title = 'Status unknown — bridge may be offline';
  }
}
const addBmsBtn = document.getElementById('add-bms-device');
if (addBmsBtn) addBmsBtn.addEventListener('click', () => {
  const idx = bmsDeviceCounter;
  renderBmsDevice({ name: '', address: '', enabled: true }, idx);
});

const addBmsWiredBtn = document.getElementById('add-bms-wired-device');
if (addBmsWiredBtn) addBmsWiredBtn.addEventListener('click', () => {
  const idx = bmsWiredDeviceCounter;
  renderBmsWiredDevice({
    name: '', enabled: true, transport: 'wired',
    serial_path: '', baud: 9600, data_bits: 8, parity: 'none',
    stop_bits: 1, modbus_unit_id: 1, profile: '', timeout: 5000,
  }, idx);
});

// ======================== BMS BANK AGGREGATION ========================
let bmsBankCounter = 0;
const BANK_FUNCTIONS = ['sum', 'mean', 'min', 'max', 'weighted_soc', 'sum_weighted', 'last'];
// Boolean functions (or, and) implemented server-side but hidden from UI for v1

function buildBmsBankList(banks) {
  const container = document.getElementById('bms-banks-container');
  if (!container) return;
  container.innerHTML = '';
  bmsBankCounter = 0;
  banks.forEach((bank, idx) => renderBmsBank(bank, idx));
}

function renderBmsBank(bank, idx) {
  const container = document.getElementById('bms-banks-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.dataset.bankIdx = idx;

  const safeName = escapeHtml(bank.name || '');
  const isSingleDevice = (bank.devices || []).length === 1;

  card.innerHTML = `
    <div class="device-header">
      <input type="text" class="bank-name" placeholder="Bank Name (e.g., House Bank)" value="${safeName}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" class="bank-enabled" ${bank.enabled !== false ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-bank">✕</button>
    </div>
    ${isSingleDevice ? '<div class="note" style="margin:0 0 8px 0;">Single-device bank — aggregation is a passthrough. No computation applied.</div>' : ''}

    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Devices</div>
    <div class="bank-devices-list" id="bank-devices-${idx}"></div>

    <div class="section-divider"><span class="stg-divider-icon">📊</span> Computed Metrics</div>
    <div class="bank-functions-list" id="bank-functions-${idx}"></div>
    <button type="button" class="fetch-btn add-bank-function" data-bank="${idx}">+ Add Function</button>

    <div style="margin-top:8px;">
      <button type="button" class="fetch-btn test-bank" data-bank="${idx}">Test Aggregation</button>
      <span class="test-status" id="bank-test-status-${idx}"></span>
    </div>
  `;
  container.appendChild(card);

  // Populate device checkboxes from configured BMS devices
  populateBankDevices(card, idx, bank.devices || []);

  // Render function rows
  const fnContainer = card.querySelector(`#bank-functions-${idx}`);
  (bank.functions || []).forEach((fn, fnIdx) => {
    renderBankFunctionRow(fnContainer, idx, fnIdx, fn);
  });

  // Wire events
  const removeBankBtn = card.querySelector('[data-action="remove-bank"]');
  if (removeBankBtn) removeBankBtn.addEventListener('click', () => {
    if (showConfirm('Remove this bank? Historical data under bank_* names will remain in the database.')) {
      card.remove();
      reindexBmsBanks();
    }
  });

  card.querySelector('.add-bank-function').addEventListener('click', () => {
    const fnIdx = card.querySelectorAll('.bank-function-row').length;
    renderBankFunctionRow(fnContainer, idx, fnIdx, { output: '', fn: 'sum', sources: {} });
  });

  card.querySelector('.test-bank').addEventListener('click', () => testBank(card, idx));

  bmsBankCounter++;
}

function populateBankDevices(card, bankIdx, selectedDevices) {
  const container = card.querySelector(`#bank-devices-${bankIdx}`);
  // Get all configured BMS device names from the DOM
  const bmsCards = document.querySelectorAll('#bms-devices-container .device-card');
  const allDevices = [];
  bmsCards.forEach(c => {
    const nameInput = c.querySelector('.device-header input[type="text"]');
    if (nameInput && nameInput.value.trim()) {
      allDevices.push(nameInput.value.trim());
    }
  });

  if (allDevices.length === 0) {
    container.innerHTML = '<div class="note">No BMS devices configured. Add devices above first.</div>';
    return;
  }

  const selectedNames = new Set((selectedDevices || []).map(d => typeof d === 'string' ? d : d.name));

  container.innerHTML = allDevices.map(name => {
    const checked = selectedNames.has(name) ? 'checked' : '';
    // Find existing capacity_override if any
    const existing = (selectedDevices || []).find(d => (typeof d === 'string' ? d : d.name) === name);
    const capOverride = (existing && typeof existing === 'object' && existing.capacity_override) ? existing.capacity_override : '';
    return `
      <div class="form-row bank-device-row" style="align-items:center; gap:8px; margin-bottom:4px;">
        <span class="toggle-wrap" style="flex:1;">
          <label class="toggle-switch"><input type="checkbox" class="bank-device-cb" value="${escapeHtml(name)}" ${checked}><span class="slider"></span></label>
          <label style="cursor:pointer;">${escapeHtml(name)}</label>
        </span>
        <input type="number" class="bank-device-capacity" placeholder="Ah override" value="${capOverride}" style="width:100px; font-size:0.85em;" title="Manual capacity override. Leave blank to auto-detect from BMS design_capacity.">
      </div>`;
  }).join('');
}

function renderBankFunctionRow(container, bankIdx, fnIdx, fn) {
  const row = document.createElement('div');
  row.className = 'bank-function-row';
  row.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;';

  const outputName = fn.output || '';
  const selectedFn = fn.fn || 'sum';
  // Backward compat: fn.source → fn.sources (legacy single-source)
  const sources = fn.sources || (fn.source ? { _single: fn.source } : {});
  const weightBy = fn.weight_by || '';

  // Get checked devices from the card
  const card = container.closest('.device-card');
  const checkedCbs = card.querySelectorAll('.bank-device-cb:checked');
  const checkedDevices = Array.from(checkedCbs).map(cb => cb.value);

  let html = `
    <input type="text" class="bank-fn-output" placeholder="output name" value="${escapeHtml(outputName)}" style="width:120px; font-size:0.85em;" title="Output metric name (e.g., 'soc'). Full metric: bank_<output>">
    <span style="font-size:0.8em; color:var(--muted);">←</span>
    <select class="bank-fn-type" style="width:130px; font-size:0.85em;">
      ${BANK_FUNCTIONS.map(f => `<option value="${f}" ${f === selectedFn ? 'selected' : ''}>${f}</option>`).join('')}
    </select>
    <span style="font-size:0.8em;">(</span>`;

  // One source dropdown per checked BMS device, labeled with device name
  if (checkedDevices.length === 0) {
    html += `<span style="font-size:0.8em; color:var(--muted);">check devices above</span>`;
  } else {
    for (const devName of checkedDevices) {
      const selKey = sources[devName] || '';
      html += `<span style="font-size:0.75em; color:var(--muted);">${escapeHtml(devName)}:</span>`;
      html += `<select class="bank-fn-source" data-device="${escapeHtml(devName)}" style="width:130px; font-size:0.85em;">
        <option value="">-- source --</option>
      </select>`;
    }
  }

  html += `
    <span class="bank-fn-weight-wrap" style="display:${selectedFn === 'weighted_soc' || selectedFn === 'sum_weighted' ? '' : 'none'};">
      <span style="font-size:0.8em; color:var(--muted);">×</span>
      <select class="bank-fn-weightby" style="width:140px; font-size:0.85em;">
        <option value="">-- weight --</option>
      </select>
    </span>
    <span style="font-size:0.8em;">)</span>
    <button type="button" class="remove-btn remove-metric remove-bank-fn" style="font-size:0.8em; padding:2px 6px;">×</button>
  `;
  row.innerHTML = html;
  container.appendChild(row);

  const fnType = row.querySelector('.bank-fn-type');
  const fnWeightBy = row.querySelector('.bank-fn-weightby');
  const weightWrap = row.querySelector('.bank-fn-weight-wrap');

  // Helper: load metrics for a specific device into a select element
  async function loadSourceKeysForDevice(selectEl, deviceName, selectedKey) {
    if (!deviceName) {
      selectEl.innerHTML = '<option value="">-- add devices first --</option>';
      return;
    }
    try {
      const res = await fetch(`/api/bms/device-metrics/${encodeURIComponent(deviceName)}`, { credentials: 'include' });
      if (!res.ok) throw new Error('failed');
      const items = await res.json();
      if (!items || items.length === 0) {
        selectEl.innerHTML = '<option value="">-- test connection first --</option>';
        return;
      }
      selectEl.innerHTML = '<option value="">-- source --</option>' +
        items.map(item => {
          const k = typeof item === 'string' ? item : item.key;
          return `<option value="${escapeHtml(k)}" ${k === selectedKey ? 'selected' : ''}>${escapeHtml(k)}</option>`;
        }).join('');
    } catch (_) {
      selectEl.innerHTML = '<option value="">-- unavailable --</option>';
    }
  }

  // Load each device source dropdown from its own metrics
  row.querySelectorAll('.bank-fn-source').forEach(sel => {
    const devName = sel.dataset.device;
    const selKey = sources[devName] || '';
    loadSourceKeysForDevice(sel, devName, selKey);
  });

  // Weight dropdown loads from first checked device's metrics
  if (selectedFn === 'weighted_soc' || selectedFn === 'sum_weighted') {
    loadSourceKeysForDevice(fnWeightBy, checkedDevices[0] || '', weightBy);
  }

  // Show/hide weight when function type changes
  fnType.addEventListener('change', () => {
    const needsWeight = fnType.value === 'weighted_soc' || fnType.value === 'sum_weighted';
    weightWrap.style.display = needsWeight ? '' : 'none';
    if (needsWeight) {
      const firstDev = Array.from(card.querySelectorAll('.bank-device-cb:checked')).map(cb => cb.value)[0] || '';
      loadSourceKeysForDevice(fnWeightBy, firstDev, weightBy);
    }
  });

  // ✕ button
  row.querySelector('.remove-bank-fn').addEventListener('click', () => row.remove());
}

async function testBank(card, idx) {
  const statusEl = document.getElementById(`bank-test-status-${idx}`);
  showStatus(statusEl, 'Testing...', 'info');

  // Collect bank config from the card
  const bankName = card.querySelector('.bank-name').value.trim();
  if (!bankName) { showStatus(statusEl, 'Bank name required', 'error'); return; }

  const devices = [];
  card.querySelectorAll('.bank-device-cb:checked').forEach(cb => {
    const capInput = cb.closest('.bank-device-row').querySelector('.bank-device-capacity');
    const dev = { name: cb.value };
    const capVal = parseFloat(capInput.value);
    if (!isNaN(capVal) && capVal > 0) dev.capacity_override = capVal;
    devices.push(dev);
  });
  if (devices.length === 0) { showStatus(statusEl, 'Select at least one device', 'error'); return; }

  const functions = [];
  card.querySelectorAll('.bank-function-row').forEach(row => {
    const output = row.querySelector('.bank-fn-output').value.trim();
    const fn = row.querySelector('.bank-fn-type').value;
    // Collect per-device sources from all source dropdowns in this row
    const sources = {};
    row.querySelectorAll('.bank-fn-source').forEach(sel => {
      const dev = sel.dataset.device;
      if (dev && sel.value) sources[dev] = sel.value;
    });
    const weightBy = row.querySelector('.bank-fn-weightby')?.value || undefined;
    if (output && Object.keys(sources).length > 0) {
      functions.push({ output, fn, sources, weight_by: weightBy || undefined });
    }
  });
  if (functions.length === 0) { showStatus(statusEl, 'Add at least one function', 'error'); return; }

  try {
    const res = await fetch('/api/bms/bank/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ name: bankName, devices, functions })
    });
    const data = await res.json();
    if (!res.ok) { showStatus(statusEl, data.error || 'Test failed', 'error'); return; }

    // Build result display
    let html = '';
    if (data.warnings && data.warnings.length > 0) {
      html += '<div style="color:#f59e0b; margin-bottom:4px;">' + data.warnings.map(w => escapeHtml(w)).join('<br>') + '</div>';
    }
    html += `<span style="font-weight:bold; color:${data.summary.will_publish ? '#16a34a' : '#dc2626'};">`;
    html += data.summary.will_publish ? '✅ Would publish' : '❌ Would be suppressed';
    html += ` (${data.summary.devices_fresh}/${data.summary.devices_total} devices fresh)</span><br>`;

    if (data.results && Object.keys(data.results).length > 0) {
      html += '<table style="font-size:0.85em; margin-top:4px;">';
      for (const [metric, val] of Object.entries(data.results)) {
        html += `<tr><td style="padding-right:12px;"><code>${escapeHtml(metric)}</code></td><td>${val}</td></tr>`;
      }
      html += '</table>';
    }
    showStatusHtml(statusEl, html, data.summary.will_publish ? 'success' : 'error');
  } catch (err) {
    showStatus(statusEl, 'Error: ' + err.message, 'error');
  }
}

function reindexBmsBanks() {
  const cards = document.querySelectorAll('#bms-banks-container .device-card');
  bmsBankCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    card.dataset.bankIdx = i;
    bmsBankCounter++;
  });
}

const addBankBtn = document.getElementById('add-bms-bank');
if (addBankBtn) addBankBtn.addEventListener('click', () => {
  const idx = bmsBankCounter;
  renderBmsBank({ name: '', devices: [], functions: [], enabled: true }, idx);
});

// ======================== INVERTER DONGLE ========================
let dongleDeviceCounter = 0;
let dongleProfilesCache = [];

function buildDongleDeviceList(devices) {
  const container = document.getElementById('dongle-devices-container');
  if (!container) return;
  container.innerHTML = '';
  dongleDeviceCounter = 0;
  // Preload profiles once
  fetch('/api/dongle/profiles').then(r => r.json()).then(p => { dongleProfilesCache = p; }).catch(() => {});
  devices.forEach((dev, idx) => renderDongleDevice(dev, idx));
}

function getProfileById(id) {
  return dongleProfilesCache.find(p => p.id === id);
}

function getTransportForProfile(profileId) {
  const p = getProfileById(profileId);
  if (!p) return 'solarman-v5';
  if (p.protocol === 'felicity-tcp') return 'felicity-tcp';
  if (p.protocol === 'luxpower-tcp') return 'luxpower-tcp';
  return p.transport || 'solarman-v5';
}

function updateDongleTransportUI(card) {
  const transportSelect = card.querySelector('select[name$="[transport]"]');
  if (!transportSelect) return;
  const tx = transportSelect.value;
  const isLux = tx === 'luxpower-tcp';
  const serialRow = card.querySelector('.dongle-serial-row');
  const hostInput = card.querySelector('input[name$="[host]"]');
  const portInput = card.querySelector('input[name$="[port]"]');
  const serialInput = card.querySelector('input[name$="[serial_number]"]');
  const dongleSerialInput = card.querySelector('input[name$="[dongle_serial]"]');
  const inverterSerialInput = card.querySelector('input[name$="[inverter_serial]"]');
  const unitIdInput = card.querySelector('input[name$="[modbus_unit_id]"]');
  if (serialRow) serialRow.style.display = (tx === 'modbus-tcp' || tx === 'felicity-tcp') ? 'none' : '';
  if (hostInput) hostInput.style.display = '';
  if (portInput) portInput.style.display = '';
  if (serialInput) serialInput.style.display = isLux ? 'none' : '';
  if (dongleSerialInput) dongleSerialInput.style.display = isLux ? '' : 'none';
  if (inverterSerialInput) inverterSerialInput.style.display = isLux ? '' : 'none';
  if (unitIdInput) unitIdInput.style.display = isLux ? 'none' : '';
  if (isLux && portInput && !portInput.value) portInput.value = 8000;
  // #103 (AC12/AC13/D4): migrate a stranded serial_number into dongle_serial for
  // LuxPower — but ONLY when dongle_serial is empty; if dongle_serial is already
  // filled, touch nothing. Idempotent: runs on profile change, transport change
  // and initial render.
  if (isLux) {
    const sn = serialInput ? serialInput.value.trim() : '';
    const ds = dongleSerialInput ? dongleSerialInput.value.trim() : '';
    if (ds === '' && sn !== '') {
      if (dongleSerialInput) dongleSerialInput.value = sn;
      if (serialInput) serialInput.value = '';
    }
  }
}

function renderDongleDevice(device, idx) {
  const container = document.getElementById('dongle-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;

  const transport = device.profile ? getTransportForProfile(device.profile) : (device.transport || 'solarman-v5');

  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="dongle_config[${idx}][name]" placeholder="Instance Name (e.g., SRNE Inverter)" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" name="dongle_config[${idx}][enabled]" ${device.enabled !== false ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-dongle">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <select name="dongle_config[${idx}][profile]" class="dongle-profile-select">
        <option value="">-- Select profile --</option>
      </select>
      <input type="text" name="dongle_config[${idx}][host]" placeholder="Host / IP Address" value="${escapeHtml(device.host || '')}">
      <input type="number" name="dongle_config[${idx}][port]" placeholder="Port" value="${device.port || ''}">
    </div>
    <div class="form-row dongle-serial-row" style="${transport === 'modbus-tcp' ? 'display:none;' : ''}">
      <input type="text" name="dongle_config[${idx}][serial_number]" placeholder="Logger Serial Number" value="${escapeHtml(device.serial_number || '')}">
      <input type="text" name="dongle_config[${idx}][dongle_serial]" placeholder="Dongle Serial" value="${escapeHtml(device.dongle_serial || '')}" title="Dongle serial — 10-char serial on the dongle label (LuxPower only)">
      <input type="text" name="dongle_config[${idx}][inverter_serial]" placeholder="Inverter Serial" value="${escapeHtml(device.inverter_serial || '')}" title="Inverter serial — 10-char serial on the inverter label (LuxPower only)">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⚙️</span> Configuration</div>
    <div class="form-row">
      <input type="number" name="dongle_config[${idx}][modbus_unit_id]" placeholder="Modbus Unit ID" value="${device.modbus_unit_id || 1}" style="width:100px;">
      <input type="number" name="dongle_config[${idx}][poll_interval]" placeholder="Poll (s)" value="${device.poll_interval || (transport === 'luxpower-tcp' ? 5 : 30)}" style="width:100px;">
      <input type="text" name="dongle_config[${idx}][prefix]" placeholder="Metric Prefix (optional)" value="${escapeHtml(device.prefix || '')}" style="width:150px;">
      <button type="button" class="fetch-btn test-dongle">Test Connection</button>
      <span class="test-status" id="dongle-test-status-${idx}"></span>
    </div>
    <select name="dongle_config[${idx}][transport]" class="dongle-transport-select">
      <option value="modbus-tcp" ${transport === 'modbus-tcp' ? 'selected' : ''}>TCP/IP</option>
      <option value="solarman-v5" ${transport === 'solarman-v5' ? 'selected' : ''}>Solarman v5</option>
      <option value="felicity-tcp" ${transport === 'felicity-tcp' ? 'selected' : ''}>Felicity TCP</option>
      <option value="growatt" ${transport === 'growatt' ? 'selected' : ''}>Growatt</option>
      <option value="luxpower-tcp" ${transport === 'luxpower-tcp' ? 'selected' : ''}>LuxPower Local TCP</option>
    </select>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> Register Mappings</div>
    <div class="mappings-section">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="dongle-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="dongle-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn load-dongle-registers" data-device="${idx}">
        📥 Load Profile Registers
      </button>
      <button type="button" class="fetch-btn fetch-dongle-entities" data-device="${idx}" style="display:none;">
        📋 Fetch Profile Entities
      </button>
      <button type="button" class="fetch-btn add-dongle-mapping" data-device="${idx}" style="display:none;">
        + Add Mapping
      </button>
    </div>
    <div class="section-divider dongle-write-divider" id="dongle-write-divider-${idx}" style="display:none;"><span class="stg-divider-icon">✍️</span> Write Controls</div>
    <div class="write-controls" id="dongle-write-controls-${idx}" style="display:none;"></div>
  `;
  container.appendChild(card);
  // AC-29: stored-device capture (see renderModbusDevice).
  card._origDevice = (!device || device._newCard) ? null : device;

  const transportSelect = card.querySelector('select[name$="[transport]"]');

  const profileSelect = card.querySelector('.dongle-profile-select');
  (dongleProfilesCache.length ? Promise.resolve(dongleProfilesCache) : fetch('/api/dongle/profiles').then(r => r.json()))
    .then(profiles => {
      if (!dongleProfilesCache.length) dongleProfilesCache = profiles;
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === device.profile) opt.selected = true;
        profileSelect.appendChild(opt);
      });
    }).catch(() => {});

  profileSelect.addEventListener('change', async () => {
    const profileId = profileSelect.value;
    const p = await resolveDongleProfile(profileId);
    if (!p) return;
    const tx = p.protocol === 'felicity-tcp' ? 'felicity-tcp' : p.transport;
    transportSelect.value = tx;
    updateDongleTransportUI(card);
    const portInput = card.querySelector('input[name$="[port]"]');
    portInput.value = p.default_port || '';
    const unitIdInput = card.querySelector('input[name$="[modbus_unit_id]"]');
    unitIdInput.value = p.default_unit_id || 1;
    unitIdInput.style.display = (tx === 'felicity-tcp') ? 'none' : '';
    // Mapping UI is adapter-dispatched by the profile's family (#108 wave 4):
    //   luxpower-tcp → entity-catalog UI only (wave-3 path, unchanged)
    //   register transports → entity-catalog UI with the legacy Load retained
    //   growatt/felicity → legacy register/field UI (input families, later wave)
    // Metrics are never auto-created or pre-bound in the catalog paths; the
    // legacy Load button stays as the only auto-creating entry point.
    const mappingsList = card.querySelector('.mappings-list');
    if (mappingsList) {
      if (mappingsList.children.length > 0 && !showConfirm('Changing profile will replace existing register mappings. Continue?')) {
        profileSelect.value = device.profile || '';
        return;
      }
      const lux = isLuxpowerDongleProfile(p);
      const reg = isDongleRegisterProfile(p);
      card._dongleEntities = null;
      // Card button mode is adapter-driven via the shared CatalogUI component.
      applyDongleMappingMode(card, p);
      if (lux) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'No entities mapped yet — “Fetch Profile Entities” lists every register for this profile, or “+ Add Mapping” adds a single row.';
        mappingsList.innerHTML = '';
        mappingsList.appendChild(note);
        populateDongleWriteControls(card, profileSelect.value);
      } else if (reg) {
        hideDongleWriteControls(card);
        // Register transport: explicit catalog UI. Reset with a hint — nothing
        // auto-creates; 'Load Profile Registers' (visible alongside) is the
        // retained legacy auto-create path.
        mappingsList.innerHTML = '';
        mappingsList.appendChild(dongleRegisterResetNote());
      } else {
        hideDongleWriteControls(card);
        loadDongleRegisterMappings(profileSelect.value, idx, mappingsList);
      }
      updateMappingSaveNote(card);
    }
  });

  transportSelect.addEventListener('change', () => updateDongleTransportUI(card));
  updateDongleTransportUI(card);

  const removeDongleBtn = card.querySelector('[data-action="remove-dongle"]');
  if (removeDongleBtn) removeDongleBtn.addEventListener('click', () => {
    if (showConfirm('Remove this dongle instance?')) {
      card.remove();
      reindexDongle();
    }
  });

  card.querySelector('.test-dongle').addEventListener('click', async () => {
    const statusEl = document.getElementById(`dongle-test-status-${idx}`);
    const host = card.querySelector('input[name$="[host]"]')?.value.trim() || '';
    const port = card.querySelector('input[name$="[port]"]')?.value;
    const serial = card.querySelector('input[name$="[serial_number]"]')?.value || '';
    const dongleSerial = card.querySelector('input[name$="[dongle_serial]"]')?.value || '';
    const inverterSerial = card.querySelector('input[name$="[inverter_serial]"]')?.value || '';
    const unitId = card.querySelector('input[name$="[modbus_unit_id]"]')?.value;
    const tx = transportSelect.value;
    if (!host) { showStatus(statusEl, 'Host required', 'error'); return; }
    showStatus(statusEl, 'Testing...', 'info');
    try {
      const res = await fetch('/api/dongle/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ host, port: parseInt(port) || undefined, serial_number: serial, dongle_serial: dongleSerial, inverter_serial: inverterSerial, modbus_unit_id: parseInt(unitId) || 1, transport: tx })
      });
      const data = await res.json();
      if (res.ok) {
        const label = (tx === 'luxpower-tcp') ? 'OK — Operational State (reg 0x0000) =' : 'OK — Register 0x0100 =';
        showStatus(statusEl, `${label} ${data.raw}`, 'success');
      }
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  dongleDeviceCounter++;

  // Load button click (register-based profiles; luxpower-tcp cards use the
  // 'Fetch Profile Entities' / '+ Add Mapping' buttons instead — visible only
  // in luxpower mode via CatalogUI.applyMode with the dongleLux adapter).
  card.querySelector('.load-dongle-registers').addEventListener('click', async () => {
    const profileId = profileSelect.value || device.profile || '';
    if (!profileId) return;
    if (await isLuxpowerDongleProfileAsync(profileId)) return; // hidden in lux mode — guard anyway (no auto-create)
    const mappingsList = card.querySelector('.mappings-list');
    loadDongleRegisterMappings(profileId, idx, mappingsList).then(() => updateMappingSaveNote(card));
  });

  // LuxPower local-TCP / register transports (#106 2C / #108): fetch the
  // profile entity catalog via the shared CatalogUI component and render one
  // row per entity — metric dropdown EMPTY (metrics are never auto-created or
  // pre-bound). Which adapter runs is decided by the profile's family, so the
  // same buttons serve dongleLux (luxpower-tcp) and dongleRegister (register
  // transports). growatt/felicity never show these buttons (applyMode).
  card.querySelector('.fetch-dongle-entities').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    resolveDongleProfile(profileId).then(p => {
      const adapter = dongleCatalogAdapterForProfile(p);
      if (!adapter) return;
      CatalogUI.fetchAndRender(adapter, card.querySelector('.mappings-list'), card.querySelector('.fetch-dongle-entities'), { profileId });
    });
  });
  card.querySelector('.add-dongle-mapping').addEventListener('click', () => {
    const profileId = profileSelect.value || device.profile || '';
    resolveDongleProfile(profileId).then(p => {
      const adapter = dongleCatalogAdapterForProfile(p);
      if (!adapter) return;
      CatalogUI.addRow(adapter, card, { profileId });
    });
  });

  // Restore saved mappings on initial load (mode-aware: luxpower-tcp profiles
  // restore namespaced metric↔entity rows resolved via the entity catalog).
  if (device.profile) {
    const mappingsList = card.querySelector('.mappings-list');
    const hasMappings = device.mappings && Object.keys(device.mappings).length > 0;
    if (hasMappings) mappingsList.innerHTML = '<div class="note">Loading saved mappings…</div>';
    initDongleCardMappings(card, device.profile, device.mappings || {}, mappingsList);
  }
}
function reindexDongle() {
  const cards = document.querySelectorAll('#dongle-devices-container .device-card');
  dongleDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    dongleDeviceCounter++;
  });
}
const addDongleBtn = document.getElementById('add-dongle-device');
if (addDongleBtn) addDongleBtn.addEventListener('click', () => {
  const idx = dongleDeviceCounter;
  renderDongleDevice({ name: '', host: '', port: '', serial_number: '', modbus_unit_id: 1, poll_interval: 30, transport: 'solarman-v5', profile: '', prefix: '', enabled: true, _newCard: true }, idx);
});

// ---------- Dongle register/field mapping helpers ----------
async function loadDongleRegisterMappings(profileId, deviceIdx, container) {
  container.innerHTML = '';
  container.innerHTML = '<div class="note">Loading profile...</div>';
  try {
    const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`);
    if (!res.ok) {
      container.innerHTML = '<div class="note" style="color:var(--error);">Profile not found</div>';
      return;
    }
    const profile = await res.json();

    // Auto-create any profile metrics not yet in the system
    if (profile.metrics && allMetrics) {
      const existingNames = new Set(allMetrics.map(m => m.name));
      for (const m of profile.metrics) {
        if (m.name && !existingNames.has(m.name)) {
          await fetch('/api/metrics/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ name: m.name, unit: m.unit || '' })
          }).catch(() => {});
        }
      }
      await refreshAllMetricDropdowns();
    }

    const mappings = {};
    // metrics[] — key = register (Modbus) or field (TCP), flipped: metricName → key
    if (profile.metrics) {
      profile.metrics.forEach(m => {
        if (m.name) mappings[m.name] = m.register || m.field || '';
      });
    }
    // fields[] (Felicity TCP) — key = path, flipped: metricName → path
    if (profile.fields) {
      profile.fields.forEach(f => {
        if (f.name) mappings[f.name] = f.path;
      });
    }
    renderDongleMappings(profileId, mappings, container);
  } catch (e) {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load profile</div>';
  }
}

function renderDongleMappings(profileId, mappings, container) {
  container.innerHTML = '';
  if (!mappings || Object.keys(mappings).length === 0) {
    container.innerHTML = '<div class="note">No registers/fields in this profile.</div>';
    return;
  }
  // Fetch profile for labels
  fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`).then(r => r.json()).then(profile => {
    // Build lookup maps: key → label, key → type (register|field)
    const labelMap = {};   // keyed by register or field string
    const typeMap = {};    // key → 'register' or 'field'
    if (profile.metrics) {
      profile.metrics.forEach(m => {
        const key = m.register || m.field;
        if (key) {
          labelMap[key] = m.label || m.name;
          typeMap[key] = m.register ? 'register' : 'field';
        }
      });
    }
    if (profile.fields) {
      profile.fields.forEach(f => {
        if (f.path) {
          labelMap[f.path] = f.label || f.name;
          typeMap[f.path] = 'field';
        }
      });
    }

    Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b)).forEach(([metricName, key]) => {
      const label = labelMap[key] || key || metricName;
      const type = typeMap[key];
      let desc;
      if (key && type === 'field') {
        desc = `${label} (Field: ${key})`;
      } else if (key && type === 'register') {
        desc = `${label} (Register ${key})`;
      } else if (key) {
        desc = `${label} (${key})`;
      } else {
        desc = label; // empty key = field-based, just show label
      }
      const row = document.createElement('div');
      row.className = 'metric-row';
      row.dataset.address = key;
      // AC-29: legacy Load rows stamp the same row-state contract as CatalogUI rows.
      stampRowMetricState(row, metricName);

      const descSpan = document.createElement('span');
      descSpan.className = 'register-desc';
      descSpan.textContent = desc;
      descSpan.style.flex = '1';
      descSpan.style.fontSize = '0.85em';
      descSpan.style.overflow = 'hidden';
      descSpan.style.textOverflow = 'ellipsis';
      descSpan.style.whiteSpace = 'nowrap';

      const metricSelect = createMetricDropdown(metricName || '', getAllUsedMetrics ? Array.from(getAllUsedMetrics()) : []);
      metricSelect.className = 'metric-name';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn remove-metric';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        const cardEl = row.closest('.device-card');
        row.remove();
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
        updateMappingSaveNote(cardEl);
      });

      metricSelect.addEventListener('change', () => {
        syncRowClearedFlag(row, metricSelect);
        if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
      });

      row.appendChild(metricSelect);
      row.appendChild(descSpan);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });
    if (refreshAllMetricDropdowns) refreshAllMetricDropdowns();
    updateMappingSaveNote(container.closest ? container.closest('.device-card') : null);
  }).catch(() => {
    container.innerHTML = '<div class="note" style="color:var(--error);">Failed to load register details</div>';
  });
}

// ---------- LuxPower TCP entity-catalog mapping helpers (#106 Batch 2C) ----------
// Row machinery now lives in the shared, source-generic CatalogUI component
// (public/js/catalog-ui.js, #108 wave 3); this section keeps the LuxPower
// profile predicates, the entities fetcher and the dongleLux reference adapter.
// luxpower-tcp profiles are mapping:'explicit': the UI pairs an EXISTING metric
// (user-picked dropdown — never auto-created, never pre-bound) with a namespaced
// entity handle (input:0xNNNN / holding:0xNNNN) that is persisted verbatim as
// the mapping value. The entity catalog comes from GET
// /api/dongle/profile/<id>/entities (id/register_type/register/name/label/unit/
// scale/type/count/access/writable/min/max/step/kind/actions?).

function isLuxpowerDongleProfile(p) {
  return !!(p && (p.protocol === 'luxpower-tcp' || p.transport === 'luxpower-tcp'));
}

function dongleProfileIsLuxpower(profileId) {
  if (!profileId) return false;
  return isLuxpowerDongleProfile(getProfileById(profileId));
}

async function isLuxpowerDongleProfileAsync(profileId) {
  if (!profileId) return false;
  if (dongleProfileIsLuxpower(profileId)) return true;
  try {
    const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`);
    if (!res.ok) return false;
    return isLuxpowerDongleProfile(await res.json());
  } catch (e) { return false; }
}

async function fetchDongleProfileEntities(profileId) {
  if (!profileId) throw new Error('Select a profile first');
  const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}/entities`);
  if (!res.ok) {
    let msg = `Failed to load entities (HTTP ${res.status})`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
    throw new Error(msg);
  }
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

// dongleLux — the LuxPower TCP reference CatalogUI adapter (issue #108 wave 3).
// The shared component (public/js/catalog-ui.js) is source-generic: families
// supply an adapter implementing fetch / entityId / entityLabel / resolveHandle /
// handleCtrl / defaultUnit / applyMode (adapter-interface doc lives in that
// file). All logic below is moved verbatim from the pre-#108 helpers
// (dongleEntityId / dongleEntityLabel / resolveDongleMappingHandle /
// applyDongleMappingMode) — the DOM contract, handle semantics, bare-hex
// fallback and unresolvable round-trip are unchanged.
const dongleLux = {
  // Card property holding the fetched entity catalog. '_dongleEntities'
  // predates #108 and is still consumed by populateDongleWriteControls() and
  // reset on profile change in renderDongleDevice — sharing the store keeps
  // both identical to the pre-refactor behavior (component default: '_catalog').
  cacheKey: '_dongleEntities',

  // Thin wrapper over the dongle profile entity catalog endpoint.
  // ctx = { profileId }. Throws 'Select a profile first' when profileId is
  // empty; the component surfaces err.message as an inline .note.
  fetch(ctx) {
    return fetchDongleProfileEntities(ctx && ctx.profileId);
  },

  // Source-native persisted handle: namespaced 'register_type:register'
  // (input:0x0065 / holding:0x005B) — the decode key modules/dongle.js reverse-
  // looks up. Falls back to a bare register for catalog items without
  // register_type.
  entityId(e) {
    if (!e) return '';
    if (e.id) return String(e.id);
    return (e.register_type && e.register) ? `${e.register_type}:${e.register}` : (e.register ? String(e.register) : '');
  },

  // Chip text: "Label (unit) - input:0x0001 - read" / "… - holding:0x005B - readwrite".
  entityLabel(e) {
    const id = dongleLux.entityId(e);
    const name = (e && (e.label || e.name)) || id;
    const unit = (e && e.unit) ? ` (${e.unit})` : '';
    return `${name}${unit} - ${id} - ${dongleLux.entityAccess(e)}`;
  },

  // Access suffix for the chip label: explicit access key when present, else
  // derived (holding registers are writable, inputs are read-only).
  entityAccess(e) {
    if (e && e.access) return String(e.access);
    return (e && (e.writable || e.register_type === 'holding')) ? 'readwrite' : 'read';
  },

  // Resolve a saved mapping value against the catalog → { id, entity }.
  // Namespaced handles match exactly; legacy bare-hex values (pre-namespacing
  // saves) resolve by register number (input preferred). Unresolvable handles
  // round-trip as-is so the readable raw chip survives save/reload.
  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { id: '', entity: null };
    const list = Array.isArray(entities) ? entities : [];
    const bareHex = /^0x[0-9a-f]+$/i.test(raw);
    const lower = raw.toLowerCase();
    const hit = list.find(e => dongleLux.entityId(e).toLowerCase() === lower)
      || (bareHex
        ? (list.find(e => e.register_type === 'input' && String(e.register || '').toLowerCase() === lower)
          || list.find(e => String(e.register || '').toLowerCase() === lower))
        : null);
    if (!hit) return { id: raw, entity: null };
    return { id: dongleLux.entityId(hit), entity: hit };
  },

  // Register-family rows: fixed chip for Fetch / restore rows, entity <select>
  // for "+ Add Mapping" rows (createRow's explicit mode overrides this).
  handleCtrl: 'chip',

  // D4 inline-create unit prefill (adapter interface contract; the D4
  // affordance is wired by a later wave — unused here).
  defaultUnit(e) {
    return (e && e.unit) ? String(e.unit) : '';
  },

  // Which mapping-section buttons the card shows for a profile capability:
  // luxpower-tcp → '📋 Fetch Profile Entities' + '+ Add Mapping'; every other
  // dongle transport keeps the legacy '📥 Load Profile Registers' button.
  // Verbatim legacy applyDongleMappingMode logic (#106 Batch 2C).
  applyMode(card, enabled) {
    const loadBtn = card.querySelector('.load-dongle-registers');
    const fetchBtn = card.querySelector('.fetch-dongle-entities');
    const addBtn = card.querySelector('.add-dongle-mapping');
    if (loadBtn) loadBtn.style.display = enabled ? 'none' : '';
    if (fetchBtn) fetchBtn.style.display = enabled ? '' : 'none';
    if (addBtn) addBtn.style.display = enabled ? '' : 'none';
  }
};
// Adapter registry (window.catalogAdapters): defined on the page side because
// adapters depend on settings.js runtime helpers (predicates, fetchers), while
// catalog-ui.js loads AFTER settings.js. CatalogUI.adapter(name) resolves
// adapters lazily from here. Later families register alongside dongleLux.
window.catalogAdapters = window.catalogAdapters || {};
window.catalogAdapters.dongleLux = dongleLux;

// ============ Issue #108 wave 4 (AC-20..24, AC-28..31): register-family UI ====
// The dongleLux adapter above is the reference. This wave registers the
// remaining register-source adapters the shared CatalogUI component drives:
//   dongleRegister  — dongle register transports (solarman-v5 / modbus-tcp /
//                     default): GET /api/dongle/profile/:id/entities returns
//                     register-family items with id = bare-hex register string
//                     (the exact handle modules/dongle.js decode consumes).
//   modbusRegister  — GET /api/modbus/profile/:id/entities, id = String(address).
//   rs232*          — GET /api/rs232/profile/:id/entities, one adapter per
//                     protocol family: modbus-rtu (bare-hex register), ascii
//                     query/response (`${cmd}:${index}`), vedirect-streaming
//                     (field label), solax-aa55 decoder (`${cmd}:${offset}`).
// All of them: chip rows, catalog-exact restore with family legacy fallbacks,
// explicit metric mapping only — fetch/save/add never auto-create a metric
// (zero auto-creation, AC-30). Legacy "Load Profile Registers/Fields" buttons
// stay side-by-side as the only auto-creating path.

// Register-family chip trailing token: the entity's kind word ('register',
// 'ascii', 'vedirect', …) — access is already surfaced where the projection
// carries it (see dongleLux for the luxpower-tcp variant).
function catalogKindToken(e) {
  return (e && e.kind) ? String(e.kind) : 'read';
}

// A dongle profile whose entities are bare-hex registers: anything that is not
// luxpower-tcp / felicity-tcp (JSON paths) / growatt (push fields). Mirrors the
// modules/entityCatalog.js dongleProfileEntities dispatcher exactly.
function isDongleRegisterProfile(p) {
  if (!p || typeof p !== 'object') return false;
  const protocol = String(p.protocol || '').toLowerCase();
  if (protocol === 'luxpower-tcp' || protocol === 'felicity-tcp') return false;
  if (String(p.transport || '').toLowerCase() === 'growatt') return false;
  return true;
}

// ---------------------------------------------------------------------------
// dongleRegister — bare-hex register transports (solarman-v5 / modbus-tcp)
// ---------------------------------------------------------------------------
const dongleRegister = {
  cacheKey: '_dongleEntities',

  fetch(ctx) {
    return fetchDongleProfileEntities(ctx && ctx.profileId);
  },

  // Bare-hex register verbatim — what modules/dongle.js pollInstance decodes
  // and what legacy saves contain.
  entityId(e) {
    if (!e) return '';
    if (e.id !== undefined && e.id !== null) return String(e.id);
    return (e.register !== undefined && e.register !== null) ? String(e.register) : '';
  },

  // Chip: "Label (unit) - 0x0065 - register".
  entityLabel(e) {
    const id = dongleRegister.entityId(e);
    const name = (e && (e.label || e.name)) || id;
    const unit = (e && e.unit) ? ` (${e.unit})` : '';
    return `${name}${unit} - ${id} - ${catalogKindToken(e)}`;
  },

  // Saved value → catalog: exact id match first, then register-family legacy
  // fallbacks (bare-hex case-insensitive / numeric-normalised — legacy saves
  // predate the catalog and may carry a differently-cased or zero-padded hex).
  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { id: '', entity: null };
    const list = Array.isArray(entities) ? entities : [];
    const lower = raw.toLowerCase();
    const toNum = (s) => /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    const numMatches = (idStr) => {
      if (idStr === raw) return true;
      if (/^0x[0-9a-f]+$/i.test(raw) || /^\d+$/.test(raw)) {
        const a = toNum(raw); const b = toNum(idStr);
        return Number.isFinite(a) && Number.isFinite(b) && a === b;
      }
      return false;
    };
    const hit = list.find(e => dongleRegister.entityId(e).toLowerCase() === lower)
      || list.find(e => numMatches(dongleRegister.entityId(e)));
    if (!hit) return { id: raw, entity: null };
    return { id: dongleRegister.entityId(hit), entity: hit };
  },

  handleCtrl: 'chip',

  defaultUnit(e) {
    return (e && e.unit) ? String(e.unit) : '';
  },

  // Register transports show Fetch/Add AND the legacy Load side by side;
  // legacy-only profiles (growatt/felicity/blank) get Load alone.
  applyMode(card, enabled) {
    const loadBtn = card.querySelector('.load-dongle-registers');
    const fetchBtn = card.querySelector('.fetch-dongle-entities');
    const addBtn = card.querySelector('.add-dongle-mapping');
    if (loadBtn) loadBtn.style.display = '';
    if (fetchBtn) fetchBtn.style.display = enabled ? '' : 'none';
    if (addBtn) addBtn.style.display = enabled ? '' : 'none';
  }
};

// ---------------------------------------------------------------------------
// modbusRegister — Modbus TCP/RTU device profiles (register addresses)
// ---------------------------------------------------------------------------
async function fetchModbusProfileEntities(profileId) {
  if (!profileId) throw new Error('Select a profile first');
  const res = await fetch(`/api/modbus/profile/${encodeURIComponent(profileId)}/entities`);
  if (!res.ok) {
    let msg = `Failed to load entities (HTTP ${res.status})`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
    throw new Error(msg);
  }
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

const modbusRegister = {
  cacheKey: '_modbusEntities',

  fetch(ctx) {
    return fetchModbusProfileEntities(ctx && ctx.profileId);
  },

  // id = String(address) — the exact handle modules/modbus.js addrToMetric
  // consumes and legacy saves contain.
  entityId(e) {
    if (!e) return '';
    if (e.id !== undefined && e.id !== null) return String(e.id);
    return (e.address !== undefined && e.address !== null) ? String(e.address) : '';
  },

  // Chip: "Label (unit) - 90 - register".
  entityLabel(e) {
    const id = modbusRegister.entityId(e);
    const name = (e && (e.label || e.name)) || id;
    const unit = (e && e.unit) ? ` (${e.unit})` : '';
    return `${name}${unit} - ${id} - ${catalogKindToken(e)}`;
  },

  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { id: '', entity: null };
    const list = Array.isArray(entities) ? entities : [];
    const lower = raw.toLowerCase();
    const hit = list.find(e => modbusRegister.entityId(e).toLowerCase() === lower)
      || (raw === String(parseInt(raw, 10)) // decimal address, legacy normalization
        ? list.find(e => modbusRegister.entityId(e) === String(parseInt(raw, 10)))
        : null);
    if (!hit) return { id: raw, entity: null };
    return { id: modbusRegister.entityId(hit), entity: hit };
  },

  handleCtrl: 'chip',

  defaultUnit(e) {
    return (e && e.unit) ? String(e.unit) : '';
  },

  // Same side-by-side contract as dongleRegister: Load stays visible, catalog
  // buttons appear once a profile is active.
  applyMode(card, enabled) {
    const loadBtn = card.querySelector('.load-modbus-registers');
    const fetchBtn = card.querySelector('.fetch-modbus-entities');
    const addBtn = card.querySelector('.add-modbus-mapping');
    if (loadBtn) loadBtn.style.display = '';
    if (fetchBtn) fetchBtn.style.display = enabled ? '' : 'none';
    if (addBtn) addBtn.style.display = enabled ? '' : 'none';
  }
};

// ---------------------------------------------------------------------------
// rs232Register / rs232Ascii / rs232Vedirect / rs232Solax — one adapter per
// RS232 protocol family (entities endpoint /api/rs232/profile/:id/entities).
// Shared base below; only the family word, chip label front, entity-id form
// (all ride on the projection's canonical `id`) and legacy resolve fallback
// differ per family.
// ---------------------------------------------------------------------------
async function fetchRs232ProfileEntities(profileId) {
  if (!profileId) throw new Error('Select a profile first');
  const res = await fetch(`/api/rs232/profile/${encodeURIComponent(profileId)}/entities`);
  if (!res.ok) {
    let msg = `Failed to load entities (HTTP ${res.status})`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
    throw new Error(msg);
  }
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

// rs232 profile → adapter registry key, from the profile's protocol/decoder
// (mirrors server.js rs232ProfileEntities family dispatch).
function rs232FamilyAdapterKey(profile) {
  if (!profile) return null;
  const protocol = String(profile.protocol || '').toLowerCase();
  if (protocol === 'modbus-rtu') return 'rs232Register';
  if (protocol === 'vedirect-streaming') return 'rs232Vedirect';
  if (protocol === 'solax-aa55' || String(profile.decoder || '').toLowerCase().includes('solax')) return 'rs232Solax';
  return 'rs232Ascii'; // voltronic-qpigs + aliases (infinisolar) and any ascii query family
}

function makeRs232Adapter(family, opts) {
  opts = opts || {};
  return {
    cacheKey: '_rs232Entities',

    fetch(ctx) {
      return fetchRs232ProfileEntities(ctx && ctx.profileId);
    },

    // The endpoint's canonical id IS the family-specific persisted handle:
    // modbus-rtu bare hex, ascii `${cmd}:${index}`, vedirect field label,
    // solax `${cmd}:${offset}`. entityId just round-trips it verbatim.
    entityId(e) {
      if (!e) return '';
      if (e.id !== undefined && e.id !== null) return String(e.id);
      return '';
    },

    // Chip: "Name (unit) - <id> - <family>".
    entityLabel(e) {
      const id = this.entityId(e);
      let name = (e && (e.label || e.name)) || id;
      if (opts.labelFromName && e && e.name) name = e.name; // vedirect: frame keys are the id
      const unit = (e && e.unit) ? ` (${e.unit})` : '';
      return `${name}${unit} - ${id} - ${family}`;
    },

    resolveHandle(value, entities) {
      const raw = String(value == null ? '' : value).trim();
      if (!raw) return { id: '', entity: null };
      const list = Array.isArray(entities) ? entities : [];
      const lower = raw.toLowerCase();
      let hit = list.find(e => this.entityId(e).toLowerCase() === lower);
      // Family legacy fallbacks beyond the exact match:
      if (!hit && opts.legacyNumeric && /^0x[0-9a-f]+$/i.test(raw)) {
        const num = parseInt(raw, 16);
        hit = list.find(e => {
          const idStr = this.entityId(e);
          return (/^0x[0-9a-f]+$/i.test(idStr) && parseInt(idStr, 16) === num);
        });
      }
      if (!hit) return { id: raw, entity: null };
      return { id: this.entityId(hit), entity: hit };
    },

    handleCtrl: 'chip',

    defaultUnit(e) {
      return (e && e.unit) ? String(e.unit) : '';
    },

    // Load Profile Fields stays visible for every family; the catalog buttons
    // appear once a profile is active.
    applyMode(card, enabled) {
      const loadBtn = card.querySelector('.load-rs232-fields');
      const fetchBtn = card.querySelector('.fetch-rs232-entities');
      const addBtn = card.querySelector('.add-rs232-mapping');
      if (loadBtn) loadBtn.style.display = '';
      if (fetchBtn) fetchBtn.style.display = enabled ? '' : 'none';
      if (addBtn) addBtn.style.display = enabled ? '' : 'none';
    }
  };
}

const rs232Register = makeRs232Adapter('register', { legacyNumeric: true });
const rs232Ascii = makeRs232Adapter('ascii', {});
const rs232Vedirect = makeRs232Adapter('vedirect', { labelFromName: true });
const rs232Solax = makeRs232Adapter('solax', {});

window.catalogAdapters.dongleRegister = dongleRegister;
window.catalogAdapters.modbusRegister = modbusRegister;
window.catalogAdapters.rs232Register = rs232Register;
window.catalogAdapters.rs232Ascii = rs232Ascii;
window.catalogAdapters.rs232Vedirect = rs232Vedirect;
window.catalogAdapters.rs232Solax = rs232Solax;

// ============ Issue #108 wave 5 (AC-25..27, AC-29..31): HA / MQTT / REST ====
// These three families predate CatalogUI and keep their bespoke per-card
// renderers and save collectors byte-compatible (AC-31). Their adapters make
// the registry complete and let the shared component's helpers (entity
// labeling, unit prefill, applyMode, '+ New' inline create) be wired INTO the
// existing card functions — the cards themselves are not rewritten.
//
//   ha        — enriched HA entity catalog (AC-25): fetch(ctx{url,token}) →
//               GET /api/ha/entities (items have friendly_name/unit/state);
//               handle = entity_id (the persisted mapping value, byte-compat);
//               handleCtrl 'select' (row anatomy of addHaMetricRow).
//   mqtt      — MQTT discovery cache (AC-26): fetch(ctx{broker}) → GET
//               /api/mqtt-discovery-cache?broker → entries [{topic, sample}];
//               handle = topic; handleCtrl 'input' (rows carry .topic-input).
//   external  — REST leaf catalog (AC-27): fetch(ctx{url}) → POST
//               /api/external/fields {url} → leaves [{path,value,type,sample}];
//               handle = leaf path; handleCtrl 'input' (rows carry .jsonpath).
const haAdapter = {
  cacheKey: '_haCatalog',
  fetch(ctx) {
    const url = ctx && ctx.url;
    const token = ctx && ctx.token;
    if (!url || !token) return Promise.reject(new Error('HA URL and token required'));
    return fetchHaEntityCatalog(url, token);
  },
  // Persisted handle: entity_id — exactly what the save collector writes and
  // modules/ha.js reverse-looks-up (byte-compat, AC-25).
  entityId(e) { return haEntityIdOf(e); },
  // Chip/option text: "friendly_name (unit) - sensor.x - <state>".
  entityLabel(e) { return haEntityLabelText(e); },
  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    const list = Array.isArray(entities) ? entities : [];
    const hit = list.find(e => haEntityIdOf(e) === raw);
    return hit ? { id: haEntityIdOf(hit), entity: hit } : { id: raw, entity: null };
  },
  handleCtrl: 'select',
  defaultUnit(e) {
    return (e && e.unit_of_measurement !== undefined && e.unit_of_measurement !== null) ? String(e.unit_of_measurement) : '';
  },
  // HA cards always expose the fetch/add-row/actions UI — nothing to hide.
  applyMode() {}
};

const mqttAdapter = {
  cacheKey: '_mqttCache',
  fetch(ctx) {
    const broker = ctx && ctx.broker;
    if (!broker) return Promise.reject(new Error('Broker URL required'));
    return fetch(`/api/mqtt-discovery-cache?broker=${encodeURIComponent(broker)}`)
      .then(res => res.json().catch(() => ({})))
      .then(data => (data && Array.isArray(data.entries)) ? data.entries : []);
  },
  entityId(e) { return (e && e.topic != null) ? String(e.topic) : ''; },
  entityLabel(e) { return mqttSampleText(mqttAdapter.entityId(e), e && e.sample); },
  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    const list = Array.isArray(entities) ? entities : [];
    const hit = list.find(e => mqttAdapter.entityId(e) === raw);
    return hit ? { id: mqttAdapter.entityId(hit), entity: hit } : { id: raw, entity: null };
  },
  handleCtrl: 'input',
  defaultUnit() { return ''; },
  applyMode() {}
};

const externalAdapter = {
  cacheKey: '_externalLeaves',
  fetch(ctx) {
    const url = ctx && ctx.url;
    if (!url) return Promise.reject(new Error('URL required'));
    return fetch('/api/external/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ url })
    }).then(res => res.json().catch(() => ({})))
      .then(data => {
        if (data && data.error) throw new Error(data.error);
        return (data && Array.isArray(data.leaves)) ? data.leaves : [];
      });
  },
  entityId(e) { return (e && e.path !== undefined) ? String(e.path) : ''; },
  entityLabel(e) { return externalLeafSampleText(e); },
  resolveHandle(value, entities) {
    const raw = String(value == null ? '' : value).trim();
    const list = Array.isArray(entities) ? entities : [];
    const hit = list.find(e => externalAdapter.entityId(e) === raw);
    return hit ? { id: externalAdapter.entityId(hit), entity: hit } : { id: raw, entity: null };
  },
  handleCtrl: 'input',
  defaultUnit() { return ''; },
  applyMode() {}
};

window.catalogAdapters.ha = haAdapter;
window.catalogAdapters.mqtt = mqttAdapter;
window.catalogAdapters.external = externalAdapter;

// ---------------------------------------------------------------------------
// AC-29 row-state helpers (page side). CatalogUI rows stamp themselves; the
// legacy renderers (Load Profile Registers/Fields rows) use these so the save
// handler sees one consistent dataset contract:
//   dataset.prevMetric — metric the row held when it entered the DOM
//   dataset.cleared='1' — that metric was flipped back to empty (removal intent)
// ---------------------------------------------------------------------------
function stampRowMetricState(row, metricName) {
  if (!row) return;
  if (metricName) row.dataset.prevMetric = metricName;
}

function syncRowClearedFlag(row, selectEl) {
  if (!row) return;
  if (selectEl && selectEl.value) {
    row.dataset.prevMetric = selectEl.value;
    delete row.dataset.cleared;
  } else if (row.dataset.prevMetric) {
    row.dataset.cleared = '1';
  } else {
    delete row.dataset.cleared;
  }
}

// ---------------------------------------------------------------------------
// AC-29 save-count note + implicit→explicit-none flip warning (register
// families: modbus / rs232 / dongle). DOM-only — the save collectors read the
// same rows, so the note always agrees with what a save would persist.
// ---------------------------------------------------------------------------
// Count of rows on a card that would persist: a chosen metric AND a handle
// (chip/select rows: dataset.address; input rows: their text input). Mirrors
// the modbus/rs232/dongle save collectors exactly.
function cardMappedRowCount(card) {
  const listEl = card ? card.querySelector('.mappings-section .mappings-list') : null;
  if (!listEl) return 0;
  let n = 0;
  listEl.querySelectorAll('.metric-row').forEach(row => {
    const ms = row.querySelector('.metric-name');
    if (!ms || !ms.value) return;
    const textInput = row.querySelector('.topic-input, .jsonpath');
    const entitySel = row.querySelector('.entity-select');
    const handle = row.dataset.address
      || (entitySel && entitySel.value ? entitySel.value : '')
      || (textInput ? textInput.value.trim() : '');
    if (handle) n++;
  });
  return n;
}

// "Save will persist N of M mapped" transient note for one card's mapping
// section. Rendered as a sibling of .mappings-list (never inside it, so the
// filter machinery and row counts are unaffected); removed when the list is
// empty. Called from catalog-rows-changed events (CatalogUI), container
// delegation (legacy rows) and directly after restore / legacy-load renders.
function updateMappingSaveNote(card) {
  if (!card || !card.querySelector) return;
  const section = card.querySelector('.mappings-section');
  const listEl = card.querySelector('.mappings-section .mappings-list');
  if (!section || !listEl) return;
  const old = section.querySelector('.mappings-save-note');
  if (old) old.remove();
  const rows = listEl.querySelectorAll('.metric-row').length;
  if (!rows) return;
  const mapped = cardMappedRowCount(card);
  const note = document.createElement('div');
  note.className = 'note mappings-save-note';
  note.style.color = 'var(--text-secondary, #93a1b5)';
  note.style.fontSize = '0.8em';
  note.textContent = `Save will persist ${mapped} of ${rows} mapped.`;
  listEl.after(note);
}

// CatalogUI rows dispatch 'catalog-rows-changed' (catalog-ui.js) after every
// row-structural change — keep the note live for all of them.
document.addEventListener('catalog-rows-changed', (e) => {
  const card = e && e.detail && e.detail.card ? e.detail.card : null;
  if (card) updateMappingSaveNote(card);
});
// Legacy renderers (Load Profile Registers/Fields + growatt/felicity restore)
// build rows directly — cover their metric picks and row removals too. The HA,
// MQTT and external cards use the same legacy row anatomy, so they join here
// for a live "Save will persist N of M mapped" note (AC-29/AC-31).
['ha-devices-container', 'mqtt-devices-container', 'external-sources-container', 'modbus-devices-container', 'rs232-devices-container', 'dongle-devices-container'].forEach(id => {
  const container = document.getElementById(id);
  if (!container) return;
  container.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.classList && (t.classList.contains('metric-name') || t.classList.contains('entity-select') || t.classList.contains('topic-input') || t.classList.contains('jsonpath'))) {
      updateMappingSaveNote(t.closest('.device-card'));
    }
  });
  container.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('remove-metric')) {
      updateMappingSaveNote(t.closest('.device-card'));
    }
  });
});

// AC-29 flip warning: a device whose STORED config has no `mappings` key polls
// implicitly (profile-default names). Saving it with zero mapped rows writes
// `mappings: {}`, which every poller reads as explicit-none — polling stops.
// Warn when that would happen. Devices already carrying a `mappings` key are
// already explicit (an existing `{}` is explicit-none, no flip); brand-new
// cards (no stored device) were never implicit, so they never warn.
function confirmImplicitToExplicitNoneFlips() {
  const flagged = [];
  ['modbus-devices-container', 'rs232-devices-container', 'dongle-devices-container'].forEach(id => {
    const container = document.getElementById(id);
    if (!container) return;
    container.querySelectorAll('.device-card').forEach(card => {
      const orig = card._origDevice;
      if (!orig || Object.prototype.hasOwnProperty.call(orig, 'mappings')) return;
      if (cardMappedRowCount(card) > 0) return;
      const nameInput = card.querySelector('.device-header input[type="text"]');
      flagged.push((nameInput && nameInput.value.trim()) || orig.name || 'this device');
    });
  });
  if (flagged.length === 0) return true;
  const list = flagged.map(n => `“${n}”`).join(', ');
  return showConfirm(
    `Saving will flip ${flagged.length === 1 ? 'a device' : flagged.length + ' devices'} from implicit ` +
    `profile-default polling to explicit-none (polling stops) because it has no mapped metrics: ${list}. ` +
    `Map at least one metric to keep it polling. Save anyway?`
  );
}

function hideDongleWriteControls(card) {
  const wrap = card.querySelector('.write-controls');
  const divider = card.querySelector('.dongle-write-divider');
  if (wrap) wrap.style.display = 'none';
  if (divider) divider.style.display = 'none';
}

// ---- Dongle mapping-mode dispatch (issue #108 wave 4, AC-20/AC-22) ---------
// One place that decides which adapter/buttons a dongle card shows, driven by
// the selected PROFILE (the transport <select> is cosmetic; the profile's
// protocol/transport is authoritative — mirrors modules/dongle.js + the
// entityCatalog dispatcher):
//   luxpower-tcp         → dongleLux (Fetch/Add only — wave-3 behaviour, unchanged)
//   register transport   → dongleRegister (Fetch/Add AND legacy Load side by side)
//   growatt / felicity   → legacy Load only (input families, later wave)
//   no profile           → legacy Load only (nothing to catalogue yet)
async function resolveDongleProfile(profileId) {
  if (!profileId) return null;
  let p = getProfileById(profileId);
  if (p) return p;
  try {
    const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`);
    if (res.ok) p = await res.json();
  } catch (e) {}
  return p || null;
}

function applyDongleMappingMode(card, profile) {
  if (!card || !window.CatalogUI) return;
  if (!profile) { CatalogUI.applyMode(dongleLux, card, false); return; } // legacy Load only
  if (isLuxpowerDongleProfile(profile)) { CatalogUI.applyMode(dongleLux, card, true); return; }
  if (isDongleRegisterProfile(profile)) { CatalogUI.applyMode(dongleRegister, card, true); return; }
  CatalogUI.applyMode(dongleLux, card, false); // growatt/felicity: legacy Load only
}

function dongleCatalogAdapterForProfile(profile) {
  if (!profile) return null;
  if (isLuxpowerDongleProfile(profile)) return dongleLux;
  if (isDongleRegisterProfile(profile)) return dongleRegister;
  return null; // legacy-only families have no catalog buttons
}

// Empty-state note used when a register-family card resets its mapping list.
function dongleRegisterResetNote() {
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'No mappings yet — “Fetch Profile Entities” lists every register for this profile (metrics are never auto-created), “+ Add Mapping” adds a single row, or “Load Profile Registers” imports the profile defaults.';
  return note;
}

// Write Controls — luxpower-tcp only, when the profile has capabilities.write
// and a non-empty writable_registers list. Per writable entry: a human label
// (unit + min/max/step), a number input and a Write button that confirm()s and
// POSTs /api/action { source:'dongle', device:<card instance name>,
// action:'write', entity:'holding:0xNNNN', params:{value} } with an inline
// status (8s timeout). Preset buttons render from entry.actions when present.
async function populateDongleWriteControls(card, profileId, profile) {
  const wrap = card.querySelector('.write-controls');
  if (!wrap || !profileId) return;
  hideDongleWriteControls(card);
  wrap.innerHTML = '';
  let p = profile;
  if (!p) {
    try {
      const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`);
      if (res.ok) p = await res.json();
    } catch (e) {}
  }
  if (!p || !isLuxpowerDongleProfile(p)) return;
  const caps = p.capabilities || {};
  const writable = Array.isArray(p.writable_registers) ? p.writable_registers : [];
  if (caps.write !== true || writable.length === 0) return;
  let entities = Array.isArray(card._dongleEntities) ? card._dongleEntities : [];
  if (!entities.length) {
    try { entities = await fetchDongleProfileEntities(profileId); card._dongleEntities = entities; } catch (e) {}
  }
  const byId = new Map();
  entities.forEach(e => { const id = dongleLux.entityId(e); if (id) byId.set(id.toLowerCase(), e); });
  // The user may have switched profiles while the fetches above were in flight.
  const sel = card.querySelector('.dongle-profile-select');
  if (sel && sel.value && sel.value !== profileId) return;

  const divider = card.querySelector('.dongle-write-divider');
  if (divider) divider.style.display = '';
  wrap.style.display = '';

  writable.forEach(w => {
    const id = `${(w.register_type || 'holding').toLowerCase()}:${w.register}`;
    const ent = byId.get(id.toLowerCase()) || null;
    const label = w.label || w.name || id;
    const unit = w.unit ? ` (${w.unit})` : '';
    const rangeParts = [];
    if (w.min !== undefined && w.min !== null) rangeParts.push(`min ${w.min}`);
    if (w.max !== undefined && w.max !== null) rangeParts.push(`max ${w.max}`);
    if (w.step !== undefined && w.step !== null) rangeParts.push(`step ${w.step}`);
    const rangeTxt = rangeParts.length ? ` · ${rangeParts.join(' · ')}` : '';

    const row = document.createElement('div');
    row.className = 'write-control-row';
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;padding:0.3rem 0;';
    const nameEl = document.createElement('span');
    nameEl.textContent = `${label}${unit}${rangeTxt}`;
    nameEl.title = `${id} — ${w.type || 'uint16'}${w.scale !== undefined && w.scale !== 1 ? `, scale ${w.scale}` : ''}`;
    nameEl.style.cssText = 'flex:1;min-width:180px;font-size:0.85em;';
    row.appendChild(nameEl);

    const input = document.createElement('input');
    input.type = 'number';
    if (w.min !== undefined && w.min !== null) input.min = w.min;
    if (w.max !== undefined && w.max !== null) input.max = w.max;
    input.step = (w.step !== undefined && w.step !== null) ? w.step : 'any';
    input.placeholder = (w.min !== undefined && w.max !== undefined) ? `${w.min} … ${w.max}` : 'value';
    input.style.cssText = 'width:110px;';
    row.appendChild(input);

    const writeBtn = document.createElement('button');
    writeBtn.type = 'button';
    writeBtn.className = 'fetch-btn';
    writeBtn.textContent = 'Write';
    row.appendChild(writeBtn);

    const statusEl = document.createElement('span');
    statusEl.className = 'test-status';
    statusEl.style.fontSize = '0.75em';
    row.appendChild(statusEl);

    const runWrite = () => {
      const rawVal = input.value.trim();
      if (rawVal === '') { showStatus(statusEl, 'Enter a value first', 'error'); return; }
      const val = Number(rawVal);
      if (isNaN(val)) { showStatus(statusEl, 'Not a number', 'error'); return; }
      if (!showConfirm(`Write ${val} to ${label} (${id})?`)) return;
      sendDongleRegisterWrite(card, id, val, 'write', statusEl);
    };
    writeBtn.addEventListener('click', runWrite);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runWrite(); }
    });

    // Preset actions for this entry (catalog entity first, then profile entry).
    const actions = (ent && Array.isArray(ent.actions) && ent.actions.length) ? ent.actions
      : (Array.isArray(w.actions) ? w.actions : []);
    actions.forEach(a => {
      const preset = (a && typeof a === 'object' && !Array.isArray(a)) ? a : { action: String(a), label: String(a) };
      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'fetch-btn write-preset-btn';
      pBtn.textContent = preset.label || String(preset.action || 'preset');
      pBtn.style.cssText = 'font-size:0.72rem;padding:0.15rem 0.55rem;';
      row.appendChild(pBtn);
      pBtn.addEventListener('click', () => {
        const val = (preset.value !== undefined && preset.value !== null)
          ? preset.value
          : (input.value.trim() !== '' ? Number(input.value) : undefined);
        if (val === undefined) { showStatus(statusEl, 'Enter a value (or use the number box)', 'error'); return; }
        sendDongleRegisterWrite(card, id, val, String(preset.action || 'preset'), statusEl);
      });
    });

    wrap.appendChild(row);
  });
}

// POST /api/action for a dongle register write. The device NAME comes from the
// card header input — the server resolves the transport from its stored config
// (no host/port/serials cross the wire; same SSRF-safe pattern as HA actions).
async function sendDongleRegisterWrite(card, entityId, value, action, statusEl) {
  const nameInput = card.querySelector('.device-header input[type="text"]');
  const deviceName = nameInput ? nameInput.value.trim() : '';
  if (!deviceName) { showStatus(statusEl, 'Instance name required', 'error'); return; }
  // Disable every button in this entry's row while the write is in flight so a
  // second click (Write or a preset) cannot fire a concurrent POST.
  const rowEl = statusEl.closest ? statusEl.closest('.write-control-row') : null;
  const rowBtns = rowEl ? Array.from(rowEl.querySelectorAll('button')) : [];
  rowBtns.forEach(b => { b.disabled = true; });
  showStatus(statusEl, 'Writing…', 'info');
  const body = { source: 'dongle', device: deviceName, action: action || 'write', entity: entityId, params: {} };
  if (value !== undefined && value !== null) body.params.value = value;
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.success !== false && !data.error) {
      showStatus(statusEl, 'Write OK', 'success');
    } else {
      showStatus(statusEl, (data && data.error) ? data.error : `Write failed (HTTP ${res.status})`, 'error');
    }
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    showStatus(statusEl, timedOut ? 'Write timed out' : (e.message || 'Write failed'), 'error');
  } finally {
    rowBtns.forEach(b => { b.disabled = false; });
  }
}

// Async initialiser for a dongle card: fetch the profile to pick the mapping UI
// by family (luxpower-tcp → dongleLux entity-catalog; register transports →
// dongleRegister entity-catalog with legacy Load retained; growatt/felicity →
// legacy register/field UI), restore saved mappings, then build the Write
// Controls section (luxpower-tcp only).
async function initDongleCardMappings(card, profileId, savedMappings, mappingsList) {
  if (!profileId) return;
  if (!mappingsList) mappingsList = card.querySelector('.mappings-list');
  if (!mappingsList) return;
  const profileSel = card.querySelector('.dongle-profile-select');
  const profileStillSelected = () => {
    if (!profileSel) return true;
    return profileSel.value === '' || profileSel.value === profileId;
  };
  let profile = null;
  try {
    const res = await fetch(`/api/dongle/profile/${encodeURIComponent(profileId)}`);
    if (res.ok) profile = await res.json();
  } catch (e) {}
  if (!profileStillSelected()) return;
  const lux = isLuxpowerDongleProfile(profile);
  const reg = !lux && isDongleRegisterProfile(profile);
  // Card button mode is adapter-driven (#108 wave 4 family dispatch).
  applyDongleMappingMode(card, profile);
  if (!lux && !reg) {
    // growatt/felicity + any legacy-only family: unchanged legacy UI.
    hideDongleWriteControls(card);
    if (savedMappings && Object.keys(savedMappings).length > 0) {
      renderDongleMappings(profileId, savedMappings, mappingsList);
    } else {
      mappingsList.innerHTML = '';
    }
    updateMappingSaveNote(card);
    return;
  }
  // luxpower-tcp / register transport: cache the entity catalog, then restore
  // saved rows through the shared component (metric dropdowns pre-selected to
  // the saved names, handles resolved against the catalog — raw chips for
  // unresolvable values, round-trip safe). Zero auto-creation on this path.
  const adapter = lux ? dongleLux : dongleRegister;
  let entities = [];
  try {
    entities = await fetchDongleProfileEntities(profileId);
    card._dongleEntities = entities;
  } catch (e) {
    card._dongleEntities = [];
  }
  if (!profileStillSelected()) return;
  if (lux) {
    // The transport <select> derives from the profile cache, which may not have
    // loaded when this card first rendered — correct it for luxpower so the
    // dongle/inverter serial fields show and saves persist transport:'luxpower-tcp'.
    const txSel = card.querySelector('select[name$="[transport]"]');
    if (txSel && txSel.value !== 'luxpower-tcp') {
      txSel.value = 'luxpower-tcp';
      if (typeof updateDongleTransportUI === 'function') updateDongleTransportUI(card);
    }
    if (!profileStillSelected()) return;
    CatalogUI.renderSaved(dongleLux, savedMappings || {}, entities, mappingsList);
    await populateDongleWriteControls(card, profileId, profile);
    return;
  }
  // Register transport: restore via the dongleRegister adapter.
  hideDongleWriteControls(card);
  if (savedMappings && Object.keys(savedMappings).length > 0) {
    CatalogUI.renderSaved(dongleRegister, savedMappings, entities, mappingsList);
  } else {
    mappingsList.innerHTML = '';
    mappingsList.appendChild(dongleRegisterResetNote());
  }
  updateMappingSaveNote(card);
}

// ======================== PVOUTPUT ========================
function buildPvoutputConfig(config) {
  if (!config) config = {};
  const enabledCb = document.getElementById('pvoutput-enabled');
  if (enabledCb) enabledCb.checked = config.enabled === true;
  const apiKey = document.getElementById('pvoutput-api-key');
  if (apiKey) apiKey.value = config.api_key || '';
  const sysId = document.getElementById('pvoutput-system-id');
  if (sysId) sysId.value = config.system_id || '';
  const tz = document.getElementById('pvoutput-timezone');
  if (tz) tz.value = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const interval = document.getElementById('pvoutput-interval');
  if (interval) interval.value = config.upload_interval_minutes || 5;
  const sysSize = document.getElementById('pvoutput-system-size');
  if (sysSize) sysSize.value = config.system_size_w || '';
  const webhookUrl = document.getElementById('pvoutput-webhook-url');
  if (webhookUrl) webhookUrl.value = config.webhook_url || '';

  const cumulativeRadio = document.querySelector('input[name="pvoutput-mode"][value="cumulative"]');
  const netRadio = document.querySelector('input[name="pvoutput-mode"][value="net"]');
  if (cumulativeRadio) cumulativeRadio.checked = !config.net_mode;
  if (netRadio) netRadio.checked = config.net_mode === true;

  // Metric mapping dropdowns
  const mm = config.metric_map || {};
  const metricFields = [
    { key: 'v1', label: 'v1 Energy Generated (Wh)', hint: 'Cumulative daily solar generation. Typically daily_solar_kwh or solar_kwh.' },
    { key: 'v2', label: 'v2 Power Generated (W)', hint: 'Instantaneous solar output in watts. Typically solar_power or solar.' },
    { key: 'v3', label: 'v3 Energy Consumed (Wh)', hint: 'Cumulative daily consumption. Typically daily_consumption or load_kwh.' },
    { key: 'v4', label: 'v4 Power Consumed (W)', hint: 'Instantaneous load in watts. Typically load_power or consumption.' },
    { key: 'v5', label: 'v5 Temperature (°C)', hint: 'Ambient or inverter temperature. Typically inverter_temperature.' },
    { key: 'v6', label: 'v6 Voltage (V)', hint: 'Grid/mains voltage. Typically grid_voltage.' }
  ];
  const container = document.getElementById('pvoutput-metrics-container');
  if (container) {
    container.innerHTML = metricFields.map(f => {
      const sel = generateMetricOptionsHtml(mm[f.key]);
      return `<div class="form-group" style="flex:1;min-width:200px;"><label>${escapeHtml(f.label)}</label><select class="pvoutput-metric" data-key="${f.key}" style="width:100%;">${sel}</select><div class="note">${escapeHtml(f.hint)}</div></div>`;
    }).join('');
  }

  // Queue status
  refreshPvoutputQueue();
}

function collectPvoutputConfig() {
  const mm = {};
  document.querySelectorAll('.pvoutput-metric').forEach(sel => {
    if (sel.value) mm[sel.dataset.key] = sel.value;
  });
  return {
    enabled: document.getElementById('pvoutput-enabled')?.checked || false,
    api_key: document.getElementById('pvoutput-api-key')?.value || '',
    system_id: document.getElementById('pvoutput-system-id')?.value || '',
    timezone: document.getElementById('pvoutput-timezone')?.value || '',
    upload_interval_minutes: parseInt(document.getElementById('pvoutput-interval')?.value) || 5,
    system_size_w: parseInt(document.getElementById('pvoutput-system-size')?.value) || 0,
    net_mode: document.querySelector('input[name="pvoutput-mode"]:checked')?.value === 'net',
    webhook_url: document.getElementById('pvoutput-webhook-url')?.value || '',
    metric_map: mm
  };
}

async function refreshPvoutputQueue() {
  const statusEl = document.getElementById('pvoutput-queue-status');
  if (!statusEl) return;
  try {
    const res = await fetch('/api/pvoutput/queue');
    if (!res.ok) { statusEl.textContent = 'Configure PVOutput first'; return; }
    const data = await res.json();
    if (data.pending > 0) {
      statusEl.innerHTML = `Pending: <strong>${data.pending}</strong> records across ${data.byDate?.length || 0} dates.`;
      if (data.pending > 100) {
        statusEl.innerHTML += `<br><span class="note" style="color:#dc2626;">Large queue detected. Free account backfill may take several hours. Consider enabling donation mode for batch upload support.</span>`;
      }
    } else {
      statusEl.textContent = 'Queue empty.';
    }
  } catch (e) { statusEl.textContent = ''; }
}

// Test connection button
const pvoutputTestBtn = document.getElementById('pvoutput-test-btn');
if (pvoutputTestBtn) {
  pvoutputTestBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('pvoutput-test-status');
    const apiKey = document.getElementById('pvoutput-api-key')?.value.trim();
    const sysId = document.getElementById('pvoutput-system-id')?.value.trim();
    if (!apiKey || !sysId) { showStatus(statusEl, 'API key and System ID required', 'error'); return; }
    showStatus(statusEl, 'Connecting to PVOutput...', 'info');
    try {
      const res = await fetch('/api/pvoutput/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ api_key: apiKey, system_id: sysId })
      });
      const data = await res.json();
      if (res.ok) {
        showStatus(statusEl, `Connected — ${data.system_name}, ${data.system_size}W. Timezone: ${data.timezone}`, 'success');
        // Auto-fill timezone (NM6)
        if (data.timezone) {
          const tzInput = document.getElementById('pvoutput-timezone');
          if (tzInput && !tzInput.value) tzInput.value = data.timezone;
        }
      } else {
        showStatus(statusEl, data.error, 'error');
      }
    } catch (e) { showStatus(statusEl, e.message, 'error'); }
  });
}

// Backfill button
const backfillBtn = document.getElementById('pvoutput-backfill-btn');
if (backfillBtn) {
  backfillBtn.addEventListener('click', async () => {
    backfillBtn.disabled = true;
    backfillBtn.textContent = 'Running...';
    try {
      const res = await fetch('/api/pvoutput/backfill', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const data = await res.json();
      showStatus(document.getElementById('pvoutput-test-status'), data.message || 'Backfill complete', 'success');
      refreshPvoutputQueue();
    } catch (e) {
      showStatus(document.getElementById('pvoutput-test-status'), e.message, 'error');
    } finally {
      backfillBtn.disabled = false;
      backfillBtn.textContent = 'Run Backfill';
    }
  });
}

// View Queue button
const viewQueueBtn = document.getElementById('pvoutput-view-queue-btn');
if (viewQueueBtn) {
  viewQueueBtn.addEventListener('click', () => {
    refreshPvoutputQueue();
  });
}

// ======================== FORECAST TEST ========================
const forecastTestBtn = document.getElementById('test-forecast');
if (forecastTestBtn) {
  forecastTestBtn.addEventListener('click', async function() {
    const btn = this;
    const statusEl = document.getElementById('forecast-test-status');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';
    showStatus(statusEl, 'Fetching forecast...', 'info');
    try {
      // Send current form values so user can test before saving
      const params = new URLSearchParams({
        lat: document.getElementById('solar-latitude')?.value || '',
        lon: document.getElementById('solar-longitude')?.value || '',
        capacity: document.getElementById('solar-capacity')?.value || '',
        tilt: document.getElementById('solar-tilt')?.value || '30',
        azimuth: document.getElementById('solar-azimuth')?.value || '180',
        loss: document.getElementById('solar-loss-factor')?.value || '0.9',
        install_date: document.getElementById('solar-install-date')?.value || '2020-01-01',
        api_key: document.getElementById('solcast-api-key')?.value || '',
        resource_id: document.getElementById('solcast-resource-id')?.value || ''
      });
      const res = await fetch(`/api/test-forecast?${params.toString()}`);
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `✅ ${data.source}: Today ~${data.today_estimate_kwh} kWh, Peak ${data.peak_kw} kW`, 'success');
      else showStatus(statusEl, `❌ ${data.error}`, 'error');
    } catch (e) {
      showStatus(statusEl, `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Forecast';
    }
  });
}

// ======================== ROLE METRICS ========================
const ROLE_LABELS = {
  solar: 'Solar Power',
  consumption: 'Consumption / Load Power',
  battery_charge: 'Battery Charge Power',
  battery_discharge: 'Battery Discharge Power',
  grid_import: 'Grid Import Power',
  grid_export: 'Grid Export Power',
  battery_soc: 'Battery SOC',
  solar_voltage: 'Solar Voltage',
  daily_solar: 'Daily Solar Energy (gen)',
  daily_consumption: 'Daily Consumption Energy',
  daily_battery_charge: 'Daily Battery Charge Energy',
  daily_battery_discharge: 'Daily Battery Discharge Energy',
  daily_grid_import: 'Daily Grid Import Energy',
  daily_grid_export: 'Daily Grid Export Energy',
};

async function loadRoleMetrics() {
  const container = document.getElementById('role-metrics-container');
  if (!container) return;
  try {
    const [rolesRes, metricsRes] = await Promise.all([
      fetch('/api/role-metrics'),
      fetch('/api/metrics/list')
    ]);
    const roles = await rolesRes.json();
    const metrics = await metricsRes.json();
    const metricNames = Array.isArray(metrics) ? metrics : [];
    container.innerHTML = Object.entries(ROLE_LABELS).map(([role, label]) => {
      const current = roles[role] || '';
      const options = ['<option value="">-- Not mapped --</option>',
        ...metricNames.map(m => `<option value="${escapeHtml(m.name || m)}" ${(m.name || m) === current ? 'selected' : ''}>${escapeHtml(m.name || m)}</option>`)
      ].join('');
      return `<div class="stg-form-row" style="margin-bottom:0.4rem;"><div class="stg-form-group" style="flex:1;"><label style="font-size:0.8rem;">${escapeHtml(label)}</label><select class="role-metric-select" data-role="${role}" style="width:100%;">${options}</select></div></div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<p class="note" style="color:#ef4444;">Failed to load: ${e.message}</p>`;
  }
}

// Role metrics save button
const saveRoleMetricsBtn = document.getElementById('save-role-metrics');
if (saveRoleMetricsBtn) {
  saveRoleMetricsBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('role-metrics-status');
    const selects = document.querySelectorAll('.role-metric-select');
    const mapping = {};
    selects.forEach(sel => {
      if (sel.value) mapping[sel.dataset.role] = sel.value;
    });
    try {
      const res = await fetch('/api/role-metrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(mapping)
      });
      const data = await res.json();
      showStatus(statusEl, data.success ? '✅ Saved' : '❌ ' + (data.error || 'Failed'), data.success ? 'success' : 'error');
    } catch (e) {
      showStatus(statusEl, '❌ Error: ' + e.message, 'error');
    }
  });
}

// Load role metrics when solar tab is shown
const solarObserver = new MutationObserver(() => {
  if (document.getElementById('section-solar')?.classList.contains('active') && document.getElementById('role-metrics-container')?.innerHTML === '') {
    loadRoleMetrics();
  }
});
const stgSections = document.getElementById('stg-main');
if (stgSections) solarObserver.observe(stgSections, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
window.addEventListener('beforeunload', () => { solarObserver.disconnect(); if (bmsScanInterval) clearInterval(bmsScanInterval); });

// ======================== METRICS MANAGEMENT ========================
let metricsList = [];
async function loadMetricsList() {
  try {
    const authRes = await fetch('/api/auth/status');
    const auth = await authRes.json();
    if (!auth.authenticated) return; // silently defer — page reloads after login
  } catch (e) { return; }
  try {
    const res = await fetch('/api/metrics/list');
    if (!res.ok) throw new Error('Failed to fetch metrics');
    metricsList = await res.json();
    renderMetricsTable();
  } catch (err) {
    console.error('Error loading metrics:', err);
    const tbody = document.getElementById('metrics-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Failed to load metrics</td></tr>';
  }
}
function renderMetricsTable() {
  const tbody = document.getElementById('metrics-table-body');
  if (!tbody) return;
  if (!metricsList.length) {
    tbody.innerHTML = '<tr><td colspan="5">No metrics yet. Create one using the "New Metric" button.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  metricsList.forEach(metric => {
    const row = document.createElement('tr');
    const lastUpdated = metric.timestamp ? new Date(metric.timestamp * 1000).toLocaleString() : 'Never';
    row.innerHTML = `
      <td>${escapeHtml(metric.name)}</td>
      <td>${metric.value !== null ? metric.value : '-'}</td>
      <td>${lastUpdated}</td>
      <td>${escapeHtml(metric.unit || '-')}</td>
      <td><button class="delete-metric-btn remove-btn" data-name="${escapeHtml(metric.name)}" title="Delete">✕</button></td>
    `;
    tbody.appendChild(row);
  });
  document.querySelectorAll('.delete-metric-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const name = btn.dataset.name;
      if (showConfirm(`Delete metric "${name}"? This will remove it from all mappings and cannot be undone.`)) {
        try {
          const res = await fetch(`/api/metrics/${encodeURIComponent(name)}`, { method: 'DELETE' });
          if (res.ok) {
            showStatus(backupStatus, `Metric "${name}" deleted`, 'success');
            await loadMetricsList();
            await refreshAllMetricDropdowns();
          } else {
            const err = await res.json();
            showStatus(backupStatus, err.error || 'Delete failed', 'error');
          }
        } catch (err) {
          showStatus(backupStatus, err.message, 'error');
        }
      }
    });
  });
}
// Modal handling
const modal = document.getElementById('metric-modal');
const createBtn = document.getElementById('create-metric-btn');
const modalCancel = document.getElementById('modal-cancel');
const modalCreate = document.getElementById('modal-create');
if (createBtn) {
  createBtn.addEventListener('click', () => {
    if (modal) modal.style.display = 'flex';
    const nameInput = document.getElementById('new-metric-name');
    const unitInput = document.getElementById('new-metric-unit');
    if (nameInput) nameInput.value = '';
    if (unitInput) unitInput.value = '';
  });
}
if (modalCancel) modalCancel.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
if (modalCreate) {
  modalCreate.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-metric-name');
    const unitInput = document.getElementById('new-metric-unit');
    const name = nameInput ? nameInput.value.trim() : '';
    const unit = unitInput ? unitInput.value.trim() : '';
    if (!name) { showStatus(backupStatus, 'Metric name is required', 'error'); return; }
    try {
      const res = await fetch('/api/metrics/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ name, unit }) });
      if (res.ok) {
        if (modal) modal.style.display = 'none';
        await loadMetricsList();
        await refreshAllMetricDropdowns();
        showStatus(backupStatus, `Metric "${name}" created`, 'success');
      } else {
        const err = await res.json();
        showStatus(backupStatus, err.error || 'Creation failed', 'error');
      }
    } catch (err) { showStatus(backupStatus, err.message, 'error'); }
  });
}
window.addEventListener('click', (e) => { if (modal && e.target === modal) modal.style.display = 'none'; });

function populateDashboardSelects(config, savedDesktop, savedMobile) {
  const dashboards = config?.dashboards || [];
  const saved = { 'desktop-dashboard': savedDesktop, 'mobile-dashboard': savedMobile };
  ['desktop-dashboard', 'mobile-dashboard'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = saved[id] || '';
    sel.innerHTML = '<option value="">-- Default --</option>';
    dashboards.forEach(db => { const o = document.createElement('option'); o.value = db.id; o.textContent = db.name; if (db.id === cur) o.selected = true; sel.appendChild(o); });
  });
}

// ======================== DASHBOARD EDITOR ========================
let dashConfig = null;
function buildDashboardEditor(config) {
  dashConfig = config || { dashboards: [], activeDashboard: 'main' };
  const listEl = document.getElementById('dashboards-list');
  listEl.innerHTML = '';
  if (!dashConfig.dashboards.length) return;
  const activeId = dashConfig.activeDashboard || dashConfig.dashboards[0]?.id;
  dashConfig.dashboards.forEach(db => {
    const row = document.createElement('div');
    row.className = 'dash-row';
    row.innerHTML = `
      <input type="text" value="${escapeHtml(db.name)}" data-db-id="${db.id}" class="dash-name">
      <button type="button" class="fetch-btn set-active" data-id="${db.id}">${db.id === activeId ? '★ Active' : 'Set Active'}</button>
      <button type="button" class="remove-btn delete-dash" data-id="${db.id}">✕</button>
    `;
    listEl.appendChild(row);
    row.querySelector('.set-active').addEventListener('click', () => {
      dashConfig.activeDashboard = db.id;
      buildDashboardEditor(dashConfig);
    });
    row.querySelector('.delete-dash').addEventListener('click', () => {
      if (!showConfirm(`Delete dashboard "${db.name}"? This cannot be undone.`)) return;
      dashConfig.dashboards = dashConfig.dashboards.filter(d => d.id !== db.id);
      if (dashConfig.activeDashboard === db.id) dashConfig.activeDashboard = dashConfig.dashboards[0]?.id || 'main';
      buildDashboardEditor(dashConfig);
    });
    row.querySelector('.dash-name').addEventListener('change', (e) => { db.name = e.target.value; });
  });
  const activeDb = dashConfig.dashboards.find(db => db.id === activeId);
  if (activeDb) renderBlockInventory(activeDb);
}
function renderBlockInventory(dashboard) {
  const container = document.getElementById('active-dashboard-editor');
  const blocks = dashboard.layout || [];

  // Count blocks by type
  const typeCounts = {};
  const typeIcons = {
    'flow-card': '◉', 'flow-card-2': '◎', 'flow-card-square': '◉', 'flow-card-square-2': '◎',
    'forecast-banner': '☷', 'forecast-sparkline': '☷', 'forecast-info': '☷', 'forecast-pvtoday': '☷',
    'metric-cards': '≡', 'multi-value': '≡',
    'gauge-card': '◔', 'half-gauge': '◔', 'half-gauge-2': '◔', 'bar-gauge': '▬', 'bar-gauge-retro': '▬',
    'chart-power': '📈', 'chart-energy': '📊',
    'grid-card': '⊞', 'battery-block': '⊟',
    'savings-summary': '💰', 'data-table-daily': '📋', 'data-table-monthly': '📋',
    'text-card': '📝', 'iframe-card': '🌐', 'system-info': '⌂'
  };

  blocks.forEach(b => {
    const t = b.type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  const chips = Object.entries(typeCounts).map(([type, count]) => {
    const icon = typeIcons[type] || '●';
    return `<div class="block-preview-chip"><span class="chip-icon">${icon}</span> ${count}× ${type}</div>`;
  }).join('');

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Block Inventory — ${blocks.length} block${blocks.length !== 1 ? 's' : ''}</span>
        <a href="/editor" class="btn btn-sm btn-primary">Open in Editor →</a>
      </div>
      <div class="block-preview-list">${chips || '<div class="empty-state"><p>No blocks yet. Add them in the Editor.</p></div>'}</div>
      <p class="note" style="margin-top:0.5rem;font-size:0.775rem;">
        Block editing has moved to the dedicated <a href="/editor" style="color:var(--accent);font-weight:600;">Editor page</a> for a full drag-and-drop experience with visual previews.
      </p>
    </div>
  `;
}
const addDashboardBtn = document.getElementById('add-dashboard-btn');
if (addDashboardBtn) addDashboardBtn.addEventListener('click', () => {
  const newId = 'db_' + Date.now();
  dashConfig.dashboards.push({ id: newId, name: 'New Tab', layout: [] });
  dashConfig.activeDashboard = newId;
  buildDashboardEditor(dashConfig);
});

// ======================== LAYOUT IMPORT/EXPORT ========================
const exportLayoutBtn = document.getElementById('export-layout-btn');
if (exportLayoutBtn) exportLayoutBtn.addEventListener('click', () => window.location.href = '/api/dashboard-config/export');
const importLayoutBtn = document.getElementById('import-layout-btn');
const importLayoutFile = document.getElementById('import-layout-file');
if (importLayoutBtn && importLayoutFile) {
  importLayoutBtn.addEventListener('click', () => importLayoutFile.click());
  importLayoutFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('layout', file);
    try {
      const res = await fetch('/api/dashboard-config/import?merge=true', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: formData });
      const data = await res.json();
      if (res.ok) {
        showStatus(backupStatus, 'Layout imported successfully! Reloading...', 'success');
        setTimeout(() => location.reload(), 1500);
      } else {
        showStatus(backupStatus, data.error || 'Import failed', 'error');
      }
    } catch (err) {
      showStatus(backupStatus, 'Error: ' + err.message, 'error');
    } finally {
      importLayoutFile.value = '';
    }
  });
}

// ======================== TUYA ========================
let tuyaDeviceCounter = 0;
function buildTuyaDeviceList(devices) {
  const container = document.getElementById('tuya-devices-container');
  if (!container) return;
  container.innerHTML = '';
  tuyaDeviceCounter = 0;
  devices.forEach((dev, idx) => renderTuyaDevice(dev, idx));
  refreshAllMetricDropdowns();
}

function renderTuyaDevice(device, idx) {
  const container = document.getElementById('tuya-devices-container');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  const versionOptions = ['3.1','3.2','3.3','3.4','3.5'];
  const versionOptsHtml = versionOptions.map(v =>
    `<option value="${v}"${(device.version || '3.3') === v ? ' selected' : ''}>v${v}</option>`
  ).join('');
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="tuya_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <span class="toggle-wrap" style="margin:0 1rem;"><label class="toggle-switch"><input type="checkbox" name="tuya_devices[${idx}][enabled]" ${device.enabled !== false ? 'checked' : ''}><span class="slider"></span></label><label>Enabled</label></span>
      <button type="button" class="remove-btn danger" data-action="remove-tuya">✕</button>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <input type="text" name="tuya_devices[${idx}][dev_id]" placeholder="Device ID" value="${escapeHtml(device.dev_id || '')}" readonly style="background:var(--bg-tertiary);cursor:not-allowed;">
      <input type="text" name="tuya_devices[${idx}][address]" placeholder="IP Address" value="${escapeHtml(device.address || '')}">
    </div>
    <div class="form-row">
      <input type="text" name="tuya_devices[${idx}][local_key]" placeholder="Local Key" value="${escapeHtml(device.local_key || '')}">
      <select name="tuya_devices[${idx}][version]" style="width:120px;flex:0 0 auto;">${versionOptsHtml}</select>
    </div>
    <div class="section-divider"><span class="stg-divider-icon">⏱</span> Polling</div>
    <div class="form-row">
      <input type="number" name="tuya_devices[${idx}][poll_interval]" placeholder="Poll Interval (s)" value="${device.poll_interval || 30}" style="width:120px;">
    </div>
    <div class="section-divider"><span class="stg-divider-icon">🔗</span> DP Mappings</div>
    <div class="mappings-section" id="tuya-mappings-${idx}">
      <div class="mappings-filter-bar">
        <input type="text" class="mappings-filter-input" placeholder="🔍 Filter mappings..." data-container="tuya-mappings-list-${idx}">
      </div>
      <div class="mappings-list" id="tuya-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-tuya-dp" data-device="${idx}">
        + Add DP Mapping
      </button>
    </div>
  `;
  container.appendChild(card);

  // Remove button handler
  const removeTuyaBtn = card.querySelector('[data-action="remove-tuya"]');
  if (removeTuyaBtn) removeTuyaBtn.addEventListener('click', () => {
    if (showConfirm('Remove this Tuya device and all its DP mappings?')) {
      card.remove();
      reindexTuya();
      refreshAllMetricDropdowns();
    }
  });

  // Add DP Mapping button — always show input for custom DP, cloud devices have labels pre-populated
  card.querySelector('.add-tuya-dp').addEventListener('click', () => {
    addTuyaDpRow(card, idx, '', '', null);
    refreshAllMetricDropdowns();
  });

  // Render existing DP mappings
  const mappingsList = card.querySelector('.mappings-list');
  if (device.dps && typeof device.dps === 'object') {
    // Check if this is a cloud-fetched device with dpNames
    if (device.dpNames && typeof device.dpNames === 'object') {
      // Cloud-fetched: dpNames is { label: dpNumber }
      card.dataset.cloudFetched = 'true';
      card.dataset.dpNames = JSON.stringify(device.dpNames);
      Object.entries(device.dpNames).forEach(([label, dpNum]) => {
        const metricName = Object.keys(device.dps || {}).find(k => device.dps[k] === String(dpNum)) || '';
        addTuyaDpRow(card, idx, metricName, String(dpNum), label);
      });
    } else {
      // Manual: dps is { metricName: dpNumber }
      Object.entries(device.dps).forEach(([metricName, dpNum]) => {
        addTuyaDpRow(card, idx, metricName, String(dpNum), null);
      });
    }
  }
  if (mappingsList.children.length === 0) {
    addTuyaDpRow(card, idx, '', '', null);
  }

  tuyaDeviceCounter++;
}

function addTuyaDpRow(card, deviceIdx, metricName, dpNumber, dpLabel) {
  const mappingsList = card.querySelector('.mappings-list');
  if (!mappingsList) return;
  const used = getAllUsedMetrics();
  const excludeOthers = Array.from(used).filter(m => m !== metricName);

  const row = document.createElement('div');
  row.className = 'metric-row';

  const hasLabel = dpLabel !== null && dpLabel !== undefined && dpLabel !== '';

  // DP number display — always visible as a span with label text (read-only)
  const dpSpan = document.createElement('span');
  dpSpan.className = 'dp-label';
  dpSpan.dataset.dp = dpNumber;
  if (hasLabel) {
    dpSpan.innerHTML = `<code>DP ${escapeHtml(dpNumber)}</code> — <strong>${escapeHtml(dpLabel)}</strong>`;
  } else {
    dpSpan.innerHTML = `<code>DP ${escapeHtml(dpNumber || '?')}</code>`;
  }
  dpSpan.style.cssText = 'min-width:160px;max-width:280px;display:flex;align-items:center;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  row.appendChild(dpSpan);

  const metricSelect = createMetricDropdown(metricName, excludeOthers);
  row.appendChild(metricSelect);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshAllMetricDropdowns();
  });
  row.appendChild(removeBtn);

  metricSelect.addEventListener('change', () => {
    refreshAllMetricDropdowns();
  });

  mappingsList.appendChild(row);
}

function reindexTuya() {
  const cards = document.querySelectorAll('#tuya-devices-container .device-card');
  tuyaDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    const nameInput = card.querySelector('.device-header input[type="text"]');
    if (nameInput) nameInput.name = `tuya_devices[${i}][name]`;
    const enableCb = card.querySelector('.device-header input[type="checkbox"]');
    if (enableCb) enableCb.name = `tuya_devices[${i}][enabled]`;
    const devIdInput = card.querySelector('input[name$="[dev_id]"]');
    if (devIdInput) devIdInput.name = `tuya_devices[${i}][dev_id]`;
    const addrInput = card.querySelector('input[name$="[address]"]');
    if (addrInput) addrInput.name = `tuya_devices[${i}][address]`;
    const keyInput = card.querySelector('input[name$="[local_key]"]');
    if (keyInput) keyInput.name = `tuya_devices[${i}][local_key]`;
    const verSel = card.querySelector('select[name$="[version]"]');
    if (verSel) verSel.name = `tuya_devices[${i}][version]`;
    const pollInput = card.querySelector('input[name$="[poll_interval]"]');
    if (pollInput) pollInput.name = `tuya_devices[${i}][poll_interval]`;
    const addBtn = card.querySelector('.add-tuya-dp');
    if (addBtn) addBtn.dataset.device = i;
    tuyaDeviceCounter++;
  });
}

async function autoMatchTuyaLanIps() {
  const container = document.getElementById('tuya-devices-container');
  if (!container) return;
  const cards = container.querySelectorAll('.device-card');
  if (!cards.length) return;

  try {
    const res = await fetch('/api/tuya-discover', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.success || !data.devices || !data.devices.length) return;

    let matched = 0;
    cards.forEach(card => {
      const devIdInput = card.querySelector('input[name$="[dev_id]"]');
      const addrInput = card.querySelector('input[name$="[address]"]');
      if (!devIdInput || !addrInput) return;
      const cardDevId = devIdInput.value.trim();
      if (!cardDevId) return;
      // Only fill if address is empty
      if (addrInput.value.trim()) return;
      const match = data.devices.find(d => d.dev_id === cardDevId);
      if (match) {
        addrInput.value = match.ip || '';
        const verSel = card.querySelector('select[name$="[version]"]');
        if (verSel && match.version) {
          for (const opt of verSel.options) {
            if (opt.value === match.version) { opt.selected = true; break; }
          }
        }
        matched++;
      }
    });
    if (matched > 0) {
      const statusEl = document.getElementById('tuya-lan-status');
      if (statusEl) showStatus(statusEl, `${matched} device(s) matched to LAN IPs`, 'success');
    }
  } catch (e) {
    // Silent — LAN scan is best-effort
  }
}

async function populateTuyaDevicesFromCloud(devices) {
  if (!Array.isArray(devices)) return;
  const container = document.getElementById('tuya-devices-container');
  if (!container) return;
  console.log('[populateTuyaDevicesFromCloud] received', devices.length, 'devices');
  // Log first device's mapping for debugging
  if (devices.length > 0) {
    console.log('[populateTuyaDevicesFromCloud] first device:', devices[0].name, 'mapping keys:', Object.keys(devices[0].mapping || {}).length);
  }
  // Collect existing dev_ids
  const existingIds = new Set();
  container.querySelectorAll('.device-card input[name$="[dev_id]"]').forEach(inp => {
    if (inp.value) existingIds.add(inp.value);
  });
  devices.forEach(dev => {
    const devId = dev.id || dev.dev_id || '';
    if (!devId) return;

    // Update existing device: refresh local_key + dpNames from cloud
    if (existingIds.has(devId)) {
      console.log('[populateTuyaDevicesFromCloud] updating existing device:', dev.name || devId, 'mapping keys:', Object.keys(dev.mapping || {}).length);
      const card = Array.from(container.querySelectorAll('.device-card')).find(c => {
        const inp = c.querySelector('input[name$="[dev_id]"]');
        return inp && inp.value.trim() === devId;
      });
      if (card) {
        // Update local_key
        const keyInput = card.querySelector('input[name$="[local_key]"]');
        if (keyInput && dev.key) keyInput.value = dev.key;
        // Update dpNames (rebuild DP rows with labels)
        if (dev.mapping && typeof dev.mapping === 'object') {
          const mappingsList = card.querySelector('.mappings-list');
          const nameInput = card.querySelector('input[name$="[name]"]');
          // Store dpNames on card
          const dpNames = {};
          Object.entries(dev.mapping).forEach(([dpNum, label]) => { dpNames[label] = dpNum; });
          card.dataset.dpNames = JSON.stringify(dpNames);
          card.dataset.cloudFetched = 'true';
          // Rebuild DP rows with cloud labels
          if (mappingsList) {
            // Preserve existing metric→DP mappings
            const existingMappings = {};
            mappingsList.querySelectorAll('.metric-row').forEach(row => {
              const metricSel = row.querySelector('.metric-name');
              const dpSpan = row.querySelector('.dp-label');
              if (metricSel && metricSel.value && dpSpan && dpSpan.dataset.dp) {
                existingMappings[dpSpan.dataset.dp] = metricSel.value;
              }
            });
            mappingsList.innerHTML = '';
            const dpEntries = Object.entries(dev.mapping).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
            console.log('[populateTuyaDevicesFromCloud] rebuilding', dpEntries.length, 'DP rows for', dev.name || devId);
            dpEntries.forEach(([dpNum, label]) => {
              const metricName = existingMappings[dpNum] || '';
              addTuyaDpRow(card, parseInt(card.dataset.index || '0'), metricName, dpNum, label);
            });
          }
        }
        // LAN IPs come from auto-match, not cloud
      }
      return;
    }
    console.log('[populateTuyaDevicesFromCloud] creating new device:', dev.name || devId, 'mapping keys:', Object.keys(dev.mapping || {}).length);
    const config = {
      name: dev.name || dev.product_name || '',
      enabled: true,
      dev_id: devId,
      address: '',   // will be auto-matched from LAN scan
      local_key: dev.key || '',
      version: dev.version || '3.3',
      poll_interval: 30,
      dps: {},
      dpNames: {}
    };
    // Invert cloud mapping: {"19":"Power", "20":"Voltage"} → dpNames{"Power":"19"}, dps{"Power":"19"}
    if (dev.mapping && typeof dev.mapping === 'object') {
      Object.entries(dev.mapping).forEach(([dpNum, label]) => {
        config.dpNames[label] = dpNum;
        config.dps[label] = dpNum;
      });
    }
    renderTuyaDevice(config, tuyaDeviceCounter++);
  });
  refreshAllMetricDropdowns();
  console.log('[populateTuyaDevicesFromCloud] done —', devices.length, 'devices processed');

  // Auto-run LAN scan to match dev_ids to local IPs
  await autoMatchTuyaLanIps();
  const statusEl = document.getElementById('tuya-oauth-status');
  showStatus(statusEl, `Fetched ${devices.length} device(s)`, 'success');
}

// Verify All button — batch-tests all device connections
const tuyaVerifyAllBtn = document.getElementById('tuya-verify-all-btn');
const tuyaVerifyAllStatus = document.getElementById('tuya-verify-all-status');

if (tuyaVerifyAllBtn) {
  tuyaVerifyAllBtn.addEventListener('click', async function() {
    const container = document.getElementById('tuya-devices-container');
    if (!container) return;
    const cards = container.querySelectorAll('.device-card');
    if (cards.length === 0) {
      showStatus(tuyaVerifyAllStatus, 'No devices to verify', 'info');
      return;
    }

    // Collect device configs from cards
    const devices = [];
    cards.forEach(card => {
      const devId = card.querySelector('input[name$="[dev_id]"]')?.value?.trim() || '';
      const address = card.querySelector('input[name$="[address]"]')?.value?.trim() || '';
      const localKey = card.querySelector('input[name$="[local_key]"]')?.value?.trim() || '';
      const version = card.querySelector('select[name$="[version]"]')?.value || '3.3';
      const name = card.querySelector('.device-header input[type="text"]')?.value?.trim() || '';
      devices.push({ name, dev_id: devId, address, local_key: localKey, version });
    });

    showStatus(tuyaVerifyAllStatus, `Verifying ${devices.length} device(s)...`, 'info');
    try {
      const res = await fetch('/api/tuya-verify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ devices })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      const successCount = data.results.filter(r => r.success).length;
      const failCount = data.results.length - successCount;
      if (failCount === 0) {
        showStatus(tuyaVerifyAllStatus, `✅ All ${successCount} device(s) connected`, 'success');
      } else {
        const failures = data.results.filter(r => !r.success).map(r => `${r.name}: ${r.error}`).join(', ');
        showStatus(tuyaVerifyAllStatus, `⚠️ ${successCount}/${data.results.length} connected — failures: ${failures}`, 'warning');
      }
    } catch (e) {
      showStatus(tuyaVerifyAllStatus, e.message, 'error');
    }
  });
}

// QR Code OAuth flow
const tuyaGenerateQrBtn = document.getElementById('tuya-generate-qr-btn');
const tuyaQrContainer = document.getElementById('tuya-qr-container');
const tuyaQrCanvas = document.getElementById('tuya-qr-canvas');
const tuyaOauthStatus = document.getElementById('tuya-oauth-status');
let oauthTokenInfo = null;
let pollTimer = null;

if (tuyaGenerateQrBtn) {
  tuyaGenerateQrBtn.addEventListener('click', async function() {
    const uid = document.getElementById('tuya-uid').value.trim();
    if (!uid) {
      showStatus(tuyaOauthStatus, 'Enter your Smart Life UID first', 'error');
      return;
    }
    showStatus(tuyaOauthStatus, 'Generating QR code...', 'info');
    try {
      const res = await fetch('/api/tuya-generate-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ uid })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Failed');
      
      // Generate QR code on canvas
      const qrUrl = data.qr_url;
      drawQrCode(tuyaQrCanvas, qrUrl);
      tuyaQrContainer.style.display = 'block';
      showStatus(tuyaOauthStatus, 'Scan QR code with Smart Life app...', 'info');
      
      // Start polling
      startLoginPoll(data.qr_token, uid);
    } catch (e) {
      showStatus(tuyaOauthStatus, e.message, 'error');
    }
  });
}

function drawQrCode(canvas, text) {
  // Simple QR code drawing using a data URL from a quick API
  // We'll generate via a URL-based QR API or inline
  const size = 200;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  
  // Generate QR code using Google Charts API (lightweight, no deps)
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, size, size);
  };
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
}

async function startLoginPoll(qrToken, uid) {
  if (pollTimer) clearInterval(pollTimer);
  
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/tuya-poll-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ qr_token: qrToken, uid })
      });
      const data = await res.json();
      
      if (data.status === 'ok') {
        clearInterval(pollTimer);
        pollTimer = null;
        showStatus(tuyaOauthStatus, 'Login successful! Fetching devices...', 'success');
        oauthTokenInfo = data;
        await fetchDevicesWithOAuth(data);
      } else if (data.status === 'expired') {
        clearInterval(pollTimer);
        pollTimer = null;
        showStatus(tuyaOauthStatus, 'QR code expired — generate a new one', 'error');
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        pollTimer = null;
        showStatus(tuyaOauthStatus, data.error || 'Login failed', 'error');
      }
      // 'waiting' — keep polling
    } catch (e) {
      // Silently retry on network errors
    }
  }, 3000);
}

async function fetchDevicesWithOAuth(tokenInfo) {
  try {
    const res = await fetch('/api/tuya-fetch-oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ token_info: tokenInfo })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Device fetch failed');
    if (data.devices && data.devices.length > 0) {
      populateTuyaDevicesFromCloud(data.devices);
      showStatus(tuyaOauthStatus, `Fetched ${data.devices.length} device(s)`, 'success');
    } else {
      showStatus(tuyaOauthStatus, 'No devices found on account', 'info');
    }
  } catch (e) {
    showStatus(tuyaOauthStatus, e.message, 'error');
  }
}

// Add Manual Tuya Device button
const addTuyaBtn = document.getElementById('add-tuya-device');
if (addTuyaBtn) {
  addTuyaBtn.addEventListener('click', () => {
    const idx = tuyaDeviceCounter;
    renderTuyaDevice({ name: '', enabled: true, dev_id: '', address: '', local_key: '', version: '3.3', poll_interval: 30, dps: {} }, idx);
  });
}

// ======================== SAVE ========================
// AC-38 (_catalogV2 migration marker): a card "used catalog mode" when any of
// its mapping rows were produced by the shared catalog component — those rows
// carry data-catalog (CatalogUI.createRow / addMqttDiscoveryRow) or, on the HA
// card, data-ha-expose. Legacy Load-Profile/Fields imports and manual add-row
// flows build rows without those attributes, so their saves stay unmarked.
// The marker is inert: nothing reads _catalogV2 for behavior today.
function cardHasCatalogRows(card) {
  if (!card || !card.querySelector) return false;
  return card.querySelectorAll('.mappings-list .metric-row[data-catalog]').length > 0;
}
if (form) form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {};
  form.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
    if (el.name.startsWith('ha_devices[') || el.name.startsWith('mqtt_devices[') || el.name.startsWith('modbus_devices[') || el.name.startsWith('tuya_devices[') || el.name === 'dashboard_config' || el.name.startsWith('external_sources[') || el.name.startsWith('bms_devices[') || el.name.startsWith('bms_banks[')) return;
    if (el.type === 'checkbox') payload[el.name] = el.checked ? 'true' : 'false';
    else payload[el.name] = el.value;
  });
  payload.ha_devices = collectDeviceArray('ha-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.url = card.querySelector('input[name$="[url]"]').value;
    dev.token = card.querySelector('input[name$="[token]"]').value;
    dev.poll_interval = card.querySelector('input[name$="[poll_interval]"]').value;
    dev.entities = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const metricName = row.querySelector('.metric-name').value; // from dropdown
      const entityId = row.querySelector('.entity-select').value;
      if (metricName && entityId) {
        let actions = [];
        try { actions = row.dataset.actions ? JSON.parse(row.dataset.actions) : []; } catch { actions = []; }
        if (Array.isArray(actions) && actions.length) {
          // Persist configured actions as { entityId, actions } (AC-7.3).
          dev.entities[metricName] = { entityId, actions };
        } else {
          // Backward compat: plain entity_id string when no actions configured.
          dev.entities[metricName] = entityId;
        }
      }
    });
    // AC-38: HA-catalog expose-all rows are deliberately NOT stamped. Expose
    // provenance (data-ha-expose) is in-session only — restored rows render as
    // manual-anatomy rows, so a _catalogV2 stamp could not round-trip
    // reload→save and would break the AC-31.14 byte-identical contract.
    // HA-catalog is not trivially separable; the marker stays register-family
    // + MQTT-cache scoped.
    return dev;
  });
  payload.mqtt_devices = collectDeviceArray('mqtt-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.broker = card.querySelector('input[name$="[broker]"]').value;
    dev.username = card.querySelector('input[name$="[username]"]')?.value || '';
    dev.password = card.querySelector('input[name$="[password]"]')?.value || '';
    dev.topics = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const metricName = row.querySelector('.metric-name').value;
      const topic = row.querySelector('.topic-input').value.trim();
      if (metricName && topic) dev.topics[metricName] = topic;
    });
    // AC-38: MQTT discovery/cache rows are catalog rows — stamp when the card
    // persists any (manual topic rows and pure restores carry no data-catalog).
    if (cardHasCatalogRows(card)) dev._catalogV2 = true;
    return dev;
  });
  payload.modbus_devices = collectDeviceArray('modbus-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.transport = card.querySelector('.modbus-transport-select').value;
    dev.profile = card.querySelector('.modbus-profile-select').value;
    dev.host = card.querySelector('input[name$="[host]"]')?.value || '';
    dev.port = card.querySelector('input[name$="[port]"]')?.value || '';
    dev.serial_path = card.querySelector('input[name$="[serial_path]"]')?.value || '';
    dev.serial_baud = card.querySelector('input[name$="[serial_baud]"]')?.value || '';
    dev.serial_data_bits = card.querySelector('input[name$="[serial_data_bits]"]')?.value || '';
    dev.serial_parity = card.querySelector('select[name$="[serial_parity]"]')?.value || '';
    dev.serial_stop_bits = card.querySelector('input[name$="[serial_stop_bits]"]')?.value || '';
    dev.unit = card.querySelector('input[name$="[unit]"]')?.value || 1;
    dev.poll_interval = card.querySelector('input[name$="[poll_interval]"]')?.value || 30;
    // Collect register mappings: { metricName → address }
    dev.mappings = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const address = row.dataset.address;
      const metricName = row.querySelector('.metric-name').value;
      if (address && metricName) dev.mappings[metricName] = address;
    });
    // AC-38: catalog-mode saves (fetch/+Add/restore rows) carry data-catalog;
    // legacy 'Load Profile Registers' rows never do.
    if (cardHasCatalogRows(card)) dev._catalogV2 = true;
    return dev;
  });
  payload.rs232_devices = collectDeviceArray('rs232-devices-container', (card) => {
    return collectRs232Config(card);
  });
  payload.external_sources = collectDeviceArray('external-sources-container', (card) => {
    const src = {};
    src.name = card.querySelector('.device-header input[type="text"]').value;
    src.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    src.url = card.querySelector('input[name$="[url]"]').value;
    src.mappings = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const jsonPath = row.querySelector('.jsonpath').value.trim();
      const metricName = row.querySelector('.metric-name').value;
      if (jsonPath && metricName) src.mappings[metricName] = jsonPath;
    });
    return src;
  });
  payload.bms_devices = JSON.stringify([
    ...JSON.parse(collectDeviceArray('bms-devices-container', (card) => {
      const dev = {};
      dev.name = card.querySelector('.device-header input[type="text"]').value;
      dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
      dev.address = card.querySelector('input[name$="[address]"]').value;
      dev.transport = 'bluetooth';
      // Collect metric mappings: { bmsKey → metricName }
      dev.mappings = {};
      card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
        const bmsKey = row.dataset.bmsKey;
        const metricName = row.querySelector('.metric-name').value;
        if (bmsKey && metricName) dev.mappings[bmsKey] = metricName;
      });
      return dev;
    })),
    ...JSON.parse(collectDeviceArray('bms-wired-devices-container', (card) => {
      const dev = collectBmsWiredConfig(card);
      dev.transport = 'wired';
      return dev;
    })),
  ]);
  payload.bms_banks = collectDeviceArray('bms-banks-container', (card) => {
    const bank = {};
    bank.name = card.querySelector('.bank-name').value;
    bank.enabled = card.querySelector('.bank-enabled').checked;
    bank.devices = [];
    card.querySelectorAll('.bank-device-cb:checked').forEach(cb => {
      const capInput = cb.closest('.bank-device-row').querySelector('.bank-device-capacity');
      const dev = { name: cb.value };
      const capVal = parseFloat(capInput.value);
      if (!isNaN(capVal) && capVal > 0) dev.capacity_override = capVal;
      bank.devices.push(dev);
    });
    bank.functions = [];
    card.querySelectorAll('.bank-function-row').forEach(row => {
      const output = row.querySelector('.bank-fn-output').value.trim();
      const fn = row.querySelector('.bank-fn-type').value;
      const sources = {};
      row.querySelectorAll('.bank-fn-source').forEach(sel => {
        const dev = sel.dataset.device;
        if (dev && sel.value) sources[dev] = sel.value;
      });
      const weightBy = row.querySelector('.bank-fn-weightby')?.value || undefined;
      if (output && Object.keys(sources).length > 0) {
        bank.functions.push({ output, fn, sources, weight_by: weightBy || undefined });
      }
    });
    return bank;
  });
  payload.dongle_config = collectDeviceArray('dongle-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.profile = card.querySelector('.dongle-profile-select').value;
    const txSel = card.querySelector('select[name$="[transport]"]')?.value || 'solarman-v5';
    dev.transport = txSel;
    dev.host = card.querySelector('input[name$="[host]"]').value;
    dev.port = parseInt(card.querySelector('input[name$="[port]"]').value) || undefined;
    dev.serial_number = card.querySelector('input[name$="[serial_number]"]')?.value || '';
    dev.dongle_serial = card.querySelector('input[name$="[dongle_serial]"]')?.value?.trim() || '';
    dev.inverter_serial = card.querySelector('input[name$="[inverter_serial]"]')?.value?.trim() || '';
    // LuxPower: never persist a stranded shape (serial in serial_number but dongle_serial empty).
    if ((txSel === 'luxpower-tcp') && !dev.dongle_serial && dev.serial_number) {
      dev.dongle_serial = dev.serial_number;
      dev.serial_number = '';
    }
    dev.modbus_unit_id = parseInt(card.querySelector('input[name$="[modbus_unit_id]"]').value) || 1;
    dev.poll_interval = parseInt(card.querySelector('input[name$="[poll_interval]"]').value) || (txSel === 'luxpower-tcp' ? 5 : 30);
    dev.prefix = card.querySelector('input[name$="[prefix]"]')?.value || '';
    // Phase-2 (issue #106) explicit-mapping era marker (AC18): every luxpower-tcp
    // device saved through the current settings UI is user-managed under
    // mapping:'explicit'. Stamp it so the boot-time legacy migration never
    // treats a phase-2 save (brand-new instance, or one whose mappings were all
    // deleted) as a phase-1 legacy instance to auto-migrate.
    if (txSel === 'luxpower-tcp') dev._luxpowerPhase2 = true;
    dev.mappings = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const address = row.dataset.address;
      const metricName = row.querySelector('.metric-name').value;
      if (address && metricName) dev.mappings[metricName] = address;
    });
    // AC-38: catalog-mode saves stamp the inert _catalogV2 marker. LuxPower
    // keeps its existing _luxpowerPhase2 marker ONLY (byte-compat: never add
    // _catalogV2 to luxpower saves); non-LuxPower register families stamp
    // _catalogV2 when any catalog component row is persisted.
    if (txSel !== 'luxpower-tcp' && cardHasCatalogRows(card)) dev._catalogV2 = true;
    return dev;
  });
  payload.tuya_devices = collectDeviceArray('tuya-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.dev_id = card.querySelector('input[name$="[dev_id]"]')?.value || '';
    dev.address = card.querySelector('input[name$="[address]"]')?.value || '';
    dev.local_key = card.querySelector('input[name$="[local_key]"]')?.value || '';
    dev.version = card.querySelector('select[name$="[version]"]')?.value || '3.3';
    dev.poll_interval = parseInt(card.querySelector('input[name$="[poll_interval]"]')?.value) || 30;
    dev.dps = {};
    const metricRows = card.querySelectorAll('.mappings-list .metric-row');
    console.log('[save] device:', dev.name, 'metricRows:', metricRows.length, 'cloudFetched:', card.dataset.cloudFetched);
    metricRows.forEach(row => {
      const metricName = row.querySelector('.metric-name')?.value;
      if (!metricName) return;
      // Read DP number from the dp-label span's data-dp attribute
      const dpSpan = row.querySelector('.dp-label');
      if (dpSpan) {
        const dp = dpSpan.dataset.dp;
        if (dp) dev.dps[metricName] = dp;
      }
    });
    // Preserve dpNames from read-only DP label spans (for cloud-fetched devices round-tripping)
    if (card.dataset.cloudFetched === 'true') {
      dev.dpNames = {};
      card.querySelectorAll('.metric-row').forEach(row => {
        const dpSpan = row.querySelector('.dp-label');
        if (dpSpan) {
          const dp = dpSpan.dataset.dp;
          // Extract label from span text: "DP 19 — Power" → "Power"
          const text = dpSpan.textContent || '';
          const labelMatch = text.match(/—\s*(.+)$/);
          const name = labelMatch ? labelMatch[1].trim() : '';
          if (dp && name) dev.dpNames[name] = dp;
        }
      });
    }
    return dev;
  });
  payload.pvoutput_config = JSON.stringify(collectPvoutputConfig());
  payload.dashboard_config = JSON.stringify(dashConfig);
  payload.dashboard_layouts = JSON.stringify(dashConfig.dashboards || []);
  payload.dashboard_active = dashConfig.activeDashboard || 'main';
  // Collect tuya_cloud credentials
  const tuyaCloud = {
    region: document.getElementById('tuya-cloud-region')?.value || 'eu',
    access_id: document.getElementById('tuya-cloud-access-id')?.value?.trim() || '',
    access_secret: document.getElementById('tuya-cloud-access-secret')?.value?.trim() || '',
    device_id: document.getElementById('tuya-cloud-device-id')?.value?.trim() || ''
  };
  if (tuyaCloud.access_id || tuyaCloud.access_secret || tuyaCloud.device_id) {
    payload.tuya_cloud = JSON.stringify(tuyaCloud);
  }
  // AC-29: an implicit-polling device (stored config has no `mappings` key)
  // that saves with zero mapped rows would flip to explicit-none and stop
  // polling — confirm before persisting that.
  if (!confirmImplicitToExplicitNoneFlips()) {
    showStatus(saveStatus, 'Save cancelled — a device would flip from implicit profile-default polling to explicit-none (polling stops). Map at least one metric for it first.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(payload) });
    if (res.ok) {
      showStatus(saveStatus, 'Settings saved successfully!', 'success');
      // Clear the unsaved changes indicator
      const dirtyCount = document.getElementById('stg-dirty-count');
      if (dirtyCount) { dirtyCount.textContent = ''; dirtyCount.classList.remove('show'); }
      document.dispatchEvent(new CustomEvent('stg-save-complete'));
    }
    else {
      let msg = `Server error (${res.status})`;
      try { const err = await res.json(); msg = err.error || msg; } catch {}
      showStatus(saveStatus, msg, 'error');
    }
  } catch (e) { showStatus(saveStatus, 'Error: ' + e.message, 'error'); }
});

function collectDeviceArray(containerId, extractFn) {
  const container = document.getElementById(containerId);
  if (!container) return '[]';
  const cards = container.querySelectorAll('.device-card');
  const arr = [];
  cards.forEach(card => arr.push(extractFn(card)));
  return JSON.stringify(arr);
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize
loadMetricsList();
loadSettings();
