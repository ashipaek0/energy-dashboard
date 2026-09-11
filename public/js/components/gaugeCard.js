import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildGaugeCard(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? 0, max = config.max ?? 100;
  const color = config.color || 'var(--accent)';
  const container = document.createElement('div');
  container.className = 'gauge-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:200px;height:200px;margin:0.5rem auto;">
      <svg viewBox="0 0 120 120" style="transform:rotate(-90deg);width:100%;height:100%;">
        <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="20"/>
        <circle cx="60" cy="60" r="50" fill="none" stroke="${color}" stroke-width="20" stroke-dasharray="0 314" stroke-linecap="round" id="gauge-fill-${block.id}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <span class="stat-value" style="font-size:1.6rem;font-weight:600;line-height:1;" id="gauge-val-${block.id}">--</span>
        <span class="stat-label" style="font-size:1rem;color:var(--text-secondary);margin-top:1px;">${escapeHtml(config.title || 'Gauge')}</span>
      </div>
    </div>`;
  return container;
}
export function updateGaugeCard(state) {
  document.querySelectorAll('.gauge-card').forEach(container => {
    let cfg; try{cfg=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const v = state.metrics?.[cfg.value]?.value;
    if (v === undefined || v === null) return;
    const id = container.querySelector('[id^="gauge-fill-"]')?.id?.replace('gauge-fill-','');
    const val = document.getElementById('gauge-val-' + id);
    if (isNumericValue(v)) {
      // D6 keeps the name-inferred unit on the numeric path only (no regression).
      const unit = state.metrics?.[cfg.value]?.unit || inferUnit(cfg.value);
      const pct = Math.min(100, Math.max(0, ((v - cfg.min) / (cfg.max - cfg.min)) * 100));
      const fill = document.getElementById('gauge-fill-' + id);
      if (fill) fill.setAttribute('stroke-dasharray', `${(pct/100)*314} 314`);
      if (val) val.textContent = Math.round(v) + (unit ? ' ' + unit : '');
    } else {
      // D6: non-numeric values use explicit units only — never a name-inferred guess.
      const unit = state.metrics?.[cfg.value]?.unit || '';
      // AC-2.4: reset the arc so a number→text flip cannot leave a stale fill.
      const fill = document.getElementById('gauge-fill-' + id);
      if (fill) fill.setAttribute('stroke-dasharray', '0 314');
      if (val) val.textContent = formatValueText(v) + (unit ? ' ' + unit : '');
    }
  });
}

function inferUnit(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/soc|percentage|percent/.test(n)) return '%';
  if (/temp/.test(n)) return '°C';
  if (/volt/.test(n)) return 'V';
  if (/current|amp/.test(n)) return 'A';
  if (/power|watt/.test(n)) return 'W';
  if (/energy|kwh|wh/.test(n)) return 'kWh';
  if (/freq|hz/.test(n)) return 'Hz';
  if (/runtime/.test(n)) return 'h';
  return '';
}
