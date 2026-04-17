// Theme handling
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('theme-toggle').innerHTML = '<span class="theme-icon">☀️</span>';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('theme-toggle').innerHTML = '<span class="theme-icon">🌙</span>';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  document.getElementById('theme-toggle').innerHTML = newTheme === 'dark' 
    ? '<span class="theme-icon">☀️</span>' 
    : '<span class="theme-icon">🌙</span>';
  
  // Update chart colors to match new theme
  updateChartColors();
}

function updateChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  
  if (powerChart) {
    powerChart.options.scales.x.grid.color = gridColor;
    powerChart.options.scales.y.grid.color = gridColor;
    powerChart.options.plugins.legend.labels.color = textColor;
    powerChart.update();
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = gridColor;
    energyBarChart.options.scales.y.grid.color = gridColor;
    energyBarChart.options.plugins.legend.labels.color = textColor;
    energyBarChart.update();
  }
}

// Charts initialization and other functions remain the same as before...
// (Include all the existing functions: initCharts, updateCurrent, updateFlowArrows, 
//  updateGridStatus, updateChart, updateEnergyBarChart, updateMonthly, loadBranding)

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
        line: { borderWidth: 1.5, tension: 0.3 },
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

// [Rest of the functions unchanged: updateCurrent, updateFlowArrows, updateGridStatus,
//  updateChart, updateEnergyBarChart, updateMonthly, loadBranding, event listeners, intervals]

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
    const savings = (d.daily_solar_kwh * rate).toFixed(2);
    document.getElementById('savings').textContent = `${savings} ${currency}`;
  } catch (e) {
    console.error(e);
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  if (solar > 0) {
    solarArrow.style.color = 'var(--solar)';
    solarArrow.classList.add('flowing');
  } else {
    solarArrow.style.color = 'var(--text-secondary)';
    solarArrow.classList.remove('flowing');
  }

  const battArrow = document.querySelector('.flow-arrow.battery');
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

  const gridArrow = document.querySelector('.flow-arrow.grid');
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

  const gridToBatt = document.getElementById('grid-to-battery');
  if (gridImport > 0 && battCharge > battDischarge && battCharge > 0) {
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
      { label: 'Load', data: [], borderColor: isDark ? '#8b5cf6' : '#7c3aed', backgroundColor: isDark ? '#8b5cf620' : '#7c3aed20', tension: 0.3, borderWidth: 1.5 },
      { label: 'Solar PV', data: [], borderColor: isDark ? '#fbbf24' : '#d97706', backgroundColor: isDark ? '#fbbf2420' : '#d9770620', tension: 0.3, borderWidth: 1.5 },
      { label: 'Battery Charge', data: [], borderColor: isDark ? '#10b981' : '#059669', backgroundColor: isDark ? '#10b98120' : '#05966920', tension: 0.3, borderWidth: 1.5 },
      { label: 'Battery Discharge', data: [], borderColor: '#f59e0b', backgroundColor: '#f59e0b20', tension: 0.3, borderWidth: 1.5 },
      { label: 'Grid Import', data: [], borderColor: isDark ? '#ef4444' : '#dc2626', backgroundColor: isDark ? '#ef444420' : '#dc262620', tension: 0.3, borderWidth: 1.5 },
      { label: 'Grid Export', data: [], borderColor: '#3b82f6', backgroundColor: '#3b82f620', tension: 0.3, borderWidth: 1.5 }
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

async function updateMonthly() {
  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    const tbody = document.querySelector('#monthly-table tbody');
    tbody.innerHTML = '';
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    data.forEach(row => {
      const [year, month] = row.month.split('-');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${monthNames[parseInt(month) - 1]} ${year.slice(2)}</td>
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
    console.error(e);
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

// Event listeners
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

document.querySelectorAll('.chart-controls button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    e.target.classList.add('active');
    const days = parseInt(e.target.dataset.range);
    updateChart(days);
  });
});

// Initialize
initTheme();
initCharts();
updateCurrent();
updateGridStatus();
updateChart(1);
updateEnergyBarChart();
updateMonthly();
loadBranding();

setInterval(() => {
  updateCurrent();
  updateGridStatus();
  updateChart(1);
  updateEnergyBarChart();
}, 30000);
