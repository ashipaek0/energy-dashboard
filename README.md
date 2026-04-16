<<<<<<< HEAD
# energy-dashboard
AshipaEk0's Energy Monitoring Dashboard
=======
# Energy Dashboard with MQTT Support

Self-hosted energy monitor integrating Home Assistant, Solar Assistant, and MQTT.

## Quick Start
1. Set `SETTINGS_PASSWORD` in `docker-compose.yml`.
2. Run `docker-compose up -d --build`
3. Access `http://server:3000` (public) and `/settings` (protected, user `admin` + password).

## Configuration
All settings are stored in SQLite and editable via the settings UI. MQTT is optional – if configured, values will override Home Assistant for real-time data.
>>>>>>> 1ac1393 (Initial commit)
