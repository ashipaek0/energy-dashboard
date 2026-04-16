let powerChart;
const ctx = document.getElementById('powerChart').getContext('2d');

function initChart() {
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'hour' },
          grid: { color: '#334155' }
        },
        y: {
          title: { display: true, text: 'Power (kW)' },
          grid: { color: '#334155' }
        }
      },
      plugins: {
        tooltip: { mode: 'index' },
        legend: { labels: { color: '#f8fafc' } }
      }
    }
  });
}

async function updateCurrent() {
  try {
    const res = await fetch('/api/current');
    const d = await res.json();

    // Flow card
    document.getElementById('flow-solar').textContent = Math.round(d.solar_kw * 1000) + ' W';
    const batterySoc = d.battery_soc || 0;
    document.getElementById('flow-battery-soc').textContent = batterySoc.toFixed(1) + '%';
    const battNet = d.battery_charge_kw - d.battery_discharge_kw;
    const battSign = battNet >= 0 ? '⚡' : '🔋';
    document.getElementById('flow-battery-power').innerHTML = `${battSign} ${Math.abs(Math.round(battNet * 1000))} W`;
    document.getElementById('flow-home').textContent = Math.round(d.consumption_kw * 1000) + ' W';
    const gridNet = d.grid_import_kw - d.grid_export_kw;
    const gridDir = gridNet >= 0 ? 'Import' : 'Export';
    document.getElementById('flow-grid').textContent = Math.abs(Math.round(gridNet * 1000)) + ' W';
    document.getElementById('flow-grid-direction').textContent = gridDir;

    // Stats
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

    const datasets = [
      { label: 'Load', data: [], borderColor: '#8b5cf6', backgroundColor: '#8b5cf620', tension: 0.2 },
      { label: 'Solar PV', data: [], borderColor: '#fbbf24', backgroundColor: '#fbbf2420', tension: 0.2 },
      { label: 'Battery Charge', data: [], borderColor: '#10b981', backgroundColor: '#10b98120', tension: 0.2, hidden: true },
      { label: 'Battery Discharge', data: [], borderColor: '#f59e0b', backgroundColor: '#f59e0b20', tension: 0.2, hidden: true },
      { label: 'Grid Import', data: [], borderColor: '#ef4444', backgroundColor: '#ef444420', tension: 0.2, hidden: true },
      { label: 'Grid Export', data: [], borderColor: '#3b82f6', backgroundColor: '#3b82f620', tension: 0.2, hidden: true }
    ];

    data.forEach(d => {
      datasets[0].data.push({ x: d.timestamp, y: d.consumption_kw });
      datasets[1].data.push({ x: d.timestamp, y: d.solar_kw });
      datasets[2].data.push({ x: d.timestamp, y: d.battery_charge_kw });
      datasets[3].data.push({ x: d.timestamp, y: d.battery_discharge_kw });
      datasets[4].data.push({ x: d.timestamp, y: d.grid_import_kw });
      datasets[5].data.push({ x: d.timestamp, y: d.grid_export_kw });
    });

    powerChart.data.datasets = datasets;
    powerChart.update();
  } catch (e) {
    console.error(e);
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
  btn.addEventListener('click', () => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    btn.classList.add('active');
    updateChart(parseInt(btn.dataset.range));
  });
});

initChart();
updateCurrent();
updateGridStatus();
updateChart(1);
updateMonthly();
loadBranding();

setInterval(() => {
  updateCurrent();
  updateGridStatus();
  updateChart(1);
}, 30000);
