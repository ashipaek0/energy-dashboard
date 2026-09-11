import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildMultiValueCard(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || [];
  const container = document.createElement('div');
  container.className = 'multi-value-card';
  container.style.display = 'flex'; container.style.gap = '0.5rem'; container.style.flexWrap = 'wrap';
  container.dataset.metricMap = JSON.stringify(metrics);
  container.dataset.blockId = block.id;

  (metrics.length ? metrics : [{ label: '', metric: '', unit: '' }]).forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.style.flex = '1 1 0'; card.style.minWidth = '80px';
    card.dataset.mvidx = i;
    card.innerHTML = `<div class="stat-label">${escapeHtml(m.label || '--')}</div><div class="stat-value" data-metric="${escapeHtml(m.metric || '')}">-- ${escapeHtml(m.unit || '')}</div>`;
    container.appendChild(card);
  });
  return container;
}
export function updateMultiValueCard(state) {
  document.querySelectorAll('.multi-value-card').forEach(container => {
    let metrics; try{metrics=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    const cards = container.querySelectorAll('.stat-card');
    metrics.forEach((cfg, i) => {
      if (!cfg.metric) return;
      const v = m[cfg.metric]?.value;
      if (v === undefined || v === null) return;
      if (cards[i]) {
        const valEl = cards[i].querySelector('.stat-value');
        if (valEl) {
          if (isNumericValue(v)) valEl.textContent = `${v.toFixed(1)} ${cfg.unit||''}`;
          else valEl.textContent = formatValueText(v) + (cfg.unit ? ' ' + cfg.unit : '');
        }
      }
    });
  });
}
