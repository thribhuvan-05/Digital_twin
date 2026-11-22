const path = require("node:path");
require("dotenv").config();
const { saveCountryDataset } = require("./dataset-utils");

const startYear = Number(process.argv[2] || 2023);
const endYear = Number(process.argv[3] || 2026);
if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 2010 || endYear <= startYear || endYear > 2101) {
  throw new Error("Usage: node scripts/import-chicago-us.js [start-year] [exclusive-end-year].");
}

const endpoint = "https://data.cityofchicago.org/resource/85ca-t3if.json";
const projectDirectory = path.join(__dirname, "..");
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR || ".");
const outputFile = path.join(dataDirectory, "clusters.json");
const pageSize = 50_000;
const where = `crash_date >= '${startYear}-01-01T00:00:00' AND crash_date < '${endYear}-01-01T00:00:00' AND longitude IS NOT NULL AND latitude IS NOT NULL`;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchPage(offset) {
  const parameters = new URLSearchParams({
    "$select": "crash_record_id,crash_date,longitude,latitude,injuries_fatal,injuries_incapacitating,injuries_total",
    "$where": where,
    "$order": "crash_record_id",
    "$limit": String(pageSize),
    "$offset": String(offset)
  });
  const response = await fetch(`${endpoint}?${parameters}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Chicago Data Portal returned HTTP ${response.status} at offset ${offset}.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Chicago Data Portal returned an unexpected response.");
  return rows;
}

async function fetchTotal() {
  const parameters = new URLSearchParams({ "$select": "count(*)", "$where": where });
  const response = await fetch(`${endpoint}?${parameters}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Chicago Data Portal count query returned HTTP ${response.status}.`);
  const result = await response.json();
  const total = Number(result[0]?.count);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("Chicago Data Portal returned an invalid record count.");
  return total;
}

async function main() {
  const zones = new Map();
  let validRecords = 0;
  const totalRecords = await fetchTotal();
  for (let offset = 0; offset < totalRecords; offset += pageSize) {
    const rows = await fetchPage(offset);
    if (!rows.length) throw new Error(`Chicago Data Portal returned no records at offset ${offset} of ${totalRecords}.`);
    for (const row of rows) {
      const longitude = Number(row.longitude);
      const latitude = Number(row.latitude);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
          longitude < -88.2 || longitude > -87.4 || latitude < 41.6 || latitude > 42.1) continue;

      const key = `GRID ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
      if (!zones.has(key)) {
        zones.set(key, {
          Longitude: 0, Latitude: 0, country: "usa", countryLabel: "United States (Chicago)",
          region: "Chicago, Illinois", zone: key, severity: "low",
          fatal: 0, serious: 0, slight: 0, noInjury: 0, recordCount: 0,
          year: `${startYear}-${endYear - 1}`,
          source: "City of Chicago Data Portal — Traffic Crashes - Crashes",
          isDemo: false
        });
      }
      const zone = zones.get(key);
      zone.Longitude += longitude;
      zone.Latitude += latitude;
      zone.recordCount++;
      const fatalities = number(row.injuries_fatal);
      const serious = number(row.injuries_incapacitating);
      const injuries = number(row.injuries_total);
      if (fatalities > 0) zone.fatal++;
      else if (serious > 0) zone.serious++;
      else if (injuries > 0) zone.slight++;
      else zone.noInjury++;
      validRecords++;
    }
    console.log(`Fetched page ${Math.floor(offset / pageSize) + 1}; processed ${validRecords.toLocaleString()} of ${totalRecords.toLocaleString()} records.`);
  }
  if (!validRecords) throw new Error("No geocoded Chicago collision records were returned; existing datasets were not changed.");

  const accidents = [...zones.values()].map(zone => {
    zone.Longitude = Number((zone.Longitude / zone.recordCount).toFixed(6));
    zone.Latitude = Number((zone.Latitude / zone.recordCount).toFixed(6));
    const score = zone.fatal * 3 + zone.serious * 2 + zone.slight;
    const average = score / zone.recordCount;
    zone.severity = zone.fatal > 0 ? "high" : average >= 0.2 || zone.recordCount >= 20 ? "medium" : "low";
    return zone;
  });
  const metadata = {
    country: "usa",
    label: "United States (Chicago only)",
    coverage: "City of Chicago, Illinois only; not national US coverage.",
    source: "City of Chicago Data Portal — Traffic Crashes - Crashes",
    sourceUrl: "https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if",
    year: `${startYear}-${endYear - 1}`,
    isDemo: false,
    recordCount: validRecords,
    zoneCount: accidents.length,
    method: "Crashes with published coordinates grouped into 0.01-degree grid zones; severity is based on reported injuries and counts, not traffic exposure or predicted safety.",
    importedAt: new Date().toISOString()
  };
  saveCountryDataset(outputFile, "usa", metadata, accidents);
  console.log(`Imported ${validRecords.toLocaleString()} Chicago collisions into ${accidents.length.toLocaleString()} zones (${startYear}-${endYear - 1}).`);
  console.log("Coverage is Chicago only; this is not a nationwide US dataset.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
