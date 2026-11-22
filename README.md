# Roadwise

Roadwise is a single-instance traffic-analysis web app with an interactive Mapbox map, route planner, optional accident heatmap, account registration, and cookie-based sessions.

## Local setup

Requirements: Node.js 22 or newer and npm.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm test
npm start
```

Open <http://localhost:5000>. Set `MAPBOX_ACCESS_TOKEN` in `.env` to a restricted Mapbox public token. Map tiles and driving directions require internet access. Local development imports existing `db.json` users into `.data/roadwise.sqlite` once and replaces legacy plain-text passwords in `db.json` with their hashes. Production does not import demo accounts.

## Docker deployment

Create a restricted Mapbox public token and a random session secret. One way to generate the secret is:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `MAPBOX_ACCESS_TOKEN` and `SESSION_SECRET` in `.env`, then build and run with persistent storage:

```powershell
docker build -t roadwise .
docker volume create roadwise-data
docker run --name roadwise --restart unless-stopped -p 5000:5000 --env-file .env -e NODE_ENV=production -e DATA_DIR=/app/data -v roadwise-data:/app/data roadwise
```

The container runs as a non-root user and has a `/api/health` health check. Keep the volume when replacing or restarting the container; it stores the SQLite database. This configuration is for one app instance. Do not run multiple replicas against a local SQLite file; use a managed database before scaling horizontally. Terminate HTTPS at the hosting platform or reverse proxy.

Mapbox access tokens are public browser tokens, not server secrets. Restrict their allowed URLs and APIs in Mapbox, and rotate the development token before deploying. The token is sent to browsers through `/runtime-config.js` and is not embedded in the HTML.

## Accident data

The project includes real Great Britain Department for Transport STATS19 records and official geocoded US city data from Chicago and New York City. US coverage is limited to those cities, not nationwide. India is not populated with guessed locations: install an authorized geocoded dataset with the generic importer below. Additional countries can be added the same way.

An importer is included to refresh the published Great Britain dataset. Download and import an annual collision CSV (default: 2025) into the configured `DATA_DIR`:

```powershell
npm run import:dft:uk
```

You can select a year or import a CSV you already downloaded:

```powershell
npm run import:dft:uk -- 2024
npm run import:dft:uk -- 2024 .\path\to\dft-collisions.csv
```

Official source: [DfT Road Safety Open Data](https://www.gov.uk/government/statistical-data-sets/road-safety-open-data). The importer aggregates reported collisions by LSOA (or a coordinate grid where the LSOA code is absent), publishes severity counts, and replaces the dataset in `DATA_DIR`. It does not infer traffic exposure or predict safety. The importer currently covers Great Britain only.

Import real, geocoded City of Chicago crash records (2023–2025 by default; current-year partial records are excluded):

```powershell
npm run import:chicago:us
```

The source is the [City of Chicago Data Portal crash dataset](https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if). The importer fetches published coordinate records and adds them as US zones while preserving other countries' data. The dashboard labels the coverage as Chicago only.

Import real, geocoded New York City Motor Vehicle Collision records (2023–2025 by default):

```powershell
npm run import:nyc:us
```

The source is [NYC Open Data — Motor Vehicle Collisions - Crashes](https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95). The dashboard combines both city datasets under US and shows the covered cities/years. This does not represent all US locations.

Import a licensed geocoded dataset for India or another country. The CSV must have longitude, latitude, and severity columns; optionally use an administrative zone column:

```powershell
npm run import:country -- IN "India" "Official source name" 2024 .\india-crashes.csv longitude latitude district severity https://example.gov.in/data
```

Replace the sample source name, URL, year, and columns with the actual dataset provenance. ISO alpha-2/alpha-3 codes are accepted. The importer groups coordinates into zones and preserves other imported countries. It will not obtain or invent data for you. If the official dataset is only state-level totals and has no coordinates, it cannot produce real map zones.

`npm run generate:accidents` replaces the dataset with synthetic UK/India/USA interface-test points. Do not run that command if you want to keep the official dataset.

The dashboard lists searchable zones for the selected country and makes each zone clickable on the map. Route alternatives are compared against nearby collision records and their severity, with sampled route sections colored by relative recorded collision severity. These descriptive estimates depend on dataset coverage, date range, quality, and Mapbox alternatives; they are not predictions or safety guarantees.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python clean.py
python cluster.py
```

For local use, `clusters.json` beside the application is loaded automatically. In Docker, the build copies it to `/app/data/clusters.json`; a persistent volume can replace it with a production dataset. Without it, the map and route planner remain available.

## Before a public launch

- Configure HTTPS, a restricted Mapbox token, a strong `SESSION_SECRET`, and persistent storage.
- Create the first production account through registration; sample accounts are not imported.
- Review the dataset license and privacy implications before publishing accident locations.
- The current inline browser scripts require a CSP allowance for inline scripts. Move them to versioned external assets before enforcing a stricter script policy.
- SQLite on a persistent disk is intended for a small, single-instance deployment. Use a managed relational database, backups, and monitoring for a multi-instance or higher-availability service.
