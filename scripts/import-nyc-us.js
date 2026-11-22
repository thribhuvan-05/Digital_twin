const path = require("node:path");
require("dotenv").config();
const { saveCountryDataset } = require("./dataset-utils");

const startYear = Number(process.argv[2] || 2023);
const endYear = Number(process.argv[3] || 2026);
if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 2012 || endYear <= startYear || endYear > 2101) {
  throw new Error("Usage: node scripts/import-nyc-us.js [start-year] [exclusive-end-year].");
}

const endpoint = "https://data.cityofnewyork.us/resource/h9gi-nx95.json";
const projectDirectory = path.join(__dirname, "..");
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR || ".");
const outputFile = path.join(dataDirectory, "clusters.json");
const where = `crash_date >= '${startYear}-01-01T00:00:00' AND crash_date < '${endYear}-01-01T00:00:00' AND longitude BETWEEN -74.3 AND -73.6 AND latitude BETWEEN 40.4 AND 41.0`;

async function main() {
  const parameters = new URLSearchParams({
    "$select": "borough,round(latitude,2) as lat,round(longitude,2) as lon,count(*) as records,sum(number_of_persons_killed) as killed,sum(number_of_persons_injured) as injured",
    "$where": where,
    "$group": "borough,lat,lon",
    "$limit": "50000"
  });
  const response = await fetch(`${endpoint}?${parameters}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`NYC Open Data returned HTTP ${response.status}.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("NYC Open Data returned an unexpected response.");
  if (rows.length >= 50_000) throw new Error("NYC zone aggregation exceeded the response limit; narrow the year range and retry.");

  const accidents = rows.map(row => {
    const latitude = Number(row.lat), longitude = Number(row.lon), recordCount = Number(row.records);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isSafeInteger(recordCount) || recordCount < 1) return null;
    const fatal = Number(row.killed) || 0, injured = Number(row.injured) || 0;
    const borough = row.borough || "Unknown borough";
    return {
      Longitude: longitude, Latitude: latitude, country: "usa", countryLabel: "United States (New York City)",
      region: `New York City, ${borough}`, zone: `GRID ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
      severity: fatal > 0 ? "high" : injured / recordCount >= .2 || recordCount >= 20 ? "medium" : "low",
      fatal, injured, recordCount, year: `${startYear}-${endYear - 1}`,
      source: "NYC Open Data — Motor Vehicle Collisions - Crashes", isDemo: false
    };
  }).filter(Boolean);
  const validRecords = accidents.reduce((sum, zone) => sum + zone.recordCount, 0);
  if (!validRecords) throw new Error("No geocoded NYC collision records were returned; existing datasets were not changed.");

  const metadata = {
    country: "usa",
    label: "United States (Chicago and New York City)",
    coverage: "New York City, New York only; not national US coverage.",
    source: "NYC Open Data — Motor Vehicle Collisions - Crashes",
    sourceUrl: "https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95",
    year: `${startYear}-${endYear - 1}`,
    isDemo: false,
    recordCount: validRecords,
    zoneCount: accidents.length,
    method: "Collisions with published coordinates grouped by borough and 0.01-degree grid; severity uses reported fatalities/injuries and is not adjusted for traffic exposure.",
    importedAt: new Date().toISOString()
  };
  saveCountryDataset(outputFile, "usa", metadata, accidents);
  console.log(`Imported ${validRecords.toLocaleString()} NYC collisions into ${accidents.length.toLocaleString()} borough/grid zones (${startYear}-${endYear - 1}).`);
  console.log("US coverage is Chicago and New York City only; this is not a nationwide US dataset.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
