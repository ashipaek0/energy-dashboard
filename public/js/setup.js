/**
 * Epilykos — First-run Setup Wizard (frontend)
 * Talks to the locked /api/wizard/* + /api/settings + /api/*-source contracts.
 * Classic script; pairs with /js/csrf.js (adds X-Requested-With to non-GET).
 */
(function () {
  'use strict';

  // ── DOM helpers ───────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Reject path segments that could mutate or read the object prototype chain
  // (CWE-1321). Guards apply to BOTH setPath and getPath so the property-chain
  // walk in each is provably safe.
  function isSafeKey(k) {
    return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
  }

  function setPath(obj, path, val) {
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (!isSafeKey(parts[i])) return; // refuse to walk/assign onto polluted keys
    }
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) { cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = val;
  }
  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      if (!isSafeKey(parts[i])) return undefined; // refuse to read dangerous chains
      cur = cur[parts[i]];
    }
    return cur;
  }

  function randomString(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var arr = new Uint32Array(Math.max(len, 1));
    (window.crypto || window.msCrypto).getRandomValues(arr);
    var out = '';
    for (var i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  // ── API helper (returns {ok, status, data}) ──────────────
  function api(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['Accept'] = 'application/json';
    if (opts.method && opts.method !== 'GET') opts.headers['Content-Type'] = 'application/json';
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') > -1 && text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data, text: text };
      }).catch(function () { return { ok: res.ok, status: res.status, data: null }; });
    }).catch(function (err) {
      return { ok: false, status: 0, data: null, error: err };
    });
  }

  function encodeQuery(obj) {
    var p = [];
    for (var k in obj) {
      var v = obj[k];
      if (v !== undefined && v !== null && v !== '') {
        p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    }
    return p.length ? '?' + p.join('&') : '';
  }

  // ── Constants ─────────────────────────────────────────────
  var SOURCE_KEYS = ['ha', 'mqtt', 'dongle', 'rs232', 'modbusSerial', 'modbusTcp', 'bms', 'bmsWired', 'rest'];
  var STEP_LABELS = ['Password', 'Sources', 'Metrics', 'Dashboard', 'Basics', 'Optional', 'Finish'];
  var ROLES = [
    { key: 'solar',              label: 'Solar Power',       unit: 'W' },
    { key: 'consumption',        label: 'Home Consumption',   unit: 'W' },
    { key: 'battery_charge',     label: 'Battery Charge',     unit: 'W' },
    { key: 'battery_discharge',  label: 'Battery Discharge',  unit: 'W' },
    { key: 'grid_import',        label: 'Grid Import',        unit: 'W' },
    { key: 'grid_export',        label: 'Grid Export',        unit: 'W' },
    { key: 'battery_soc',        label: 'Battery SOC',        unit: '%' },
    { key: 'solar_voltage',      label: 'Solar Voltage',      unit: 'V' },
    { key: 'daily_solar',        label: 'Daily Solar',        unit: 'kWh' },
    { key: 'daily_consumption',  label: 'Daily Consumption',  unit: 'kWh' },
    { key: 'daily_battery_charge',    label: 'Daily Battery Charge', unit: 'kWh' },
    { key: 'daily_battery_discharge', label: 'Daily Battery Discharge', unit: 'kWh' },
    { key: 'daily_grid_import',  label: 'Daily Grid Import',  unit: 'kWh' },
    { key: 'daily_grid_export',  label: 'Daily Grid Export',  unit: 'kWh' }
  ];
  var MINIMAL_DASH_TYPES = ['flow-card-2', 'savings-summary', 'metric-cards'];

  // ── State ─────────────────────────────────────────────────
  var state = {
    status: null,
    currentStep: 1,
    isReRun: false,
    authGated: false,       // pristine first-run: password step only
    completed: false,
    busy: false,
    existing: null,
    password: { current: '', newPw: '', confirmPw: '' },
    sources: {
      ha:      { selected: false, name: 'Home Assistant', url: '', token: '', poll_interval: '30', enabled: true, entities: [], profileMetrics: [] },
      mqtt:    { selected: false, name: 'MQTT Broker', broker: '', username: '', password: '', poll_interval: '30', enabled: true, discoveredTopics: [], selectedTopics: {}, topics: {} },
      dongle:  { selected: false, name: 'Inverter (TCP)', profile: '', transport: 'tcp', host: '', port: '', serial_number: '', modbus_unit_id: '', poll_interval: '30', prefix: '', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      rs232:   { selected: false, name: 'Inverter (RS232)', portChoice: '', custom_path: '', profile: '', baud: '', data_bits: '', stop_bits: '', parity: '', modbus_unit_id: '', timeout: '5', poll_interval: '30', enabled: true, ports: [], portsLoaded: false, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      modbusSerial: { selected: false, name: 'Inverter (RS485)', transport: 'serial', profile: '', serial_path: '', serial_baud: '9600', serial_data_bits: '8', serial_parity: 'none', serial_stop_bits: '1', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      modbusTcp:   { selected: false, name: 'Inverter (Modbus-TCP)', transport: 'tcp', profile: '', host: '', port: '502', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      bms:     { selected: false, name: 'BMS (BLE bridge)', address: '', bridge_url: 'http://bms-bridge:8020', poll_interval: '30', enabled: true, mappings: {} },
      bmsWired: { selected: false, name: 'BMS (RS485/RS232)', enabled: true, transport: 'wired', serial_path: '', baud: '9600', data_bits: '8', parity: 'none', stop_bits: '1', modbus_unit_id: '1', profile: '', timeout: '5000', poll_interval: '30', mappings: {} },
      rest:    { selected: false, name: 'REST API', url: '', enabled: true, mappings: {} }
    },
    roleMetrics: {},       // role -> metric name
    dashboard: { choice: 'full', layoutMap: {}, mainBlocks: [], blockCount: 0 },
    basics: { savings_currency: '€', solar_capacity_kwp: '4', dashboard_title: 'My Solar' },
    optional: {
      pvoutput: { enabled: false, api_key: '', system_id: '', timezone: '', upload_interval_minutes: '5', system_size_w: '0', net_mode: false, webhook_url: '', metric_map: {} },
      forecast: { enabled: false, latitude: '', longitude: '', tilt: '30', azimuth: '180', capacity_kwp: '', solcast_api_key: '', solcast_resource_id: '', loss_factor: '0.9', install_date: '' },
      network: { local_url: '', remote_url: '' }
    }
  };

  // ── Theme (client-side only) ──────────────────────────────
  function applyTheme(theme) {
    if (theme !== 'dark') theme = 'light';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); localStorage.setItem('epilykos-theme', theme); } catch (e) {}
    var b = $('#theme-toggle');
    if (b) b.innerHTML = theme === 'dark' ? '☀ Dark' : '☾ Light';
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    if (!saved) { try { saved = localStorage.getItem('epilykos-theme'); } catch (e) {} }
    if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) saved = 'dark';
    applyTheme(saved || 'light');
  }

  // ── Boot ──────────────────────────────────────────────────
  function boot() {
    initTheme();
    api('/api/wizard/status').then(function (res) {
      if (!res.ok || !res.data) { showFatal(); return; }
      state.status = res.data;
      isAuthenticated().then(function (auth) {
        if (state.status.completed) {
          if (!auth) { showAlreadySetup(); return; }
          // Authenticated re-run: skip password, start additive at step 2
          state.authGated = false;
          state.isReRun = true;
          state.currentStep = 2;
          markStepDone(1);
          revealWizard();
          loadExistingConfig().then(function () { gotoStep(state.currentStep); }).catch(function () { gotoStep(state.currentStep); });
          return;
        }
        if (state.status.needsSetup && !auth) {
          state.authGated = true;
          state.isReRun = false;
          state.currentStep = 1;
          revealWizard();
          hideStepperNav();
          renderStep1();
          return;
        }
        state.authGated = false;
        if (!state.status.needsSetup) {
          state.isReRun = true;
          state.currentStep = 2;
          markStepDone(1);
        } else {
          state.currentStep = 1;
        }
        revealWizard();
        loadExistingConfig().then(function () { gotoStep(state.currentStep); }).catch(function () { gotoStep(state.currentStep); });
      });
    }).catch(function () { showFatal(); });
  }

  function loadExistingConfig() {
    return api('/api/settings').then(function (res) {
      if (!res.ok || !res.data) return;
      state.existing = res.data;
      prefillSources(res.data);
      prefillRoleMetrics(res.data);
      prefillDashboard(res.data);
      prefillBasics(res.data);
      prefillOptional(res.data);
    }).catch(function () {});
  }

  function prefillSources(cfg) {
    var bySrc = { ha: cfg.ha_devices, mqtt: cfg.mqtt_devices, dongle: cfg.dongle_config, rs232: cfg.rs232_devices, modbus: cfg.modbus_devices, bms: cfg.bms_devices, rest: cfg.external_sources };
    function asArray(v) { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return []; } } return []; }
    var ha = asArray(bySrc.ha)[0]; if (ha) { Object.assign(state.sources.ha, { selected: true, name: ha.name || 'Home Assistant', url: ha.url || '', token: ha.token || '', poll_interval: String(ha.poll_interval || 30), entities: Object.keys(ha.entities || {}) }); }
    var mq = asArray(bySrc.mqtt)[0]; if (mq) { Object.assign(state.sources.mqtt, { selected: true, name: mq.name || 'MQTT Broker', broker: mq.broker || '', username: mq.username || '', password: mq.password || '', poll_interval: String(mq.poll_interval || 30), selectedTopics: mq.topics || {}, topics: mq.topics || {} }); }
    var dg = asArray(bySrc.dongle)[0]; if (dg) { Object.assign(state.sources.dongle, { selected: true, name: dg.name || 'Inverter (TCP)', profile: dg.profile || '', transport: dg.transport || 'tcp', host: dg.host || '', port: dg.port || '', serial_number: dg.serial_number || '', modbus_unit_id: dg.modbus_unit_id || '', poll_interval: String(dg.poll_interval || 30), prefix: dg.prefix || '', mappings: dg.mappings || {} }); }
    var rs = asArray(bySrc.rs232)[0]; if (rs) {
      Object.assign(state.sources.rs232, { selected: true, name: rs.name || 'Inverter (RS232)', portChoice: rs.serial_path || '', profile: rs.profile || '', baud: rs.baud || '', data_bits: rs.data_bits || '', stop_bits: rs.stop_bits || '', parity: rs.parity || '', modbus_unit_id: rs.modbus_unit_id || '', timeout: String(rs.timeout || 5), mappings: rs.mappings || {} });
    }
    // Modbus: split saved entries by transport into the serial / tcp wizard slots.
    asArray(bySrc.modbus).forEach(function (mb) {
      if (!mb) return;
      if (mb.transport === 'serial') {
        Object.assign(state.sources.modbusSerial, { selected: true, name: mb.name || 'Inverter (RS485)', profile: mb.profile || '', serial_path: mb.serial_path || '', serial_baud: mb.serial_baud || '9600', serial_data_bits: mb.serial_data_bits || '8', serial_parity: mb.serial_parity || 'none', serial_stop_bits: mb.serial_stop_bits || '1', unit: mb.unit || '1', poll_interval: String(mb.poll_interval || 30), mappings: mb.mappings || {} });
      } else {
        Object.assign(state.sources.modbusTcp, { selected: true, name: mb.name || 'Inverter (Modbus-TCP)', profile: mb.profile || '', host: mb.host || '', port: mb.port || '502', unit: mb.unit || '1', poll_interval: String(mb.poll_interval || 30), mappings: mb.mappings || {} });
      }
    });
    var bm = asArray(bySrc.bms)[0]; if (bm) { Object.assign(state.sources.bms, { selected: true, name: bm.name || 'BMS (BLE bridge)', address: bm.address || '', bridge_url: bm.bridge_url || state.sources.bms.bridge_url, poll_interval: String(bm.poll_interval || 30), mappings: bm.mappings || {} }); }
    var bw = (asArray(bySrc.bms) || []).find(function (d) { return d && d.transport === 'wired'; }); if (bw) { Object.assign(state.sources.bmsWired, { selected: true, name: bw.name || 'BMS (RS485/RS232)', serial_path: bw.serial_path || '', baud: String(bw.baud || 9600), data_bits: String(bw.data_bits || 8), parity: bw.parity || 'none', stop_bits: String(bw.stop_bits || 1), modbus_unit_id: String(bw.modbus_unit_id || 1), profile: bw.profile || '', timeout: String(bw.timeout || 5000), poll_interval: String(bw.poll_interval || 30), mappings: bw.mappings || {} }); }
    var rx = asArray(bySrc.rest)[0]; if (rx) { Object.assign(state.sources.rest, { selected: true, name: rx.name || 'REST API', url: rx.url || '', mappings: rx.mappings || {} }); }
    // Re-seed wizard discovery results (HA entities, MQTT selectedTopics,
    // dongle/RS232 mappings) so the metrics step has candidates without
    // re-probing. Stored in the wizard-owned setup_probe_cache key.
    if (cfg.setup_probe_cache) {
      var cache = null;
      if (typeof cfg.setup_probe_cache === 'string') { try { cache = JSON.parse(cfg.setup_probe_cache); } catch (e) { cache = null; } }
      else if (cfg.setup_probe_cache && typeof cfg.setup_probe_cache === 'object') { cache = cfg.setup_probe_cache; }
      if (cache && typeof cache === 'object') {
        if (Array.isArray(cache.ha)) state.sources.ha.entities = cache.ha;
        if (cache.mqtt && typeof cache.mqtt === 'object') state.sources.mqtt.selectedTopics = cache.mqtt;
        if (cache.dongle && typeof cache.dongle === 'object') state.sources.dongle.mappings = cache.dongle;
        if (cache.rs232 && typeof cache.rs232 === 'object') state.sources.rs232.mappings = cache.rs232;
      }
    }
  }
  function prefillRoleMetrics(cfg) {
    var rm = cfg.role_metrics;
    if (!rm) return;
    if (typeof rm === 'string') { try { rm = JSON.parse(rm); } catch (e) { rm = null; } }
    if (rm && typeof rm === 'object') state.roleMetrics = Object.assign({}, rm);
  }
  function prefillDashboard(cfg) {
    state.dashboard.layoutMap = normalizeLayouts(cfg.dashboard_layouts);
    var main = state.dashboard.layoutMap.main || [];
    // Use stored active layout if it's a real layout entry
    if (typeof main === 'object' && main && main.blocks) main = main.blocks;
    state.dashboard.mainBlocks = Array.isArray(main) ? main : [];
    state.dashboard.blockCount = state.dashboard.mainBlocks.length;
  }
  function prefillBasics(cfg) {
    if (cfg.savings_currency != null) state.basics.savings_currency = cfg.savings_currency;
    if (cfg.solar_capacity_kwp != null) state.basics.solar_capacity_kwp = String(cfg.solar_capacity_kwp);
    if (cfg.dashboard_title != null) state.basics.dashboard_title = cfg.dashboard_title;
  }
  function prefillOptional(cfg) {
    // Defensive: this must never throw, even on malformed / partial config.
    if (!cfg || typeof cfg !== 'object') return;
    var present = function (v) { return v !== undefined && v !== null && v !== ''; };

    // PVOutput — cfg.pvoutput_config is a JSON STRING (see settings.js JSON.stringify/JSON.parse).
    if (present(cfg.pvoutput_config)) {
      var pv = null;
      if (typeof cfg.pvoutput_config === 'string') {
        try { pv = JSON.parse(cfg.pvoutput_config); } catch (e) { pv = null; }
      } else {
        pv = cfg.pvoutput_config;
      }
      if (pv && typeof pv === 'object') {
        var pvPatch = {};
        ['enabled', 'api_key', 'system_id', 'timezone', 'upload_interval_minutes', 'system_size_w', 'net_mode', 'webhook_url'].forEach(function (k) {
          if (present(pv[k])) pvPatch[k] = pv[k];
        });
        if (pvPatch.enabled !== undefined) pvPatch.enabled = !!pvPatch.enabled;
        // Issue #117 (D6/AC-11): carry the existing metric_map — including the
        // v1_unit/v3_unit energy-unit selections — through the wizard.
        // saveConfigKeys uses INSERT OR REPLACE for the whole pvoutput_config
        // value, so omitting this key here would silently wipe it.
        pvPatch.metric_map = (pv.metric_map && typeof pv.metric_map === 'object') ? pv.metric_map : {};
        Object.assign(state.optional.pvoutput, pvPatch);
      }
    }

    // Forecast — individual solar_* / solcast_* keys.
    var fg = state.optional.forecast;
    [
      ['forecast_enabled', 'enabled'],
      ['solar_latitude', 'latitude'],
      ['solar_longitude', 'longitude'],
      ['solar_tilt', 'tilt'],
      ['solar_azimuth', 'azimuth'],
      ['solar_capacity_kwp', 'capacity_kwp'],
      ['solcast_api_key', 'solcast_api_key'],
      ['solcast_resource_id', 'solcast_resource_id'],
      ['solar_loss_factor', 'loss_factor'],
      ['solar_install_date', 'install_date']
    ].forEach(function (pair) {
      var v = cfg[pair[0]];
      if (present(v)) fg[pair[1]] = v;
    });
    if (fg.enabled !== undefined) fg.enabled = !!fg.enabled;

    // Network
    var net = state.optional.network;
    if (present(cfg.network_local_url)) net.local_url = cfg.network_local_url;
    if (present(cfg.network_remote_url)) net.remote_url = cfg.network_remote_url;
  }

  function normalizeLayouts(raw) {
    var map = {};
    if (!raw) return map;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return map; } }
    if (Array.isArray(raw)) {
      raw.forEach(function (l) { if (l && (l.id || l.name)) map[l.id || l.name] = l.blocks || l.layout || []; });
    } else if (typeof raw === 'object') {
      for (var k in raw) {
        map[k] = raw[k];
      }
    }
    return map;
  }

  // ── Auth probe ────────────────────────────────────────────
  function isAuthenticated() {
    return api('/api/role-metrics').then(function (res) {
      if (!res.ok) return false;
      return !!res.data && typeof res.data === 'object';
    }).catch(function () { return false; });
  }

  // ── Screen switching ──────────────────────────────────────
  function showScreen(id) {
    ['boot-screen', 'fatal-screen', 'already-setup', 'wizard'].forEach(function (s) {
      var el = $('#' + s);
      if (el) el.hidden = (s !== id);
    });
  }
  function showFatal() { showScreen('fatal-screen'); }
  function showAlreadySetup() { showScreen('already-setup'); }
  function revealWizard() { showScreen('wizard'); }

  function setGlobalError(msg) {
    var el = $('#wizard-global-error');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
  }

  // In auth-gated (pristine first-run) mode the spec shows the Password
  // step only, so the stepper + Back/Next nav are hidden until the
  // password is set (auto-login) and the rest is revealed.
  function hideStepperNav() {
    var s = $('#wizard-steps'); if (s) s.style.display = 'none';
    var n = $('#wizard-nav'); if (n) n.style.display = 'none';
    var g = $('#wizard-global-error'); if (g) g.hidden = true;
  }
  function showStepperNav() {
    var s = $('#wizard-steps'); if (s) s.style.display = '';
    var n = $('#wizard-nav'); if (n) n.style.display = '';
  }

  // ── Stepper ───────────────────────────────────────────────
  function renderStepper() {
    var ol = $('#wizard-steps');
    var html = '';
    for (var i = 1; i <= STEP_LABELS.length; i++) {
      var cls = i === state.currentStep ? 'active' : (i < state.currentStep ? 'done' : '');
      var isLast = i === STEP_LABELS.length;
      html += '<li class="step ' + cls + '">'
        + '<span class="step-dot" title="' + esc(STEP_LABELS[i - 1]) + '">' + i + '</span>'
        + (isLast ? '' : '<span class="step-bar"></span>')
        + '</li>';
    }
    ol.innerHTML = html;
  }
  function markStepDone(step) { renderStepper(); }

  // ── Step navigation ───────────────────────────────────────
  function gotoStep(n) {
    if (n < 1) n = 1;
    if (n > 7) n = 7;
    state.currentStep = n;
    if (n > 1) state.progressAtLeast = n;
    renderStepper();
    $$('.wizard-panel').forEach(function (p) {
      p.classList.toggle('active', parseInt(p.getAttribute('data-step'), 10) === n);
    });
    renderStepBody(n);
    updateNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderStepBody(n) {
    var body = $('#step-' + n + '-body');
    if (!body) return;
    if (n === 1) renderStep1();
    else if (n === 2) renderStep2();
    else if (n === 3) renderStep3();
    else if (n === 4) renderStep4();
    else if (n === 5) renderStep5();
    else if (n === 6) renderStepOptional();
    else if (n === 7) renderStep6();
  }

  // ── VALIDATION ────────────────────────────────────────────
  function validNewPassword() {
    var p = state.password;
    return p.newPw && p.newPw.length >= 4 && p.newPw === p.confirmPw;
  }
  function selectedSourcesCount() {
    return SOURCE_KEYS.filter(function (k) { return state.sources[k].selected; }).length;
  }
  function basicsValid() {
    var b = state.basics;
    var cap = String(b.solar_capacity_kwp).trim();
    return b.savings_currency.trim() !== '' && cap !== '' && !isNaN(Number(cap)) && b.dashboard_title.trim() !== '';
  }
  function canGoNext(step) {
    if (step === 1) return state.status ? (state.status.passwordEnvManaged ? true : validNewPassword()) : false;
    if (step === 2) return selectedSourcesCount() > 0 && Object.keys(sourceValidationErrors()).length === 0;
    if (step === 3) return true;
    if (step === 4) return true;
    if (step === 5) return basicsValid();
    if (step === 6) return true;   // Optional — always skippable / non-blocking
    if (step === 7) return true;   // Finish
    return false;
  }
  function unassignedCount() {
    return ROLES.filter(function (r) { return !((state.roleMetrics[r.key] || '').trim()); }).length;
  }
  function roleCountLabel() {
    var u = unassignedCount();
    if (u === ROLES.length) return 'No metrics mapped yet — leave blank to skip.';
    return u + ' role' + (u === 1 ? '' : 's') + ' unassigned';
  }

  function updateNav() {
    if (state.authGated) return;
    var wiz = $('#wizard');
    var next = $('#next-btn');
    var back = $('#back-btn');
    var firstVisible = state.isReRun ? 2 : 1;
    back.style.display = (state.currentStep > firstVisible) ? '' : 'none';
    if (next) {
      if (!state.busy) next.disabled = !canGoNext(state.currentStep);
      next.textContent = (state.currentStep === 7) ? (state.completed ? 'Done' : 'Finish') : 'Next →';
    }
    var hint = '';
    if (state.currentStep === 2 && selectedSourcesCount() === 0) hint = 'Select at least one source.';
    else if (state.currentStep === 3) hint = roleCountLabel();
    else if (state.currentStep === 6) hint = 'All optional — leave blank to skip.';
    var hintEl = $('#nav-hint');
    if (hintEl) hintEl.textContent = hint;
  }

  // ── STEP 1: PASSWORD ──────────────────────────────────────
  function renderStep1() {
    var body = $('#step-1-body');
    var envManaged = state.status && state.status.passwordEnvManaged;
    state.password.current = '';
    state.password.newPw = '';
    state.password.confirmPw = '';

    var html = '<div class="card">'
      + '<div class="card-header"><span class="card-title">🔑 Admin password</span></div>';

    if (envManaged) {
      // Env-managed: replace the default intro, hide manual password fields,
      // keep the Next/continue control enabled.
      html += '<div class="alert alert-info">Password has been set via environment variable server-side. Click next to continue.</div>';
    } else {
      // Show current password (pre-auth public endpoint)
      html += '<div class="form-group">'
        + '<label>Current password</label>'
        + '<div class="current-pw-row" style="display:flex;gap:0.4rem;">'
        + '<input class="input" readonly type="password" value="' + esc(state.password.current) + '" id="current-pw" placeholder="Loading…">'
        + '<button class="btn btn-sm" type="button" data-action="reveal-pw">Show</button>'
        + '</div>'
        + '<span class="note">Record this — it unlocks Settings and the REST API.</span>'
        + '</div>'
        + '<div class="form-row">'
        + '<div class="form-group"><label>New password</label><input class="input" type="password" id="pw-new" data-field="password.newPw" placeholder="Min 4 characters"><span class="note" id="pw-new-err"></span></div>'
        + '<div class="form-group"><label>Confirm password</label><input class="input" type="password" id="pw-confirm" data-field="password.confirmPw" placeholder="Repeat password"></div>'
        + '</div>'
        + '<div class="test-row">'
        + '<button class="btn btn-sm" type="button" data-action="regenerate">🔄 Regenerate</button>'
        + '<span class="test-badge pending" data-badge-src="pw">Untouched</span>'
        + '</div>'
        + '<p class="note" id="pw-msg" style="font-size:0.78rem;"></p>';
    }

    if (state.authGated) {
      html += '<div class="btn-group" style="margin-top:0.75rem;">'
        + '<button class="btn btn-primary" type="button" data-action="password-submit">' + (envManaged ? 'Continue →' : 'Set password & continue →') + '</button>'
        + '</div>';
    }
    html += '</div>';

    body.innerHTML = html;

    if (!envManaged) {
      loadCurrentPassword();
      var revealBtn = $('[data-action="reveal-pw"]');
      if (revealBtn) revealBtn.addEventListener('click', function () {
        var input = $('#current-pw');
        if (!input) return;
        if (input.type === 'password') { input.type = 'text'; this.textContent = 'Hide'; }
        else { input.type = 'password'; this.textContent = 'Show'; }
      });
    }
  }

  function loadCurrentPassword() {
    api('/api/wizard/password').then(function (res) {
      if (res.ok && res.data && res.data.password != null) {
        state.password.current = res.data.password;
        var input = $('#current-pw');
        if (input) input.value = res.data.password;
      } else if (res.status === 403) {
        var input = $('#current-pw');
        if (input) { input.value = '(hidden)'; input.type = 'password'; }
      }
    }).catch(function () {});
  }

  function submitPassword() {
    var envManaged = state.status && state.status.passwordEnvManaged;
    if (envManaged) {
      // Establish the auto-login session (env-managed first-run) before continuing.
      api('/api/wizard/password', { method: 'POST', body: JSON.stringify({}) }).then(function () { afterPasswordDone(); }).catch(function () { afterPasswordDone(); });
      return;
    }
    var p = state.password;
    if (!validNewPassword()) {
      var err = $('#pw-new-err');
      if (err) err.textContent = (p.newPw.length < 4) ? 'Password must be at least 4 characters.' : 'Passwords do not match.';
      updateNav();
      return;
    }
    setBusy(true);
    api('/api/wizard/password', { method: 'POST', body: JSON.stringify({ password: p.newPw }) }).then(function (res) {
      setBusy(false);
      if (res.ok && res.data && res.data.success) {
        var msg = $('#pw-msg'); if (msg) msg.textContent = '✔ Password saved.';
        afterPasswordDone();
      } else {
        setGlobalError('Could not save the password (' + res.status + '). Please try again.');
      }
    }).catch(function () {
      setBusy(false);
      setGlobalError('Could not reach the server to save the password.');
    });
    return true; // handled
  }

  function afterPasswordDone() {
    state.password.newPw = ''; state.password.confirmPw = '';
    if (state.authGated) {
      state.authGated = false;
      state.isReRun = false;
      state.currentStep = 2;
      setGlobalError(null);
      showStepperNav();
      revealWizard();
      loadExistingConfig().then(function () { gotoStep(2); }).catch(function () { gotoStep(2); });
      return;
    }
    markStepDone(1);
    gotoStep(2);
  }

  // ── STEP 2: SOURCES ───────────────────────────────────────
  function renderStep2() {
    var g = (window.EPILYKOS_LABELS && window.EPILYKOS_LABELS.groups) || {};
    var body = $('#step-2-body');

    function tile(t) {
      var on = state.sources[t.key].selected;
      return '<div class="source-tile' + (on ? ' selected' : '') + '" data-action="toggle-source" data-source="' + t.key + '" role="button" tabindex="0">'
        + '<span class="tile-icon">' + t.icon + '</span>'
        + '<span class="tile-block"><span class="tile-label">' + esc(t.label) + '</span><br><span class="tile-sub">' + esc(t.sub) + '</span></span>'
        + '<span class="tile-check">✓</span>'
        + '</div>';
    }
    function grid(tiles) {
      return '<div class="source-grid">' + tiles.map(tile).join('') + '</div>';
    }
    function section(label, sub, tilesHtml, cardsHtml) {
      return '<div class="setup-section">'
        + '<div class="setup-section-head"><h3>' + esc(label) + '</h3>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>'
        + tilesHtml + cardsHtml
        + '</div>';
    }

    var html = '';

    // 1 · Inverter — Wired
    html += section(g.inverterWired, 'Connect over a direct cable to the inverter.',
      grid([
        { key: 'modbusSerial', icon: '🔌', label: 'RS485 (Modbus-RTU)', sub: 'USB / RS485 adapter' },
        { key: 'rs232', icon: '📟', label: 'RS232 (direct serial)', sub: '9-pin serial' }
      ]),
      sourceCardModbusSerial() + sourceCardRS232());

    // 2 · Inverter — Wireless (TCP/IP)
    html += section(g.inverterWireless, 'Connect over your local network.',
      grid([
        { key: 'modbusTcp', icon: '🌐', label: 'Modbus-TCP', sub: 'Modbus over TCP/IP' }
      ]),
      sourceCardModbusTcp());

    // 3 · Inverter — Dongle
    html += section(g.inverterDongle, 'Built-in logger / WiFi dongle on the inverter.',
      grid([
        { key: 'dongle', icon: '🔌', label: 'Inverter dongle', sub: 'Solarman / Felicity / Growatt' }
      ]),
      sourceCardDongle());

    // 4 · BMS — Bluetooth
    html += section(g.bmsBluetooth, 'Battery BMS over Bluetooth, via the BLE bridge.',
      grid([
        { key: 'bms', icon: '🔋', label: 'BMS (BLE bridge)', sub: 'MAC address + bridge' }
      ]),
      sourceCardBMS());

    // 5 · BMS — Wired (real source)
    html += section(g.bmsWired, 'Read your BMS over a direct wired connection (RS485/RS232, Modbus-RTU).',
      grid([{ key: 'bmsWired', icon: '🔌', label: 'BMS (RS485/RS232)', sub: 'Modbus-RTU over serial' }]),
      sourceCardBmsWired());

    // 6 · Home Assistant
    html += section(g.ha, 'A running Home Assistant instance.',
      grid([{ key: 'ha', icon: '🏠', label: 'Home Assistant', sub: 'Base URL + token' }]),
      sourceCardHA());

    // 7 · MQTT
    html += section(g.mqtt, 'An MQTT broker to subscribe to.',
      grid([{ key: 'mqtt', icon: '📡', label: 'MQTT', sub: 'Broker + optional topic list' }]),
      sourceCardMQTT());

    // 8 · REST API
    html += section(g.rest, 'Pull readings from any JSON endpoint.',
      grid([{ key: 'rest', icon: '🌐', label: 'REST API', sub: 'URL + JSON path' }]),
      sourceCardREST());

    // Tuya is configured in Settings, not the wizard.
    html += '<div class="source-coming"><span class="source-coming-note">Tuya devices are configurable in the Settings page.</span></div>';

    // Footer actions: Next is the single save+advance; Start fresh is the destructive reset (behind confirm).
    html += '<div class="test-row">'
      + '<span class="spacer"></span>'
      + '<button class="btn" type="button" data-action="reset-sources">Start fresh</button>'
      + '</div>'
      + '<div class="alert alert-info" id="reset-sources-note" hidden></div>'
      + '<div class="alert alert-error" id="sources-error" hidden></div>';

    body.innerHTML = html;
    syncSourceCardVisibility();
    updateTestButtons();
    loadSourceCatalog();
  }

  // small helper to get an input value back into state when re-rendered
  function cfg(kind) { return state.sources[kind]; }

  function sourceCardHA() {
    var s = cfg('ha');
    return '<div class="source-config card" data-source="ha">'
      + '<div class="card-header"><span class="card-title">Home Assistant</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.ha.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.ha.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Base URL</label><input class="input" type="url" data-field="sources.ha.url" placeholder="http://192.168.1.20:8123" value="' + esc(s.url) + '"></div>'
      + '<div class="form-group"><label>Long-lived access token</label><input class="input" type="password" data-field="sources.ha.token" placeholder="Paste your HA long-lived token" value="' + esc(s.token) + '"></div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="ha" data-test="ha">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="ha">Not tested</span>'
      + '</div>'
      + '<div id="ha-entities"></div>'
      + '<input type="hidden" id="ha-entity-count" value="' + s.entities.length + '">'
      + '<div data-error="ha"></div>'
      + '</div>';
  }
  function sourceCardMQTT() {
    var s = cfg('mqtt');
    return '<div class="source-config card" data-source="mqtt">'
      + '<div class="card-header"><span class="card-title">MQTT</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.mqtt.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.mqtt.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Broker URL</label><input class="input" data-field="sources.mqtt.broker" placeholder="mqtt://192.168.1.20:1883" value="' + esc(s.broker) + '"></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Username <span class="note">(optional)</span></label><input class="input" data-field="sources.mqtt.username" value="' + esc(s.username) + '"></div>'
      + '<div class="form-group"><label>Password <span class="note">(optional)</span></label><input class="input" type="password" data-field="sources.mqtt.password" value="' + esc(s.password) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="mqtt" data-test="mqtt">Test connection</button>'
      + '<button class="btn btn-sm" type="button" data-action="browse-topics">Browse topics</button>'
      + '<span class="test-badge pending" data-badge-src="mqtt">Not tested</span>'
      + '</div>'
      + '<div id="mqtt-topics"></div>'
      + '<div data-error="mqtt"></div>'
      + '</div>';
  }
  function sourceCardDongle() {
    var s = cfg('dongle');
    var serialVisible = s.profile && (s.profileRequiresSerial || s.serialVisible) ? '' : ' style="display:none;"';
    return '<div class="source-config card" data-source="dongle">'
      + '<div class="card-header"><span class="card-title">Inverter (TCP / dongle)</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.dongle.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Profile</label><select class="select-input" data-field="sources.dongle.profile" id="dongle-profile"><option value="">Loading…</option></select></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Host</label><input class="input" data-field="sources.dongle.host" placeholder="192.168.1.50" value="' + esc(s.host) + '"></div>'
      + '<div class="form-group"><label>Port</label><input class="input" type="number" data-field="sources.dongle.port" value="' + esc(s.port) + '"></div>'
      + '</div>'
      + '<div class="form-group" id="dongle-serial-group"' + serialVisible + '><label>Serial number</label><input class="input" data-field="sources.dongle.serial_number" value="' + esc(s.serial_number) + '"></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Modbus unit id</label><input class="input" type="number" data-field="sources.dongle.modbus_unit_id" value="' + esc(s.modbus_unit_id) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.dongle.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Topic prefix <span class="note">(optional)</span></label><input class="input" data-field="sources.dongle.prefix" value="' + esc(s.prefix) + '"></div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="dongle" data-test="dongle">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="dongle">Not tested</span>'
      + '</div>'
      + '<div data-error="dongle"></div>'
      + '</div>';
  }
  function sourceCardRS232() {
    var s = cfg('rs232');
    var customVisible = s.portChoice === '__custom' ? '' : ' style="display:none;"';
    return '<div class="source-config card" data-source="rs232">'
      + '<div class="card-header"><span class="card-title">Inverter (RS232 / serial)</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.rs232.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Profile</label><select class="select-input" data-field="sources.rs232.profile" id="rs232-profile"><option value="">Loading…</option></select></div>'
      + '</div>'
      + '<div class="form-group"><label>Serial port</label><select class="select-input" data-field="sources.rs232.portChoice" id="rs232-port"><option value="">Loading…</option></select></div>'
      + '<div class="form-group" id="rs232-custom-group"' + customVisible + '><label>Custom serial path</label><input class="input" data-field="sources.rs232.custom_path" placeholder="/dev/ttyUSB0" value="' + esc(s.custom_path) + '"></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Baud rate</label><input class="input" type="number" data-field="sources.rs232.baud" value="' + esc(s.baud) + '"></div>'
      + '<div class="form-group"><label>Modbus unit id</label><input class="input" type="number" data-field="sources.rs232.modbus_unit_id" value="' + esc(s.modbus_unit_id) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Data bits</label><input class="input" type="number" data-field="sources.rs232.data_bits" value="' + esc(s.data_bits) + '"></div>'
      + '<div class="form-group"><label>Stop bits</label><input class="input" type="number" data-field="sources.rs232.stop_bits" value="' + esc(s.stop_bits) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Parity</label><input class="input" data-field="sources.rs232.parity" value="' + esc(s.parity) + '"></div>'
      + '<div class="form-group"><label>Timeout (s)</label><input class="input" type="number" data-field="sources.rs232.timeout" value="' + esc(s.timeout) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="rs232" data-test="rs232">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="rs232">Not tested</span>'
      + '</div>'
      + '<div data-error="rs232"></div>'
      + '</div>';
  }

  function modbusParityOptions(sel) {
    var opts = [['none', 'None'], ['even', 'Even'], ['odd', 'Odd']];
    return opts.map(function (o) { return '<option value="' + o[0] + '"' + (sel === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
  }
  function modbusVersionOptions(sel) {
    var opts = ['3.1', '3.2', '3.3', '3.4', '3.5'];
    return opts.map(function (v) { return '<option value="' + v + '"' + ((sel || '3.3') === v ? ' selected' : '') + '>v' + v + '</option>'; }).join('');
  }
  function modbusProfileSelect(id, kind) {
    var s = cfg(kind);
    return '<select class="select-input" data-field="sources.' + kind + '.profile" id="' + id + '"><option value="">Loading…</option></select>';
  }

  function sourceCardModbusSerial() {
    var s = cfg('modbusSerial');
    return '<div class="source-config card" data-source="modbusSerial">'
      + '<div class="card-header"><span class="card-title">RS485 (Modbus-RTU)</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.modbusSerial.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Profile</label>' + modbusProfileSelect('modbus-serial-profile', 'modbusSerial') + '</div>'
      + '</div>'
      + '<div class="form-group"><label>Serial path</label><input class="input" data-field="sources.modbusSerial.serial_path" placeholder="/dev/ttyUSB0" value="' + esc(s.serial_path) + '"></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Baud rate</label><input class="input" type="number" data-field="sources.modbusSerial.serial_baud" value="' + esc(s.serial_baud) + '"></div>'
      + '<div class="form-group"><label>Data bits</label><input class="input" type="number" data-field="sources.modbusSerial.serial_data_bits" value="' + esc(s.serial_data_bits) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Parity</label><select class="select-input" data-field="sources.modbusSerial.serial_parity">' + modbusParityOptions(s.serial_parity) + '</select></div>'
      + '<div class="form-group"><label>Stop bits</label><input class="input" type="number" data-field="sources.modbusSerial.serial_stop_bits" value="' + esc(s.serial_stop_bits) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Unit id</label><input class="input" type="number" data-field="sources.modbusSerial.unit" value="' + esc(s.unit) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.modbusSerial.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="modbusSerial" data-test="modbus">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="modbusSerial">Not tested</span>'
      + '</div>'
      + '<div data-error="modbusSerial"></div>'
      + '</div>';
  }
  function sourceCardModbusTcp() {
    var s = cfg('modbusTcp');
    return '<div class="source-config card" data-source="modbusTcp">'
      + '<div class="card-header"><span class="card-title">Modbus-TCP</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.modbusTcp.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Profile</label>' + modbusProfileSelect('modbus-tcp-profile', 'modbusTcp') + '</div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Host</label><input class="input" data-field="sources.modbusTcp.host" placeholder="192.168.1.50" value="' + esc(s.host) + '"></div>'
      + '<div class="form-group"><label>Port</label><input class="input" type="number" data-field="sources.modbusTcp.port" placeholder="502" value="' + esc(s.port) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Unit id</label><input class="input" type="number" data-field="sources.modbusTcp.unit" value="' + esc(s.unit) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.modbusTcp.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="modbusTcp" data-test="modbus">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="modbusTcp">Not tested</span>'
      + '</div>'
      + '<div data-error="modbusTcp"></div>'
      + '</div>';
  }
  function sourceCardBMS() {
    var s = cfg('bms');
    return '<div class="source-config card" data-source="bms">'
      + '<div class="card-header"><span class="card-title">BMS (BLE bridge)</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.bms.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.bms.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>MAC address</label><input class="input" data-field="sources.bms.address" placeholder="AA:BB:CC:DD:EE:FF" value="' + esc(s.address) + '"></div>'
      + '<div class="form-group"><label>BMS bridge URL</label><input class="input" data-field="sources.bms.bridge_url" value="' + esc(s.bridge_url) + '">'
      + '<span class="note">The BLE bridge container. Only change this if the bridge runs on another host.</span></div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="bms" data-test="bms">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="bms">Not tested</span>'
      + '</div>'
      + '<div data-error="bms"></div>'
      + '</div>';
  }
  function sourceCardBmsWired() {
    var s = cfg('bmsWired');
    return '<div class="source-config card" data-source="bmsWired">'
      + '<div class="card-header"><span class="card-title">BMS (RS485/RS232)</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.bmsWired.name" value="' + esc(s.name) + '"></div>'
      + '<div class="form-group"><label>Poll interval (s)</label><input class="input" type="number" data-field="sources.bmsWired.poll_interval" value="' + esc(s.poll_interval) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Serial port</label><select class="input" data-field="sources.bmsWired.serial_path" id="bms-wired-port"><option value="">Loading…</option></select></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Baud rate</label><input class="input" type="number" data-field="sources.bmsWired.baud" value="' + esc(s.baud) + '"></div>'
      + '<div class="form-group"><label>Modbus unit id</label><input class="input" type="number" data-field="sources.bmsWired.modbus_unit_id" value="' + esc(s.modbus_unit_id) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Data bits</label><select class="select-input" data-field="sources.bmsWired.data_bits">' + [[8,'8'],[7,'7'],[6,'6'],[5,'5']].map(function (x) { return '<option value="' + x[1] + '"' + (String(s.data_bits) === String(x[1]) ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
      + '<div class="form-group"><label>Parity</label><select class="select-input" data-field="sources.bmsWired.parity">' + [['none','None'],['even','Even'],['odd','Odd']].map(function (x) { return '<option value="' + x[0] + '"' + (String(s.parity) === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Stop bits</label><select class="select-input" data-field="sources.bmsWired.stop_bits">' + [['1','1'],['2','2']].map(function (x) { return '<option value="' + x[1] + '"' + (String(s.stop_bits) === String(x[1]) ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
      + '<div class="form-group"><label>Timeout (ms)</label><input class="input" type="number" data-field="sources.bmsWired.timeout" value="' + esc(s.timeout) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Profile</label><select class="input" data-field="sources.bmsWired.profile" id="bms-wired-profile"><option value="">Loading…</option></select></div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="bmsWired" data-test="bmsWired">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="bmsWired">Not tested</span>'
      + '</div>'
      + '<div data-error="bmsWired"></div>'
      + '</div>';
  }
  function sourceCardREST() {
    var s = cfg('rest');
    return '<div class="source-config card" data-source="rest">'
      + '<div class="card-header"><span class="card-title">REST API</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Name</label><input class="input" data-field="sources.rest.name" value="' + esc(s.name) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Endpoint URL</label><input class="input" data-field="sources.rest.url" placeholder="https://api.example.com/v1/data?key=..." value="' + esc(s.url) + '"></div>'
      + '<div class="form-group"><label>Test JSON path</label><input class="input" id="rest-test-jsonpath" placeholder="e.g. current.temp_c">'
      + '<span class="note">Optional — test the URL above with a JSON path. Metric mappings are configured in Settings after setup.</span></div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="rest" data-test="rest">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="rest">Not tested</span>'
      + '</div>'
      + '<div data-error="rest"></div>'
      + '</div>';
  }
  function syncSourceCardVisibility() {
    $$('.source-config').forEach(function (card) {
      var key = card.getAttribute('data-source');
      card.classList.toggle('visible', !!state.sources[key].selected);
      if (!state.sources[key].selected) { clearBadge(key); clearError(key); }
    });
  }

  // load dongle profiles + rs232 ports/profiles once
  function loadSourceCatalog() {
    if (state.sources.dongle.selected && !state.sources.dongle.profilesLoaded) loadDongleProfiles();
    if (state.sources.rs232.selected && !state.sources.rs232.profilesLoaded) loadRs232Ports();
    if (state.sources.rs232.selected && !state.sources.rs232.profilesLoaded) loadRs232Profiles();
    if (state.sources.modbusSerial.selected && !state.sources.modbusSerial.profilesLoaded) loadModbusProfiles('modbusSerial', 'modbus-serial-profile');
    if (state.sources.modbusTcp.selected && !state.sources.modbusTcp.profilesLoaded) loadModbusProfiles('modbusTcp', 'modbus-tcp-profile');
    if (state.sources.bmsWired.selected) { loadBmsWiredPorts(); loadBmsWiredProfiles(); }
  }

  function loadModbusProfiles(kind, selId) {
    state.sources[kind].profilesLoaded = true;
    api('/api/modbus/profiles').then(function (res) {
      var sel = docById(selId);
      if (!res.ok || !Array.isArray(res.data)) {
        if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      state.sources[kind].profiles = res.data;
      if (!sel) return;
      var html = '<option value="">Select a profile…</option>';
      res.data.forEach(function (p) {
        var v = p.id;
        html += '<option value="' + esc(v) + '"' + (state.sources[kind].profile === v ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      });
      sel.innerHTML = html;
    }).catch(function () {
      var sel = docById(selId);
      if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }
  function docById(id) { return document.getElementById(id); }

  function loadDongleProfiles() {
    state.sources.dongle.profilesLoaded = true;
    api('/api/dongle/profiles').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#dongle-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      state.sources.dongle.profiles = res.data;
      var sel = $('#dongle-profile');
      if (sel) {
        var html = '<option value="">Select a profile…</option>';
        res.data.forEach(function (p) {
          var v = p.name;
          html += '<option value="' + esc(v) + '"' + (state.sources.dongle.profile === v ? ' selected' : '') + '>' + esc(v) + '</option>';
        });
        sel.innerHTML = html;
        if (state.sources.dongle.profile) onDongleProfileChange(state.sources.dongle.profile);
      }
    }).catch(function () {
      var sel = $('#dongle-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }

  function loadRs232Ports() {
    state.sources.rs232.portsLoaded = true;
    api('/api/rs232/ports').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#rs232-port'); if (sel) sel.innerHTML = '<option value=""></option><option value="__custom">No ports — use a custom path…</option>';
        return;
      }
      state.sources.rs232.ports = res.data;
      var sel = $('#rs232-port');
      if (sel) {
        var html = '<option value="">Select a port…</option>';
        res.data.forEach(function (p) {
          var v = p.path;
          var label = p.friendlyName ? (p.friendlyName + ' (' + p.path + ')') : p.path;
          html += '<option value="' + esc(v) + '"' + (state.sources.rs232.portChoice === v ? ' selected' : '') + '>' + esc(label) + '</option>';
        });
        html += '<option value="__custom"' + (state.sources.rs232.portChoice === '__custom' ? ' selected' : '') + '>Custom path…</option>';
        sel.innerHTML = html;
        syncCustomGroup();
      }
    }).catch(function () {
      var sel = $('#rs232-port'); if (sel) sel.innerHTML = '<option value=""></option><option value="__custom">No ports — use a custom path…</option>';
    });
  }

  function loadRs232Profiles() {
    state.sources.rs232.profilesLoaded = true;
    api('/api/rs232/profiles').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#rs232-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      state.sources.rs232.profiles = res.data;
      var sel = $('#rs232-profile');
      if (sel) {
        var html = '<option value="">Select a profile…</option>';
        res.data.forEach(function (p) {
          var hay = String(p.name || '') + ' ' + String(p.id || '');
          if (hay.toLowerCase().indexOf('bms') !== -1) return;
          var v = p.name;
          html += '<option value="' + esc(v) + '"' + (state.sources.rs232.profile === v ? ' selected' : '') + '>' + esc(v) + '</option>';
        });
        sel.innerHTML = html;
        if (state.sources.rs232.profile) onRs232ProfileChange(state.sources.rs232.profile);
      }
    }).catch(function () {
      var sel = $('#rs232-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }

  function loadBmsWiredPorts() {
    api('/api/rs232/ports').then(function (res) {
      var sel = $('#bms-wired-port');
      if (!sel) return;
      if (!res.ok || !Array.isArray(res.data)) {
        sel.innerHTML = '<option value="">Ports unavailable</option>';
        return;
      }
      var html = '<option value="">-- Select port --</option>';
      res.data.forEach(function (p) {
        var v = p.path;
        var label = p.friendlyName ? (p.friendlyName + ' (' + p.path + ')') : p.path;
        html += '<option value="' + esc(v) + '"' + (state.sources.bmsWired.serial_path === v ? ' selected' : '') + '>' + esc(label) + '</option>';
      });
      sel.innerHTML = html;
    }).catch(function () {
      var sel = $('#bms-wired-port');
      if (sel) sel.innerHTML = '<option value="">Ports unavailable</option>';
    });
  }

  function loadBmsWiredProfiles() {
    api('/api/rs232/profiles').then(function (res) {
      var sel = $('#bms-wired-profile');
      if (!sel) return;
      if (!res.ok || !Array.isArray(res.data)) {
        sel.innerHTML = '<option value="">Profiles unavailable</option>';
        return;
      }
      var html = '<option value="">Select a profile…</option>';
      var found = false;
      res.data.forEach(function (p) {
        var id = p.id !== undefined && p.id !== null ? p.id : p.name;
        var name = p.name || id;
        var hay = String(name).toLowerCase() + ' ' + String(id).toLowerCase();
        if (hay.indexOf('bms') === -1) return;
        found = true;
        html += '<option value="' + esc(id) + '"' + (state.sources.bmsWired.profile === id ? ' selected' : '') + '>' + esc(name) + '</option>';
      });
      if (!found) html = '<option value="">No BMS profiles found</option>';
      sel.innerHTML = html;
    }).catch(function () {
      var sel = $('#bms-wired-profile');
      if (sel) sel.innerHTML = '<option value="">Profiles unavailable</option>';
    });
  }

  function syncCustomGroup() {
    var g = $('#rs232-custom-group');
    if (g) g.style.display = (state.sources.rs232.portChoice === '__custom') ? '' : 'none';
  }

  function onDongleProfileChange(id) {
    var d = state.sources.dongle;
    var prof = (d.profiles || []).filter(function (p) { return p.name === id; })[0];
    if (prof) {
      if (prof.transport) setFieldValue('sources.dongle.transport', prof.transport);
      if (prof.default_port != null) setFieldValue('sources.dongle.port', prof.default_port);
      if (prof.default_unit_id != null) setFieldValue('sources.dongle.modbus_unit_id', prof.default_unit_id);
      d.profileRequiresSerial = !!prof.requires_serial;
      var g = $('#dongle-serial-group');
      if (g) g.style.display = d.profileRequiresSerial ? '' : 'none';
      if (state.sources.dongle.profileMetricsLoadedFor !== id) ensureDongleProfileDetail(id);
    }
  }

  function onRs232ProfileChange(id) {
    var r = state.sources.rs232;
    var prof = (r.profiles || []).filter(function (p) { return p.name === id; })[0];
    if (prof) {
      var defaults = prof.defaults || {};
      if (defaults.baud != null) setFieldValue('sources.rs232.baud', defaults.baud);
      if (defaults.dataBits != null) setFieldValue('sources.rs232.data_bits', defaults.dataBits);
      if (defaults.stopBits != null) setFieldValue('sources.rs232.stop_bits', defaults.stopBits);
      if (defaults.parity != null) setFieldValue('sources.rs232.parity', defaults.parity);
      if (prof.default_unit_id != null) setFieldValue('sources.rs232.modbus_unit_id', prof.default_unit_id);
      if (state.sources.rs232.profileMetricsLoadedFor !== id) ensureRs232ProfileDetail(id);
    }
  }

  function setFieldValue(path, value) {
    setPath(state, path, value);
    var el = document.querySelector('[data-field="' + path + '"]');
    if (el && String(el.value) !== String(value)) { el.value = value; }
  }

  function ensureDongleProfileDetail(id) {
    api('/api/dongle/profile/' + encodeURIComponent(id)).then(function (res) {
      if (res.ok && res.data) {
        state.sources.dongle.profileMetrics = res.data.metrics || [];
        state.sources.dongle.profileMetricsLoadedFor = id;
        if (state.currentStep === 3) renderStep3(); // refresh auto-fill
      }
    }).catch(function () {});
  }
  function ensureRs232ProfileDetail(id) {
    api('/api/rs232/profile/' + encodeURIComponent(id)).then(function (res) {
      if (res.ok && res.data) {
        state.sources.rs232.profileMetrics = res.data.metrics || [];
        state.sources.rs232.profileMetricsLoadedFor = id;
        if (state.currentStep === 3) renderStep3();
      }
    }).catch(function () {});
  }

  // ── Connection tests ──────────────────────────────────────
  function setBadge(key, cls, text) {
    var el = document.querySelector('[data-badge-src="' + key + '"]');
    if (el) el.className = 'test-badge ' + cls;
    if (el) el.textContent = text;
  }
  function clearBadge(key) { setBadge(key, 'pending', 'Not tested'); }
  function setError(key, msg) {
    var el = document.querySelector('[data-error="' + key + '"]');
    if (el) { el.className = 'alert alert-error'; el.textContent = msg; }
  }
  function clearError(key) {
    var el = document.querySelector('[data-error="' + key + '"]');
    if (el) { el.className = 'alert alert-error'; el.innerHTML = ''; }
  }

  function hasMinimal(kind) {
    var s = state.sources[kind];
    if (kind === 'ha') return !!(s.url && s.token);
    if (kind === 'mqtt') return !!s.broker;
    if (kind === 'dongle') return !!(s.host && s.port && s.profile);
    if (kind === 'rs232') return !!(resolveSerialPath(s) && s.profile);
    if (kind === 'modbusSerial') return !!(s.serial_path && s.transport === 'serial');
    if (kind === 'modbusTcp') return !!(s.host && s.port && s.transport === 'tcp');
    if (kind === 'bms') return !!s.address;
    if (kind === 'bmsWired') return !!(s.serial_path && s.profile && s.modbus_unit_id);
    if (kind === 'rest') return !!s.url;
    return false;
  }
  function resolveSerialPath(s) {
    s = s || state.sources.rs232;
    return (s.portChoice === '__custom') ? (s.custom_path || '') : (s.portChoice || '');
  }

  function updateTestButtons() {
    $$('[data-action="test"]').forEach(function (btn) {
      var src = btn.getAttribute('data-source');
      // Optional-step test buttons (pvoutput/forecast/network) are always enabled.
      if (!state.sources[src]) { btn.disabled = false; return; }
      btn.disabled = !state.sources[src].selected || !hasMinimal(src);
    });
    var browse = $('[data-action="browse-topics"]');
    if (browse) browse.disabled = !state.sources.mqtt.selected || !hasMinimal('mqtt');
  }

  function runTest(kind) {
    var s = state.sources[kind];
    setBadge(kind, 'pending', 'Testing…');
    clearError(kind);
    var p;
    if (kind === 'ha') {
      p = api('/api/ha-device-entities' + encodeQuery({ url: s.url, token: s.token }));
    } else if (kind === 'mqtt') {
      p = api('/api/test-mqtt' + encodeQuery({ broker: s.broker, username: s.username, password: s.password }));
    } else if (kind === 'dongle') {
      var body = dongleTestBody();
      p = api('/api/dongle/test', { method: 'POST', body: JSON.stringify(body) });
    } else if (kind === 'rs232') {
      p = api('/api/test-rs232', { method: 'POST', body: JSON.stringify(buildRS232Device()) });
    } else if (kind === 'modbusSerial' || kind === 'modbusTcp') {
      var mb = modbusTestBody(kind);
      p = api('/api/test-modbus', { method: 'POST', body: JSON.stringify(mb) });
    } else if (kind === 'bms') {
      p = api('/api/bms/test' + encodeQuery({ address: s.address }));
    } else if (kind === 'bmsWired') {
      p = api('/api/bms-wired/test', { method: 'POST', body: JSON.stringify({ serial_path: s.serial_path, baud: s.baud, data_bits: s.data_bits, parity: s.parity, stop_bits: s.stop_bits, modbus_unit_id: s.modbus_unit_id, profile: s.profile, timeout: s.timeout }) });
    } else if (kind === 'rest') {
      var jpEl = document.getElementById('rest-test-jsonpath');
      var jsonPath = jpEl ? jpEl.value : '';
      p = api('/api/test-external', { method: 'POST', body: JSON.stringify({ url: s.url, jsonPath: jsonPath }) });
    } else if (kind === 'pvoutput') {
      var pvo = state.optional.pvoutput;
      p = api('/api/pvoutput/test', { method: 'POST', body: JSON.stringify({ api_key: pvo.api_key, system_id: pvo.system_id }) });
    } else if (kind === 'forecast') {
      var fo = state.optional.forecast;
      p = api('/api/test-forecast' + encodeQuery({ lat: fo.latitude, lon: fo.longitude, capacity: fo.capacity_kwp, api_key: fo.solcast_api_key, resource_id: fo.solcast_resource_id, tilt: fo.tilt, azimuth: fo.azimuth, loss: fo.loss_factor }));
    } else if (kind === 'network') {
      p = testNetworkUrls();
    }
    if (!p) return;
    p.then(function (res) {
      if (kind === 'ha') {
        if (res.ok && Array.isArray(res.data)) {
          state.sources.ha.entities = res.data;
          setBadge('ha', 'ok', '✔ ' + res.data.length + ' entities');
          renderHAEntities(res.data);
        } else {
          var msg = apiErrMsg(res, 'HA');
          setBadge('ha', 'fail', '✖ Failed');
          setError('ha', msg);
        }
      } else if (kind === 'mqtt') {
        if (res.ok && res.data && res.data.success !== false) {
          setBadge('mqtt', 'ok', '✔ Connected');
        } else {
          setBadge('mqtt', 'fail', '✖ Failed');
          setError('mqtt', apiErrMsg(res, 'MQTT'));
        }
      } else if (kind === 'dongle') {
        if (res.ok && res.data && res.data.success) {
          setBadge('dongle', 'ok', '✔ Connected');
        } else {
          setBadge('dongle', 'fail', '✖ Failed');
          setError('dongle', apiErrMsg(res, 'Inverter'));
        }
      } else if (kind === 'rs232') {
        if (res.ok && res.data && res.data.success) {
          setBadge('rs232', 'ok', '✔ Connected');
        } else {
          setBadge('rs232', 'fail', '✖ Failed');
          setError('rs232', apiErrMsg(res, 'RS232'));
        }
      } else if (kind === 'modbusSerial' || kind === 'modbusTcp') {
        if (res.ok && res.data && res.data.success !== false) {
          setBadge(kind, 'ok', '✔ Connected');
        } else {
          setBadge(kind, 'fail', '✖ Failed');
          setError(kind, apiErrMsg(res, 'Modbus'));
        }
      } else if (kind === 'bms') {
        if (res.ok && res.data && (res.data.success || res.data.metrics || Object.keys(res.data || {}).length)) {
          setBadge('bms', 'ok', '✔ Connected');
        } else if (res.ok && res.data && res.data.success === false) {
          setBadge('bms', 'fail', '✖ Failed');
          setError('bms', apiErrMsg(res, 'BMS'));
        } else {
          setBadge('bms', 'ok', '✔ Connected');
        }
      } else if (kind === 'bmsWired') {
        if (res.ok && res.data && Object.keys(res.data || {}).length) {
          setBadge('bmsWired', 'ok', '✔ ' + Object.keys(res.data).length + ' metrics');
        } else {
          setBadge('bmsWired', 'fail', '✖ Failed');
          setError('bmsWired', apiErrMsg(res, 'Wired BMS'));
        }
      } else if (kind === 'rest') {
        if (res.ok) {
          setBadge('rest', 'ok', '✔ OK');
        } else {
          setBadge('rest', 'fail', '✖ Failed');
          setError('rest', apiErrMsg(res, 'REST'));
        }
      } else if (kind === 'pvoutput') {
        if (res.ok && res.data && res.data.success) {
          setBadge('pvoutput', 'ok', '✔ Connected');
        } else {
          setBadge('pvoutput', 'fail', '✖ Failed');
          setError('pvoutput', apiErrMsg(res, 'PVOutput'));
        }
      } else if (kind === 'forecast') {
        if (res.ok && res.data && res.data.source) {
          setBadge('forecast', 'ok', '✔ ' + res.data.source + ' · ' + res.data.today_estimate_kwh + ' kWh');
        } else {
          setBadge('forecast', 'fail', '✖ Failed');
          setError('forecast', apiErrMsg(res, 'Forecast'));
        }
      } else if (kind === 'network') {
        if (res.ok && res.data) {
          var lr = res.data.localReachable;
          var rr = res.data.remoteReachable;
          setBadge('network', (lr || rr) ? 'ok' : 'fail',
            (lr ? '✔ Local' : '✖ Local') + ' · ' + (rr ? '✔ Remote' : '✖ Remote'));
          if (!lr && !rr) setError('network', 'None of the configured URLs were reachable.');
        } else {
          setBadge('network', 'fail', '✖ Failed');
          setError('network', apiErrMsg(res, 'Network'));
        }
      }
    }).catch(function (e) {
      setBadge(kind, 'fail', '✖ Error');
      setError(kind, 'Network error during test.');
    });
  }

  // Probe whether a base URL is reachable, without CORS/status concerns.
  // Mirrors public/js/network-detect.js checkLocalReachable(): a small static
  // asset is enough — a reachable server that answers must set onload.
  function probeUrl(baseURL) {
    if (!baseURL) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var img = new Image();
      var timer = setTimeout(function () { img.src = ''; resolve(false); }, 4000);
      img.onload = function () { clearTimeout(timer); resolve(true); };
      img.onerror = function () { clearTimeout(timer); resolve(false); };
      img.src = baseURL.replace(/\/+$/, '') + '/icons/icon-192.png?' + Date.now();
    });
  }

  function testNetworkUrls() {
    var nw = state.optional.network;
    if (!nw.local_url && !nw.remote_url) {
      return Promise.resolve({ ok: false, status: 0, data: { localReachable: false, remoteReachable: false } });
    }
    return Promise.all([probeUrl(nw.local_url), probeUrl(nw.remote_url)]).then(function (r) {
      return { ok: true, status: 200, data: { localReachable: r[0], remoteReachable: r[1] } };
    });
  }

  function modbusTestBody(kind) {
    if (kind === 'modbusTcp') {
      var t = state.sources.modbusTcp;
      return { transport: 'tcp', profile: t.profile, host: t.host, port: t.port, unit: t.unit };
    }
    var s = state.sources.modbusSerial;
    return { transport: 'serial', profile: s.profile, serial_path: s.serial_path, serial_baud: s.serial_baud, serial_data_bits: s.serial_data_bits, serial_parity: s.serial_parity, serial_stop_bits: s.serial_stop_bits, unit: s.unit };
  }

  function apiErrMsg(res, label) {
    if (res.data && typeof res.data === 'object') {
      if (res.data.error) return String(res.data.error);
      if (res.data.message) return String(res.data.message);
    }
    return label + ' test failed (' + (res.status || 'network') + ').';
  }

  function dongleTestBody() {
    var d = state.sources.dongle;
    var body = { host: d.host, port: d.port, modbus_unit_id: d.modbus_unit_id, transport: d.transport };
    if (d.serial_number) body.serial_number = d.serial_number;
    return body;
  }

  function renderHAEntities(entities) {
    var box = $('#ha-entities');
    if (!box) return;
    if (!entities.length) { box.innerHTML = ''; return; }
    var items = entities.slice(0, 60).map(function (e) {
      return '<div class="topic-item"><span>...</span><code>' + esc(e) + '</code><span class="tick"></span></div>';
    }).join('');
    box.innerHTML = '<div class="form-group" style="margin-top:0.5rem;"><label>Available entities (' + entities.length + ')</label>'
      + '<div class="topic-list">' + items + '</div></div>';
  }

  function runBrowseTopics() {
    var s = state.sources.mqtt;
    var box = $('#mqtt-topics');
    if (box) box.innerHTML = '<div class="test-badge pending">Discovering…</div>';
    api('/api/mqtt-discover-topics' + encodeQuery({ broker: s.broker, username: s.username, password: s.password })).then(function (res) {
      if (!box) return;
      if (res.ok && res.data && res.data.success && Array.isArray(res.data.topics)) {
        var topics = res.data.topics;
        s.discoveredTopics = topics;
        var items = topics.map(function (t) {
          var on = s.selectedTopics[t] ? ' on' : '';
          return '<div class="topic-item' + on + '" data-action="toggle-topic" data-topic="' + esc(t) + '" role="button" tabindex="0">'
            + '<span class="tick">' + (s.selectedTopics[t] ? '✓' : '') + '</span><code>' + esc(t) + '</code></div>';
        }).join('');
        box.innerHTML = '<div class="section-divider">Discovered topics (' + (res.data.count || topics.length) + ')</div>'
          + '<div class="topic-list">' + items + '</div>'
          + '<span class="note" style="font-size:0.72rem;">Tap topics to select them; they become metric suggestions in the next step.</span>';
      } else {
        box.innerHTML = '<div class="alert alert-error">Could not browse topics: ' + esc(apiErrMsg(res, 'MQTT')) + '</div>';
      }
    }).catch(function () {
      if (box) box.innerHTML = '<div class="alert alert-error">Network error discovering topics.</div>';
    });
  }

  function toggleTopic(btn) {
    var t = btn.getAttribute('data-topic');
    var s = state.sources.mqtt;
    if (s.selectedTopics[t]) { delete s.selectedTopics[t]; btn.classList.remove('on'); var tick = btn.querySelector('.tick'); if (tick) tick.textContent = ''; }
    else { s.selectedTopics[t] = true; btn.classList.add('on'); var tick2 = btn.querySelector('.tick'); if (tick2) tick2.textContent = '✓'; }
  }

  // ── Build devices + save sources ──────────────────────────
  // Preserve a Settings-owned metric/mapping map across a wizard re-save.
  // existing = state.existing (wizard's loaded config) or undefined.
  // configKey = 'ha_devices'|'dongle_config'|'rs232_devices'; mapKey = 'entities'|'mappings'.
  // deviceName: optional match by device name; if falsy, use the first slot for single-slot sources.
  function carryForwardMap(existing, configKey, mapKey, deviceName) {
    var out = {};
    try {
      var raw = existing ? existing[configKey] : null;
      if (!raw) return out;
      var arr = Array.isArray(raw) ? raw : JSON.parse(raw);
      if (!Array.isArray(arr)) return out;
      var hit = null;
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i] || {};
        if (deviceName) { if (d.name === deviceName) { hit = d; break; } }
        else { hit = d; break; }
      }
      if (hit && hit[mapKey] && typeof hit[mapKey] === 'object') out = hit[mapKey];
    } catch (e) { out = {}; }
    try { return JSON.parse(JSON.stringify(out)); } catch (e) { return {}; }
  }
  function buildHADevices() {
    if (!state.sources.ha.selected) return [];
    var s = state.sources.ha;
    return [{ name: s.name || 'Home Assistant', url: s.url, token: s.token, enabled: true, poll_interval: parseInt(s.poll_interval, 10) || 30, entities: carryForwardMap(state.existing, 'ha_devices', 'entities', '') }];
  }
  function buildMQTTDevices() {
    if (!state.sources.mqtt.selected) return [];
    var s = state.sources.mqtt;
    return [{ name: s.name || 'MQTT Broker', broker: s.broker, username: s.username || '', password: s.password || '', enabled: true, poll_interval: parseInt(s.poll_interval, 10) || 30, topics: s.topics || {} }];
  }
  function buildDongleConfig() {
    if (!state.sources.dongle.selected) return [];
    var d = state.sources.dongle;
    return [{ name: d.name || 'Inverter (TCP)', enabled: true, profile: d.profile, transport: d.transport, host: d.host, port: d.port, serial_number: d.serial_number, modbus_unit_id: d.modbus_unit_id, poll_interval: parseInt(d.poll_interval, 10) || 30, prefix: d.prefix, mappings: carryForwardMap(state.existing, 'dongle_config', 'mappings', '') }];
  }
  function buildRS232Device(opts) {
    var r = state.sources.rs232;
    var dev = { name: r.name || 'Inverter (RS232)', serial_path: resolveSerialPath(r), baud: r.baud, modbus_unit_id: r.modbus_unit_id, parity: r.parity, data_bits: r.data_bits, stop_bits: r.stop_bits, profile: r.profile, timeout: r.timeout ? parseInt(r.timeout, 10) : 5, enabled: r.enabled, mappings: (r && r.mappings && typeof r.mappings === 'object' && Object.keys(r.mappings).length) ? r.mappings : carryForwardMap(state.existing, 'rs232_devices', 'mappings', '') };
    return dev;
  }
  function buildRS232Devices() {
    if (!state.sources.rs232.selected) return [];
    return [buildRS232Device()];
  }
  function buildModbusDevices() {
    var out = [];
    var ms = state.sources.modbusSerial;
    if (ms.selected) {
      out.push({ name: ms.name || 'Inverter (RS485)', enabled: true, transport: 'serial', profile: ms.profile || '', serial_path: ms.serial_path || '', serial_baud: parseInt(ms.serial_baud, 10) || 9600, serial_data_bits: parseInt(ms.serial_data_bits, 10) || 8, serial_parity: ms.serial_parity || 'none', serial_stop_bits: parseInt(ms.serial_stop_bits, 10) || 1, unit: parseInt(ms.unit, 10) || 1, poll_interval: parseInt(ms.poll_interval, 10) || 30, mappings: ms.mappings || {} });
    }
    var mt = state.sources.modbusTcp;
    if (mt.selected) {
      out.push({ name: mt.name || 'Inverter (Modbus-TCP)', enabled: true, transport: 'tcp', profile: mt.profile || '', host: mt.host || '', port: parseInt(mt.port, 10) || 502, unit: parseInt(mt.unit, 10) || 1, poll_interval: parseInt(mt.poll_interval, 10) || 30, mappings: mt.mappings || {} });
    }
    return out;
  }
  function buildBmsDevices() {
    var out = [];
    if (state.sources.bms.selected) {
      var b = state.sources.bms;
      out.push({ name: b.name || 'BMS (BLE bridge)', enabled: true, transport: 'bluetooth', address: b.address || '', bridge_url: b.bridge_url || 'http://bms-bridge:8020', poll_interval: parseInt(b.poll_interval, 10) || 30, mappings: b.mappings || {} });
    }
    if (state.sources.bmsWired.selected) {
      var w = state.sources.bmsWired;
      out.push({ name: w.name || 'BMS (RS485/RS232)', enabled: true, transport: 'wired', serial_path: w.serial_path || '', baud: parseInt(w.baud, 10) || 9600, data_bits: parseInt(w.data_bits, 10) || 8, parity: w.parity || 'none', stop_bits: parseInt(w.stop_bits, 10) || 1, modbus_unit_id: parseInt(w.modbus_unit_id, 10) || 1, profile: w.profile || '', timeout: parseInt(w.timeout, 10) || 5000, poll_interval: parseInt(w.poll_interval, 10) || 30, mappings: w.mappings || {} });
    }
    return out;
  }
  function buildRestDevices() {
    if (!state.sources.rest.selected) return [];
    var r = state.sources.rest;
    return [{ name: r.name || 'REST API', enabled: true, url: r.url || '', mappings: r.mappings || {} }];
  }
  // Wizard-owned cache of discovery results so the metrics step (step 3) can
  // offer candidates on re-entry without re-probing sources. Never used by
  // Settings' metric→entity map; that stays in ha_devices[0].entities.
  function buildProbeCache() {
    return JSON.stringify({
      ha: state.sources.ha.entities || [],
      mqtt: state.sources.mqtt.selectedTopics || {},
      dongle: state.sources.dongle.mappings || {},
      rs232: state.sources.rs232.mappings || {},
      modbus: state.sources.modbusSerial.mappings || state.sources.modbusTcp.mappings || {}
    });
  }

  function saveSources() {
    if (!validateSources()) return Promise.resolve(false);
    var body = {
      ha_devices: JSON.stringify(buildHADevices()),
      mqtt_devices: JSON.stringify(buildMQTTDevices()),
      dongle_config: JSON.stringify(buildDongleConfig()),
      rs232_devices: JSON.stringify(buildRS232Devices()),
      modbus_devices: JSON.stringify(buildModbusDevices()),
      external_sources: JSON.stringify(buildRestDevices()),
      bms_devices: JSON.stringify(buildBmsDevices()),
      setup_probe_cache: buildProbeCache()
    };
    return api('/api/settings/data-sources', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (res.ok && res.data && (res.data.ok || res.data.success)) {
        hideSourcesError();
        clearSourceErrors();
        return true;
      }
      showSourcesError('Could not save data sources (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'));
      return false;
    }).catch(function () {
      showSourcesError('Network error saving data sources.');
      return false;
    });
  }
  function showSourcesError(msg) { var el = $('#sources-error'); if (el) { el.textContent = msg; el.hidden = false; } }
  function hideSourcesError() { var el = $('#sources-error'); if (el) el.hidden = true; }

  // Required-field validation for selected sources (mirrors hasMinimal gating used for Test).
  // Returns { sourceKey: errorMessage } for each selected source missing required fields.
  function sourceValidationErrors() {
    var errors = {};
    SOURCE_KEYS.forEach(function (k) {
      if (!state.sources[k].selected) return;
      var s = state.sources[k];
      if (k === 'ha' && !(s.url && s.token)) errors.ha = 'Base URL and access token are required.';
      else if (k === 'mqtt' && !s.broker) errors.mqtt = 'Broker URL is required.';
      else if (k === 'dongle' && !(s.host && s.port && s.profile)) errors.dongle = 'Host, port and profile are required.';
      else if (k === 'rs232' && !(resolveSerialPath(s) && s.profile)) errors.rs232 = 'Serial port and profile are required.';
      else if (k === 'modbusSerial' && !s.serial_path) errors.modbusSerial = 'Serial path is required.';
      else if (k === 'modbusTcp' && !(s.host && s.port)) errors.modbusTcp = 'Host and port are required.';
      else if (k === 'bms' && !s.address) errors.bms = 'MAC address is required.';
      else if (k === 'bmsWired' && !(s.serial_path && s.profile && s.modbus_unit_id)) errors.bmsWired = 'Serial port, profile and Modbus unit ID are required.';
      else if (k === 'rest' && !s.url) errors.rest = 'Endpoint URL is required.';
    });
    return errors;
  }
  // Blocks Save/Next when a selected source has empty required fields. Shows inline per-source hints.
  function validateSources() {
    if (selectedSourcesCount() === 0) {
      showSourcesError('Select at least one source.');
      return false;
    }
    var errors = sourceValidationErrors();
    var keys = Object.keys(errors);
    if (keys.length) {
      keys.forEach(function (k) { setError(k, errors[k]); });
      showSourcesError('Fix the highlighted required fields before continuing.');
      return false;
    }
    hideSourcesError();
    clearSourceErrors();
    return true;
  }
  function clearSourceErrors() {
    SOURCE_KEYS.forEach(function (k) { clearError(k); });
  }

  // ── "Start fresh" — clear data sources (behind confirm) ───────
  function showResetNote() {
    var el = $('#reset-sources-note');
    if (el) { el.textContent = 'Data sources cleared'; el.hidden = false; }
  }

  function resetSources() {
    if (!window.confirm('This clears all configured data sources, role mapping and resets setup. History, metrics and snapshots are untouched. Continue?')) return;
    setBusy(true);
    api('/api/wizard/reset', { method: 'POST', body: '{}' }).then(function (res) {
      if (res.ok && res.data && res.data.success) {
        resetClientState();
        loadExistingConfig().then(function () { setBusy(false); gotoStep(state.currentStep); showResetNote(); })
          .catch(function () { setBusy(false); gotoStep(state.currentStep); showResetNote(); });
      } else {
        setBusy(false);
        showSourcesError('Could not reset data sources (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'));
      }
    }).catch(function () {
      setBusy(false);
      showSourcesError('Network error resetting data sources.');
    });
  }

  function resetClientState() {
    // Revert the wizard's local source state so a cleared server state is fully reflected.
    state.sources = {
      ha:      { selected: false, name: 'Home Assistant', url: '', token: '', poll_interval: '30', enabled: true, entities: [], profileMetrics: [] },
      mqtt:    { selected: false, name: 'MQTT Broker', broker: '', username: '', password: '', poll_interval: '30', enabled: true, discoveredTopics: [], selectedTopics: {}, topics: {} },
      dongle:  { selected: false, name: 'Inverter (TCP)', profile: '', transport: 'tcp', host: '', port: '', serial_number: '', modbus_unit_id: '', poll_interval: '30', prefix: '', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      rs232:   { selected: false, name: 'Inverter (RS232)', portChoice: '', custom_path: '', profile: '', baud: '', data_bits: '', stop_bits: '', parity: '', modbus_unit_id: '', timeout: '5', poll_interval: '30', enabled: true, ports: [], portsLoaded: false, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      modbusSerial: { selected: false, name: 'Inverter (RS485)', transport: 'serial', profile: '', serial_path: '', serial_baud: '9600', serial_data_bits: '8', serial_parity: 'none', serial_stop_bits: '1', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      modbusTcp:   { selected: false, name: 'Inverter (Modbus-TCP)', transport: 'tcp', profile: '', host: '', port: '502', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null },
      bms:     { selected: false, name: 'BMS (BLE bridge)', address: '', bridge_url: 'http://bms-bridge:8020', poll_interval: '30', enabled: true, mappings: {} },
      bmsWired: { selected: false, name: 'BMS (RS485/RS232)', enabled: true, transport: 'wired', serial_path: '', baud: '9600', data_bits: '8', parity: 'none', stop_bits: '1', modbus_unit_id: '1', profile: '', timeout: '5000', poll_interval: '30', mappings: {} },
      rest:    { selected: false, name: 'REST API', url: '', enabled: true, mappings: {} }
    };
    state.roleMetrics = {};
    state.dashboard.choice = 'full';
    state.optional = {
      pvoutput: { enabled: false, api_key: '', system_id: '', timezone: '', upload_interval_minutes: '5', system_size_w: '0', net_mode: false, webhook_url: '', metric_map: {} },
      forecast: { enabled: false, latitude: '', longitude: '', tilt: '30', azimuth: '180', capacity_kwp: '', solcast_api_key: '', solcast_resource_id: '', loss_factor: '0.9', install_date: '' },
      network: { local_url: '', remote_url: '' }
    };
  }

  // ── STEP 3: METRICS ───────────────────────────────────────
  function roleSuggestions() {
    var set = {};
    state.sources.ha.entities.forEach(function (e) { set[e] = true; });
    Object.keys(state.sources.mqtt.selectedTopics).forEach(function (t) { set[t] = true; });
    metricsNames(state.sources.dongle.profileMetrics).forEach(function (n) { set[n] = true; });
    metricsNames(state.sources.rs232.profileMetrics).forEach(function (n) { set[n] = true; });
    return Object.keys(set);
  }
  function metricsNames(list) {
    list = list || [];
    var names = [];
    function push(n) { if (n && n.trim() && names.indexOf(n) === -1) names.push(n); }
    list.forEach(function (m) {
      if (typeof m === 'string') push(m);
      else if (m) push(m.name || m.key || m.metric || '');
    });
    return names;
  }
  function profileHint(list) {
    var names = metricsNames(list).map(function (n) { return n.toLowerCase(); });
    var hint = {};
    function find(keys) {
      for (var i = 0; i < keys.length; i++) {
        for (var j = 0; j < names.length; j++) { if (names[j].indexOf(keys[i]) > -1) return names[j]; }
      }
      return null;
    }
    var s = find(['solar_power', 'pv_power', 'avatar_power', 'pv', 'solar']); if (s) hint.solar = s;
    var g = find(['grid_power', 'grid_import', 'buy', 'grid']); if (g) hint.grid_import = g;
    var l = find(['load_power', 'consumption', 'home_power', 'load']); if (l) hint.consumption = l;
    var b = find(['battery_power', 'battery']); if (b) { hint.battery_charge = b; hint.battery_discharge = b; }
    var soc = find(['battery_soc', 'soc']); if (soc) hint.battery_soc = soc;
    var v = find(['solar_voltage', 'panel_voltage', 'voltage']); if (v) hint.solar_voltage = v;
    // daily-ish role hints
    function findDaily(words) { for (var w = 0; w < words.length; w++) for (var j = 0; j < names.length; j++) if (names[j].indexOf(words[w]) > -1) return names[j]; return null; }
    var ds = findDaily(['daily_solar', 'day_solar', 'kwh*', 'pv_daily']); if (ds) hint.daily_solar = ds;
    return hint;
  }

  function renderStep3() {
    var body = $('#step-3-body');
    var suggestions = roleSuggestions();
    var hint = profileHint(state.sources.dongle.profileMetrics);
    var hint2 = profileHint(state.sources.rs232.profileMetrics);
    Object.keys(hint2).forEach(function (k) { if (!hint[k]) hint[k] = hint2[k]; });

    var hasEntities = state.sources.ha.entities.length > 0;
    var hasTopics = Object.keys(state.sources.mqtt.selectedTopics).length > 0;
    var hasInv = metricsNames(state.sources.dongle.profileMetrics).length || metricsNames(state.sources.rs232.profileMetrics).length;

    var note = '<div class="alert alert-info" id="metrics-info">';
    if (!hasEntities && !hasTopics && !hasInv) {
      note += 'No source data yet — type the metric name you expect.';
    } else {
      note += 'Suggestions are pulled from your tested sources.';
    }
    note += '</div>';

    var rows = '';
    ROLES.forEach(function (r) {
      var val = (state.roleMetrics[r.key] || '').trim() || (hint[r.key] || '');
      if (!val && !(state.roleMetrics[r.key] || '').trim()) { /* fall back to hint */ }
      if (val && !(state.roleMetrics[r.key] || '').trim()) { state.roleMetrics[r.key] = val; }
      rows += '<tr>'
        + '<td class="role-cell">' + esc(r.label) + ' <span class="role-hint">' + esc(r.key) + '</span></td>'
        + '<td><input class="input" list="role-suggestions" data-metric-role="' + esc(r.key) + '" value="' + esc(val) + '" placeholder="' + esc(r.label) + ' ' + esc(r.unit) + '"></td>'
        + '</tr>';
    });

    var dl = '<datalist id="role-suggestions">' + suggestions.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>';

    body.innerHTML = note
      + '<div class="metric-table-wrap"><table class="metric-table"><thead><tr><th>Role</th><th>Metric / entity</th></tr></thead><tbody>'
      + rows + '</tbody></table></div>'
      + '<p class="metric-empty" id="metric-count" style="margin-top:0.5rem;">' + esc(roleCountLabel()) + '</p>'
      + dl
      + '<div class="alert alert-error" id="metrics-error" hidden></div>';
  }

  function saveRoleMetrics() {
    // Keep existing roles by sending the full mapping of non-empty values.
    var map = {};
    ROLES.forEach(function (r) { var v = (state.roleMetrics[r.key] || '').trim(); if (v) map[r.key] = v; });
    return api('/api/role-metrics', { method: 'POST', body: JSON.stringify(map) }).then(function (res) {
      if (res.ok && res.data && res.data.success) return true;
      var el = $('#metrics-error'); if (el) { el.textContent = 'Could not save metric mapping (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    }).catch(function () {
      var el = $('#metrics-error'); if (el) { el.textContent = 'Network error saving metric mapping.'; el.hidden = false; }
      return false;
    });
  }

  // ── STEP 4: DASHBOARD ─────────────────────────────────────
  function renderStep4() {
    var body = $('#step-4-body');
    var main = state.dashboard.mainBlocks;
    var blockCount = main.length;
    var typeSet = {};
    main.forEach(function (b) { if (b && b.type) typeSet[b.type] = true; });
    var known = ['flow-card-2','forecast-pvtoday','grid-card','savings-summary','metric-cards','bar-gauge-retro','chart-power','chart-energy'];
    var tags = Object.keys(typeSet).map(function (t) { return '<span class="dash-badge">' + esc(t) + '</span>'; }).join('');

    var html = '<div class="alert alert-info">Using the seeded <strong>Main</strong> layout (' + blockCount + ' blocks). Pick how much to keep.</div>';
    html += '<div class="dash-options" id="dash-options">';
    html += '<div class="dash-option' + (state.dashboard.choice === 'full' ? ' selected' : '') + '" data-action="choose-dashboard" data-layout="full" role="button" tabindex="0">'
      + '<span class="dash-radio"></span><h3>Full</h3>'
      + '<p>All ' + blockCount + ' seeded Main blocks — flow, gauges, charts, weather, savings. Everything at once.</p>'
      + '<div style="margin-top:0.4rem;">' + (tags || '<span class="dash-badge">—</span>') + '</div>'
      + '</div>';
    html += '<div class="dash-option' + (state.dashboard.choice === 'minimal' ? ' selected' : '') + '" data-action="choose-dashboard" data-layout="minimal" role="button" tabindex="0">'
      + '<span class="dash-radio"></span><h3>Minimal</h3>'
      + '<p>A curated subset — flow card, metric cards and savings summary. Clean and simple.</p>'
      + '<div style="margin-top:0.4rem;">' + MINIMAL_DASH_TYPES.map(function (t) { return '<span class="dash-badge">' + esc(t) + '</span>'; }).join('') + '</div>'
      + '</div>';
    html += '</div>';
    body.innerHTML = html;
  }

  function saveDashboard() {
    var main = state.dashboard.mainBlocks.slice();
    var chosen;
    if (state.dashboard.choice === 'minimal') {
      chosen = main.filter(function (b) { return b && MINIMAL_DASH_TYPES.indexOf(b.type) > -1; });
    } else {
      chosen = main;
    }
    if (!Array.isArray(chosen)) chosen = [];
    // Persist the ARRAY shape via the canonical /api/dashboard-config path so getDashboardConfig()
    // (which requires dashboard_layouts to be an array of {id,name,layout}) reads the chosen starter.
    return api('/api/dashboard-config').then(function (res) {
      var config = (res.data && res.data.dashboards) ? res.data : { dashboards: [], activeDashboard: 'main' };
      if (!Array.isArray(config.dashboards)) config.dashboards = [];
      var mainDash = null;
      for (var i = 0; i < config.dashboards.length; i++) {
        if (config.dashboards[i] && config.dashboards[i].id === 'main') { mainDash = config.dashboards[i]; break; }
      }
      if (mainDash) {
        mainDash.layout = chosen;
      } else {
        config.dashboards.push({ id: 'main', name: 'Main', layout: chosen });
      }
      config.activeDashboard = 'main';
      return api('/api/dashboard-config', { method: 'POST', body: JSON.stringify(config) });
    }).then(function (res) {
      if (res.ok) return true;
      setGlobalError('Could not save the dashboard layout (' + (res.status || 'network') + ').');
      return false;
    }).catch(function () {
      setGlobalError('Network error saving the dashboard layout.');
      return false;
    });
  }

  // ── STEP 5: BASICS ────────────────────────────────────────
  function renderStep5() {
    var body = $('#step-5-body');
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var html = '<div class="card">'
      + '<div class="card-header"><span class="card-title">Housekeeping</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Savings currency</label><input class="input" data-field="basics.savings_currency" value="' + esc(state.basics.savings_currency) + '" placeholder="€"></div>'
      + '<div class="form-group"><label>Solar capacity (kWp)</label><input class="input" type="number" step="0.01" data-field="basics.solar_capacity_kwp" value="' + esc(state.basics.solar_capacity_kwp) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>Dashboard title</label><input class="input" data-field="basics.dashboard_title" value="' + esc(state.basics.dashboard_title) + '" placeholder="My Solar"></div>'
      + '</div>'
      + '<div class="theme-row">'
      + '<span class="theme-label">Appearance<small>Choose a light or dark theme</small></span>'
      + '<button class="theme-toggle" type="button" data-action="toggle-theme" id="theme-toggle">' + (theme === 'dark' ? '☀ Dark' : '☾ Light') + '</button>'
      + '</div>'
      + '<div class="alert alert-error" id="basics-error" hidden></div>';
    body.innerHTML = html;
  }

  function saveBasics() {
    if (!basicsValid()) { var el = $('#basics-error'); if (el) { el.textContent = 'Add a currency, capacity and title to continue.'; el.hidden = false; } updateNav(); return Promise.resolve(false); }
    var b = state.basics;
    var payload = {
      savings_currency: b.savings_currency,
      solar_capacity_kwp: Number(b.solar_capacity_kwp),
      dashboard_title: b.dashboard_title
    };
    return api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      if (res.ok) return true;
      var el = $('#basics-error'); if (el) { el.textContent = 'Could not save basics (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    }).catch(function () {
      var el = $('#basics-error'); if (el) { el.textContent = 'Network error saving basics.'; el.hidden = false; }
      return false;
    });
  }

  // ── STEP 6: OPTIONAL (skippable) ──────────────────────────
  function renderStepOptional() {
    var body = $('#step-6-body');
    var o = state.optional;
    var pv = o.pvoutput, fc = o.forecast, nw = o.network;
    var html = '<div class="alert alert-info">All optional — fill any of these or leave them blank and skip. Nothing here blocks finishing.</div>';

    // PVOutput
    html += '<div class="card">'
      + '<div class="card-header"><span class="card-title">📤 PVOutput upload</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Enabled</label><select class="select-input" data-field="optional.pvoutput.enabled"><option value="false"' + (pv.enabled ? '' : ' selected') + '>No</option><option value="true"' + (pv.enabled ? ' selected' : '') + '>Yes</option></select></div>'
      + '<div class="form-group"><label>System ID</label><input class="input" data-field="optional.pvoutput.system_id" placeholder="12345" value="' + esc(pv.system_id) + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>API key</label><input class="input" type="password" data-field="optional.pvoutput.api_key" placeholder="PVOutput API key" value="' + esc(pv.api_key) + '"></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Timezone</label><input class="input" data-field="optional.pvoutput.timezone" placeholder="e.g. Africa/Lagos" value="' + esc(pv.timezone) + '"></div>'
      + '<div class="form-group"><label>Upload interval (min)</label><select class="select-input" data-field="optional.pvoutput.upload_interval_minutes">' + [[5,'5'],[10,'10'],[15,'15']].map(function (x) { return '<option value="' + x[0] + '"' + (String(pv.upload_interval_minutes) === String(x[0]) ? ' selected' : '') + '>' + x[0] + '</option>'; }).join('') + '</select></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>System size (W)</label><input class="input" type="number" data-field="optional.pvoutput.system_size_w" value="' + esc(pv.system_size_w) + '"></div>'
      + '<div class="form-group"><label>Webhook URL <span class="note">(optional)</span></label><input class="input" data-field="optional.pvoutput.webhook_url" value="' + esc(pv.webhook_url) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="save-optional" data-source="pvoutput">💾 Save</button>'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="pvoutput">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="pvoutput">Not tested</span>'
      + '<span class="spacer"></span>'
      + '</div>'
      + '<div data-error="pvoutput"></div>'
      + '</div>';

    // Solar Forecast
    html += '<div class="card">'
      + '<div class="card-header"><span class="card-title">☀️ Solar forecast</span></div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Enabled</label><select class="select-input" data-field="optional.forecast.enabled"><option value="false"' + (fc.enabled ? '' : ' selected') + '>No</option><option value="true"' + (fc.enabled ? ' selected' : '') + '>Yes</option></select></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Latitude</label><input class="input" data-field="optional.forecast.latitude" value="' + esc(fc.latitude) + '"></div>'
      + '<div class="form-group"><label>Longitude</label><input class="input" data-field="optional.forecast.longitude" value="' + esc(fc.longitude) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Panel tilt (°)</label><input class="input" type="number" data-field="optional.forecast.tilt" value="' + esc(fc.tilt) + '"></div>'
      + '<div class="form-group"><label>Panel azimuth (°)</label><input class="input" type="number" data-field="optional.forecast.azimuth" value="' + esc(fc.azimuth) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Capacity (kWp)</label><input class="input" data-field="optional.forecast.capacity_kwp" value="' + esc(fc.capacity_kwp) + '"></div>'
      + '<div class="form-group"><label>Solcast API key</label><input class="input" type="password" data-field="optional.forecast.solcast_api_key" value="' + esc(fc.solcast_api_key) + '"></div>'
      + '</div>'
      + '<div class="form-row">'
      + '<div class="form-group"><label>Solcast resource ID</label><input class="input" data-field="optional.forecast.solcast_resource_id" value="' + esc(fc.solcast_resource_id) + '"></div>'
      + '<div class="form-group"><label>Loss factor</label><input class="input" data-field="optional.forecast.loss_factor" value="' + esc(fc.loss_factor) + '"></div>'
      + '</div>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="save-optional" data-source="forecast">💾 Save</button>'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="forecast">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="forecast">Not tested</span>'
      + '<span class="spacer"></span>'
      + '</div>'
      + '<div data-error="forecast"></div>'
      + '</div>';

    // Network URLs
    html += '<div class="card">'
      + '<div class="card-header"><span class="card-title">🌐 Network URLs</span></div>'
      + '<div class="form-group"><label>Local URL (LAN / WiFi)</label><input class="input" data-field="optional.network.local_url" placeholder="http://local-ip:port" value="' + esc(nw.local_url) + '"></div>'
      + '<div class="form-group"><label>Remote URL (Internet)</label><input class="input" data-field="optional.network.remote_url" placeholder="https://domain-name.tld" value="' + esc(nw.remote_url) + '"></div>'
      + '<span class="note">The PWA picks the fastest URL for your current network automatically.</span>'
      + '<div class="test-row">'
      + '<button class="btn btn-sm" type="button" data-action="save-optional" data-source="network">💾 Save</button>'
      + '<button class="btn btn-sm" type="button" data-action="test" data-source="network">Test connection</button>'
      + '<span class="test-badge pending" data-badge-src="network">Not tested</span>'
      + '<span class="spacer"></span>'
      + '</div>'
      + '<div data-error="network"></div>'
      + '</div>';

    body.innerHTML = html;
  }

  function truthy(v) { return v === true || v === 'true' || v === '1'; }

  function saveOptional() {
    var o = state.optional;
    var pv = o.pvoutput, fc = o.forecast, nw = o.network;
    var payload = {
      network_local_url: nw.local_url,
      network_remote_url: nw.remote_url,
      forecast_enabled: truthy(fc.enabled) ? 'true' : 'false',
      solar_latitude: fc.latitude,
      solar_longitude: fc.longitude,
      solar_tilt: fc.tilt,
      solar_azimuth: fc.azimuth,
      solar_capacity_kwp: fc.capacity_kwp,
      solcast_api_key: fc.solcast_api_key,
      solcast_resource_id: fc.solcast_resource_id,
      solar_loss_factor: fc.loss_factor
    };
    // Best-effort; a failure must never block the wizard.
    return api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
      return api('/api/settings/data-sources', { method: 'POST', body: JSON.stringify({
        pvoutput_config: JSON.stringify({
          enabled: truthy(pv.enabled),
          api_key: pv.api_key,
          system_id: pv.system_id,
          timezone: pv.timezone,
          upload_interval_minutes: parseInt(pv.upload_interval_minutes, 10) || 5,
          system_size_w: parseInt(pv.system_size_w, 10) || 0,
          net_mode: truthy(pv.net_mode),
          webhook_url: pv.webhook_url,
          // Issue #117 (D6/AC-11): re-emit the existing metric_map so the
          // wizard's wholesale config replace cannot drop the unit selection.
          metric_map: pv.metric_map || {}
        })
      }) });
    }).then(function () { return true; }).catch(function () { return true; });
  }

  function saveOptionalCard(src) {
    if (src === 'pvoutput') return saveOptionalPvOutput();
    if (src === 'forecast') return saveOptionalForecast();
    if (src === 'network') return saveOptionalNetwork();
    return Promise.resolve(false);
  }

  function saveOptionalPvOutput() {
    var pv = state.optional.pvoutput;
    setBadge('pvoutput', 'pending', 'Saving…');
    return api('/api/settings/data-sources', { method: 'POST', body: JSON.stringify({
      pvoutput_config: JSON.stringify({
        enabled: truthy(pv.enabled),
        api_key: pv.api_key,
        system_id: pv.system_id,
        timezone: pv.timezone,
        upload_interval_minutes: parseInt(pv.upload_interval_minutes, 10) || 5,
        system_size_w: parseInt(pv.system_size_w, 10) || 0,
        net_mode: truthy(pv.net_mode),
        webhook_url: pv.webhook_url,
        // Issue #117 (D6/AC-11): re-emit the existing metric_map so the
        // wizard's wholesale config replace cannot drop the unit selection.
        metric_map: pv.metric_map || {}
      })
    }) }).then(function (res) {
      if (res.ok) { setBadge('pvoutput', 'ok', '✔ Saved'); return true; }
      setBadge('pvoutput', 'fail', '✖ Failed');
      setError('pvoutput', 'Could not save PVOutput (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'PVOutput'));
      return false;
    }).catch(function () {
      setBadge('pvoutput', 'fail', '✖ Failed');
      setError('pvoutput', 'Network error saving PVOutput.');
      return false;
    });
  }

  function saveOptionalForecast() {
    var fc = state.optional.forecast;
    setBadge('forecast', 'pending', 'Saving…');
    var payload = {
      forecast_enabled: truthy(fc.enabled) ? 'true' : 'false',
      solar_latitude: fc.latitude,
      solar_longitude: fc.longitude,
      solar_tilt: fc.tilt,
      solar_azimuth: fc.azimuth,
      solar_capacity_kwp: fc.capacity_kwp,
      solcast_api_key: fc.solcast_api_key,
      solcast_resource_id: fc.solcast_resource_id,
      solar_loss_factor: fc.loss_factor
    };
    return api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      if (res.ok) { setBadge('forecast', 'ok', '✔ Saved'); return true; }
      setBadge('forecast', 'fail', '✖ Failed');
      setError('forecast', 'Could not save forecast (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Forecast'));
      return false;
    }).catch(function () {
      setBadge('forecast', 'fail', '✖ Failed');
      setError('forecast', 'Network error saving forecast.');
      return false;
    });
  }

  function saveOptionalNetwork() {
    var nw = state.optional.network;
    setBadge('network', 'pending', 'Saving…');
    var payload = { network_local_url: nw.local_url, network_remote_url: nw.remote_url };
    return api('/api/settings/network', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      if (res.ok) { setBadge('network', 'ok', '✔ Saved'); return true; }
      setBadge('network', 'fail', '✖ Failed');
      setError('network', 'Could not save network URLs (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Network'));
      return false;
    }).catch(function () {
      setBadge('network', 'fail', '✖ Failed');
      setError('network', 'Network error saving network URLs.');
      return false;
    });
  }

  // ── STEP 7: FINISH ────────────────────────────────────────
  function renderStep6() {
    var body = $('#step-7-body');
    if (state.completed) {
      body.innerHTML = finishHero(true);
    } else {
      body.innerHTML = '<div class="finish-hero">'
        + '<div class="finish-icon">🚀</div>'
        + '<h3>Ready to go</h3>'
        + '<p>Finish to enable your dashboard and lock in this first-run setup.</p>'
        + '</div>';
    }
  }
  function finishHero(done) {
    return '<div class="finish-hero">'
      + '<div class="finish-icon">' + (done ? '✅' : '🚀') + '</div>'
      + '<h3>' + (done ? 'Setup complete!' : 'Ready to go') + '</h3>'
      + '<p>' + (done ? 'Your Epilykos workspace is live and configured.' : 'Finish to enable your dashboard.') + '</p>'
      + '</div>'
      + '<div class="btn-group" style="justify-content:center;margin-top:1rem;">'
      + '<a href="/" class="btn btn-primary">Open Dashboard</a>'
      + '<a href="/settings" class="btn">Go to Settings</a>'
      + '</div>';
  }

  function completeWizard() {
    setBusy(true);
    api('/api/wizard/complete', { method: 'POST', body: '{}' }).then(function (res) {
      setBusy(false);
      if (res.ok && res.data && res.data.success) {
        state.completed = true;
        state.status.completed = true;
        renderStep6();
        var el = $('#step-7-body'); if (el) el.innerHTML = finishHero(true);
        var next = $('#next-btn'); if (next) next.textContent = 'Done';
        setGlobalError(null);
      } else {
        setGlobalError('Could not finalize setup (' + (res.status || 'network') + ').');
      }
    }).catch(function () {
      setBusy(false);
      setGlobalError('Network error finalizing setup.');
    });
  }

  // ── Busy handling ─────────────────────────────────────────
  function setBusy(b) {
    state.busy = b;
    var next = $('#next-btn'); if (next) next.disabled = b;
    var back = $('#back-btn'); if (back) back.disabled = b;
  }

  // ── Field change side-effects ─────────────────────────────
  function afterFieldChange(field) {
    if (field === 'sources.dongle.profile') onDongleProfileChange(state.sources.dongle.profile);
    else if (field === 'sources.rs232.profile') onRs232ProfileChange(state.sources.rs232.profile);
    else if (field === 'sources.rs232.portChoice') syncCustomGroup();
  }

  // ── Event delegation ──────────────────────────────────────
  function bindEvents() {
    var wiz = $('#wizard');

    wiz.addEventListener('input', function (e) {
      var t = e.target;
      if (t.matches('[data-field]')) {
        var field = t.getAttribute('data-field');
        setPath(state, field, t.value);
        afterFieldChange(field);
        updateTestButtons();
        updateMetricsCountLabel();
        updateNav();
      }
      if (t.matches('[data-metric-role]')) {
        var role = t.getAttribute('data-metric-role');
        state.roleMetrics[role] = t.value;
        updateMetricsCountLabel();
      }
    });

    wiz.addEventListener('change', function (e) {
      var t = e.target;
      if (t.matches('[data-field]')) {
        var field = t.getAttribute('data-field');
        setPath(state, field, t.value);
        afterFieldChange(field);
        updateTestButtons();
        updateMetricsCountLabel();
        updateNav();
      }
    });

    wiz.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      if (action === 'toggle-source') toggleSource(el);
      else if (action === 'test') runTest(el.getAttribute('data-source'));
      else if (action === 'save-optional') saveOptionalCard(el.getAttribute('data-source'));
      else if (action === 'browse-topics') runBrowseTopics();
      else if (action === 'toggle-topic') toggleTopic(el);
      else if (action === 'regenerate') regeneratePassword();
      else if (action === 'password-submit') submitPassword();
      else if (action === 'build-entities') { /* noop */ }
      else if (action === 'choose-dashboard') chooseDashboard(el);
      else if (action === 'toggle-theme') toggleTheme();
      else if (action === 'reset-sources') resetSources();
    });

    $('#back-btn').addEventListener('click', function () { if (!state.busy) gotoStep(state.currentStep - 1); });
    $('#next-btn').addEventListener('click', function () { if (!state.busy) onNext(); });
  }

  function toggleSource(el) {
    var key = el.getAttribute('data-source');
    var s = state.sources[key];
    s.selected = !s.selected;
    el.classList.toggle('selected', s.selected);
    syncSourceCardVisibility();
    updateTestButtons();
    loadSourceCatalog();
    updateNav();
  }

  function regeneratePassword() {
    var pw = randomString(16);
    setPath(state, 'password.newPw', pw);
    setPath(state, 'password.confirmPw', pw);
    var a = $('#pw-new'); if (a) a.value = pw;
    var b = $('#pw-confirm'); if (b) b.value = pw;
    var err = $('#pw-new-err'); if (err) err.textContent = '';
    setBadge('pw', 'ok', '✔ Generated');
    updateNav();
  }

  function updateMetricsCountLabel() {
    var el = $('#metric-count');
    if (el) el.textContent = roleCountLabel();
  }

  function chooseDashboard(el) {
    state.dashboard.choice = el.getAttribute('data-layout');
    $$('.dash-option').forEach(function (o) { o.classList.toggle('selected', o === el); });
    updateNav();
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    var b = $('#theme-toggle'); if (b) b.innerHTML = cur === 'dark' ? '☾ Light' : '☀ Dark';
  }

  // ── NEXT ──────────────────────────────────────────────────
  function onNext() {
    if (state.busy) return;
    var step = state.currentStep;
    if (step === 1) { submitPassword(); return; }
    if (step === 7) { completeWizard(); return; }

    setBusy(true);
    var proceed = function () { setBusy(false); gotoStep(step + 1); };
    if (step === 2) {
      saveSources().then(function (ok) { if (ok) proceed(); else setBusy(false); });
    } else if (step === 3) {
      saveRoleMetrics().then(function () { proceed(); });
    } else if (step === 4) {
      saveDashboard().then(function (ok) { if (ok) proceed(); else setBusy(false); });
    } else if (step === 5) {
      saveBasics().then(function (ok) { if (ok) proceed(); else setBusy(false); });
    } else if (step === 6) {
      // Optional: never blocks, never forces a test. Best-effort save.
      saveOptional().then(function () { proceed(); });
    } else {
      proceed();
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    $$('.wizard-panel').forEach(function (p) { p.classList.toggle('active', parseInt(p.getAttribute('data-step'), 10) === 1); });
    bindEvents();
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
