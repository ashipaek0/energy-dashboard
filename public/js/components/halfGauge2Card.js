/**
 * Half Gauge 2 Card — 180° semicircle (9 o'clock to 3 o'clock).
 * Zero at 12 o'clock (top centre). Positive fills clockwise to 3 o'clock (right).
 * Negative fills counter-clockwise to 9 o'clock (left).
 */
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildHalfGauge2Card(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100;
  const max = config.max ?? 100;
  const color = config.color || 'var(--color-solar)';

  const container = document.createElement('div');
  container.className = 'half-gauge2-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.dataset.blockId = id;

  const svgId = `hg2-fill-${id}`;
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:100%;max-width:220px;aspect-ratio:2/1.1;margin:0.25rem auto 0;overflow:hidden;">
      <svg viewBox="0 0 200 110" style="width:100%;height:100%;display:block;">
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--border)" stroke-width="35" stroke-linecap="butt"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${color}" stroke-width="35" stroke-dasharray="0 260" stroke-dashoffset="130" stroke-linecap="butt" id="${svgId}"/>
      </svg>
      <div style="position:absolute;bottom:6%;left:0;right:0;text-align:center;display:flex;flex-direction:column;align-items:center;">
        <span class="stat-value" style="font-size:clamp(0.85rem,2.5vw,1.1rem);font-weight:600;line-height:1;" id="hg2-val-${id}">--</span>
        <span class="stat-label" style="font-size:1rem;color:var(--text-secondary);margin-top:1px;">${escapeHtml(config.title || 'Gauge')}</span>
      </div>
    </div>`;
  return container;
}
export function updateHalfGauge2Card(state) {
  document.querySelectorAll('.half-gauge2-card').forEach(container => {
    let cfg; try{cfg=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const v = state.metrics?.[cfg.value]?.value;
    if (v === undefined || v === null) return;
    const id = container.querySelector('[id^="hg2-fill-"]')?.id?.replace('hg2-fill-','');
    const val = document.getElementById('hg2-val-' + id);
    if (isNumericValue(v)) {
      // D6 keeps the name-inferred unit on the numeric path only (no regression).
      const unit = state.metrics?.[cfg.value]?.unit || inferHalf2Unit(cfg.value);
      const min = cfg.min ?? -100, max = cfg.max ?? 100;
      const range = max - min;
      const pct = (v - min) / range;
      const arcLen = Math.PI * 80; // ≈ 251.3 — true semicircle arc length (radius=80)
      const midArc = arcLen / 2;    // ≈ 125.7 — position of 12 o'clock
      const color = cfg.color || 'var(--color-solar)';
      const negColor = getComputedStyle(document.documentElement).getPropertyValue('--color-negative').trim();
      // 12 o'clock (top centre) is the neutral point
      // Positive: clockwise from 12 o'clock → 3 o'clock (right)
      // Negative: counter-clockwise from 12 o'clock → 9 o'clock (left)
      const zeroPoint = Math.max(0, Math.min(1, (0 - min) / range));
      const maxDist = Math.max(zeroPoint, 1 - zeroPoint);
      const fillLen = Math.min(midArc, (Math.abs(pct - zeroPoint) / maxDist) * midArc);
      const offset = pct >= zeroPoint ? -midArc : fillLen - midArc;
      const fill = document.getElementById('hg2-fill-' + id);
      if (fill) {
        fill.setAttribute('stroke-dasharray', `${fillLen} ${arcLen}`);
        fill.setAttribute('stroke-dashoffset', offset);
        fill.setAttribute('stroke', pct >= zeroPoint ? color : negColor);
      }
      if (val) val.textContent = Math.round(v) + (unit ? ' ' + unit : '');
    } else {
      // D6: non-numeric values use explicit units only — never a name-inferred guess.
      const unit = state.metrics?.[cfg.value]?.unit || '';
      // AC-2.6: reset the arc to its empty SVG state so a number→text flip
      // cannot leave the previous fill (and colour) frozen on screen.
      const fill = document.getElementById('hg2-fill-' + id);
      if (fill) {
        fill.setAttribute('stroke-dasharray', '0 260');
        fill.setAttribute('stroke-dashoffset', '130');
        fill.setAttribute('stroke', cfg.color || 'var(--color-solar)');
      }
      if (val) val.textContent = formatValueText(v) + (unit ? ' ' + unit : '');
    }
  });
}
function inferHalf2Unit(n){n=(n||"").toLowerCase();if(/soc|percentage|percent/.test(n))return"%";if(/temp/.test(n))return"°C";if(/volt/.test(n))return"V";if(/current|amp/.test(n))return"A";if(/power|watt/.test(n))return"W";if(/energy|kwh|wh/.test(n))return"kWh";if(/freq|hz/.test(n))return"Hz";if(/runtime/.test(n))return"h";return"";}
