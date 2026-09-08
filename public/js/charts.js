/**
 * Chart Management
 *
 * Multi-instance Chart.js wrapper for power (line) and energy (bar) charts.
 * Charts stored in Maps keyed by canvas ID for multi-instance support.
 *
 * Power chart: 24h/3d range, configurable datasets, green/red zone gradients.
 * Energy chart: 7d/30d/90d range, configurable datasets.
 *
 * Exports lifecycle functions: init, refresh, update from state, range switching.
 *
 * @module charts
 */
import { fetchDashboardState } from './api.js';
import { destroyPvTodayCharts } from './components/pvToday.js';

const powerCharts = {}, energyCharts = {}, metricCharts = {};
let currentPowerRange = '24h', currentEnergyRange = '7d', currentMetricRange = '24h';

/** Resolve any arbitrary metric name to the matching API power field via keyword matching. */
function resolvePowerField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar|pv/.test(n)) return 'solar_kw';
  if (/consumption|load/.test(n)) return 'consumption_kw';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kw';
    if (/charge|charging/.test(n)) return 'battery_charge_kw';
    return 'battery_power_kw';
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kw';
    return 'grid_import_kw';
  }
  console.warn('[charts] could not resolve power field for metric:', metricName);
  return null;
}

/** Resolve any arbitrary metric name to the matching API energy field via keyword matching. */
function resolveEnergyField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar|pv/.test(n)) return 'solar_kwh';
  if (/consumption|load/.test(n)) return 'consumption_kwh';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kwh';
    return 'battery_charge_kwh';
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kwh';
    return 'grid_import_kwh';
  }
  console.warn('[charts] could not resolve energy field for metric:', metricName);
  return null;
}

/** Resolve any arbitrary metric name to the API metric field via exact pass-through (no keyword mapping). */
function resolveMetricField(metricName) {
  return (metricName || '').trim() || null;
}

function getDatasets(c) { if (c && c.dataset.chartDatasets) { try { return JSON.parse(c.dataset.chartDatasets); } catch (e) {} } return null; }
function defaultPower() { return [{ label: 'Load', metric: 'consumption', color: '#44403c' }, { label: 'Solar', metric: 'solar', color: '#f59e0b' }, { label: 'Battery Power', metric: 'battery_power', color: '#84a45a' }, { label: 'Grid Import', metric: 'grid_import', color: '#87aec8' }]; }
function defaultEnergy() { return [{ label: 'Solar Generated', metric: 'daily_solar', color: '#f59e0b' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#87aec8' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#44403c' }]; }

/** Read chart config from the container's data attribute. */
function getChartConfig(container) {
  if (!container) return {};
  try { return JSON.parse(container.dataset.chartConfig || '{}'); } catch (e) { return {}; }
}

const zonePlugin = { id: 'zonePlugin', beforeDraw(chart) { const { ctx, chartArea, scales } = chart; if (!chartArea) return; const zy = scales.y.getPixelForValue(0); if (zy > chartArea.top) { const g = ctx.createLinearGradient(0, chartArea.top, 0, zy); g.addColorStop(0, 'rgba(245,158,11,0.12)'); g.addColorStop(0.6, 'rgba(245,158,11,0.04)'); g.addColorStop(1, 'rgba(245,158,11,0)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, zy - chartArea.top); } if (zy < chartArea.bottom) { const g = ctx.createLinearGradient(0, zy, 0, chartArea.bottom); g.addColorStop(0, 'rgba(135,174,200,0)'); g.addColorStop(0.4, 'rgba(135,174,200,0.08)'); g.addColorStop(1, 'rgba(135,174,200,0.18)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, zy, chartArea.right - chartArea.left, chartArea.bottom - zy); } } };

export function destroyCharts() { Object.values(powerCharts).forEach(c => c.destroy()); Object.values(energyCharts).forEach(c => c.destroy()); Object.values(metricCharts).forEach(c => c.destroy()); for (const k in powerCharts) delete powerCharts[k]; for (const k in energyCharts) delete energyCharts[k]; for (const k in metricCharts) delete metricCharts[k]; destroyPvTodayCharts(); }

export function initPowerChart() {
  document.querySelectorAll('.chart-container canvas[id]').forEach(canvas => {
    if (!canvas.id.startsWith('powerChart')) return;
    if (powerCharts[canvas.id]) return;
    // Show canvas and remove loading indicator
    const container = canvas.closest('.chart-container');
    const cfg = getChartConfig(container);
    const loadingEl = container?.querySelector('.chart-loading');
    if (loadingEl) loadingEl.remove();
    canvas.style.display = '';
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a';
    powerCharts[canvas.id] = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' }, elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0, hoverRadius: 4 } }, scales: { x: { type: 'time', time: { unit: 'hour' }, grid: { color: gc, display: !cfg.hideGrid } }, y: { title: { display: true, text: 'Power (kW)', color: tc }, grid: { color: gc, display: !cfg.hideGrid }, grace: '5%' } }, plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: tc, display: !cfg.hideGrid } } } }, plugins: cfg.hideGrid ? [] : [zonePlugin] });
    // Data filled by updatePowerChartFromState when WebSocket connects
  });
}

export function initEnergyChart() {
  document.querySelectorAll('.chart-container canvas[id]').forEach(canvas => {
    if (!canvas.id.startsWith('energyBarChart')) return;
    if (energyCharts[canvas.id]) return;
    // Show canvas and remove loading indicator
    const container = canvas.closest('.chart-container');
    const cfg = getChartConfig(container);
    const loadingEl = container?.querySelector('.chart-loading');
    if (loadingEl) loadingEl.remove();
    canvas.style.display = '';
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a';
    const ds = getDatasets(canvas.closest('.chart-container')) || defaultEnergy();
    energyCharts[canvas.id] = new Chart(canvas.getContext('2d'), { type: 'bar', data: { labels: [], datasets: ds.map(d => ({ label: d.label, backgroundColor: d.color || '#888', data: [] })) }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { color: gc, display: !cfg.hideGrid } }, y: { title: { display: true, text: 'Energy (kWh)', color: tc }, grid: { color: gc, display: !cfg.hideGrid }, beginAtZero: true } }, plugins: { legend: { labels: { color: tc } }, tooltip: { mode: 'index' } } } });
    // Data filled by updateEnergyChartFromState when WebSocket connects
  });
}

export function initMetricChart() {
  document.querySelectorAll('.chart-container canvas[id]').forEach(canvas => {
    if (!canvas.id.startsWith('metricChart')) return;
    if (metricCharts[canvas.id]) return;
    // Show canvas and remove loading indicator
    const container = canvas.closest('.chart-container');
    const cfg = getChartConfig(container);
    const loadingEl = container?.querySelector('.chart-loading');
    if (loadingEl) loadingEl.remove();
    canvas.style.display = '';
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a';
    const ds = getDatasets(container) || [];
    const yTitle = (ds[0] && ds[0].unit) ? ds[0].unit : (cfg.yAxis?.unit || 'Value');
    metricCharts[canvas.id] = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' }, elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0, hoverRadius: 4 } }, scales: { x: { type: 'time', time: { unit: 'hour' }, grid: { color: gc, display: !cfg.hideGrid } }, y: { title: { display: true, text: yTitle, color: tc }, grid: { color: gc, display: !cfg.hideGrid }, grace: '5%' } }, plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: tc, display: !cfg.hideGrid } } } }, plugins: cfg.hideGrid ? [] : [zonePlugin] });
    // Data filled by refreshMetricChart on init/range change/state push
  });
}

function resolveColor(color) { if (!color) return '#ccc'; if (color.startsWith('#')) return color; return '#ccc'; }

export function applyGradientFills(chart) { if (!chart || !chart.ctx) return; requestAnimationFrame(() => { const ctx = chart.ctx, ca = chart.chartArea; if (!ca) { setTimeout(() => applyGradientFills(chart), 50); return; } chart.data.datasets.forEach((ds, i) => { if (!chart.getDatasetMeta(i).hidden && ds.data.length) { const g = ctx.createLinearGradient(0, ca.bottom, 0, ca.top), hx = resolveColor(ds.borderColor || '#ccc'), r = parseInt(hx.slice(1, 3), 16), gv = parseInt(hx.slice(3, 5), 16), b = parseInt(hx.slice(5, 7), 16); g.addColorStop(0, `rgba(${r},${gv},${b},0.03)`); g.addColorStop(0.5, `rgba(${r},${gv},${b},0.06)`); g.addColorStop(1, `rgba(${r},${gv},${b},0.1)`); ds.backgroundColor = g; } }); chart.update(); }); }

export function updateChartColors() { const isDark = document.documentElement.getAttribute('data-theme') === 'dark', gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a'; Object.values(powerCharts).forEach(c => { const ct = c.canvas?.closest?.('.chart-container'); const cfg = getChartConfig(ct); c.options.scales.x.grid.color = gc; c.options.scales.y.grid.color = gc; c.options.scales.x.grid.display = !cfg.hideGrid; c.options.scales.y.grid.display = !cfg.hideGrid; c.options.plugins.legend.labels.color = tc; c.update(); if (cfg.fill !== false) applyGradientFills(c); }); Object.values(energyCharts).forEach(c => { const ct = c.canvas?.closest?.('.chart-container'); const cfg = getChartConfig(ct); c.options.scales.x.grid.color = gc; c.options.scales.y.grid.color = gc; c.options.scales.x.grid.display = !cfg.hideGrid; c.options.scales.y.grid.display = !cfg.hideGrid; c.options.plugins.legend.labels.color = tc; c.update(); }); Object.values(metricCharts).forEach(c => { const ct = c.canvas?.closest?.('.chart-container'); const cfg = getChartConfig(ct); c.options.scales.x.grid.color = gc; c.options.scales.y.grid.color = gc; c.options.scales.x.grid.display = !cfg.hideGrid; c.options.scales.y.grid.display = !cfg.hideGrid; c.options.plugins.legend.labels.color = tc; c.update(); if (cfg.fill !== false) applyGradientFills(c); }); }

async function refreshPowerChartFor(cid) { const chart = powerCharts[cid]; if (!chart) return; let data; if (currentPowerRange === '24h') { const s = await fetchDashboardState(); data = s.powerHistory; } else if (currentPowerRange === '3d') { const r = await fetch('/api/history?days=3'); const hd = await r.json(); data = hd.map(d => ({ timestamp: d.timestamp, consumption_kw: d.consumption_kw ?? 0, solar_kw: d.solar_kw ?? 0, battery_charge_kw: d.battery_charge_kw ?? 0, battery_discharge_kw: d.battery_discharge_kw ?? 0, battery_power_kw: d.battery_power_kw ?? 0, grid_import_kw: d.grid_import_kw ?? 0, grid_export_kw: d.grid_export_kw ?? 0 })); } else { const s = await fetchDashboardState(); data = s.powerHistory; } updatePowerChartData(chart, cid, data); }

export async function refreshPowerChart() { for (const cid of Object.keys(powerCharts)) await refreshPowerChartFor(cid); }

function updatePowerChartData(chart, cid, data) { if (!data || !data.length) return; const ct = document.getElementById(cid)?.closest('.chart-container'); const cfg = getChartConfig(ct); const ds = getDatasets(ct) || defaultPower(); const existing = chart.data.datasets; ds.forEach((d, i) => { const f = resolvePowerField(d.metric); const pts = data.map(p => ({ x: p.timestamp, y: f ? (p[f] ?? 0) : 0 })); if (i < existing.length) { existing[i].label = d.label; existing[i].data = pts; existing[i].borderColor = resolveColor(d.color); existing[i].fill = cfg.fill !== false; } else { existing.push({ label: d.label, data: pts, borderColor: resolveColor(d.color), fill: cfg.fill !== false, tension: 0.4, borderWidth: 2 });} }); while (existing.length > ds.length) existing.pop(); chart.update(); if (cfg.fill !== false) applyGradientFills(chart); }

export function setPowerRange(range, datasets) { currentPowerRange = range; if (datasets) { document.querySelectorAll('.chart-container').forEach(c => { if (c.querySelector('canvas[id^="powerChart"]')) c.dataset.chartDatasets = JSON.stringify(datasets); }); } refreshPowerChart(); }

async function refreshEnergyChartFor(cid) { const chart = energyCharts[cid]; if (!chart) return; const days = parseInt(currentEnergyRange); const r = await fetch(`/api/daily?days=${days}`); const data = await r.json(); updateEnergyChartData(chart, cid, data); }

export async function refreshEnergyChart() { for (const cid of Object.keys(energyCharts)) await refreshEnergyChartFor(cid); }

function updateEnergyChartData(chart, cid, data) { if (!data || !data.length) return; const ct = document.getElementById(cid)?.closest('.chart-container'); const src = getDatasets(ct) || defaultEnergy(); chart.data.labels = data.map(d => new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })); const existing = chart.data.datasets; src.forEach((s, i) => { const f = resolveEnergyField(s.metric); const vals = f ? data.map(d => d[f] || 0) : []; if (i < existing.length) { existing[i].label = s.label; existing[i].data = vals; existing[i].backgroundColor = s.color || '#888'; } else { existing.push({ label: s.label, data: vals, backgroundColor: s.color || '#888' }); } }); while (existing.length > src.length) existing.pop(); chart.update(); }

export function setEnergyRange(range) { currentEnergyRange = range; refreshEnergyChart(); }

export function updatePowerChartFromState(state) { if (!state) return; for (const [cid, chart] of Object.entries(powerCharts)) { if (currentPowerRange !== '24h') { refreshPowerChartFor(cid); continue; } updatePowerChartData(chart, cid, state.powerHistory); } }

export function updateEnergyChartFromState(state) { if (!state) return; for (const [cid, chart] of Object.entries(energyCharts)) { if (currentEnergyRange !== '7d') { refreshEnergyChartFor(cid); continue; } if (state.dailyEnergyBar) updateEnergyChartData(chart, cid, state.dailyEnergyBar); } }

function setMetricEmptyState(ct, isEmpty) {
  if (!ct) return;
  let emptyEl = ct.querySelector('.chart-empty');
  if (isEmpty) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'chart-empty';
      emptyEl.textContent = 'No data available for the selected range';
      ct.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
  }
}

async function refreshMetricChartFor(cid) {
  const chart = metricCharts[cid];
  if (!chart) return;
  const canvas = document.getElementById(cid);
  const ct = canvas?.closest('.chart-container');
  const ds = getDatasets(ct) || [];
  const hours = currentMetricRange === '3d' ? 72 : (currentMetricRange === '7d' ? 168 : 24);
  const results = await Promise.all(ds.map(async (d, i) => {
    let points = [];
    if (d.metric && resolveMetricField(d.metric)) {
      try {
        const r = await fetch(`/api/metrics/history?metric=${encodeURIComponent(d.metric)}&hours=${hours}`);
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr)) points = arr.map(p => ({ x: p.timestamp, y: (p.value ?? 0) * (parseFloat(d.scale || 1) || 1) }));
        }
      } catch (e) { points = []; }
    }
    updateMetricChartData(chart, cid, points, i);
    return points.length > 0;
  }));
  setMetricEmptyState(ct, !results.some(Boolean));
}

export async function refreshMetricChart() {
  for (const cid of Object.keys(metricCharts)) await refreshMetricChartFor(cid);
}

function updateMetricChartData(chart, cid, data, dsIndex) {
  const ct = document.getElementById(cid)?.closest('.chart-container');
  const cfg = getChartConfig(ct);
  const src = getDatasets(ct) || [];
  const d = src[dsIndex] || {};
  const existing = chart.data.datasets;
  const pts = Array.isArray(data) ? data : [];
  if (dsIndex < existing.length) {
    existing[dsIndex].label = d.label || 'Metric';
    existing[dsIndex].data = pts;
    existing[dsIndex].borderColor = resolveColor(d.color);
    existing[dsIndex].fill = cfg.fill !== false;
  } else {
    existing.push({ label: d.label || 'Metric', data: pts, borderColor: resolveColor(d.color), fill: cfg.fill !== false, tension: 0.4, borderWidth: 2 });
  }
  chart.update();
  if (cfg.fill !== false && pts.length) applyGradientFills(chart);
}

export function setMetricRange(range, datasets) {
  currentMetricRange = range;
  if (datasets) {
    document.querySelectorAll('.chart-container').forEach(c => {
      if (c.querySelector('canvas[id^="metricChart"]')) c.dataset.chartDatasets = JSON.stringify(datasets);
    });
  }
  refreshMetricChart();
}

export function updateMetricChartFromState(state) {
  if (state) refreshMetricChart();
}
