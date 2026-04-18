const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const backupStatus = document.getElementById('backup-status');

function showStatus(element, msg, type) {
  element.textContent = msg;
  element.className = `status ${type}`;
  if (type !== 'info') {
    setTimeout(() => { element.textContent = ''; element.className = 'status'; }, 5000);
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    for (const [key, value] of Object.entries(data)) {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = value === 'true';
        } else {
          input.value = value;
        }
      }
    }
  } catch (e) {
    showStatus(saveStatus, 'Failed to load settings', 'error');
  }
}

async function fetchEntities() {
  const haUrl = form.querySelector('[name="ha_url"]').value.trim();
  const haToken = form.querySelector('[name="ha_token"]').value.trim();
  if (!haUrl || !haToken) {
    showStatus(saveStatus, 'Please enter HA URL and Token first', 'error');
    return;
  }
  showStatus(saveStatus, 'Fetching entities...', 'info');
  try {
    const res = await fetch(`/api/ha/entities?url=${encodeURIComponent(haUrl)}&token=${encodeURIComponent(haToken)}`);
    if (!res.ok) throw new Error('Failed to fetch');
    const entities = await res.json();
    const selects = form.querySelectorAll('select');
    selects.forEach(select => {
      const currentVal = select.value;
      select.innerHTML = '<option value="">-- Select entity --</option>';
      entities.sort().forEach(id => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        select.appendChild(option);
      });
      if (currentVal) select.value = currentVal;
    });
    showStatus(saveStatus, 'Entities loaded!', 'success');
  } catch (e) {
    showStatus(saveStatus, 'Error fetching entities: ' + e.message, 'error');
  }
}

document.getElementById('fetch-entities').addEventListener('click', fetchEntities);

// MQTT broker test
document.getElementById('test-mqtt').addEventListener('click', async function() {
  const btn = this;
  const statusEl = document.getElementById('mqtt-test-status');
  const broker = form.querySelector('[name="mqtt_broker_url"]').value.trim();
  const username = form.querySelector('[name="mqtt_username"]').value.trim();
  const password = form.querySelector('[name="mqtt_password"]').value.trim();
  
  if (!broker) {
    showStatus(statusEl, 'Please enter Broker URL', 'error');
    return;
  }
  
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Testing...';
  showStatus(statusEl, 'Testing connection...', 'info');
  
  const params = new URLSearchParams({ broker });
  if (username) params.append('username', username);
  if (password) params.append('password', password);
  
  try {
    const res = await fetch(`/api/test-mqtt?${params.toString()}`);
    const data = await res.json();
    if (res.ok) {
      showStatus(statusEl, '✅ Connected to MQTT broker!', 'success');
    } else {
      showStatus(statusEl, `❌ ${data.error}`, 'error');
    }
  } catch (e) {
    showStatus(statusEl, `❌ Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test MQTT Broker Connection';
  }
});

// MQTT topic test
document.getElementById('test-mqtt-topic').addEventListener('click', async function() {
  const btn = this;
  const statusEl = document.getElementById('topic-test-status');
  const broker = form.querySelector('[name="mqtt_broker_url"]').value.trim();
  const username = form.querySelector('[name="mqtt_username"]').value.trim();
  const password = form.querySelector('[name="mqtt_password"]').value.trim();
  const topic = document.getElementById('test-topic').value.trim();
  
  if (!broker) {
    showStatus(statusEl, 'Please enter Broker URL first', 'error');
    return;
  }
  if (!topic) {
    showStatus(statusEl, 'Please enter a topic to test', 'error');
    return;
  }
  
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Testing...';
  showStatus(statusEl, `Waiting for message on "${topic}"...`, 'info');
  
  const params = new URLSearchParams({ broker, topic });
  if (username) params.append('username', username);
  if (password) params.append('password', password);
  
  try {
    const res = await fetch(`/api/test-mqtt-topic?${params.toString()}`);
    const data = await res.json();
    if (res.ok) {
      if (data.value !== undefined && data.value !== null) {
        showStatus(statusEl, `✅ Received: ${data.value}`, 'success');
      } else {
        showStatus(statusEl, `✅ Received (non-numeric): ${data.raw}`, 'success');
      }
    } else {
      showStatus(statusEl, `❌ ${data.error}`, 'error');
    }
  } catch (e) {
    showStatus(statusEl, `❌ Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Topic';
  }
});

// Backup & Restore
document.getElementById('backup-btn').addEventListener('click', async function() {
  const btn = this;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Preparing backup...';
  showStatus(backupStatus, 'Generating backup file...', 'info');
  
  try {
    window.location.href = '/api/backup';
    showStatus(backupStatus, '✅ Backup download started', 'success');
  } catch (e) {
    showStatus(backupStatus, `❌ Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇️ Download Backup';
  }
});

document.getElementById('restore-btn').addEventListener('click', function() {
  document.getElementById('restore-file').click();
});

document.getElementById('restore-file').addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const btn = document.getElementById('restore-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Restoring...';
  showStatus(backupStatus, 'Uploading and restoring database...', 'info');
  
  const formData = new FormData();
  formData.append('dbfile', file);
  
  try {
    const res = await fetch('/api/restore', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      showStatus(backupStatus, '✅ Database restored successfully! Reloading...', 'success');
      setTimeout(() => { window.location.reload(); }, 2000);
    } else {
      showStatus(backupStatus, `❌ ${data.error}`, 'error');
    }
  } catch (e) {
    showStatus(backupStatus, `❌ Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆️ Restore Backup';
    document.getElementById('restore-file').value = '';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  ['ha_enabled', 'mqtt_enabled'].forEach(key => {
    data[key] = form.querySelector(`[name="${key}"]`)?.checked ? 'true' : 'false';
  });
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      showStatus(saveStatus, 'Settings saved successfully!', 'success');
    } else {
      showStatus(saveStatus, 'Failed to save settings', 'error');
    }
  } catch (e) {
    showStatus(saveStatus, 'Error: ' + e.message, 'error');
  }
});

loadSettings();
