/**
 * Flow Card 2 — System Topology Diagram
 *
 * Cross/cardinal layout showing energy flow between Solar (top), Battery (bottom),
 * Grid (left), Home (right), and a central Inverter hub.
 *
 * Features:
 * - Animated flow lines with travelling dots showing power direction
 * - Colour-coded icons and circle borders (amber=solar, green=charge, red=grid, amber=discharge)
 * - Hub colour reflects active power source with priority: solar > battery discharge > grid
 * - Solar circle shows utilization % (watts / system capacity)
 * - Battery discharge detected across multiple metric names
 * - Configurable inverter image via block.config.inverter_image
 *
 * @module systemTopology
 */
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
import { uid } from '../utils/uid.js';

const flowLineObservers = new Map();
let flowLineResizePending = new Set();

function scheduleFlowLineReposition(container) {
  if (flowLineResizePending.has(container)) return;
  flowLineResizePending.add(container);
  requestAnimationFrame(() => {
    flowLineResizePending.delete(container);
    positionFlowLines(container);
  });
}

export function buildSystemTopology(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || { solar: 'solar', grid_import: 'grid_import', battery_charge: 'battery_charge', battery_soc: 'battery_soc', consumption: 'consumption', battery_discharge: 'battery_discharge', grid_export: 'grid_export' };
  const container = document.createElement('div');
  container.className = 'flow-card-2';
  container.dataset.metricMap = JSON.stringify(metrics);
  container.dataset.blockId = id;

  container.innerHTML = `
    <div class="topo-grid">
      <div class="topo-node topo-solar" id="${uid('topo-solar',id)}">
        <span class="topo-label">Solar</span>
        <div class="topo-node-circle topo-solar-circle"><span class="topo-value" data-metric="${escapeHtml(metrics.solar)}">0 W</span><span class="topo-pct" id="${uid('topo-solar-pct',id)}">0%</span><i id="${uid('topo-icon-solar',id)}" class="fi fi-sr-solar-panel"></i></div>
      </div>
      <div class="topo-node topo-grid-node" id="${uid('topo-grid-node',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-grid',id)}" class="fi fi-sr-bolt"></i><span class="topo-value" data-metric="${escapeHtml(metrics.grid_import)}">0 W</span></div>
        <span class="topo-label">Grid</span>
      </div>
      <div class="topo-center" id="${uid('topo-center',id)}"><div class="topo-hub"${config.inverter_image ? ` style="background-image:url(${escapeHtml(config.inverter_image)})"` : ''}>${config.inverter_image ? '' : 'INV'}</div></div>
      <div class="topo-node topo-home" id="${uid('topo-home',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-home',id)}" class="fi fi-sr-home"></i><span class="topo-value" data-metric="${escapeHtml(metrics.consumption)}">0 W</span></div>
        <span class="topo-label">Home</span>
      </div>
      <div class="topo-node topo-battery" id="${uid('topo-battery',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-battery',id)}" class="fi fi-sr-battery-full"></i><span class="topo-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="${uid('topo-battery-soc',id)}">0%</span><span class="topo-sub" data-metric="${escapeHtml(metrics.battery_charge)}" id="${uid('topo-battery-power',id)}">0 W</span></div>
        <span class="topo-label">Battery</span>
      </div>
      <div class="topo-line topo-line-solar"></div><div class="topo-line topo-line-grid"></div><div class="topo-line topo-line-home"></div><div class="topo-line topo-line-battery"></div>
    </div>`;

  // ResizeObserver: reposition flow lines when card size changes
  if (id) {
    if (flowLineObservers.has(id)) flowLineObservers.get(id).disconnect();
    const observer = new ResizeObserver(() => scheduleFlowLineReposition(container));
    requestAnimationFrame(() => {
      const grid = container.querySelector('.topo-grid');
      if (grid) observer.observe(grid);
    });
    flowLineObservers.set(id, observer);
  }

  return container;
}
export function updateSystemTopology(state) {
  document.querySelectorAll('.flow-card-2').forEach(container => {
    const id = container.dataset.blockId || '';
    let mm; try{mm=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    // Issue #61 Phase 2 (D1/D4): `?? 0` does NOT coerce strings, so a text slot
    // used to reach Math.round() and render a not-a-number label. Coerce through
    // predicate first; render the raw text for a non-numeric primary slot.
    const entryOf = (r) => { const n = mm[r]; return n ? m[n] : undefined; };
    const numOf = (r) => { const v = entryOf(r)?.value; return isNumericValue(v) ? v : 0; };
    const rawTextOf = (r) => { const v = entryOf(r)?.value; return (typeof v === 'string' || typeof v === 'boolean') ? formatValueText(v) : null; };
    const solar = numOf('solar'), grid = numOf('grid_import'), battPower = numOf('battery_charge'), battSoc = numOf('battery_soc'), consumption = numOf('consumption');
    const battDischarge = numOf('battery_discharge') || (battPower < 0 ? Math.abs(battPower) : 0);
    const gridExport = numOf('grid_export');
    const battIsSource = battDischarge > 10;
    const transparent = container.style.getPropertyValue('--card-bg') === 'transparent';
    const el = (s) => document.getElementById(uid(s, id));
    const sv = container.querySelector('.topo-solar .topo-value'); if (sv) sv.textContent = rawTextOf('solar') ?? (Math.round(solar) + ' W');
    const sp = el('topo-solar-pct'); if (sp) { const cap = window.systemCapacityKwp || 2.1; const pct = Math.min(100, Math.round((solar / (cap * 1000)) * 100)); sp.textContent = pct + '%'; }
    const gv2 = container.querySelector('.topo-grid-node .topo-value'); if (gv2) { gv2.textContent = gridExport > grid ? Math.round(gridExport) + ' W out' : Math.round(grid) + ' W in'; }
    const hv = container.querySelector('.topo-home .topo-value'); if (hv) hv.textContent = rawTextOf('consumption') ?? (Math.round(consumption) + ' W');
    const so = el('topo-battery-soc'); if (so) so.textContent = rawTextOf('battery_soc') ?? (Math.round(battSoc) + '%');
    const bp = el('topo-battery-power'); if (bp) { if (battPower > 10) bp.textContent = '↑ ' + Math.round(battPower) + ' W'; else if (battDischarge > 10) bp.textContent = '↓ ' + Math.round(battDischarge) + ' W'; else bp.textContent = '0 W'; }
    [['topo-icon-solar', solar > 10 ? 'var(--solar)' : 'var(--text-secondary)']].forEach(([k, v]) => { const e = el(k); if (e) e.style.color = v; });
    const ih = el('topo-icon-home'); if (ih) { if (solar > 10) ih.style.color = 'var(--solar)'; else if (battIsSource) ih.style.color = 'var(--discharge)'; else if (grid > 10) ih.style.color = 'var(--grid)'; else ih.style.color = 'var(--text-secondary)'; }
    const ig = el('topo-icon-grid'); if (ig) { if (gridExport > 10) ig.style.color = 'var(--export)'; else if (grid > 10) ig.style.color = 'var(--grid)'; else ig.style.color = 'var(--text-secondary)'; }
    const ib = el('topo-icon-battery'); if (ib) { if (battPower > 10) ib.style.color = 'var(--battery)'; else if (battDischarge > 10) ib.style.color = 'var(--discharge)'; else ib.style.color = 'var(--text-secondary)'; let cl = 'fi fi-sr-battery-empty'; if (battSoc >= 76) cl = 'fi fi-sr-battery-full'; else if (battSoc >= 51) cl = 'fi fi-sr-battery-three-quarters'; else if (battSoc >= 26) cl = 'fi fi-sr-battery-half'; else if (battSoc >= 1) cl = 'fi fi-sr-battery-quarter'; ib.className = cl; }
    // Circle borders — proportional when multiple sources feed a node
    if (!transparent) {
    const solarCircle = container.querySelector('.topo-solar-circle');
    applyCircleBorder(solarCircle, [{ color: 'var(--solar)', watts: solar }], 10);

    const gridCircle = container.querySelector('.topo-grid-node .topo-node-circle');
    applyCircleBorder(gridCircle, [
      { color: 'var(--grid)', watts: grid },
      { color: 'var(--export)', watts: gridExport }
    ], 10);

    // Battery: can charge from solar + grid simultaneously
    const battCircle = container.querySelector('.topo-battery .topo-node-circle');
    if (battPower > 10) {
      applyCircleBorder(battCircle, [
        { color: 'var(--solar)', watts: solar },
        { color: 'var(--grid)', watts: grid }
      ], 10);
    } else if (battDischarge > 10) {
      applyCircleBorder(battCircle, [{ color: 'var(--discharge)', watts: battDischarge }], 10);
    } else {
      battCircle.style.borderColor = 'var(--border)';
      battCircle.style.background = 'var(--card-bg)';
    }

    // Home: can be fed by solar, battery discharge, and grid simultaneously
    const homeCircle = container.querySelector('.topo-home .topo-node-circle');
    applyCircleBorder(homeCircle, [
      { color: 'var(--solar)', watts: solar },
      { color: 'var(--discharge)', watts: battIsSource ? battDischarge : 0 },
      { color: 'var(--grid)', watts: grid }
    ], 10);
    }
    // Hub — always visible indicator, even when card is transparent
    const hub = container.querySelector('.topo-hub'); if (hub) { if (solar > 10) hub.style.backgroundColor = 'var(--solar)'; else if (battIsSource) hub.style.backgroundColor = 'var(--discharge)'; else if (grid > 10) hub.style.backgroundColor = 'var(--grid)'; else hub.style.backgroundColor = 'var(--accent)'; }
    container.querySelectorAll('.topo-line').forEach(l => { l.classList.remove('active', 'reverse'); l.style.background = ''; });
    const setLine = (cls, active, bg, rev) => { const l = container.querySelector(cls); if (l && active) { l.classList.add('active'); if (rev) l.classList.add('reverse'); l.style.background = bg; } };
    setLine('.topo-line-solar', solar > 10, 'var(--solar)', false);
    setLine('.topo-line-grid', grid > 10, 'var(--grid)', false);
    if (gridExport > 10) setLine('.topo-line-grid', true, 'var(--export)', true);

    // Home line: pick dominant source by wattage, not priority order
    if (consumption > 10) {
      const homeSources = [
        { color: 'var(--solar)', watts: solar },
        { color: 'var(--discharge)', watts: battIsSource ? battDischarge : 0 },
        { color: 'var(--grid)', watts: grid }
      ].filter(s => s.watts > 10);
      if (homeSources.length > 0) {
        homeSources.sort((a, b) => b.watts - a.watts);
        setLine('.topo-line-home', true, homeSources[0].color, false);
      }
    }

    // Battery charging line: dominant source by wattage
    if (battPower > 10) {
      const chargeSources = [
        { color: 'var(--solar)', watts: solar },
        { color: 'var(--grid)', watts: grid },
        { color: 'var(--battery)', watts: battPower }
      ].filter(s => s.watts > 10);
      chargeSources.sort((a, b) => b.watts - a.watts);
      const src = chargeSources.length > 0 ? chargeSources[0].color : 'var(--battery)';
      setLine('.topo-line-battery', true, src, false);
    }
    setLine('.topo-line-battery', battDischarge > 10, 'var(--discharge)', true);

    // Position flow lines edge-to-edge
    positionFlowLines(container);
  });
}

/**
 * Position flow lines from the edge of each circle to the edge of the hub.
 * Uses getBoundingClientRect for pixel-perfect edge-to-edge connections,
 * regardless of container size or responsive scaling.
 */
function positionFlowLines(container) {
  const grid = container.querySelector('.topo-grid');
  if (!grid) return;
  const gridRect = grid.getBoundingClientRect();

  const hub = container.querySelector('.topo-hub');
  const solarCircle = container.querySelector('.topo-solar .topo-node-circle');
  const gridCircle = container.querySelector('.topo-grid-node .topo-node-circle');
  const homeCircle = container.querySelector('.topo-home .topo-node-circle');
  const battCircle = container.querySelector('.topo-battery .topo-node-circle');

  if (!hub || !solarCircle || !gridCircle || !homeCircle || !battCircle) return;

  const hubR = hub.getBoundingClientRect();
  const solarR = solarCircle.getBoundingClientRect();
  const gridR = gridCircle.getBoundingClientRect();
  const homeR = homeCircle.getBoundingClientRect();
  const battR = battCircle.getBoundingClientRect();

  const lineW = 3; // line thickness

  // Solar → Hub (vertical: solar bottom-center to hub top-center)
  const solarLine = container.querySelector('.topo-line-solar');
  if (solarLine) {
    const cx = (solarR.left + solarR.right) / 2 - gridRect.left;
    const y1 = solarR.bottom - gridRect.top;
    const y2 = hubR.top - gridRect.top;
    Object.assign(solarLine.style, {
      left: (cx - lineW / 2) + 'px', top: y1 + 'px',
      width: lineW + 'px', height: Math.max(0, y2 - y1) + 'px',
      transform: 'none'
    });
  }

  // Hub → Battery (vertical: hub bottom-center to battery top-center)
  const battLine = container.querySelector('.topo-line-battery');
  if (battLine) {
    const cx = (hubR.left + hubR.right) / 2 - gridRect.left;
    const y1 = hubR.bottom - gridRect.top;
    const y2 = battR.top - gridRect.top;
    Object.assign(battLine.style, {
      left: (cx - lineW / 2) + 'px', top: y1 + 'px',
      width: lineW + 'px', height: Math.max(0, y2 - y1) + 'px',
      transform: 'none'
    });
  }

  // Grid → Hub (horizontal: grid right-center to hub left-center)
  const gridLine = container.querySelector('.topo-line-grid');
  if (gridLine) {
    const cy = (gridR.top + gridR.bottom) / 2 - gridRect.top;
    const x1 = gridR.right - gridRect.left;
    const x2 = hubR.left - gridRect.left;
    Object.assign(gridLine.style, {
      left: x1 + 'px', top: (cy - lineW / 2) + 'px',
      width: Math.max(0, x2 - x1) + 'px', height: lineW + 'px',
      transform: 'none'
    });
  }

  // Hub → Home (horizontal: hub right-center to home left-center)
  const homeLine = container.querySelector('.topo-line-home');
  if (homeLine) {
    const cy = (homeR.top + homeR.bottom) / 2 - gridRect.top;
    const x1 = hubR.right - gridRect.left;
    const x2 = homeR.left - gridRect.left;
    Object.assign(homeLine.style, {
      left: x1 + 'px', top: (cy - lineW / 2) + 'px',
      width: Math.max(0, x2 - x1) + 'px', height: lineW + 'px',
      transform: 'none'
    });
  }
}

/**
 * Apply a proportional conic-gradient ring to a circle element.
 * When only one source is active, falls back to solid borderColor for simplicity.
 * When multiple sources feed the node, shows proportional color segments.
 *
 * @param {HTMLElement} circle — the .topo-node-circle element
 * @param {Array<{color: string, watts: number}>} sources — power sources with colors
 * @param {number} threshold — minimum watts to consider a source "active"
 */
function applyCircleBorder(circle, sources, threshold) {
  if (!circle) return;
  const active = sources.filter(s => s.watts > threshold);
  if (active.length === 0) {
    circle.style.borderColor = 'var(--border)';
    circle.style.background = 'var(--card-bg)';
    return;
  }
  if (active.length === 1) {
    circle.style.borderColor = active[0].color;
    circle.style.background = 'var(--card-bg)';
    return;
  }
  // Two or more active sources — proportional ring using layered backgrounds.
  // radial-gradient creates an opaque center so icons/text remain visible.
  // conic-gradient renders the colored ring segments behind the center.
  const total = active.reduce((s, x) => s + x.watts, 0);
  let acc = 0;
  const stops = active.map(s => {
    const start = (acc / total) * 100;
    acc += s.watts;
    const end = (acc / total) * 100;
    return `${s.color} ${start}% ${end}%`;
  }).join(', ');
  circle.style.borderColor = 'transparent';
  circle.style.background = `radial-gradient(circle, var(--card-bg) 58.3%, transparent 60%), conic-gradient(${stops})`;
}
