/**
 * Bar Gauge Card — multi-row horizontal bar visualization for any metric.
 * Each row: label | bar (min→max fill) | value+unit.
 */
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildBarGauge(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const rows = (config.metrics && config.metrics.length ? config.metrics : [{ label: '', metric: '', unit: '', min: 0, max: 100, color: '' }]);

  const container = document.createElement('div');
  container.className = 'bar-gauge-card';
  container.dataset.blockId = id;
  container.dataset.metricMap = JSON.stringify(rows);

  let html = '';
  rows.forEach((r, i) => {
    const fillStyle = r.gradient
      ? `width:0%;background:linear-gradient(to right,${r.gradient});`
      : `width:0%;background:${r.color || 'var(--accent)'};`;
    html += `
      <div class="bar-gauge-row" data-bgidx="${i}">
        <span class="bar-gauge-label">${escapeHtml(r.label || '--')}</span>
        <div class="bar-gauge-track">
          <div class="bar-gauge-fill" id="bg-fill-${id}-${i}" style="${fillStyle}"></div>
        </div>
        <span class="bar-gauge-value" id="bg-val-${id}-${i}" data-metric="${escapeHtml(r.metric || '')}">-- ${escapeHtml(r.unit || '')}</span>
      </div>`;
  });
  container.innerHTML = html;
  return container;
}
export function updateBarGauge(state) {
  document.querySelectorAll('.bar-gauge-card').forEach(container => {
    let rows;
    try { rows = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    const id = container.dataset.blockId || '';
    const m = state.metrics || {};

    rows.forEach((cfg, i) => {
      if (!cfg.metric) return;
      const entry = m[cfg.metric];
      const v = entry?.value;
      if (v === undefined || v === null) return;

      const min = cfg.min ?? 0;
      const max = cfg.max ?? 100;
      const range = max - min;
      const pct = (isNumericValue(v) && range > 0) ? Math.min(100, Math.max(0, ((v - min) / range) * 100)) : 0;

      const fill = document.getElementById(`bg-fill-${id}-${i}`);
      if (fill) fill.style.width = pct + '%';

      const val = document.getElementById(`bg-val-${id}-${i}`);
      if (val) {
        if (isNumericValue(v)) {
          const unit = cfg.unit || entry.unit || inferBarUnit(cfg.metric);
          val.textContent = v.toFixed(1) + (unit ? ' ' + unit : '');
        } else {
          // D6: non-numeric values use explicit units only — never a name-inferred
          // guess (which renders nonsense such as "error °C").
          const unit = cfg.unit || entry.unit || '';
          val.textContent = formatValueText(v) + (unit ? ' ' + unit : '');
        }
      }
    });
  });
}

function inferBarUnit(n) {
  n = (n || '').toLowerCase();
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
