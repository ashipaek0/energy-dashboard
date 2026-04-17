let powerChart;
let energyBarChart;
const ctxPower = document.getElementById('powerChart').getContext('2d');
const ctxEnergy = document.getElementById('energyBarChart').getContext('2d');

function initCharts() {
  // Power line chart
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
        x: { type: 'time', time: { unit: 'hour' }, grid: { color: '#334155' } },
        y: { title: { display: true, text: 'Power (kW)' }, grid: { color: '#334155' } }
      },
      plugins: {
        tooltip: { mode: 'index' },
        legend: { labels: { color: '#f8fafc' } }
      }
    }
  });

  // Energy bar chart
  energyBarChart = new Chart(ctxEnergy, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Solar Generated', backgroundColor: '#fbbf24', data: [] },
        { label: 'Grid Imported', backgroundColor: '#ef4444', data: [] },
        { label: 'Energy Consumed', backgroundColor: '#8b5cf6', data: [] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: '#334155' } },
        y: { title: { display: true, text: 'Energy (kWh)' }, grid: { color: '#334155' }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: '#f8fafc' } },
        tooltip: { mode: 'index' }
      }
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
    const battColor = battNet >= 0 ? '#10b981' : '#f59e0b';
    document.getElementById('flow-battery-power').innerHTML = `<span style="color:${battColor}">${battSign} ${Math.abs(battNet)} W</span>`;

    document.getElementById('flow-home').textContent = consumption + ' W';

    const gridNet = gridImport - gridExport;
    const gridDir = gridNet >= 0 ? 'Import' : 'Export';
    const gridColor = gridNet >= 0 ? '#ef4444' : '#3b82f6';
    document.getElementById('flow-grid').innerHTML = `<span style="color:${gridColor}">${Math.abs(gridNet)} W</span>`;
    document.getElementById('flow-grid-direction').textContent = gridDir;

    updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport);

    document.getElementById('daily-solar').textContent = d.daily_solar_kwh.toFixed(2) + ' kWh';
    document.getElementById('daily-load').textContent = d.daily_consumption_kwh.toFixed(2) + ' kWh';
    const sufficiency = d.daily_consumption_kwh > 0 ? (d.daily_solar_kwh / d.daily_consumption_kwh * 100).toFixed(1) : '0.0';
    document.getElementById('self-sufficiency').textContent = sufficiency + '%';
    const currency = d.savings_currency || '€';
    const rate = d.savings_rate || 0.30;
    const savings = (d.daily_solar_kwh * rate).toFixed(2);
    document.getElementById('savings').textContent = `${savings} ${currency}`;
  } catch (e) {
    console.error(e);
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  if (solar > 0) {
    solarArrow.style.color = '#fbbf24';
    solarArrow.classList.add('flowing');
  } else {
    solarArrow.style.color = '#64748b';
    solarArrow.classList.remove('flowing');
  }

  const battArrow = document.querySelector('.flow-arrow.battery');
  if (battCharge > battDischarge) {
    battArrow.style.color = '#10b981';
    battArrow.textContent = '↓';
  } else if (battDischarge > battCharge) {
    battArrow.style.color = '#f59e0b';
    battArrow.textContent = '↑';
  } else {
    battArrow.style.color = '#64748b';
    battArrow.textContent = '⇄';
  }

  const gridArrow = document.querySelector('.flow-arrow.grid');
  if (gridImport > gridExport) {
    gridArrow.style.color = '#ef4444';
    gridArrow.textContent = '→';
  } else if (gridExport > gridImport) {
    gridArrow.style.color = '#3b82f6';
    gridArrow.textContent = '←';
  } else {
    gridArrow.style.color = '#64748b';
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
    document.getElementById('grid-state').style.color = d.current ? '#10b981' : '#ef4444';
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

    // Preserve existing dataset hidden states
    const existingDatasets = powerChart.data.datasets || [];
    const hiddenState = existingDatasets.map(ds => ds.hidden || false);

    const newDatasets = [
      { label: 'Load', data: [], borderColor: '#8b5cf6', backgroundColor: '#8b5cf620', tension: 0.3, borderWidth: 1.5 },
      { label: 'Solar PV', data: [], borderColor: '#fbbf24', backgroundColor: '#fbbf2420', tension: 0.3, borderWidth: 1.5 },
      { label: 'Battery Charge', data: [], borderColor: '#10b981', backgroundColor: '#10b98120', tension: 0.3, borderWidth: 1.5, hidden: true },
      { label: 'Battery Discharge', data: [], borderColor: '#f59e0b', backgroundColor: '#f59e0b20', tension: 0.3, borderWidth: 1.5, hidden: true },
      { label: 'Grid Import', data: [], borderColor: '#ef4444', backgroundColor: '#ef444420', tension: 0.3, borderWidth: 1.5, hidden: true },
      { label: 'Grid Export', data: [], borderColor: '#3b82f6', backgroundColor: '#3b82f620', tension: 0.3, borderWidth: 1.5, hidden: true }
    ];

    // Restore hidden state if number of datasets matches
    if (hiddenState.length === newDatasets.length) {
      newDatasets.forEach((ds, i) => { ds.hidden = hiddenState[i]; });
    }

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
    const res = await fetch('/api/settings');
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

document.querySelectorAll('.chart-controls button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    e.target.classList.add('active');
    const days = parseInt(e.target.dataset.range);
    updateChart(days);
  });
});

// Initialize
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
