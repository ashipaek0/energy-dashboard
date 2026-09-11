import { fetchDashboardState } from './api.js';
import { dashboardConfig } from './dashboard.js';
import { updateFlowCard } from './components/flowCard.js';
import { updateSystemTopology } from './components/systemTopology.js';
import { updateMultiValueCard } from './components/multiValueCard.js';
import { updateGaugeCard } from './components/gaugeCard.js';
import { updateHalfGaugeCard } from './components/halfGaugeCard.js';
import { updateHalfGauge2Card } from './components/halfGauge2Card.js';
import { updateBarGauge } from './components/barGauge.js';
import { updateBarGaugeRetro } from './components/barGaugeRetro.js';
import { updateFlowCardSquare } from './components/flowCardSquare.js';
import { updateFlowCardSquare2 } from './components/flowCardSquare2.js';
import { updatePvToday } from './components/pvToday.js';
import { updateMetricCardsFromState } from './components/metricCards.js';
import { updateGridCardFromState } from './components/gridCard.js';
import { updatePowerChartFromState, updateEnergyChartFromState, updateMetricChartFromState } from './charts.js';
import { updateSavingsFromState } from './components/savingsSummary.js';
import { updateForecast } from './forecast.js';
import { updateWeatherBlock } from './components/weatherBlock.js';
import { updateSwitchBlockFromState } from './components/switchBlock.js';
import { updateStateSelectBlockFromState } from './components/stateSelectBlock.js';
import { updateTextMetricCard } from './components/textMetricCard.js';

export async function updateAllComponents() {
  try { const state = await fetchDashboardState(); updateWithState(state); } catch (e) { console.error(e); }
}

export function updateWithState(state) {
  if (!dashboardConfig?.dashboards) return;
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  const blockTypes = new Set(activeLayout.map(b => b.type));
  if (blockTypes.has('flow-card')) updateFlowCard(state);
  if (blockTypes.has('flow-card-2')) updateSystemTopology(state);
  if (blockTypes.has('multi-value')) updateMultiValueCard(state);
  if (blockTypes.has('gauge-card')) updateGaugeCard(state);
  if (blockTypes.has('half-gauge')) updateHalfGaugeCard(state);
  if (blockTypes.has('half-gauge-2')) updateHalfGauge2Card(state);
  if (blockTypes.has('bar-gauge')) updateBarGauge(state);
  if (blockTypes.has('bar-gauge-retro')) updateBarGaugeRetro(state);
  if (blockTypes.has('flow-card-square')) updateFlowCardSquare(state);
  if (blockTypes.has('flow-card-square-2')) updateFlowCardSquare2(state);
  if (blockTypes.has('metric-cards')) updateMetricCardsFromState(state);
  if (blockTypes.has('grid-card')) updateGridCardFromState(state);
  if (blockTypes.has('chart-power')) updatePowerChartFromState(state);
  if (blockTypes.has('chart-energy')) updateEnergyChartFromState(state);
  if (blockTypes.has('chart-metric')) updateMetricChartFromState(state);
  if (blockTypes.has('text-metric')) updateTextMetricCard(state);
  if (blockTypes.has('savings-summary')) updateSavingsFromState(state);
  const forecastTypes = ['forecast-banner', 'forecast-info', 'forecast-sparkline', 'forecast-pvtoday', 'pv-today', 'weather-block'];
  const hasForecast = forecastTypes.some(t => blockTypes.has(t));
  if (hasForecast) updateForecast();
  if (blockTypes.has('weather-block')) updateWeatherBlock(state);
  if (blockTypes.has('switch-block')) updateSwitchBlockFromState(state);
  if (blockTypes.has('state-select')) updateStateSelectBlockFromState(state);

  // Update screen-reader announcement with key metrics (throttled — aria-live="polite")
  const ariaEl = document.getElementById('aria-live-region');
  if (ariaEl && state.current && state.current.timestamp) {
    const c = state.current;
    const parts = [];
    if (c.solar_kw > 0) parts.push(`Solar ${Math.round(c.solar_kw * 1000)} watts`);
    if (c.consumption_kw > 0) parts.push(`Load ${Math.round(c.consumption_kw * 1000)} watts`);
    if (c.battery_soc != null) parts.push(`Battery ${Math.round(c.battery_soc)} percent`);
    if (state.gridStatus?.configured) parts.push(`Grid ${state.gridStatus.current ? 'on' : 'off'}`);
    ariaEl.textContent = parts.join('. ') || 'Dashboard updated';
  }
}
