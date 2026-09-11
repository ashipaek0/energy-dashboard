import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
export function buildMetricCards(block) {
  if (!block.cards || !block.cards.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'dashboard-block';
    placeholder.style.cssText = 'padding:1rem;color:var(--text-secondary);text-align:center;font-style:italic';
    placeholder.textContent = 'Configure metrics in Settings → Dashboard';
    return placeholder;
  }
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.dataset.blockId = block.id || '';

  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card';
    cardEl.dataset.metric = card.metric || '';
    cardEl.innerHTML = `<div class="stat-label">${escapeHtml(card.title)}</div><div class="stat-value">-- ${escapeHtml(card.unit || '')}</div>`;
    grid.appendChild(cardEl);
  });
  return grid;
}

export function updateMetricCardsFromState(state) {
  if (!state || !state.metrics) return;
  import('../dashboard.js').then(({ dashboardConfig }) => {
    try {
      const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
      if (!activeLayout) return;
      const blocks = activeLayout.filter(b => b.type === 'metric-cards');
      blocks.forEach(block => {
        if (!block.cards) return;
        const grid = document.querySelector(`.stats-grid[data-block-id="${block.id}"]`);
        if (!grid) return;
        const cards = grid.querySelectorAll('.stat-card');
        block.cards.forEach((card, i) => {
          if (!card.metric) return;
          const data = state.metrics[card.metric];
          if (data && isNumericValue(data.value)) {
            if (cards[i]) {
              const valEl = cards[i].querySelector('.stat-value');
              if (valEl) valEl.textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
            }
          } else if (data && data.value != null) {
            if (cards[i]) {
              const valEl = cards[i].querySelector('.stat-value');
              if (valEl) valEl.textContent = formatValueText(data.value) + (card.unit ? ' ' + card.unit : '');
            }
          }
        });
      });
    } catch (e) {
      console.error('Metric cards update error:', e);
    }
  }).catch(e => console.error('Metric cards import error:', e));
}
