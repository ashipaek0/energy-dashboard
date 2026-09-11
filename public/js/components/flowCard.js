import { uid } from '../utils/uid.js';
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';


export function buildFlowCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const showGauge = config.showGauge !== false;
  const metrics = config.metrics || { solar: 'solar', battery_soc: 'battery_soc', battery_charge: 'battery_charge', battery_discharge: 'battery_discharge', consumption: 'consumption', grid_import: 'grid_import', grid_export: 'grid_export' };

  const card = document.createElement('div');
  card.className = 'flow-card';
  card.dataset.metricMap = JSON.stringify(metrics);
  card.dataset.blockId = id;

  card.innerHTML = `<div class="flow-item solar"><div class="flow-icon"><i id="${uid('icon-solar',id)}" class="fi fi-sr-solar-panel"></i></div><div class="flow-label">Solar</div><div class="flow-value" data-metric="${escapeHtml(metrics.solar)}" id="${uid('flow-solar',id)}">0 W</div>${showGauge?`<div class="solar-now-gauge" id="${uid('solar-now-gauge',id)}"><div class="gauge-bar-bg"><div class="gauge-bar-fill" id="${uid('gauge-bar-fill',id)}"></div></div><span class="gauge-percent" id="${uid('gauge-percent',id)}">0%</span></div>`:''}</div><div class="flow-arrow solar-home">→</div><div class="flow-item battery"><div class="flow-icon"><i id="${uid('icon-battery',id)}" class="fi fi-sr-battery-full"></i></div><div class="flow-label">Battery</div><div class="flow-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="${uid('flow-battery-soc',id)}">--%</div><div class="flow-sub" id="${uid('flow-battery-power',id)}">0 W</div></div><div class="flow-arrow battery">⇄</div><div class="flow-item home"><div class="flow-icon"><i id="${uid('icon-home',id)}" class="fi fi-sr-home"></i></div><div class="flow-label">Home</div><div class="flow-value" data-metric="${escapeHtml(metrics.consumption)}" id="${uid('flow-home',id)}">0 W</div></div><div class="flow-arrow grid">⇄</div><div class="flow-item grid"><div class="flow-icon"><svg id="${uid('icon-grid',id)}" viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor"><path d="M426.5 480h-341l34.3-113.3h272.4L426.5 480zM144.8 334.7l34.3-113.4h153.8l34.3 113.4H144.8zM256 92.2l76.3 99.1h-152.6L256 92.2zM32 32h448v40H32z"/></svg></div><div class="flow-label">Grid</div><div class="flow-value" id="${uid('flow-grid',id)}">0 W</div><div class="flow-sub" id="${uid('flow-grid-direction',id)}">Import</div></div>`;
  return card;
}
export function updateFlowCard(state) {
  document.querySelectorAll('.flow-card').forEach(card => {
    const id = card.dataset.blockId || '';
    let mm; try{mm=JSON.parse(card.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    // Issue #61 Phase 2 (D1/D4): every slot is coerced through the shared numeric
    // predicate before any arithmetic, so a text/boolean metric can never reach
    // Math.round() and produce a not-a-number result. A non-numeric *primary* slot
    // renders its raw text (so the user sees why the diagram is idle); derived
    // sub-labels (battery power, grid net, direction) fall back to numeric zero.
    const entryOf = (r) => { const n = mm[r]; return n ? m[n] : undefined; };
    const numOf = (r) => { const v = entryOf(r)?.value; return isNumericValue(v) ? v : 0; };
    const rawTextOf = (r) => { const v = entryOf(r)?.value; return (typeof v === 'string' || typeof v === 'boolean') ? formatValueText(v) : null; };
    const sw = Math.round(numOf('solar')), cw = Math.round(numOf('consumption')), bc = Math.round(numOf('battery_charge')), bd = Math.round(numOf('battery_discharge')), gi = Math.round(numOf('grid_import')), ge = Math.round(numOf('grid_export')), bs = numOf('battery_soc');
    const el = (s) => document.getElementById(uid(s, id));
    const sf = el('flow-solar'); if (sf) sf.textContent = rawTextOf('solar') ?? (sw + ' W');
    const so = el('flow-battery-soc'); if (so) so.textContent = rawTextOf('battery_soc') ?? (Math.round(bs) + '%');
    const bn = bc - bd, bSign = bn >= 0 ? '↑' : '↓', bCol = bn >= 0 ? 'var(--battery)' : 'var(--discharge)';
    const be = el('flow-battery-power'); if (be) { be.innerHTML = ''; const s = document.createElement('span'); s.style.color = bCol; s.textContent = `${bSign} ${Math.abs(bn)} W`; be.appendChild(s); }
    const he = el('flow-home'); if (he) he.textContent = rawTextOf('consumption') ?? (cw + ' W');
    const gn = gi - ge, gDir = gn >= 0 ? 'Import' : 'Export', gCol = gn >= 0 ? 'var(--grid)' : 'var(--export)';
    const ge2 = el('flow-grid'); if (ge2) { ge2.innerHTML = ''; const s = document.createElement('span'); s.style.color = gCol; s.textContent = Math.abs(gn) + ' W'; ge2.appendChild(s); }
    const gd = el('flow-grid-direction'); if (gd) gd.textContent = gDir;
    [['icon-solar', sw > 0 ? 'var(--solar)' : 'var(--text)'], ['icon-home', cw > 0 ? 'var(--home)' : 'var(--text)'], ['icon-grid', gn > 0 ? 'var(--grid)' : gn < 0 ? 'var(--export)' : 'var(--text)']].forEach(([k, v]) => { const e = el(k); if (e) e.style.color = v; });
    const bi = el('icon-battery'); if (bi) {
      let cl = 'fi fi-sr-battery-empty';
      if (bs >= 76) cl = 'fi fi-sr-battery-full'; else if (bs >= 51) cl = 'fi fi-sr-battery-three-quarters'; else if (bs >= 26) cl = 'fi fi-sr-battery-half'; else if (bs >= 1) cl = 'fi fi-sr-battery-quarter';
      bi.className = cl; bi.style.color = bn > 0 ? 'var(--battery)' : bn < 0 ? 'var(--discharge)' : 'var(--text)';
    }
    const sa = card.querySelector('.flow-arrow.solar-home'); if (sa) { sa.style.color = sw > 0 ? 'var(--solar)' : 'var(--text-secondary)'; sa.classList.toggle('flowing', sw > 0); sa.textContent = '→'; }
    const isCharging = bc > bd, isDischarging = bd > bc, isGridChargingBattery = gi > 0 && isCharging;
    const ba = card.querySelector('.flow-arrow.battery'); if (ba) { if (isDischarging) { ba.style.color = 'var(--discharge)'; ba.textContent = '→'; } else if (isCharging) { ba.style.color = isGridChargingBattery ? 'var(--grid)' : 'var(--solar)'; ba.textContent = isGridChargingBattery ? '←' : '→'; } else { ba.style.color = 'var(--text-secondary)'; ba.textContent = '⇄'; } }
    const ga = card.querySelector('.flow-arrow.grid'); if (ga) { if (gi > ge) { ga.style.color = 'var(--grid)'; ga.textContent = '←'; } else if (ge > gi) { ga.style.color = 'var(--export)'; ga.textContent = '→'; } else { ga.style.color = 'var(--text-secondary)'; ga.textContent = '⇄'; } }
    const gf = el('gauge-bar-fill'), gp = el('gauge-percent'); if (gf && gp && window.systemCapacityKwp) { const pct = Math.min(100, (sw / (window.systemCapacityKwp * 1000)) * 100); gf.style.width = pct + '%'; gp.textContent = pct.toFixed(0) + '%'; }
  });
}
