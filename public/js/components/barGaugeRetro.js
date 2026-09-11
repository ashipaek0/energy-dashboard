/**
 * Retro Bar Gauge — segmented LED/VU meter style.
 * Each row: label | [▮▮▮▮▯▯▯▯▯▯] | value+unit
 * Lit segments determined by value position between min and max.
 */
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildBarGaugeRetro(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const rows = (config.metrics && config.metrics.length ? config.metrics : [{ label: '', metric: '', unit: '', min: 0, max: 100, color: '', segments: 10 }]);

  const container = document.createElement('div');
  container.className = 'bar-gauge-retro-card';
  container.dataset.blockId = id;
  container.dataset.metricMap = JSON.stringify(rows);

  let html = '';
  rows.forEach((r, i) => {
    const segs = r.segments || 10;
    const color = r.color || 'var(--accent)';
    let segsHtml = '';
    for (let s = 0; s < segs; s++) {
      segsHtml += `<span class="bg-retro-seg" id="bg-retro-seg-${id}-${i}-${s}" style="background:var(--border);"></span>`;
    }
    html += `
      <div class="bg-retro-row" data-bgidx="${i}">
        <span class="bg-retro-label">${escapeHtml(r.label || '--')}</span>
        <div class="bg-retro-segments" id="bg-retro-segments-${id}-${i}" data-color="${color}" data-gradient="${escapeHtml(r.gradient||'')}" data-segments="${segs}">
          ${segsHtml}
        </div>
        <span class="bg-retro-value" id="bg-retro-val-${id}-${i}" data-metric="${escapeHtml(r.metric || '')}">-- ${escapeHtml(r.unit || '')}</span>
      </div>`;
  });
  container.innerHTML = html;
  return container;
}
export function updateBarGaugeRetro(state) {
  document.querySelectorAll('.bar-gauge-retro-card').forEach(container => {
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
      const pct = (isNumericValue(v) && range > 0) ? Math.min(1, Math.max(0, (v - min) / range)) : 0;
      const segs = cfg.segments || 10;
      const litCount = Math.round(pct * segs);
      const color = cfg.color || 'var(--accent)';
      const gradient = cfg.gradient || '';

      for (let s = 0; s < segs; s++) {
        const seg = document.getElementById(`bg-retro-seg-${id}-${i}-${s}`);
        if (!seg) continue;
        if (s < litCount) {
          let segColor = color;
          if (gradient) {
            const stops = gradient.split(',').map(c => c.trim());
            const t = segs > 1 ? s / (segs - 1) : 0;
            const idx = t * (stops.length - 1);
            const lo = Math.floor(idx), hi = Math.ceil(idx);
            if (lo === hi) segColor = stops[lo];
            else {
              const f = idx - lo;
              segColor = lerpColor(stops[lo], stops[hi], f);
            }
          }
          seg.style.background = segColor;
          seg.style.boxShadow = `0 0 4px ${segColor}`;
        } else {
          seg.style.background = 'transparent';
          seg.style.boxShadow = 'none';
        }
      }

      const val = document.getElementById(`bg-retro-val-${id}-${i}`);
      if (val) {
        if (isNumericValue(v)) {
          const unit = cfg.unit || entry.unit || inferUnit(cfg.metric);
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

/** Simple linear interpolation between two hex colors */
function lerpColor(a, b, t) {
  const ah = parseInt(a.replace('#', ''), 16);
  const bh = parseInt(b.replace('#', ''), 16);
  /* eslint-disable no-bitwise */
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (rr << 16) | (rg << 8) | rb).toString(16).slice(1)}`;
}

function inferUnit(n) {
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
