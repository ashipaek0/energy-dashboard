# ⚡ Energy Dashboard

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant** and **MQTT**. Designed for public displays – no login required for viewing, while settings are password‑protected.

<img width="1491" height="883" alt="Screenshot From 2026-05-02 14-55-40" src="https://github.com/user-attachments/assets/0221c4a1-1171-4a19-82bd-2f8b1377faee" /> <img width="1491" height="883" alt="Screenshot From 2026-05-02 14-55-40" src="https://github.com/user-attachments/assets/f6f73095-382f-4461-969f-aa70b330bcb3" />



## ✨ Features

- **Live Flow Card** – Animated arrows show power flowing between Solar, Battery, Home, and Grid.
- **Real‑time Stats** – Current power (W), battery state of charge (%), daily totals (kWh), self‑sufficiency, and cost savings.
- **Grid Status Tracking** – Displays current grid state (ON/OFF), uptime hours (day/week/month/year).
- **Grid Timeline Bar** – A continuous 24‑hour bar showing grid ON/OFF segments with **hover tooltips** displaying the exact change timestamps.
- **Solar Forecast** – Predicts solar generation for the next 4 days using high‑accuracy **Solcast** (with API key) or free **Open‑Meteo** as fallback. Includes hourly chart and daily summary cards.
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
- **Connection Testing** – Verify MQTT broker, topics, and solar forecast before saving.
- **Backup & Restore** – Download the entire SQLite database (settings + history) and restore it later.
- **Responsive Design** – Works on mobile, tablet, and desktop.

## 🚀 Quick Start (Docker)

The easiest way to run the dashboard is with Docker Compose.

### 1. Clone the Repository

```bash
git clone https://github.com/ashipaek0/energy-dashboard.git
cd energy-dashboard
```

### 2. Create Environment File

Copy the example environment file and set a **strong password** for the settings page:

```bash
cp .env.example .env
nano .env   # or your favourite editor
```

Update the `SETTINGS_PASSWORD` value.  
*The `.env` file is excluded from version control, keeping your password safe.*

### 3. Start the Container

```bash
docker compose up -d --build
```

The dashboard will be available at `http://localhost:3000` (or your server's IP).

### 4. Configure Data Sources

1. Open `http://your-server-ip:3000/settings`
2. Log in with username `admin` and the password you set in the `.env` file.
3. Configure Home Assistant (URL and Long‑Lived Access Token).
4. Click **Fetch Entities from HA** to load all available sensors.
5. Map each measurement (consumption, solar, battery, grid, etc.) to the appropriate sensor.
6. Optionally enable MQTT and fill in broker details and topics.
7. Customise Savings Calculation (currency and rate) and Branding (title and logo).
8. Click **Save All Settings**.

The dashboard will immediately begin displaying data.

## 🔧 Configuration Details

### Home Assistant

- **URL**: Your Home Assistant instance (e.g., `http://homeassistant.local:8123`).
- **Token**: Generate a Long‑Lived Access Token in your Home Assistant profile.
- **Entities**: After fetching, select the sensors for:
  - Power (Watts): consumption, solar, battery charge/discharge, grid import/export.
  - Battery SOC (%).
  - Grid status (binary sensor – ON/OFF).
  - Daily energy (kWh) – the dashboard now **calculates daily totals internally** from your power sensors, so you don't need sensors that reset at midnight.

### MQTT

- **Broker URL**: `mqtt://your-broker:1883`
- **Username / Password**: Optional.
- **Topics**: Map each measurement to its MQTT topic. Leave empty to skip.

### Solar Forecast

- **Enable**: Toggle on to activate solar predictions.
- **Latitude / Longitude**: Your geographic coordinates.
- **Panel Tilt & Azimuth**: Angles of your solar array.
- **System Capacity (kWp)**: Total peak power in kilowatts (e.g., 2.7 for a 2700 W system).
- **Solcast API Key** (optional): If provided, high‑accuracy forecasts from Solcast are used. Otherwise, the free Open‑Meteo API serves as a fallback.
- **Loss Factor**: Accounts for inverter/wiring losses (default 0.9).
- **Installation Date**: Used for panel degradation calculations (Solcast).

Click **Test Forecast** to verify your configuration. The forecast banner appears on the main dashboard once enabled and correctly configured.

All settings are stored in a SQLite database (`./data/energy.db`) and persist across container restarts.

## 💾 Backup & Restore

The settings page includes a Backup & Restore section:

- **Download Backup** – Saves the entire database as a `.db` file.
- **Restore Backup** – Upload a previously saved `.db` file to restore all settings and historical data.

This is especially useful before reinstalling or migrating the dashboard.

## 📊 Dashboard Usage

- **Public View**: `http://your-server:3000/` – No login required.
- **Settings**: `http://your-server:3000/settings` – Protected by HTTP Basic Auth (`admin` / your password).
- **Data Refresh**: Automatic every 30 seconds without page reload.

## 🐳 Docker Image on Docker Hub

A pre‑built image is available on Docker Hub:

```
irunmole/energy-dashboard:latest
```

You can use it directly in your `docker-compose.yml` (see the `.env` example below).  
**Note:** if you use the pre‑built image, make sure to still provide the `SETTINGS_PASSWORD` via environment.

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
      - SETTINGS_PASSWORD=${SETTINGS_PASSWORD}   # from .env
      - TZ=Africa/Lagos                           # change to your timezone
```

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
├── .env.example          # template for credentials
├── .gitignore
├── package.json
├── server.js             # Express backend + SQLite + polling + forecast
├── public/
│   ├── index.html        # Main dashboard UI
│   ├── style.css         # Light/dark theme styles
│   ├── script.js         # Charts, flow card, tables, forecast, timeline
│   ├── settings.html     # Protected configuration page
│   └── settings.js       # Settings logic + backup/restore
└── README.md
```

## 🔒 Security

- **No hardcoded secrets** – passwords are stored in the `.env` file (excluded from git).
- **Non‑root container** – the Docker process runs as a non‑privileged `node` user.
- **No dynamic code execution** – all inputs are properly parsed and sanitised.
- **XSS‑safe rendering** – the front end uses secure DOM methods; no `innerHTML` with user data.

## ❓ Troubleshooting

### All values show zero

- Ensure at least one data source is enabled and correctly configured.
- Use the **Test MQTT Broker Connection** and **Test Topic** buttons in settings to verify connectivity.
- For Home Assistant, verify the token has read access to the selected entities.

### Today's solar or savings not updating

The dashboard calculates daily solar energy directly from your power sensors – **no special "daily" sensors are required**. If the value seems stuck, check that the correct **power** sensors are mapped (not the daily‑energy sensor).

### Grid timeline not appearing

Make sure a **grid status entity** is selected in the settings (e.g., `binary_sensor.grid_status`). The timeline bar will appear once the server has recorded at least one state change.

### Solar forecast shows zero or unrealistic values

- Ensure Latitude, Longitude, and System Capacity are correctly filled.
- If using Solcast, verify your API key is valid and the hobbyist tier has remaining calls.
- Check the server logs for detailed error messages:

```bash
docker compose logs energy-dashboard | grep -i forecast
```

### Login popup appears on main page

This was fixed in recent versions. If you still see it, clear your browser cache or test in incognito mode.

## 📄 License

GNU General License – see LICENSE file for details.

## 🙌 Acknowledgements

Built with Express, Chart.js, SQLite, and MQTT.js. Solar forecast powered by Solcast and Open-Meteo.

Happy monitoring! ☀️🔋🏠
