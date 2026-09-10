/* Epilykos — PVOutput energy-unit rules (issue #117).
 *
 * Single source of truth shared by the Settings page (browser classic script,
 * loaded before settings.js) and the PVOutput mapper (Node require), so the UI
 * and the upload path can never disagree about which fields are energy or what
 * the default unit is.
 *
 * CONVENTION — Epilykos stores energy metrics in kWh (`PV Energy Generated`,
 * `Load Energy Consumed`), while PVOutput's addstatus.jsp expects cumulative
 * watt-hours. A mapping is therefore converted kWh→Wh (×1000) UNLESS the field
 * is EXPLICITLY marked Wh:
 *
 *   1. metric_map.<key>_unit === 'Wh'    → Wh  (no conversion)
 *   2. metric_map.<key>_unit === 'kWh'   → kWh (×1000)
 *   3. metric_map.<key>_is_kwh === false → Wh  (legacy explicit Wh)
 *   4. anything else (absent / undefined / pre-#117 config) → kWh (×1000)
 *
 * Rule 4 is what repairs configs saved before #117 with no user action (D2).
 * Every check is an explicit === / string comparison, never bare truthiness, so
 * a serialized string such as "false" can never be read as truthy.
 *
 * Only v1 (energy generated) and v3 (energy consumed) are energy fields in the
 * addstatus schema — v2/v4 are power (W), v5 is °C, v6 is V. The unit is never
 * auto-detected from the metric envelope (D5 — determinism).
 */
(function () {
  'use strict';

  var ENERGY_KEYS = ['v1', 'v3'];

  var UNITS = ['kWh', 'Wh'];

  /* Metric rows rendered in Settings → PVOutput. `unit: true` marks the rows
   * that get a kWh/Wh unit selector. Labels deliberately avoid a "(Wh)" suffix:
   * the selected metric is a SOURCE metric (kWh by default), and the unit
   * selector — not the label — states what PVOutput receives. */
  var METRIC_FIELDS = [
    {
      key: 'v1', unit: true,
      label: 'v1 Energy Generated',
      hint: 'Cumulative daily solar generation. Typically daily_solar_kwh or solar_kwh. Epilykos energy metrics are kWh; the unit selector sets what PVOutput receives.'
    },
    {
      key: 'v2', unit: false,
      label: 'v2 Power Generated (W)',
      hint: 'Instantaneous solar output in watts. Typically solar_power or solar.'
    },
    {
      key: 'v3', unit: true,
      label: 'v3 Energy Consumed',
      hint: 'Cumulative daily consumption. Typically daily_consumption or load_kwh. Epilykos energy metrics are kWh; the unit selector sets what PVOutput receives.'
    },
    {
      key: 'v4', unit: false,
      label: 'v4 Power Consumed (W)',
      hint: 'Instantaneous load in watts. Typically load_power or consumption.'
    },
    {
      key: 'v5', unit: false,
      label: 'v5 Temperature (°C)',
      hint: 'Ambient or inverter temperature. Typically inverter_temperature.'
    },
    {
      key: 'v6', unit: false,
      label: 'v6 Voltage (V)',
      hint: 'Grid/mains voltage. Typically grid_voltage.'
    }
  ];

  function isEnergyKey(key) {
    return ENERGY_KEYS.indexOf(key) !== -1;
  }

  /**
   * Resolve the unit a mapped energy field is expressed in.
   * @param {object} map — metric_map (or the whole pvoutput config; anything
   *   non-object is treated as an empty map)
   * @param {string} key — 'v1' | 'v3'
   * @returns {'kWh'|'Wh'}
   */
  function resolveEnergyUnit(map, key) {
    var mm = (map && typeof map === 'object') ? map : {};

    var unit = mm[key + '_unit'];
    if (typeof unit === 'string') {
      var norm = unit.trim().toLowerCase();
      if (norm === 'wh') return 'Wh';
      if (norm === 'kwh') return 'kWh';
    }

    // Legacy boolean (D7/D8): only an explicit `false` means "already Wh".
    if (mm[key + '_is_kwh'] === false) return 'Wh';

    // D2: default — missing flag, undefined, or a pre-#117 config.
    return 'kWh';
  }

  function defaultEscape(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * HTML for one kWh/Wh unit selector, preselected from the saved config.
   * Preselection order: `_unit` → legacy `_is_kwh` → kWh (AC-3).
   */
  function buildUnitSelectorHtml(key, map, escapeFn) {
    var esc = typeof escapeFn === 'function' ? escapeFn : defaultEscape;
    var selected = resolveEnergyUnit(map, key);
    var options = UNITS.map(function (u) {
      return '<option value="' + u + '"' + (u === selected ? ' selected' : '') + '>' + u + '</option>';
    }).join('');
    return '<select class="pvoutput-metric-unit" data-key="' + esc(key) + '"'
      + ' title="Unit sent to PVOutput (Epilykos metrics are usually kWh)" style="width:100%;">'
      + options
      + '</select>';
  }

  /**
   * Render the whole PVOutput metric-mapping grid (metric dropdown + unit
   * selector for energy rows only).
   * @param {object} map — metric_map
   * @param {function} [escapeFn]
   * @param {function} [metricOptionsFn] — (selectedMetric) => <option…> HTML,
   *   supplied by the page because the metric list is a browser global.
   */
  function renderMetricFieldsHtml(map, escapeFn, metricOptionsFn) {
    var esc = typeof escapeFn === 'function' ? escapeFn : defaultEscape;
    var optionsFn = typeof metricOptionsFn === 'function'
      ? metricOptionsFn
      : function () { return '<option value="">-- Select metric --</option>'; };
    var mm = (map && typeof map === 'object') ? map : {};

    return METRIC_FIELDS.map(function (f) {
      var sel = optionsFn(mm[f.key]);
      var unitSelect = f.unit ? buildUnitSelectorHtml(f.key, mm, esc) : '';
      return '<div class="form-group" style="flex:1;min-width:200px;">'
        + '<label>' + esc(f.label) + '</label>'
        + '<select class="pvoutput-metric" data-key="' + f.key + '" style="width:100%;">' + sel + '</select>'
        + unitSelect
        + '<div class="note">' + esc(f.hint) + '</div>'
        + '</div>';
    }).join('');
  }

  /**
   * Build the metric_map saved to pvoutput_config from the rendered controls.
   * Writes `<key>_unit` ('kWh'|'Wh') AND the legacy `<key>_is_kwh` boolean
   * (true only for kWh) for backward compatibility (AC-2).
   * @param {Array<{key:string,value:string}>} metricSelections — .pvoutput-metric
   * @param {Array<{key:string,value:string}>} unitSelections — .pvoutput-metric-unit
   */
  function collectMetricMap(metricSelections, unitSelections) {
    var mm = {};
    (metricSelections || []).forEach(function (s) {
      if (!s || !s.key) return;
      if (s.value) mm[s.key] = s.value;
    });
    (unitSelections || []).forEach(function (s) {
      if (!s || !s.key || !isEnergyKey(s.key)) return;
      var unit = (typeof s.value === 'string' && s.value.trim().toLowerCase() === 'wh') ? 'Wh' : 'kWh';
      mm[s.key + '_unit'] = unit;
      mm[s.key + '_is_kwh'] = (unit === 'kWh');
    });
    return mm;
  }

  var api = {
    ENERGY_KEYS: ENERGY_KEYS,
    UNITS: UNITS,
    METRIC_FIELDS: METRIC_FIELDS,
    isEnergyKey: isEnergyKey,
    resolveEnergyUnit: resolveEnergyUnit,
    buildUnitSelectorHtml: buildUnitSelectorHtml,
    renderMetricFieldsHtml: renderMetricFieldsHtml,
    collectMetricMap: collectMetricMap
  };

  if (typeof window !== 'undefined') window.EPILYKOS_PVOUTPUT_UNITS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
