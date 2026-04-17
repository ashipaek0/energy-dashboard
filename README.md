# ⚡ Energy Dashboard

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant** and **MQTT**. Designed for public displays – no login required for viewing, while settings are password‑protected.

![Energy Dashboard Screenshot 1](https://github.com/user-attachments/assets/c3d12473-7d3b-4493-a01d-7d128b84e582)
![Energy Dashboard Screenshot 2](https://github.com/user-attachments/assets/f8ab9a0a-4432-43f6-962c-6b0d6e4abf4b)
![Energy Dashboard Screenshot 3](https://github.com/user-attachments/assets/a4a8ede7-925f-45e0-9fa1-62b75e573541)
![Energy Dashboard Screenshot 4](https://github.com/user-attachments/assets/4f921b49-2ab9-44f2-bca9-14a016b40e26)

## ✨ Features

- **Live Flow Card** – Animated arrows show power flowing between Solar, Battery, Home, and Grid.
- **Real‑time Stats** – Current power (W), battery state of charge (%), daily totals (kWh), self‑sufficiency, and cost savings.
- **Grid Status Tracking** – Displays current grid state (ON/OFF), uptime hours (day/week/month/year), and last change timestamps.
- **Historical Charts**
  - Power Overview (line chart) – 24h, 7d, 30d, 90d with smooth gradient fills.
  - Daily Energy Bar Chart – Solar generated, grid imported, and energy consumed for the last 7 days.
- **Data Tables**
  - **Last 30 Days** – Collapsible table with daily totals for load, solar, battery, and grid.
  - **Last 12 Months** – Collapsible table with monthly energy breakdown.
- **Light / Dark Mode** – Toggle manually or follow system preference; choice is saved.
- **Fully Configurable UI**
  - Set dashboard title and logo.
  - Configure savings currency and rate.
- **Multiple Data Sources**
  - **Home Assistant** – Pull sensor data via REST API (long‑lived token).
  - **MQTT** – Subscribe to topics for real‑time updates.
  - Enable/disable each source independently.
- **Entity Auto‑Discovery** – Fetch sensor list from Home Assistant and map via dropdowns.
- **Connection Testing** – Verify MQTT broker and topics before saving.
- **Backup & Restore** – Download the entire SQLite database (settings + history) and restore it later.
- **Responsive Design** – Works on mobile, tablet, and desktop.

## 🚀 Quick Start (Docker)

The easiest way to run the dashboard is with Docker Compose.

### 1. Clone the Repository

```bash
git clone https://github.com/ashipaek0/energy-dashboard.git
cd energy-dashboard
```

### 2. Set the Settings Password

Edit `docker-compose.yml` and change the `SETTINGS_PASSWORD` environment variable:

```yaml
environment:
  - SETTINGS_PASSWORD=your_secure_password_here
```

### 3. Start the Container

```bash
docker compose up -d --build
```

The dashboard will be available at `http://localhost:3000` (or your server's IP).

### 4. Configure Data Sources

1. Open `http://your-server-ip:3000/settings`
2. Log in with username `admin` and the password you set.
3. Configure Home Assistant:
   - Enter your Home Assistant URL (e.g., `http://homeassistant.local:8123`)
   - Generate and paste a Long‑Lived Access Token from your Home Assistant profile
4. Click **Fetch Entities from HA** to load all available sensors
5. Map each measurement (consumption, solar, battery, grid, etc.) to the appropriate sensor
6. Optionally enable MQTT and fill in broker details and topics
7. Customize Savings Calculation (currency and rate) and Branding (title and logo)
8. Click **Save All Settings**

The dashboard will immediately begin displaying data.

## 🔧 Configuration Details

### Home Assistant

- **URL**: Your Home Assistant instance (e.g., `http://homeassistant.local:8123`)
- **Token**: Generate a Long‑Lived Access Token in your Home Assistant profile

**Entities**: After fetching, select the sensors for:

- **Power (Watts)**: consumption, solar, battery charge/discharge, grid import/export
- **Battery SOC (%)**: battery state of charge
- **Grid status**: binary sensor – ON/OFF
- **Daily energy (kWh)**: must reset at midnight (use utility meter or Riemann sum integral sensors)

### MQTT

- **Broker URL**: `mqtt://your-broker:1883`
- **Username / Password**: Optional
- **Topics**: Map each measurement to its MQTT topic. Leave empty to skip.

All settings are stored in a SQLite database (`./data/energy.db`) and persist across container restarts.

## 💾 Backup & Restore

The settings page includes a Backup & Restore section:

- **Download Backup** – Saves the entire database as a `.db` file.
- **Restore Backup** – Upload a previously saved `.db` file to restore all settings and historical data.

This is especially useful before reinstalling or migrating the dashboard.

## 📊 Dashboard Usage

- **Public View**: `http://your-server:3000/` – No login required
- **Settings**: `http://your-server:3000/settings` – Protected by HTTP Basic Auth (`admin` / your password)

Data refreshes automatically every 30 seconds without page reload.

## 🐳 Docker Image on Docker Hub

A pre‑built image is available on Docker Hub:

```
ashipaek0/energy-dashboard:latest
```

You can use it directly in your `docker-compose.yml`:

```yaml
services:
  energy-dashboard:
    image: irunmole/energy-dashboard:latest
    container_name: energy-dashboard
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - SETTINGS_PASSWORD=your_secure_password_here
```

## 🔄 Automatic Updates (CI/CD)

This repository includes a GitHub Actions workflow that automatically builds and pushes a Docker image to Docker Hub on every push to main.

To automatically update the running container on your server, add Watchtower to your `docker-compose.yml`:

```yaml
watchtower:
  image: containrrr/watchtower
  container_name: watchtower
  restart: unless-stopped
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  command: --interval 300 energy-dashboard
```

Watchtower will check for new images every 5 minutes and restart the container when an update is available.

## 🛠️ Development / Manual Installation

If you prefer to run without Docker:

```bash
npm install
npm start
```

The server listens on port 3000. A SQLite database will be created in `./data`.

## 📁 Project Structure

```
energy-dashboard/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js          # Express backend + SQLite + polling
├── public/
│   ├── index.html     # Main dashboard UI
│   ├── style.css      # Light/dark theme styles
│   ├── script.js      # Charts, flow card, tables
│   ├── settings.html  # Protected configuration page
│   └── settings.js    # Settings logic + backup/restore
├── .env.example
└── README.md
```

## ❓ Troubleshooting

### All values show zero

- Ensure at least one data source is enabled and correctly configured
- Use the **Test MQTT Broker Connection** and **Test Topic** buttons in settings to verify connectivity
- For Home Assistant, verify the token has read access to the selected entities

### Daily energy values grow exponentially

- The sensors selected for Daily Energy must reset to zero at midnight
- Use Home Assistant's Utility Meter or Riemann sum integration to create resetting sensors

### Grid status shows "Not configured"

- Select a binary sensor in the settings that reports grid availability (e.g., `binary_sensor.grid_status`)

### Login popup appears on main page

- This was fixed in recent versions
- If you still see it, clear your browser cache or test in incognito mode

## 📄 License

GNU General License – see LICENSE file for details.

## 🙌 Acknowledgements

Built with Express, Chart.js, SQLite, and MQTT.js.

Happy monitoring! ☀️🔋🏠

