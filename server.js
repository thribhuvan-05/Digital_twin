require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 5000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, ".data"));
const DB_FILE = path.join(DATA_DIR, "roadwise.sqlite");
const LEGACY_DB_FILE = path.join(__dirname, "db.json");
const ACCIDENTS_FILE = path.join(process.env.DATA_DIR || __dirname, "clusters.json");
const ACCIDENTS_FALLBACK_FILE = path.join(__dirname, "clusters.json");
const SESSION_COOKIE = "roadwise_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || (!isProduction && crypto.randomBytes(32).toString("hex"));
const MAPBOX_ACCESS_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || "";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be a valid TCP port.");
if (isProduction && !process.env.DATA_DIR) throw new Error("DATA_DIR must point to persistent storage in production.");
if (isProduction && (!SESSION_SECRET || SESSION_SECRET.length < 32)) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
if (isProduction && !MAPBOX_ACCESS_TOKEN) throw new Error("Set MAPBOX_ACCESS_TOKEN before starting in production.");

fs.mkdirSync(DATA_DIR, { recursive: true });

const database = new Database(DB_FILE);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return `pbkdf2$${salt}$${hash}`;
}

function passwordMatches(password, storedHash) {
  const [, salt, expectedHex] = storedHash.split("$");
  if (!salt || !expectedHex || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function migrateLegacyUsers() {
  if (isProduction || process.env.MIGRATE_LEGACY_USERS === "false") return;
  if (!fs.existsSync(LEGACY_DB_FILE) || database.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0) return;

  const legacyData = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, "utf8"));
  if (!legacyData || !Array.isArray(legacyData.users)) throw new Error("db.json must contain a users array.");

  const migratedUsers = legacyData.users
    .filter(user => typeof user.username === "string" && typeof user.password === "string")
    .map(user => ({
      username: user.username.trim(),
      passwordHash: user.password.startsWith("pbkdf2$") ? user.password : hashPassword(user.password),
      createdAt: Date.now()
    }))
    .filter(user => user.username.length > 0);

  const insertUser = database.prepare("INSERT OR IGNORE INTO users (username, password_hash, created_at) VALUES (?, ?, ?)");
  database.transaction(users => users.forEach(user => insertUser.run(user.username, user.passwordHash, user.createdAt)))(migratedUsers);

  const sanitizedFile = `${LEGACY_DB_FILE}.tmp`;
  fs.writeFileSync(sanitizedFile, JSON.stringify({
    users: migratedUsers.map(user => ({ username: user.username, password: user.passwordHash }))
  }, null, 2));
  fs.renameSync(sanitizedFile, LEGACY_DB_FILE);
}

migrateLegacyUsers();

function getCookieValue(req, name) {
  const cookie = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return "";
  }
}

function hashSessionToken(token) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

function requireAuthentication(req, res, next) {
  if (!req.user) return res.redirect(302, "/login.html");
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
  if ((origin && origin !== expectedOrigin) || req.get("sec-fetch-site") === "cross-site") {
    return res.status(403).json({ success: false, message: "Cross-site request rejected." });
  }
  next();
}

const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.mapbox.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://api.mapbox.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.mapbox.com", "https://*.tiles.mapbox.com"],
      connectSrc: ["'self'", "https://api.mapbox.com", "https://*.tiles.mapbox.com", "https://events.mapbox.com"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProduction ? undefined : false
});

app.disable("x-powered-by");
app.set("trust proxy", isProduction ? 1 : false);
app.use(securityHeaders);
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (token) {
    const now = Date.now();
    const session = database.prepare(`
      SELECT users.id, users.username, sessions.token_hash
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashSessionToken(token), now);
    if (session) {
      req.user = { id: session.id, username: session.username };
      req.sessionTokenHash = session.token_hash;
    } else {
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    }
  }
  next();
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
const authenticationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please wait and try again." }
});
app.use(generalLimiter);

function sendPage(pageName, res) {
  res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, pageName));
}

function readAccidents() {
  const accidentFile = fs.existsSync(ACCIDENTS_FILE) ? ACCIDENTS_FILE : ACCIDENTS_FALLBACK_FILE;
  if (!fs.existsSync(accidentFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(accidentFile, "utf8"));
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.accidents) ? data : { accidents: [] };
  } catch (error) {
    console.error("Unable to read clusters.json:", error.message);
    return { accidents: [] };
  }
}

app.get("/runtime-config.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store");
  res.send(`window.ROADWISE_CONFIG = ${JSON.stringify({ mapboxAccessToken: MAPBOX_ACCESS_TOKEN })};`);
});

app.get("/", (req, res) => req.user ? res.redirect("/app.html") : sendPage("login.html", res));
app.get("/login.html", (req, res) => req.user ? res.redirect("/app.html") : sendPage("login.html", res));
app.get("/register.html", (req, res) => req.user ? res.redirect("/app.html") : sendPage("register.html", res));
app.get("/app.html", requireAuthentication, (req, res) => sendPage("app.html", res));

app.get("/api/health", (req, res) => {
  try {
    database.prepare("SELECT 1").get();
    res.json({ status: "ok", accidentsAvailable: fs.existsSync(ACCIDENTS_FILE) || fs.existsSync(ACCIDENTS_FALLBACK_FILE) });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.get("/api/config", (req, res) => res.json({ mapboxAccessToken: MAPBOX_ACCESS_TOKEN }));
app.get("/api/me", requireAuthentication, (req, res) => res.json({ username: req.user.username }));
app.get("/api/accident-regions", (req, res) => {
  const dataset = readAccidents();
  const accidents = Array.isArray(dataset) ? dataset : dataset.accidents;
  const countries = Array.isArray(dataset) ? {} : dataset.metadata?.countries || {};
  const grouped = new Map();
  for (const record of accidents) {
    const country = (record.country || "uk").toLowerCase();
    if (!grouped.has(country)) grouped.set(country, {
      zones: 0, records: 0, longitude: 0, latitude: 0,
      minLongitude: Infinity, minLatitude: Infinity, maxLongitude: -Infinity, maxLatitude: -Infinity
    });
    const summary = grouped.get(country);
    const count = Number(record.recordCount) || 1;
    const longitude = Number(record.Longitude);
    const latitude = Number(record.Latitude);
    summary.zones++;
    summary.records += count;
    summary.longitude += longitude * count;
    summary.latitude += latitude * count;
    summary.minLongitude = Math.min(summary.minLongitude, longitude);
    summary.minLatitude = Math.min(summary.minLatitude, latitude);
    summary.maxLongitude = Math.max(summary.maxLongitude, longitude);
    summary.maxLatitude = Math.max(summary.maxLatitude, latitude);
  }
  res.json({
    regions: [...grouped.entries()].map(([country, summary]) => {
      const metadata = countries[country] || {};
      return {
        country,
        label: metadata.label || (country === "uk" ? "Great Britain" : country.toUpperCase()),
        source: metadata.source || null,
        coverage: metadata.coverage || null,
        year: metadata.year || null,
        isDemo: Boolean(metadata.isDemo),
        zones: summary.zones,
        recordCount: summary.records,
        center: summary.records
          ? [summary.longitude / summary.records, summary.latitude / summary.records]
          : null,
        bounds: summary.records
          ? [[summary.minLongitude, summary.minLatitude], [summary.maxLongitude, summary.maxLatitude]]
          : null
      };
    })
  });
});
app.get("/api/accidents", (req, res) => {
  const country = typeof req.query.country === "string" ? req.query.country.toLowerCase() : "";
  const dataset = readAccidents();
  const allAccidents = Array.isArray(dataset) ? dataset : dataset.accidents;
  const countryMetadata = Array.isArray(dataset) ? null : dataset.metadata?.countries?.[country] || null;
  const accidents = country
    ? allAccidents.filter(record => (record.country || "uk") === country)
    : allAccidents;
  const dataFileExists = fs.existsSync(ACCIDENTS_FILE) || fs.existsSync(ACCIDENTS_FALLBACK_FILE);
  res.json({
    available: accidents.length > 0,
    count: accidents.length,
    isDemo: countryMetadata?.isDemo ?? (Array.isArray(dataset) ? allAccidents.some(record => record.isDemo) : dataset.metadata?.isDemo ?? allAccidents.some(record => record.isDemo)),
    source: countryMetadata?.source || (Array.isArray(dataset) ? allAccidents.find(record => record.country === country)?.source || (dataFileExists ? "Local accident dataset" : "No dataset installed") : dataset.metadata?.source || allAccidents[0]?.source || (dataFileExists ? "Local accident dataset" : "No dataset installed")),
    sourceUrl: countryMetadata?.sourceUrl || (Array.isArray(dataset) ? null : dataset.metadata?.sourceUrl || null),
    sources: countryMetadata?.sources || (countryMetadata?.source ? [{
      source: countryMetadata.source, sourceUrl: countryMetadata.sourceUrl || null,
      year: countryMetadata.year || null, recordCount: countryMetadata.recordCount || null,
      coverage: countryMetadata.coverage || null
    }] : []),
    coverage: countryMetadata?.coverage || null,
    year: countryMetadata?.year || (Array.isArray(dataset) ? allAccidents.find(record => record.country === country)?.year ?? null : dataset.metadata?.year ?? null),
    recordCount: accidents.reduce((sum, record) => sum + (Number(record.recordCount) || 1), 0),
    accidents
  });
});

app.post("/register", requireSameOrigin, authenticationLimiter, (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ success: false, message: "Username must be 3 to 32 letters, numbers, dots, dashes, or underscores." });
  }
  if (password.length < 12 || password.length > 128) {
    return res.status(400).json({ success: false, message: "Password must be between 12 and 128 characters." });
  }

  try {
    database.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, hashPassword(password), Date.now());
    res.status(201).json({ success: true, message: "Account created." });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ success: false, message: "That username is already in use." });
    }
    throw error;
  }
});

app.post("/login", requireSameOrigin, authenticationLimiter, (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const user = database.prepare("SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !passwordMatches(password, user.password_hash)) {
    return res.status(401).json({ success: false, message: "Username or password is incorrect." });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashSessionToken(token), user.id, now + SESSION_DURATION_MS, now);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_MS
  });
  res.json({ success: true, username: user.username, message: "Welcome back." });
});

app.post("/logout", requireSameOrigin, requireAuthentication, (req, res) => {
  database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.sessionTokenHash);
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/"
  });
  res.status(204).end();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === "entity.parse.failed" ? 400 : error.status === 413 ? 413 : 500;
  if (status === 500) console.error("Request failed:", error.message);
  res.status(status).json({ success: false, message: status === 500 ? "An unexpected server error occurred." : "Invalid request." });
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Roadwise is ready on port ${PORT}.`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => {
      database.close();
      process.exit(0);
    }));
  }
}

module.exports = { app, database };