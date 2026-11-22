const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config();
const { saveCountryDataset } = require("./dataset-utils");

const year = Number(process.argv[2] || 2025);
const localCsv = process.argv[3] ? path.resolve(process.argv[3]) : null;
const projectDirectory = path.join(__dirname, "..");
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR || ".");
const outputFile = process.argv[4] ? path.resolve(process.argv[4]) : path.join(dataDirectory, "clusters.json");
if (!Number.isInteger(year) || year < 2010 || year > 2025) {
  throw new Error("Choose a published collision-data year from 2010 to 2025.");
}

const sourceUrl = `https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-${year}.csv`;

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

function zoneRisk(records) {
  const severityScore = records.fatal * 3 + records.serious * 2 + records.slight;
  const averageSeverity = severityScore / records.total;
  if (records.fatal > 0 || averageSeverity >= 1.8) return "high";
  if (averageSeverity >= 1.35 || records.total >= 5) return "medium";
  return "low";
}

async function loadCsv() {
  if (localCsv) return fs.readFileSync(localCsv, "utf8");
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`DfT download failed with HTTP ${response.status}: ${sourceUrl}`);
  return response.text();
}

async function main() {
  const csv = await loadCsv();
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headers = parseCsvRow(lines.shift()).map(header => header.trim().toLowerCase());
  const column = name => headers.indexOf(name);
  const required = ["longitude", "latitude", "collision_severity"];
  const missing = required.filter(name => column(name) < 0);
  if (missing.length) throw new Error(`DfT CSV is missing required columns: ${missing.join(", ")}`);

  const zones = new Map();
  let validRecords = 0;
  for (const line of lines) {
    if (!line) continue;
    const row = parseCsvRow(line);
    const longitude = Number(row[column("longitude")]);
    const latitude = Number(row[column("latitude")]);
    const severity = Number(row[column("collision_severity")]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        longitude < -8.7 || longitude > 2.2 || latitude < 49.8 || latitude > 60.9 ||
        ![1, 2, 3].includes(severity)) continue;

    const authorityCode = row[column("local_authority_ons_district")] || "Unknown authority";
    const lsoaCode = column("lsoa_of_accident_location") >= 0
      ? row[column("lsoa_of_accident_location")]
      : "";
    const zoneCode = lsoaCode && lsoaCode !== "-1"
      ? `LSOA ${lsoaCode}`
      : `GRID ${Math.floor(latitude * 100)}:${Math.floor(longitude * 100)}`;
    const key = `${authorityCode}|${zoneCode}`;
    if (!zones.has(key)) {
      zones.set(key, {
        Longitude: 0, Latitude: 0, country: "uk", region: authorityCode, zone: zoneCode,
        severity: "low", fatal: 0, serious: 0, slight: 0, recordCount: 0,
        year, source: "UK Department for Transport STATS19", isDemo: false
      });
    }
    const zone = zones.get(key);
    zone.Longitude += longitude;
    zone.Latitude += latitude;
    zone.recordCount++;
    if (severity === 1) zone.fatal++;
    else if (severity === 2) zone.serious++;
    else zone.slight++;
    validRecords++;
  }
  if (!validRecords) throw new Error("No valid GB collision records were found; clusters.json was not changed.");

  const accidents = [...zones.values()].map(zone => {
    zone.Longitude = Number((zone.Longitude / zone.recordCount).toFixed(6));
    zone.Latitude = Number((zone.Latitude / zone.recordCount).toFixed(6));
    zone.severity = zoneRisk({ fatal: zone.fatal, serious: zone.serious, slight: zone.slight, total: zone.recordCount });
    return zone;
  });
  const metadata = {
    country: "uk",
    label: "Great Britain",
    title: `GB reported road collisions, ${year}`,
    source: "UK Department for Transport STATS19",
    sourceUrl,
    year,
    isDemo: false,
    recordCount: validRecords,
    zoneCount: accidents.length,
    method: "Mean coordinate per LSOA/authority cell; risk category reflects recorded collision severity, not traffic exposure or a safety prediction.",
    importedAt: new Date().toISOString()
  };
  saveCountryDataset(outputFile, "uk", metadata, accidents);
  console.log(`Imported ${validRecords.toLocaleString()} official GB collisions into ${accidents.length.toLocaleString()} zones for ${year}.`);
  console.log(`Source: ${sourceUrl}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
