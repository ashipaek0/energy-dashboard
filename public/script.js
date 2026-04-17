let powerChart;
let energyBarChart;
const ctxPower = document.getElementById('powerChart').getContext('2d');
const ctxEnergy = document.getElementById('energyBarChart').getContext('2d');

const visibilityPrefs = {
  'Load': true,
  'Solar PV': true,
  'Battery Charge': false,
  'Battery Discharge': false,
  'Grid Import': false,
  'Grid Export': false
};

function formatCurrency(amount, currency) {
  return currency + ' ' + amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function initCharts() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';

  powerChart = new Chart(ctxPower, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' },
      elements: {
        line: { borderWidth: 1.5, tension: 0.3, fill: true },
        point: { radius: 0, hoverRadius: 4 }
      },
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
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Solar Generated', backgroundColor: '#d97706', data: [] },
        { label: 'Grid Imported', backgroundColor: '#dc2626', data: [] },
        { label: 'Energy Consumed', backgroundColor: '#7c3aed', data: [] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: gridColor } },
        y: { title: { display: true, text: 'Energy (kWh)', color: textColor }, grid: { color: gridColor }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: textColor } },
        tooltip: { mode: 'index' }
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

    const solar = Math.round(d.solar_kw * 1000);
    const consumption = Math.round(d.consumption_kw * 1000);
    const battCharge = Math.round(d.battery_charge_kw * 1000);
    const battDischarge = Math.round(d.battery_discharge_kw * 1000);
    const gridImport = Math.round(d.grid_import_kw * 1000);
    const gridExport = Math.round(d.grid_export_kw * 1000);
    const battSoc = d.battery_soc || 0;

    document.getElementById('flow-solar').textContent = solar + ' W';
    document.getElementById('flow-battery-soc').textContent = battSoc.toFixed(1) + '%';

    const battNet = battCharge - battDischarge;
    const battSign = battNet >= 0 ? '↓' : '↑';
    const battColor = battNet >= 0 ? 'var(--battery)' : '#f59e0b';
    document.getElementById('flow-battery-power').innerHTML = `<span style="color:${battColor}">${battSign} ${Math.abs(battNet)} W</span>`;

    document.getElementById('flow-home').textContent = consumption + ' W';

    const gridNet = gridImport - gridExport;
    const gridDir = gridNet >= 0 ? 'Import' : 'Export';
    const gridColor = gridNet >= 0 ? 'var(--grid)' : '#3b82f6';
    document.getElementById('flow-grid').innerHTML = `<span style="color:${gridColor}">${Math.abs(gridNet)} W</span>`;
    document.getElementById('flow-grid-direction').textContent = gridDir;

    updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport);

    const cfgRes = await fetch('/api/public-config');
    const cfg = await cfgRes.json();
    const currency = cfg.savings_currency || '€';
    const rate = parseFloat(cfg.savings_rate) || 0.30;

    document.getElementById('daily-solar').textContent = d.daily_solar_kwh.toFixed(2) + ' kWh';
    document.getElementById('daily-load').textContent = d.daily_consumption_kwh.toFixed(2) + ' kWh';
    const sufficiency = d.daily_consumption_kwh > 0 ? (d.daily_solar_kwh / d.daily_consumption_kwh * 100).toFixed(1) : '0.0';
    document.getElementById('self-sufficiency').textContent = sufficiency + '%';

    const todaySavings = d.today_savings || (d.daily_solar_kwh * rate);
    const allTimeSavings = d.all_time_savings || 0;
    document.getElementById('savings').innerHTML = `
      <div style="font-size: 1.2rem;">${formatCurrency(todaySavings, currency)}</div>
      <div style="font-size: 0.8rem; opacity: 0.7;">All-time: ${formatCurrency(allTimeSavings, currency)}</div>
    `;
  } catch (e) {
    console.error(e);
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  const battArrow = document.querySelector('.flow-arrow.battery');
  const gridArrow = document.querySelector('.flow-arrow.grid');
  const gridToBatt = document.getElementById('grid-to-battery');

  if (solar > 0) {
    solarArrow.style.color = 'var(--solar)';
    solarArrow.classList.add('flowing');
    solarArrow.textContent = '→';
  } else {
    solarArrow.style.color = 'var(--text-secondary)';
    solarArrow.classList.remove('flowing');
    solarArrow.textContent = '→';
  }

  if (battCharge > battDischarge) {
    battArrow.style.color = 'var(--battery)';
    battArrow.textContent = '↓';
  } else if (battDischarge > battCharge) {
    battArrow.style.color = '#f59e0b';
    battArrow.textContent = '↑';
  } else {
    battArrow.style.color = 'var(--text-secondary)';
    battArrow.textContent = '⇄';
  }

  if (gridImport > gridExport) {
    gridArrow.style.color = 'var(--grid)';
    gridArrow.textContent = '→';
  } else if (gridExport > gridImport) {
    gridArrow.style.color = '#3b82f6';
    gridArrow.textContent = '←';
  } else {
    gridArrow.style.color = 'var(--text-secondary)';
    gridArrow.textContent = '⇄';
  }

  const isGridChargingBattery = gridImport > 0 && battCharge > battDischarge && battCharge > 0;
  if (isGridChargingBattery) {
    gridToBatt.style.display = 'block';
  } else {
    gridToBatt.style.display = 'none';
  }
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
      document.getElementById(`grid-hours-${p}`).textContent = hData.hours.toFixed(1) + ' h';
    }
  } catch (e) {
    console.error('Grid error:', e);
  }
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
      { label: 'Load', data: [], borderColor: isDark ? '#8b5cf6' : '#7c3aed', tension: 0.3, borderWidth: 1.5, fill: true },
      { label: 'Solar PV', data: [], borderColor: isDark ? '#fbbf24' : '#d97706', tension: 0.3, borderWidth: 1.5, fill: true },
      { label: 'Battery Charge', data: [], borderColor: isDark ? '#10b981' : '#059669', tension: 0.3, borderWidth: 1.5, fill: true },
      { label: 'Battery Discharge', data: [], borderColor: '#f59e0b', tension: 0.3, borderWidth: 1.5, fill: true },
      { label: 'Grid Import', data: [], borderColor: isDark ? '#ef4444' : '#dc2626', tension: 0.3, borderWidth: 1.5, fill: true },
      { label: 'Grid Export', data: [], borderColor: '#3b82f6', tension: 0.3, borderWidth: 1.5, fill: true }
    ];

    newDatasets.forEach(ds => {
      const pref = visibilityPrefs[ds.label];
      ds.hidden = (pref === false);
    });

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
  } catch (e) {
    console.error(e);
  }
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
    const solar = data.map(d => d.solar_kwh);
    const grid = data.map(d => d.grid_import_kwh);
    const consumption = data.map(d => d.consumption_kwh);

    energyBarChart.data.labels = labels;
    energyBarChart.data.datasets[0].data = solar;
    energyBarChart.data.datasets[1].data = grid;
    energyBarChart.data.datasets[2].data = consumption;
    energyBarChart.update();
  } catch (e) {
    console.error('Energy bar chart error:', e);
  }
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
      tr.innerHTML = `
        <td>${row.month}</td>
        <td>${row.consumption_kwh.toFixed(1)} kWh</td>
        <td>${row.solar_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_charge_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_discharge_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_import_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_export_kwh.toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Monthly table error:', e);
    const tbody = document.getElementById('monthly-table-body');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--grid);">Error loading data</td></tr>';
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
      tr.innerHTML = `
        <td>${formattedDate}</td>
        <td>${row.consumption_kwh.toFixed(1)} kWh</td>
        <td>${row.solar_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_charge_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_discharge_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_import_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_export_kwh.toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Daily table error:', e);
  }
}

async function loadBranding() {
  try {
    const res = await fetch('/api/public-config');
    const cfg = await res.json();
    if (cfg.dashboard_title) {
      document.getElementById('dashboard-title').textContent = cfg.dashboard_title;
      document.title = cfg.dashboard_title;
    }
    if (cfg.dashboard_logo) {
      document.getElementById('logo-img').src = cfg.dashboard_logo;
      document.getElementById('logo-img').style.display = 'inline';
    }
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
  const themeToggle = document.getElementById('theme-toggle');
  themeToggle.innerHTML = newTheme === 'dark' 
    ? '<span class="theme-icon">☀️</span>' 
    : '<span class="theme-icon">🌙</span>';
  
  updateChartColors();
  if (powerChart) applyGradientFills(powerChart);
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
  const content = document.getElementById('daily-breakdown-content');
  const btn = document.getElementById('toggle-daily-details');
  content.classList.toggle('collapsed');
  btn.classList.toggle('collapsed');
});

document.getElementById('toggle-monthly-details').addEventListener('click', () => {
  const content = document.getElementById('monthly-breakdown-content');
  const btn = document.getElementById('toggle-monthly-details');
  content.classList.toggle('collapsed');
  btn.classList.toggle('collapsed');
});

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

document.querySelectorAll('.chart-controls button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    e.target.classList.add('active');
    const days = parseInt(e.target.dataset.range);
    updateChart(days);
  });
});

initTheme();
initCharts();
updateCurrent();
updateGridStatus();
updateChart(1);
updateEnergyBarChart();
updateDailyTable();
updateMonthlyTable();
loadBranding();

setInterval(() => {
  updateCurrent();
  updateGridStatus();
  updateChart(1);
  updateEnergyBarChart();
  updateDailyTable();
  updateMonthlyTable();
}, 30000);
