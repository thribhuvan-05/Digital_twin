const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config();
const { saveCountryDataset } = require("./dataset-utils");

const [rawCountry, label, source, rawYear, csvPath, longitudeName = "longitude", latitudeName = "latitude", zoneName = "", severityName = "severity", sourceUrl = "", outputPath = ""] = process.argv.slice(2);
const countryAliases = { gb: "uk", in: "india", us: "usa" };
const country = (rawCountry || "").toLowerCase();
const countryKey = countryAliases[country] || country;
const year = Number(rawYear);
const projectDirectory = path.join(__dirname, "..");
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR || ".");
const outputFile = outputPath ? path.resolve(outputPath) : path.join(dataDirectory, "clusters.json");

function parseCsvRow(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      field += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function severityLevel(value) {
  const normalized = value.trim().toLowerCase();
  if (["1", "fatal", "fatality", "killed", "death", "fatal injury"].includes(normalized)) return "high";
  if (["2", "serious", "serious injury", "severe"].includes(normalized)) return "medium";
  if (["3", "slight", "minor", "minor injury", "non-fatal"].includes(normalized)) return "low";
  return "";
}

function assertArguments() {
  if (!/^[a-z]{2,3}$/.test(country)) throw new Error("Provide an ISO 3166-1 alpha-2/alpha-3 country code (for example IN, US, or FR).");
  if (!label || !source || !Number.isInteger(year) || year < 1900 || year > 2100 || !csvPath) {
    throw new Error("Usage: node scripts/import-country-accidents.js <country-code> <country-label> <source-name> <year> <csv> [longitude-column] [latitude-column] [zone-column] [severity-column] [source-url] [output-json]");
  }
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) throw new Error("Source URL must use HTTPS.");
  if (!fs.existsSync(path.resolve(csvPath))) throw new Error(`CSV file not found: ${csvPath}`);
}

function classifyZone(zone) {
  const severityScore = zone.fatal * 3 + zone.serious * 2 + zone.slight;
  const average = severityScore / zone.recordCount;
  if (zone.fatal > 0 || average >= 1.8) return "high";
  if (average >= 1.35 || zone.recordCount >= 5) return "medium";
  return "low";
}

function main() {
  assertArguments();
  const csv = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const lines = csv.split(/\r?\n/);
  const headers = parseCsvRow(lines.shift()).map(header => header.trim().toLowerCase());
  const column = requested => requested ? headers.indexOf(requested.trim().toLowerCase()) : -1;
  const longitudeIndex = column(longitudeName);
  const latitudeIndex = column(latitudeName);
  const zoneIndex = column(zoneName);
  const severityIndex = column(severityName);
  if (longitudeIndex < 0 || latitudeIndex < 0 || severityIndex < 0) {
    throw new Error(`CSV must include coordinate and severity columns (${longitudeName}, ${latitudeName}, ${severityName}).`);
  }
  if (zoneName && zoneIndex < 0) throw new Error(`CSV is missing zone column: ${zoneName}`);

  const zones = new Map();
  let validRecords = 0;
  for (const line of lines) {
    if (!line) continue;
    const row = parseCsvRow(line);
    const longitude = Number(row[longitudeIndex]);
    const latitude = Number(row[latitudeIndex]);
    const severity = severityLevel(row[severityIndex] || "");
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;
    if (!severity) continue;

    const explicitZone = zoneIndex < 0 ? "" : row[zoneIndex]?.trim();
    const zoneCode = explicitZone || `GRID ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
    if (!zones.has(zoneCode)) {
      zones.set(zoneCode, {
        Longitude: 0, Latitude: 0, country: countryKey, countryLabel: label,
        region: explicitZone ? label : "Coordinate grid", zone: zoneCode,
        severity: "low", fatal: 0, serious: 0, slight: 0, recordCount: 0,
        year, source, isDemo: false
      });
    }
    const zone = zones.get(zoneCode);
    zone.Longitude += longitude;
    zone.Latitude += latitude;
    zone.recordCount++;
    if (severity === "high") zone.fatal++;
    else if (severity === "medium") zone.serious++;
    else zone.slight++;
    validRecords++;
  }
  if (!validRecords) throw new Error("No records with valid coordinates and recognized severity were found; dataset was not changed.");

  const accidents = [...zones.values()].map(zone => {
    zone.Longitude = Number((zone.Longitude / zone.recordCount).toFixed(6));
    zone.Latitude = Number((zone.Latitude / zone.recordCount).toFixed(6));
    zone.severity = classifyZone(zone);
    return zone;
  });
  const metadata = {
    country: countryKey,
    label,
    source,
    sourceUrl: sourceUrl || null,
    year,
    isDemo: false,
    recordCount: validRecords,
    zoneCount: accidents.length,
    method: "Grouped by supplied zone or 0.01-degree coordinate grid; severity reflects input labels, not traffic exposure or predicted safety.",
    importedAt: new Date().toISOString()
  };
  saveCountryDataset(outputFile, countryKey, metadata, accidents);
  console.log(`Imported ${validRecords.toLocaleString()} ${label} collision records into ${accidents.length.toLocaleString()} zones.`);
  console.log(`Source: ${source}${sourceUrl ? ` (${sourceUrl})` : ""}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
