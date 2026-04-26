let powerChart;
let energyBarChart;
let sparklineChart;         // sparkline for forecast
const ctxPower = document.getElementById('powerChart').getContext('2d');
const ctxEnergy = document.getElementById('energyBarChart').getContext('2d');
const ctxSparkline = document.getElementById('pv-sparkline').getContext('2d');

const visibilityPrefs = {
  'Load': true,
  'Solar PV': true,
  'Battery Charge': false,
  'Battery Discharge': false,
  'Grid Import': false,
  'Grid Export': false
};

let currentSolarWatts = 0;
let systemCapacityKwp = 2.1;   // updated from settings

function formatCurrency(amount, currency) {
  const rounded = Math.round(amount);
  return currency + ' ' + rounded.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatHoursToHM(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m`;
}

function getDayName(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

function initCharts() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';

  powerChart = new Chart(ctxPower, {
    type: 'line', data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' },
      elements: { line: { borderWidth: 1, tension: 0.4, fill: true }, point: { radius: 0, hoverRadius: 4 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour' }, grid: { color: gridColor } },
        y: { title: { display: true, text: 'Power (kW)', color: textColor }, grid: { color: gridColor } }
      },
      plugins: {
        tooltip: { mode: 'index' },
        legend: {
          labels: { color: textColor },
          onClick: (e, legendItem, legend) => {
            const index = legendItem.datasetIndex;
            const ci = legend.chart;
            const meta = ci.getDatasetMeta(index);
            meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : !meta.hidden;
            ci.update();
            const label = ci.data.datasets[index].label;
            visibilityPrefs[label] = !meta.hidden;
          }
        }
      }
    }
  });

  energyBarChart = new Chart(ctxEnergy, {
    type: 'bar', data: {
      labels: [],
      datasets: [
        { label: 'Solar Generated', backgroundColor: '#d97706', data: [] },
        { label: 'Grid Imported', backgroundColor: '#dc2626', data: [] },
        { label: 'Energy Consumed', backgroundColor: '#7c3aed', data: [] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: gridColor } },
        y: { title: { display: true, text: 'Energy (kWh)', color: textColor }, grid: { color: gridColor }, beginAtZero: true }
      },
      plugins: { legend: { labels: { color: textColor } }, tooltip: { mode: 'index' } }
    }
  });

  sparklineChart = new Chart(ctxSparkline, {
    type: 'line', data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
      elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false }, ticks: { color: textColor, maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, callback: (v) => v + ' kW' }, max: 1 }
      },
      plugins: {
        tooltip: { enabled: false },
        legend: { display: true, labels: { color: textColor, boxWidth: 20, padding: 10 } }
      }
    }
  });
}

function applyGradientFills(chart) {
  const ctx = chart.ctx;
  const datasets = chart.data.datasets;
  const chartArea = chart.chartArea;
  datasets.forEach((dataset, i) => {
    const meta = chart.getDatasetMeta(i);
    if (!meta.hidden && dataset.data.length > 0) {
      const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
      let color = dataset.borderColor;
      if (typeof color === 'string') {
        const hex = color.startsWith('#') ? color : 
                   (color === 'var(--solar)' ? (document.documentElement.getAttribute('data-theme') === 'dark' ? '#fbbf24' : '#d97706') : 
                    color === 'var(--battery)' ? (document.documentElement.getAttribute('data-theme') === 'dark' ? '#10b981' : '#059669') :
                    color === 'var(--grid)' ? (document.documentElement.getAttribute('data-theme') === 'dark' ? '#ef4444' : '#dc2626') :
                    color === 'var(--home)' ? (document.documentElement.getAttribute('data-theme') === 'dark' ? '#8b5cf6' : '#7c3aed') :
                    color);
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.05)`);
        gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.2)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.4)`);
      } else {
        gradient.addColorStop(0, 'rgba(100,100,100,0.05)');
        gradient.addColorStop(0.5, 'rgba(100,100,100,0.2)');
        gradient.addColorStop(1, 'rgba(100,100,100,0.4)');
      }
      dataset.backgroundColor = gradient;
      dataset.fill = true;
    }
  });
}

async function updateCurrent() {
  try {
    const res = await fetch('/api/current');
    const d = await res.json();
    currentSolarWatts = Math.round(d.solar_kw * 1000);
    const consumption = Math.round(d.consumption_kw * 1000);
    const battCharge = Math.round(d.battery_charge_kw * 1000);
    const battDischarge = Math.round(d.battery_discharge_kw * 1000);
    const gridImport = Math.round(d.grid_import_kw * 1000);
    const gridExport = Math.round(d.grid_export_kw * 1000);
    const battSoc = d.battery_soc || 0;

    document.getElementById('flow-solar').textContent = currentSolarWatts + ' W';
    document.getElementById('flow-battery-soc').textContent = battSoc.toFixed(1) + '%';

    const battNet = battCharge - battDischarge;
    const battSign = battNet >= 0 ? '↑' : '↓';
    const battColor = battNet >= 0 ? 'var(--battery)' : '#f59e0b';
    document.getElementById('flow-battery-power').innerHTML = `<span style="color:${battColor}">${battSign} ${Math.abs(battNet)} W</span>`;

    document.getElementById('flow-home').textContent = consumption + ' W';

    const gridNet = gridImport - gridExport;
    const gridDir = gridNet >= 0 ? 'Import' : 'Export';
    const gridColor = gridNet >= 0 ? 'var(--grid)' : '#3b82f6';
    document.getElementById('flow-grid').innerHTML = `<span style="color:${gridColor}">${Math.abs(gridNet)} W</span>`;
    document.getElementById('flow-grid-direction').textContent = gridDir;

    updateFlowArrows(currentSolarWatts, consumption, battCharge, battDischarge, gridImport, gridExport);

    // Dynamic icon colours for solar, home, grid
    const solarIcon = document.getElementById('icon-solar');
    const homeIcon = document.getElementById('icon-home');
    const gridIcon = document.getElementById('icon-grid');
    if (solarIcon) solarIcon.style.color = currentSolarWatts > 0 ? 'var(--solar)' : 'var(--text)';
    if (homeIcon) homeIcon.style.color = consumption > 0 ? 'var(--home)' : 'var(--text)';
    if (gridIcon) {
      if (gridImport > gridExport) gridIcon.style.color = 'var(--grid)';
      else if (gridExport > gridImport) gridIcon.style.color = '#3b82f6';
      else gridIcon.style.color = 'var(--text)';
    }

    // Battery icon SOC and colour
    const batteryIcon = document.getElementById('icon-battery');
    if (batteryIcon) {
      let batteryClass = 'fi fi-sr-battery-empty';
      if (battSoc >= 76)      batteryClass = 'fi fi-sr-battery-full';
      else if (battSoc >= 51) batteryClass = 'fi fi-sr-battery-three-quarters';
      else if (battSoc >= 26) batteryClass = 'fi fi-sr-battery-half';
      else if (battSoc >= 1)  batteryClass = 'fi fi-sr-battery-quarter';
      batteryIcon.className = batteryClass;
      if (battCharge > battDischarge) batteryIcon.style.color = 'var(--battery)';
      else if (battDischarge > battCharge) batteryIcon.style.color = '#f59e0b';
      else batteryIcon.style.color = 'var(--text)';
    }

    const cfgRes = await fetch('/api/public-config');
    const cfg = await cfgRes.json();
    document.getElementById('daily-solar').textContent = d.daily_solar_kwh.toFixed(2) + ' kWh';
    document.getElementById('daily-load').textContent = d.daily_consumption_kwh.toFixed(2) + ' kWh';
    document.getElementById('daily-grid-import').textContent = d.daily_grid_import_kwh.toFixed(2) + ' kWh';
    const sufficiency = d.daily_consumption_kwh > 0 ? (d.daily_solar_kwh / d.daily_consumption_kwh * 100).toFixed(1) : '0.0';
    document.getElementById('self-sufficiency').textContent = sufficiency + '%';
    updateNowGauge();
  } catch (e) { console.error(e); }
}

function updateNowGauge() {
  const gaugeFill = document.getElementById('gauge-bar-fill');
  const gaugePercent = document.getElementById('gauge-percent');
  if (!gaugeFill || !gaugePercent) return;
  const capacityWatts = systemCapacityKwp * 1000;
  const percent = capacityWatts > 0 ? Math.min(100, (currentSolarWatts / capacityWatts) * 100) : 0;
  gaugeFill.style.width = percent + '%';
  gaugePercent.textContent = percent.toFixed(0) + '%';
}

async function updateSavings() {
  try {
    const res = await fetch('/api/savings');
    const d = await res.json();
    const curr = d.currency || '€';
    const safeFormat = (val) => formatCurrency(val || 0, curr);
    document.getElementById('savings-today').textContent = safeFormat(d.today);
    document.getElementById('savings-week').textContent = safeFormat(d.week);
    document.getElementById('savings-month').textContent = safeFormat(d.month);
    document.getElementById('savings-all').textContent = safeFormat(d.all);
  } catch (e) {
    console.error('Savings fetch error:', e);
    document.getElementById('savings-today').textContent = '--';
    document.getElementById('savings-week').textContent = '--';
    document.getElementById('savings-month').textContent = '--';
    document.getElementById('savings-all').textContent = '--';
  }
}

function setWeatherIconColor(iconEl, desc) {
  const descLower = (desc || '').toLowerCase();
  if (descLower.includes('clear') || descLower.includes('sunny')) iconEl.style.color = '#f59e0b';
  else if (descLower.includes('partly cloudy')) iconEl.style.color = '#eab308';
  else if (descLower.includes('cloudy') || descLower.includes('overcast')) iconEl.style.color = '#9ca3af';
  else if (descLower.includes('rain') || descLower.includes('drizzle')) iconEl.style.color = '#3b82f6';
  else if (descLower.includes('fog')) iconEl.style.color = '#94a3b8';
  else iconEl.style.color = 'var(--text)';
}

async function updateForecast() {
  const banner = document.getElementById('forecast-banner');
  try {
    const res = await fetch('/api/solar-forecast');
    const data = await res.json();
    if (data.error || !data.daily || data.daily.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';

    const now = new Date();
    const todayDate = now.toLocaleDateString('en-CA');

    let todayIdx = data.daily.findIndex(d => d.date === todayDate);
    if (todayIdx === -1) todayIdx = 0;
    const today = data.daily[todayIdx];
    const tomorrow = data.daily[todayIdx + 1] || null;
    const nextDay = data.daily[todayIdx + 2] || null;

    document.getElementById('pv-today-value').textContent = (today.total_kwh || 0).toFixed(1) + ' kWh';
    
    if (tomorrow) {
      document.getElementById('pred-day1-label').textContent = getDayName(tomorrow.date);
      document.getElementById('pv-tomorrow').textContent = tomorrow.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day1-label').textContent = '--';
      document.getElementById('pv-tomorrow').textContent = '-- kWh';
    }
    if (nextDay) {
      document.getElementById('pred-day2-label').textContent = getDayName(nextDay.date);
      document.getElementById('pv-nextday').textContent = nextDay.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day2-label').textContent = '--';
      document.getElementById('pv-nextday').textContent = '-- kWh';
    }

    document.getElementById('forecast-date').textContent =
      now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    // Weather data
    if (data.weather) {
      const w = data.weather;
      // Current weather
      document.getElementById('weather-i').className = w.icon_class || 'fi fi-sr-sun';
      document.getElementById('weather-temp').textContent = w.temp != null ? w.temp.toFixed(0) + '°C' : '--°';
      document.getElementById('weather-desc').textContent = w.desc || '';
      document.getElementById('weather-extra').textContent = w.extra || '';
      setWeatherIconColor(document.getElementById('weather-i'), w.desc);

      // Forecast weather columns
      const forecastWeather = w.forecast_weather || [];
      
      // First forecast day
      const fw1 = forecastWeather.length > 0 ? forecastWeather[0] : null;
      const heading1 = document.getElementById('fcast-heading-1');
      const icon1 = document.getElementById('fcast-icon-1');
      const temp1 = document.getElementById('fcast-temp-1');
      const desc1 = document.getElementById('fcast-desc-1');
      const extra1 = document.getElementById('fcast-extra-1');
      if (fw1 && tomorrow) {
        heading1.textContent = getDayName(tomorrow.date);
        icon1.className = fw1.icon_class;
        temp1.textContent = fw1.temp != null ? fw1.temp.toFixed(0) + '°C' : '--°';
        desc1.textContent = fw1.desc || '';
        extra1.textContent = fw1.extra || '';
        setWeatherIconColor(icon1, fw1.desc);
        document.getElementById('forecast-weather-1').style.display = '';
      } else {
        document.getElementById('forecast-weather-1').style.display = 'none';
      }

      // Second forecast day
      const fw2 = forecastWeather.length > 1 ? forecastWeather[1] : null;
      const heading2 = document.getElementById('fcast-heading-2');
      const icon2 = document.getElementById('fcast-icon-2');
      const temp2 = document.getElementById('fcast-temp-2');
      const desc2 = document.getElementById('fcast-desc-2');
      const extra2 = document.getElementById('fcast-extra-2');
      if (fw2 && nextDay) {
        heading2.textContent = getDayName(nextDay.date);
        icon2.className = fw2.icon_class;
        temp2.textContent = fw2.temp != null ? fw2.temp.toFixed(0) + '°C' : '--°';
        desc2.textContent = fw2.desc || '';
        extra2.textContent = fw2.extra || '';
        setWeatherIconColor(icon2, fw2.desc);
        document.getElementById('forecast-weather-2').style.display = '';
      } else {
        document.getElementById('forecast-weather-2').style.display = 'none';
      }
    }

    // Sparkline – 7 AM to 7 PM
    const historyRes = await fetch('/api/history?days=1');
    const historyData = await historyRes.json();
    const actualPoints = historyData
      .filter(d => {
        const date = new Date(d.timestamp);
        return date.toLocaleDateString('en-CA') === todayDate && date.getHours() >= 7 && date.getHours() <= 19;
      })
      .map(d => ({ x: d.timestamp, y: d.solar_kw }));

    const intervals = [];
    const intervalLabels = [];
    for (let h = 7; h <= 19; h += 0.5) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(h), (h % 1) * 60, 0);
      intervals.push(start.getTime());
      intervalLabels.push(start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
    }

    const actualByInterval = {};
    actualPoints.forEach(p => {
      const d = new Date(p.x);
      const hour = d.getHours();
      const minute = d.getMinutes();
      const bucketMinute = Math.floor(minute / 30) * 30;
      const bucketTime = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, bucketMinute, 0).getTime();
      if (!actualByInterval[bucketTime]) actualByInterval[bucketTime] = [];
      actualByInterval[bucketTime].push(p.y);
    });

    const actualData = intervals.map(ts => {
      const values = actualByInterval[ts] || [];
      if (values.length === 0) return null;
      return { x: ts, y: values.reduce((a,b) => a+b, 0) / values.length };
    }).filter(p => p !== null && p.x <= now.getTime());

    const forecastHourly = data.hourly
      .filter(h => {
        const d = new Date(h.period_end);
        return d.toISOString().startsWith(todayDate) && d.getHours() >= 7 && d.getHours() <= 19;
      })
      .map(h => ({ x: new Date(h.period_end).getTime(), y: h.pv_estimate }));

    const forecastByInterval = {};
    forecastHourly.forEach(p => {
      const d = new Date(p.x);
      const hour = d.getHours();
      const minute = d.getMinutes();
      const bucketMinute = Math.floor(minute / 30) * 30;
      const bucketTime = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, bucketMinute, 0).getTime();
      forecastByInterval[bucketTime] = p.y;
    });

    // Mobile table
    const tbody = document.getElementById('pv-hourly-body');
    if (tbody) {
      tbody.innerHTML = '';
      intervals.forEach((ts, i) => {
        const timeLabel = intervalLabels[i];
        const actualVal = actualData.find(a => a.x === ts);
        const forecastVal = forecastByInterval[ts] !== undefined ? forecastByInterval[ts] : 0;
        const actualKw = actualVal ? actualVal.y.toFixed(1) : '-';
        const row = document.createElement('tr');
        row.innerHTML = `<td>${timeLabel}</td><td>${actualKw}</td><td>${forecastVal.toFixed(1)}</td>`;
        tbody.appendChild(row);
      });
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const actualColor = '#3b82f6';
    const forecastColor = isDark ? '#fbbf24' : '#d97706';

    sparklineChart.data.datasets = [
      { label: 'Actual', data: actualData, borderColor: actualColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false, borderDash: [] },
      { label: 'Forecast', data: forecastHourly, borderColor: forecastColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, borderDash: [5,5] }
    ];

    const ctx = sparklineChart.ctx;
    const chartArea = sparklineChart.chartArea;
    if (chartArea && sparklineChart.data.datasets[1].data.length > 0) {
      const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
      const hex = forecastColor;
      const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
      gradient.addColorStop(0, `rgba(${r},${g},${b},0.1)`);
      gradient.addColorStop(0.5, `rgba(${r},${g},${b},0.3)`);
      gradient.addColorStop(1, `rgba(${r},${g},${b},0.5)`);
      sparklineChart.data.datasets[1].backgroundColor = gradient;
    }

    sparklineChart.options.scales.x.min = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7,0,0).getTime();
    sparklineChart.options.scales.x.max = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19,0,0).getTime();
    sparklineChart.options.scales.y.max = systemCapacityKwp || undefined;
    sparklineChart.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#0f172a';
    sparklineChart.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#0f172a';
    sparklineChart.options.plugins.legend.labels.color = isDark ? '#f8fafc' : '#0f172a';
    sparklineChart.update();

    updateNowGauge();

    try {
      const cfgRes = await fetch('/api/public-config');
      const cfg = await cfgRes.json();
      systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
    } catch(e) {}
  } catch (e) {
    console.error('Forecast error:', e);
    banner.style.display = 'none';
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  const battArrow = document.querySelector('.flow-arrow.battery');
  const gridArrow = document.querySelector('.flow-arrow.grid');
  const gridToBatt = document.getElementById('grid-to-battery');

  if (solar > 0) { solarArrow.style.color = 'var(--solar)'; solarArrow.classList.add('flowing'); solarArrow.textContent = '→'; }
  else { solarArrow.style.color = 'var(--text-secondary)'; solarArrow.classList.remove('flowing'); solarArrow.textContent = '→'; }

  const isCharging = battCharge > battDischarge;
  const isDischarging = battDischarge > battCharge;
  const isGridChargingBattery = gridImport > 0 && isCharging;
  const isSolarChargingBattery = solar > 0 && isCharging && !isGridChargingBattery;

  if (isDischarging) { battArrow.style.color = '#f59e0b'; battArrow.textContent = '→'; }
  else if (isCharging) {
    if (isGridChargingBattery) { battArrow.style.color = 'var(--grid)'; battArrow.textContent = '←'; }
    else { battArrow.style.color = isSolarChargingBattery ? 'var(--solar)' : 'var(--battery)'; battArrow.textContent = '→'; }
  } else { battArrow.style.color = 'var(--text-secondary)'; battArrow.textContent = '⇄'; }

  if (gridImport > gridExport) { gridArrow.style.color = 'var(--grid)'; gridArrow.textContent = '←'; }
  else if (gridExport > gridImport) { gridArrow.style.color = '#3b82f6'; gridArrow.textContent = '→'; }
  else { gridArrow.style.color = 'var(--text-secondary)'; gridArrow.textContent = '⇄'; }

  if (isGridChargingBattery) gridToBatt.style.display = 'block';
  else gridToBatt.style.display = 'none';
}

async function updateGridStatus() {
  try {
    const res = await fetch('/api/grid/status');
    const d = await res.json();
    if (!d.configured) {
      document.getElementById('grid-state').textContent = 'Not configured';
      return;
    }
    document.getElementById('grid-state').textContent = d.current ? '⚡ ON' : '⚫ OFF';
    document.getElementById('grid-state').style.color = d.current ? 'var(--battery)' : 'var(--grid)';
    document.getElementById('grid-last-on').textContent = d.lastOn ? new Date(d.lastOn).toLocaleString() : 'Never';
    document.getElementById('grid-last-off').textContent = d.lastOff ? new Date(d.lastOff).toLocaleString() : 'Never';

    const periods = ['day', 'week', 'month', 'year'];
    for (const p of periods) {
      const hRes = await fetch(`/api/grid/hours?period=${p}`);
      const hData = await hRes.json();
      document.getElementById(`grid-hours-${p}`).textContent = formatHoursToHM(hData.hours);
    }
  } catch (e) { console.error('Grid error:', e); }
}

async function updateChart(days = 1) {
  try {
    const res = await fetch(`/api/history?days=${days}`);
    const data = await res.json();
    if (!data.length) return;

    let timeUnit = 'hour';
    if (days >= 7) timeUnit = 'day';
    if (days >= 30) timeUnit = 'week';
    powerChart.options.scales.x.time.unit = timeUnit;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newDatasets = [
      { label: 'Load', data: [], borderColor: isDark ? '#8b5cf6' : '#7c3aed', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Solar PV', data: [], borderColor: isDark ? '#fbbf24' : '#d97706', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Battery Charge', data: [], borderColor: isDark ? '#10b981' : '#059669', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Battery Discharge', data: [], borderColor: '#f59e0b', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Grid Import', data: [], borderColor: isDark ? '#ef4444' : '#dc2626', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Grid Export', data: [], borderColor: '#3b82f6', tension: 0.4, borderWidth: 1, fill: true }
    ];
    newDatasets.forEach(ds => { ds.hidden = (visibilityPrefs[ds.label] === false); });
    data.forEach(d => {
      newDatasets[0].data.push({ x: d.timestamp, y: d.consumption_kw });
      newDatasets[1].data.push({ x: d.timestamp, y: d.solar_kw });
      newDatasets[2].data.push({ x: d.timestamp, y: d.battery_charge_kw });
      newDatasets[3].data.push({ x: d.timestamp, y: d.battery_discharge_kw });
      newDatasets[4].data.push({ x: d.timestamp, y: d.grid_import_kw });
      newDatasets[5].data.push({ x: d.timestamp, y: d.grid_export_kw });
    });
    powerChart.data.datasets = newDatasets;
    powerChart.update();
    applyGradientFills(powerChart);
  } catch (e) { console.error(e); }
}

async function updateEnergyBarChart() {
  try {
    const res = await fetch('/api/daily?days=7');
    const data = await res.json();
    if (!data.length) return;
    const labels = data.map(d => {
      const date = new Date(d.day + 'T00:00:00');
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });
    energyBarChart.data.labels = labels;
    energyBarChart.data.datasets[0].data = data.map(d => d.solar_kwh);
    energyBarChart.data.datasets[1].data = data.map(d => d.grid_import_kwh);
    energyBarChart.data.datasets[2].data = data.map(d => d.consumption_kwh);
    energyBarChart.update();
  } catch (e) { console.error('Energy bar chart error:', e); }
}

async function updateMonthlyTable() {
  try {
    const res = await fetch('/api/monthly');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tbody = document.getElementById('monthly-table-body');
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.month}</td><td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td><td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td><td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Monthly table error:', e);
    document.getElementById('monthly-table-body').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--grid);">Error loading data</td></tr>';
  }
}

async function updateDailyTable() {
  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    const tbody = document.getElementById('daily-table-body');
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const date = new Date(row.day + 'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formattedDate}</td><td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td><td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td><td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error('Daily table error:', e); }
}

async function loadBranding() {
  try {
    const res = await fetch('/api/public-config');
    const cfg = await res.json();
    if (cfg.dashboard_title) { document.getElementById('dashboard-title').textContent = cfg.dashboard_title; document.title = cfg.dashboard_title; }
    if (cfg.dashboard_logo) { document.getElementById('logo-img').src = cfg.dashboard_logo; document.getElementById('logo-img').style.display = 'inline'; }
    if (cfg.solar_capacity_kwp) systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
  } catch (e) {}
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const themeToggle = document.getElementById('theme-toggle');
  if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.innerHTML = '<span class="theme-icon">☀️</span>';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    themeToggle.innerHTML = '<span class="theme-icon">🌙</span>';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  document.getElementById('theme-toggle').innerHTML = newTheme === 'dark' ? '<span class="theme-icon">☀️</span>' : '<span class="theme-icon">🌙</span>';
  updateChartColors();
  if (powerChart) applyGradientFills(powerChart);
  updateForecast();
}

function updateChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  if (powerChart) {
    powerChart.options.scales.x.grid.color = gridColor;
    powerChart.options.scales.y.grid.color = gridColor;
    powerChart.options.plugins.legend.labels.color = textColor;
    powerChart.data.datasets.forEach((ds, i) => {
      if (i === 0) ds.borderColor = isDark ? '#8b5cf6' : '#7c3aed';
      else if (i === 1) ds.borderColor = isDark ? '#fbbf24' : '#d97706';
      else if (i === 2) ds.borderColor = isDark ? '#10b981' : '#059669';
      else if (i === 3) ds.borderColor = '#f59e0b';
      else if (i === 4) ds.borderColor = isDark ? '#ef4444' : '#dc2626';
      else if (i === 5) ds.borderColor = '#3b82f6';
    });
    powerChart.update();
    applyGradientFills(powerChart);
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = gridColor;
    energyBarChart.options.scales.y.grid.color = gridColor;
    energyBarChart.options.plugins.legend.labels.color = textColor;
    energyBarChart.update();
  }
}

document.getElementById('toggle-daily-details').addEventListener('click', () => {
  document.getElementById('daily-breakdown-content').classList.toggle('collapsed');
  document.getElementById('toggle-daily-details').classList.toggle('collapsed');
});
document.getElementById('toggle-monthly-details').addEventListener('click', () => {
  document.getElementById('monthly-breakdown-content').classList.toggle('collapsed');
  document.getElementById('toggle-monthly-details').classList.toggle('collapsed');
});
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.querySelectorAll('.chart-controls button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    e.target.classList.add('active');
    updateChart(1);
  });
});

initTheme();
initCharts();
loadBranding().then(() => {
  updateCurrent();
  updateSavings();
  updateForecast();
  updateGridStatus();
  updateChart(1);
  updateEnergyBarChart();
  updateDailyTable();
  updateMonthlyTable();
});
setInterval(() => {
  updateCurrent();
  updateSavings();
  updateForecast();
  updateGridStatus();
  updateChart(1);
  updateEnergyBarChart();
  updateDailyTable();
  updateMonthlyTable();
}, 30000);
