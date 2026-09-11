import { uid } from '../utils/uid.js';
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';


export function buildFlowCardSquare2(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || { solar: 'solar', grid_import: 'grid_import', battery_charge: 'battery_charge', battery_soc: 'battery_soc', consumption: 'consumption', battery_discharge: 'battery_discharge', grid_export: 'grid_export' };

  const card = document.createElement('div');
  card.className = 'flow-card-square2';
  card.dataset.metricMap = JSON.stringify(metrics);
  card.dataset.blockId = id;

  card.innerHTML = `
    <div class="fcs2-grid">
      <div class="fcs2-cell" id="${uid('fcs2-solar',id)}">
        <i id="${uid('fcs2-icon-solar',id)}" class="fi fi-sr-solar-panel fcs2-icon"></i>
        <div class="fcs2-info">
          <span class="fcs2-label">Solar</span>
          <span class="fcs2-value" data-metric="${escapeHtml(metrics.solar)}">0 W</span>
        </div>
      </div>
      <div class="fcs2-cell" id="${uid('fcs2-battery',id)}">
        <i id="${uid('fcs2-icon-battery',id)}" class="fi fi-sr-battery-full fcs2-icon"></i>
        <div class="fcs2-info">
          <span class="fcs2-label">Battery</span>
          <span class="fcs2-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="${uid('fcs2-battery-soc',id)}">0%</span>
          <span class="fcs2-sub" data-metric="${escapeHtml(metrics.battery_charge)}" id="${uid('fcs2-battery-power',id)}">0 W</span>
        </div>
      </div>
      <div class="fcs2-cell" id="${uid('fcs2-inverter',id)}">
        <div class="fcs2-inv">${config.inverter_image ? `<img src="${escapeHtml(config.inverter_image)}" alt="Inverter" class="fcs2-inv-img">` : 'INV'}</div>
        <div class="fcs2-info">
          <span class="fcs2-label">Inverter</span>
          <span class="fcs2-value" id="${uid('fcs2-inverter-mode',id)}">--</span>
        </div>
      </div>
      <div class="fcs2-cell" id="${uid('fcs2-grid',id)}">
        <i id="${uid('fcs2-icon-grid',id)}" class="fi fi-sr-bolt fcs2-icon"></i>
        <div class="fcs2-info">
          <span class="fcs2-label">Grid</span>
          <span class="fcs2-value" data-metric="${escapeHtml(metrics.grid_import)}">0 W</span>
        </div>
      </div>
      <div class="fcs2-line fcs2-line-top"></div>
      <div class="fcs2-line fcs2-line-bottom"></div>
      <div class="fcs2-line fcs2-line-left"></div>
      <div class="fcs2-line fcs2-line-right"></div>
    </div>`;
  return card;
}
export function updateFlowCardSquare2(state) {
  document.querySelectorAll('.flow-card-square2').forEach(card => {
    const id = card.dataset.blockId || '';
    let mm; try{mm=JSON.parse(card.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    // Issue #61 Phase 2 (D1/D4/D6): identical guard to flowCard/flowCardSquare.
    const entryOf = (r) => { const n = mm[r]; return n ? m[n] : undefined; };
    const numOf = (r) => { const v = entryOf(r)?.value; return isNumericValue(v) ? v : 0; };
    const rawTextOf = (r) => { const v = entryOf(r)?.value; return (typeof v === 'string' || typeof v === 'boolean') ? formatValueText(v) : null; };
    const solar = numOf('solar'), grid = numOf('grid_import'), battPower = numOf('battery_charge'), battSoc = numOf('battery_soc'), consumption = numOf('consumption');
    const battDischarge = numOf('battery_discharge') || (battPower < 0 ? Math.abs(battPower) : 0);
    const gridExport = numOf('grid_export');
    const battIsSource = battDischarge > 50;
    const el = (s) => document.getElementById(uid(s, id));

    const sv = card.querySelector(`#${uid('fcs2-solar',id)} .fcs2-value`);
    if (sv) sv.textContent = rawTextOf('solar') ?? (Math.round(solar) + ' W');
    const gv2 = card.querySelector(`#${uid('fcs2-grid',id)} .fcs2-value`);
    if (gv2) { gv2.textContent = gridExport > grid ? Math.round(gridExport) + ' W out' : Math.round(grid) + ' W in'; }
    const so = el('fcs2-battery-soc'); if (so) so.textContent = rawTextOf('battery_soc') ?? (Math.round(battSoc) + '%');
    const bp = el('fcs2-battery-power'); if (bp) { if (battPower > 50) bp.textContent = '↑ ' + Math.round(battPower) + ' W'; else if (battDischarge > 50) bp.textContent = '↓ ' + Math.round(battDischarge) + ' W'; else bp.textContent = '0 W'; }
    const si = el('fcs2-icon-solar'); if (si) si.style.color = solar > 50 ? 'var(--solar)' : 'var(--text-secondary)';
    const gi = el('fcs2-icon-grid'); if (gi) { if (grid > 50) gi.style.color = 'var(--grid)'; else if (gridExport > 50) gi.style.color = 'var(--export)'; else gi.style.color = 'var(--text-secondary)'; }
    const bi = el('fcs2-icon-battery'); if (bi) { if (battPower > 50) bi.style.color = 'var(--battery)'; else if (battDischarge > 50) bi.style.color = 'var(--discharge)'; else bi.style.color = 'var(--text-secondary)'; let cl = 'fi fi-sr-battery-empty'; if (battSoc >= 76) cl = 'fi fi-sr-battery-full'; else if (battSoc >= 51) cl = 'fi fi-sr-battery-three-quarters'; else if (battSoc >= 26) cl = 'fi fi-sr-battery-half'; else if (battSoc >= 1) cl = 'fi fi-sr-battery-quarter'; bi.className = cl + ' fcs2-icon'; }
    const im = el('fcs2-inverter-mode'); if (im) { if (solar > 100) { im.textContent = 'Solar'; im.style.color = 'var(--solar)'; } else if (battIsSource) { im.textContent = 'Battery'; im.style.color = 'var(--discharge)'; } else if (grid > 50) { im.textContent = 'Grid'; im.style.color = 'var(--grid)'; } else { im.textContent = 'Idle'; im.style.color = 'var(--text-secondary)'; } }

    // Flow lines
    card.querySelectorAll('.fcs2-line').forEach(l => { l.classList.remove('active','reverse'); l.style.background = ''; });
    const setLine = (cls, active, bg, rev) => { const l = card.querySelector(cls); if (l && active) { l.classList.add('active'); if (rev) l.classList.add('reverse'); l.style.background = bg; } };
    // Top: solar → battery
    if (solar > 100) setLine('.fcs2-line-top', true, 'var(--solar)', false);
    // Bottom: grid ↔ inverter (default direction: inverter → grid, left to right)
    if (grid > 50) setLine('.fcs2-line-bottom', true, 'var(--grid)', true);              // grid→inverter = right→left = reverse
    else if (gridExport > 50) setLine('.fcs2-line-bottom', true, 'var(--export)', false); // inverter→grid = left→right = forward
    // Left: solar ↔ inverter
    if (solar > 100 || battIsSource) setLine('.fcs2-line-left', true, solar > 100 ? 'var(--solar)' : 'var(--discharge)', false);
    // Right: grid → battery (charging only, never battery→grid)
    if (grid > 50 && battPower > 50) setLine('.fcs2-line-right', true, 'var(--grid)', true);
  });
}

