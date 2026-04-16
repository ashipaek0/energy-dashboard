# ⚡ Energy Dashboard

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant**, **Solar Assistant**, and **MQTT**. Designed for public displays – no login required for viewing, while settings are password‑protected.

![Dashboard Screenshot](https://via.placeholder.com/800x400?text=Energy+Dashboard+Screenshot)

## ✨ Features

- **Live Flow Card** – See power flowing between Solar, Battery, Home, and Grid at a glance.
- **Real‑time Stats** – Current power (kW), battery state of charge, daily totals, and self‑sufficiency.
- **Historical Charts** – Interactive line charts for 24h, 7d, 30d, and 90d.
- **Monthly Energy Table** – 12‑month breakdown of load, solar, battery, and grid.
- **Grid Uptime Tracking** – Hours of grid supply per day/week/month/year and last ON/OFF timestamps.
- **Fully Configurable UI** – Set dashboard title and logo via settings.
- **Multiple Data Sources** – Pull from Home Assistant, Solar Assistant, and MQTT simultaneously or individually.
- **Source Toggles** – Enable/disable each source independently.
- **Entity Auto‑Discovery** – Fetch sensor list from Home Assistant and map via dropdowns.
- **Connection Testing** – Verify Solar Assistant and MQTT connections before saving.
- **Responsive Design** – Works on mobile, tablet, and desktop.

## 🚀 Quick Start (Docker)

The easiest way to run the dashboard is with Docker Compose.

### 1. Clone the Repository

```bash
git clone https://github.com/ashipaek0/energy-dashboard.git
cd energy-dashboard
2. Set the Settings Password
Edit docker-compose.yml and change the SETTINGS_PASSWORD environment variable:

yaml
environment:
  - SETTINGS_PASSWORD=your_secure_password_here
3. Start the Container
bash
docker compose up -d --build
The dashboard will be available at http://localhost:3000 (or your server's IP).

4. Configure Data Sources
Open http://your-server-ip:3000/settings

Log in with username admin and the password you set.

Configure Home Assistant (URL and Long‑Lived Access Token).

Click Fetch Entities from HA to load all available sensors.

Map each measurement (consumption, solar, battery, etc.) to the appropriate sensor.

Optionally enable Solar Assistant (local IP required) and/or MQTT.

Customise Savings Calculation (currency and rate) and Branding (title and logo).

Click Save All Settings.

The dashboard will immediately begin displaying data.

🔧 Configuration Details
Home Assistant
URL: Your Home Assistant instance (e.g., http://homeassistant.local:8123).

Token: Generate a Long‑Lived Access Token in your Home Assistant profile.

Entities: After fetching, select the sensors for:

Power (Watts): consumption, solar, battery charge/discharge, grid import/export.

Battery SOC (%).

Grid status (binary sensor – ON/OFF).

Daily energy (kWh) – must reset at midnight (use utility meter or Riemann sum integral sensors).

Solar Assistant
URL: The local IP address of your Solar Assistant device (e.g., http://192.168.1.101).
Do not use the cloud dashboard URL (*.solar-assistant.io).

API Key: Found in Solar Assistant under Configuration → MQTT / API.

MQTT
Broker URL: mqtt://your-broker:1883

Username / Password: Optional.

Topics: Map each measurement to its MQTT topic. Leave empty to skip.

All settings are stored in a SQLite database (./data/energy.db) and persist across container restarts.

📊 Dashboard Usage
Public View: http://your-server:3000/ – No login required.

Settings: http://your-server:3000/settings – Protected by HTTP Basic Auth (admin / your password).

Data refreshes automatically every 30 seconds without page reload.

🐳 Docker Image on Docker Hub
A pre‑built image is available on Docker Hub:
ashipaek0/energy-dashboard:latest

You can use it directly in your docker-compose.yml:

yaml
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
🔄 Automatic Updates (CI/CD)
This repository includes a GitHub Actions workflow that automatically builds and pushes a Docker image to Docker Hub on every push to main.

If you want to automatically update the running container on your server, add Watchtower to your docker-compose.yml:

yaml
watchtower:
  image: containrrr/watchtower
  container_name: watchtower
  restart: unless-stopped
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  command: --interval 300 energy-dashboard
Watchtower will check for new images every 5 minutes and restart the container when an update is available.

🛠️ Development / Manual Installation
If you prefer to run without Docker:

bash
npm install
npm start
The server listens on port 3000. A SQLite database will be created in ./data.

📁 Project Structure
text
energy-dashboard/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js          # Express backend + SQLite + polling
├── public/
│   ├── index.html     # Main dashboard UI
│   ├── style.css
│   ├── script.js
│   ├── settings.html  # Protected configuration page
│   └── settings.js
├── .env.example
└── README.md
❓ Troubleshooting
All values show zero
Ensure at least one data source is enabled and correctly configured.

Use the Test Solar Assistant Connection button in settings to verify API access.

For Home Assistant, verify the token has read access to the selected entities.

Solar Assistant test fails with "ETIMEDOUT"
Make sure you are using the local IP address of the device, not the cloud URL.

The device must be on the same network as the dashboard.

Daily energy values grow exponentially
The sensors selected for Daily Energy must reset to zero at midnight. Use Home Assistant's Utility Meter or Riemann sum integration to create resetting sensors.

Grid status shows "Not configured"
Select a binary sensor in the settings that reports grid availability (e.g., binary_sensor.grid_status).

📄 License
MIT License – see LICENSE file for details.

🙌 Acknowledgements
Built with Express, Chart.js, SQLite, and MQTT.js.

Happy monitoring! ☀️🔋🏠
