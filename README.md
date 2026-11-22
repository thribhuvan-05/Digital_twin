# Digital Twin City Simulation

**An AI-powered Digital Twin platform for urban monitoring, traffic analysis, accident data visualization, and intelligent route assessment.**

Digital Twin City Simulation is a data-driven urban monitoring application designed to visualize geographical information, analyze traffic-related accident records, and support route assessment through an interactive mapping interface.

The platform integrates an interactive Mapbox map, route planning, accident heatmap visualization, user authentication, and data-processing capabilities to provide a unified environment for exploring urban transportation data.

---

## 1. Key Features

- Interactive Digital Twin Map using Mapbox.
- Route planning and alternative route comparison.
- Accident heatmap and geographical visualization.
- Traffic accident data analysis.
- Multi-country geographical dataset support.
- User registration and authentication.
- Cookie-based session management.
- Python-based data cleaning and clustering.
- Automated dataset importing and processing.
- Docker-based deployment support.

## 2. Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js |
| Data Processing | Python |
| Frontend | HTML, CSS, JavaScript |
| Mapping | Mapbox |
| Database | SQLite |
| Data Storage | JSON |
| Package Manager | npm |
| Containerization | Docker |
| Testing | Node.js Test Runner |

## 3. Project Structure

```text
Digital-Twin-City-Simulation/
│
├── scripts/
│   ├── dataset-utils.js
│   ├── generate-demo-accidents.js
│   ├── import-chicago-us.js
│   ├── import-country-accidents.js
│   ├── import-dft-uk.js
│   └── import-nyc-us.js
│
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── app.html
├── app.py
├── clean.py
├── cluster.py
├── db.json
├── login.html
├── package.json
├── package-lock.json
├── register.html
├── requirements.txt
├── server.js
└── server.test.js
```

## 4. Prerequisites

Before running the application, install:

- Node.js 22 or newer
- npm
- Python 3
- Git
- Docker (optional)
- Mapbox public access token

## 5. Installation and Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/thribhuvan-05/Digital_twin.git
```

### Step 2: Navigate to the Project

```bash
cd Digital_twin
```

### Step 3: Configure Environment Variables

Create a local environment file:

```powershell
if (!(Test-Path .env)) {
    Copy-Item .env.example .env
}
```

Configure the required environment variables in `.env`.

Add your Mapbox public access token as `MAPBOX_ACCESS_TOKEN`.

### Step 4: Install Dependencies

```bash
npm ci
```

### Step 5: Run Tests

```bash
npm test
```

### Step 6: Start the Application

```bash
npm start
```

Open the application:

http://localhost:5000

**Note:** Map tiles and driving directions require an internet connection.

Local development imports existing `db.json` users into `.data/roadwise.sqlite` once and replaces legacy plain-text passwords in `db.json` with their hashes. Production does not import demo accounts.

## 6. Python Environment Setup

Create a virtual environment:

```bash
python -m venv .venv
```

Activate the environment in Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
```

Install Python dependencies:

```bash
pip install -r requirements.txt
```

Run the data-processing scripts:

```bash
python clean.py
python cluster.py
```

## 7. Accident Data Sources

The project supports geographical accident datasets from multiple sources.

### Great Britain – Department for Transport

The project includes Great Britain Department for Transport STATS19 records.

Import the dataset:

```bash
npm run import:dft:uk
```

Select a specific year:

```bash
npm run import:dft:uk -- 2024
```

Official source:

https://www.gov.uk/government/statistical-data-sets/road-safety-open-data

### Chicago, USA

Import real, geocoded Chicago crash records:

```bash
npm run import:chicago:us
```

Official source:

https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if

### New York City, USA

Import New York City Motor Vehicle Collision records:

```bash
npm run import:nyc:us
```

Official source:

https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95

### India and Other Countries

The application provides a generic importer for licensed, geocoded accident datasets.

Example:

```bash
npm run import:country -- IN "India" "Official source name" 2024 .\india-crashes.csv longitude latitude district severity https://example.gov.in/data
```

Required CSV fields:

- Longitude
- Latitude
- Severity

An administrative zone column can optionally be included.

**Data integrity:** The importer does not automatically obtain or invent accident records. Imported data must have valid geographical coordinates and appropriate licensing.

## 8. Data Processing and Clustering

The project includes Python scripts for geographical data processing.

| File | Purpose |
|---|---|
| clean.py | Data cleaning workflow |
| cluster.py | Geographical clustering workflow |
| app.py | Python application component |

The JavaScript scripts support dataset importing, generation, and utility operations.

To generate synthetic interface-testing accident points:

```bash
npm run generate:accidents
```

**Warning:** This command replaces the existing accident dataset with synthetic UK, India, and USA testing points. Do not execute it if you want to preserve imported official records.

## 9. Route Assessment and Visualization

The application provides:

- Interactive geographical visualization.
- Searchable geographical accident zones.
- Route planning and alternative comparison.
- Accident information around available routes.
- Sampled route sections visualized using relative recorded collision severity.

These are descriptive estimates based on the available accident records.

They depend on dataset coverage, quality, date range, and Mapbox alternatives.

**Disclaimer:** The visualizations are not guaranteed road-safety predictions or assurances that a particular route is safe.

## 10. Docker Deployment

The application supports Docker-based deployment.

### Generate a Session Secret

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Configure Environment Variables

Add the following to `.env`:

```env
MAPBOX_ACCESS_TOKEN=your_mapbox_public_token
SESSION_SECRET=your_generated_random_secret
```

### Build Docker Image

```bash
docker build -t digital-twin-city .
```

### Create Persistent Storage

```bash
docker volume create digital-twin-data
```

### Run the Container

```bash
docker run --name digital-twin-city --restart unless-stopped -p 5000:5000 --env-file .env -e NODE_ENV=production -e DATA_DIR=/app/data -v digital-twin-data:/app/data digital-twin-city
```

The container:

- Runs as a non-root user.
- Includes a `/api/health` health check.
- Uses persistent storage for SQLite.
- Supports a single application instance.

Do not run multiple replicas against a local SQLite database. Use a managed database before scaling horizontally.

## 11. Security Considerations

Before public deployment:

- Configure HTTPS.
- Use a restricted Mapbox public token.
- Generate a strong session secret.
- Never upload passwords, API keys, or private credentials.
- Configure persistent storage.
- Review authentication and database security.
- Review dataset licensing and privacy implications.
- Configure backups and monitoring.

Mapbox browser tokens are public tokens, not server secrets. Restrict their allowed URLs and APIs through Mapbox settings.

The current inline browser scripts require a CSP allowance for inline scripts. Move them to versioned external assets before enforcing a stricter script policy.

## 12. Testing

Run the automated test suite:

```bash
npm test
```

Test file:

```text
server.test.js
```

## 13. Dataset Coverage

| Region | Supported data source |
|---|---|
| Great Britain | Department for Transport STATS19 |
| Chicago, USA | City of Chicago Data Portal |
| New York City, USA | NYC Open Data |
| India | Licensed geocoded CSV importer |
| Other countries | Licensed geocoded CSV importer |

Actual geographical coverage depends on the datasets imported into the application.

## 14. Future Development Scope

Potential future improvements include:

- Expanded geographical dataset coverage.
- Advanced spatial data processing.
- Improved traffic-pattern analysis.
- Enhanced accident visualization.
- Additional analytical capabilities.
- Improved scalability and deployment architecture.
- Integration of additional authorized geographical data sources.

## 15. Author

**E. V. Sai Thribhuvan**

B.Tech – Information Technology (AI & ML)

GitHub: https://github.com/thribhuvan-05

---

**Digital Twin City Simulation**

*Connecting geographical data, urban monitoring, and intelligent transportation analysis.*