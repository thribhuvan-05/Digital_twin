const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "roadwise-test-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDirectory;
process.env.MIGRATE_LEGACY_USERS = "false";
process.env.SESSION_SECRET = "test-session-secret-with-more-than-32-characters";
process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";

const { app, database } = require("./server");
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  database.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("health endpoint includes security headers and no permissive CORS", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("dashboard is protected until a user signs in and can sign out", async () => {
  const unauthenticated = await fetch(`${baseUrl}/app.html`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get("location"), "/login.html");

  const username = `deploy-${crypto.randomUUID().slice(0, 8)}`;
  const password = "A-strong-test-password-2026";
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password })
  });
  assert.equal(registration.status, 201);

  const shortPassword = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username: `${username}x`, password: "short" })
  });
  assert.equal(shortPassword.status, 400);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(";")[0];

  const currentUser = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
  assert.deepEqual(await currentUser.json(), { username });

  const dashboard = await fetch(`${baseUrl}/app.html`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Roadwise \| Traffic intelligence/);

  const storedPassword = database.prepare("SELECT password_hash FROM users WHERE username = ?").get(username).password_hash;
  assert.match(storedPassword, /^pbkdf2\$/);
  assert.notEqual(storedPassword, password);

  const logout = await fetch(`${baseUrl}/logout`, {
    method: "POST",
    headers: { cookie, origin: baseUrl }
  });
  assert.equal(logout.status, 204);

  const expiredSession = await fetch(`${baseUrl}/api/me`, { headers: { cookie }, redirect: "manual" });
  assert.equal(expiredSession.status, 302);
});

test("runtime configuration exposes the configured public map token", async () => {
  const response = await fetch(`${baseUrl}/runtime-config.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /pk\.test-token/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("accident APIs identify official datasets and disclose their geographic coverage", async () => {
  const ukResponse = await fetch(`${baseUrl}/api/accidents?country=uk`);
  assert.equal(ukResponse.status, 200);
  const uk = await ukResponse.json();
  assert.equal(uk.available, true);
  assert.equal(uk.isDemo, false);
  assert.equal(uk.source, "UK Department for Transport STATS19");
  assert.equal(uk.year, 2025);
  assert.ok(uk.recordCount > uk.count);
  assert.ok(uk.accidents.every(record => record.country === "uk"));

  const usResponse = await fetch(`${baseUrl}/api/accidents?country=usa`);
  assert.equal(usResponse.status, 200);
  const usa = await usResponse.json();
  assert.equal(usa.available, true);
  assert.equal(usa.isDemo, false);
  assert.match(usa.source, /City of Chicago/);
  assert.match(usa.coverage, /Chicago, Illinois only/);
  assert.equal(usa.sources.length, 2);
  assert.ok(usa.recordCount > usa.count);
  assert.ok(usa.accidents.every(record => record.country === "usa"));

  const regionsResponse = await fetch(`${baseUrl}/api/accident-regions`);
  const regions = await regionsResponse.json();
  assert.ok(regions.regions.some(region => region.country === "usa" && /Chicago and New York City/.test(region.label)));

  const indiaResponse = await fetch(`${baseUrl}/api/accidents?country=india`);
  const india = await indiaResponse.json();
  assert.equal(india.available, false);
  assert.equal(india.count, 0);
  assert.equal(india.recordCount, 0);
});

test("official DfT importer groups collision records into severity-aware zones", () => {
  const csvFile = path.join(dataDirectory, "dft-sample.csv");
  const outputFile = path.join(dataDirectory, "dft-import-test.json");
  fs.writeFileSync(csvFile, [
    "longitude,latitude,collision_severity,local_authority_ons_district,lsoa_of_accident_location",
    "-0.12,51.50,1,E09000001,E01000001",
    "-0.13,51.51,3,E09000001,E01000001",
    "-0.14,51.52,2,E09000002,E01000002"
  ].join("\n"));

  execFileSync(process.execPath, [
    path.join(__dirname, "scripts", "import-dft-uk.js"),
    "2024",
    csvFile,
    outputFile
  ]);
  const imported = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(imported.metadata.countries.uk.source, "UK Department for Transport STATS19");
  assert.equal(imported.metadata.countries.uk.isDemo, false);
  assert.equal(imported.metadata.countries.uk.recordCount, 3);
  assert.equal(imported.metadata.countries.uk.zoneCount, 2);
  assert.equal(imported.accidents.find(zone => zone.zone === "LSOA E01000001").recordCount, 2);
  assert.equal(imported.accidents.find(zone => zone.zone === "LSOA E01000001").severity, "high");
});

test("generic importer adds country zones without replacing other countries", () => {
  const csvFile = path.join(dataDirectory, "india-sample.csv");
  const outputFile = path.join(dataDirectory, "multicountry-import-test.json");
  const { saveCountryDataset } = require("./scripts/dataset-utils");
  saveCountryDataset(outputFile, "uk", { label: "Great Britain", source: "Test UK source", year: 2025 }, [
    { country: "uk", Longitude: -0.12, Latitude: 51.5, zone: "UK test zone", recordCount: 1 }
  ]);
  fs.writeFileSync(csvFile, [
    "longitude,latitude,district,severity",
    "77.1000,28.7000,Test district,fatal",
    "77.1010,28.7010,Test district,minor"
  ].join("\n"));

  execFileSync(process.execPath, [
    path.join(__dirname, "scripts", "import-country-accidents.js"),
    "IN",
    "India test sample",
    "Test official dataset",
    "2024",
    csvFile,
    "longitude",
    "latitude",
    "district",
    "severity",
    "https://example.gov.in/road-safety",
    outputFile
  ]);
  const imported = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(imported.metadata.countries.uk.source, "Test UK source");
  assert.equal(imported.metadata.countries.india.source, "Test official dataset");
  assert.equal(imported.metadata.countries.india.isDemo, false);
  assert.equal(imported.accidents.filter(zone => zone.country === "uk").length, 1);
  assert.equal(imported.accidents.filter(zone => zone.country === "india").length, 1);
  assert.equal(imported.accidents.find(zone => zone.country === "india").severity, "high");

  saveCountryDataset(outputFile, "usa", { label: "US city sample", source: "Chicago source", year: "2023-2025" }, [
    { country: "usa", Longitude: -87.6, Latitude: 41.8, zone: "Chicago zone", recordCount: 1, source: "Chicago source" }
  ]);
  saveCountryDataset(outputFile, "usa", { label: "US city sample", source: "New York source", year: "2023-2025" }, [
    { country: "usa", Longitude: -73.9, Latitude: 40.7, zone: "New York zone", recordCount: 1, source: "New York source" }
  ]);
  const withMultipleUSSources = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(withMultipleUSSources.accidents.filter(zone => zone.country === "usa").length, 2);
  assert.equal(withMultipleUSSources.metadata.countries.usa.sources.length, 2);
});
