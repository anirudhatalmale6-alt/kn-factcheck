'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kn.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ---------------------------------------------------------------------------
// Core content schema (prototype of the corrected Postgres schema).
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body  TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  source_domain TEXT,
  raw_title  TEXT,
  raw_text   TEXT,
  raw_author TEXT,
  archive_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','analyzed','published','rejected')),
  submitted_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id),
  extracted_claims TEXT,
  suggested_category TEXT,
  reasoning TEXT,
  confidence REAL,
  public_summary TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  raw_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- reviews: NO CHECK on final_category, so categories can be managed in the DB.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  final_category TEXT NOT NULL,
  public_summary TEXT NOT NULL,
  slug TEXT UNIQUE,
  editor_notes TEXT,
  overrode_ai INTEGER DEFAULT 0,
  reviewed_by INTEGER,
  published_at TEXT,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  previous_category TEXT,
  new_category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Source / content types (what KIND of thing was submitted).
CREATE TABLE IF NOT EXISTS source_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Languages the public fact-checks can be read in.
CREATE TABLE IF NOT EXISTS languages (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  dir TEXT NOT NULL DEFAULT 'ltr',
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- AI-generated translations of a published fact-check's reader-facing text.
CREATE TABLE IF NOT EXISTS fc_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  public_summary TEXT,
  claims_json TEXT,
  editor_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(review_id, lang)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'submitter',
  twofa_secret TEXT,
  twofa_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_policy ON policies (is_active) WHERE is_active = 1;`);

// ---------------------------------------------------------------------------
// Migration: rebuild an OLD reviews table that still carries the
// final_category CHECK, so category management isn't blocked by it.
// ---------------------------------------------------------------------------
const rsql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'`).get();
if (rsql && /CHECK\s*\(\s*final_category/i.test(rsql.sql)) {
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE reviews_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL,
        final_category TEXT NOT NULL,
        public_summary TEXT NOT NULL,
        slug TEXT UNIQUE,
        editor_notes TEXT,
        overrode_ai INTEGER DEFAULT 0,
        reviewed_by INTEGER,
        published_at TEXT,
        reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO reviews_new (id, submission_id, final_category, public_summary, slug, editor_notes, overrode_ai, published_at, reviewed_at)
        SELECT id, submission_id, final_category, public_summary, slug, editor_notes, overrode_ai, published_at, reviewed_at FROM reviews;
      DROP TABLE reviews;
      ALTER TABLE reviews_new RENAME TO reviews;
    `);
  });
  rebuild();
}

// Additive column migrations (safe if already present).
function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('submissions', 'submitted_by', 'submitted_by INTEGER');
addColumn('submissions', 'source_type', "source_type TEXT DEFAULT 'website'");
addColumn('submissions', 'submitter_note', 'submitter_note TEXT');
addColumn('submissions', 'file_path', 'file_path TEXT');       // uploaded media (image/video/audio/doc)
addColumn('submissions', 'file_mime', 'file_mime TEXT');
addColumn('submissions', 'content_kind', "content_kind TEXT DEFAULT 'url'"); // url | text | file
addColumn('reviews', 'reviewed_by', 'reviewed_by INTEGER');

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------
// Verdict categories
if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) {
  const seed = [
    ['verified', 'Verified', '#1a7f37', 'Core claim well-supported by credible, independent evidence.', 1],
    ['false', 'False', '#b91c1c', 'Core claim contradicted by credible evidence.', 2],
    ['misleading', 'Misleading', '#c2410c', 'True elements arranged to create a false impression.', 3],
    ['missing_context', 'Missing Context', '#b45309', 'Not false, but omits context needed to judge it fairly.', 4],
    ['unverified', 'Unverified', '#6b7280', 'Cannot be confirmed or refuted with available evidence.', 5],
    ['satire', 'Satire', '#7c3aed', 'Satire/parody presented as, or mistaken for, news.', 6],
    ['opinion', 'Opinion', '#1d4ed8', 'Commentary/analysis, not a checkable factual claim.', 7],
  ];
  const ins = db.prepare('INSERT INTO categories (key,label,color,description,sort_order) VALUES (?,?,?,?,?)');
  for (const r of seed) ins.run(...r);
}

// Source types
if (db.prepare('SELECT COUNT(*) c FROM source_types').get().c === 0) {
  const seed = [
    ['website', 'Website / news article', 1],
    ['facebook', 'Facebook page/post', 2],
    ['twitter', 'X / Twitter post', 3],
    ['instagram', 'Instagram post', 4],
    ['youtube', 'YouTube video', 5],
    ['tiktok', 'TikTok video', 6],
    ['image', 'Image / photo', 7],
    ['video', 'Video clip', 8],
    ['audio', 'Audio clip', 9],
    ['text_post', 'Text / message', 10],
    ['document', 'Document / PDF', 11],
    ['other', 'Other', 12],
  ];
  const ins = db.prepare('INSERT INTO source_types (key,label,sort_order) VALUES (?,?,?)');
  for (const r of seed) ins.run(...r);
}
// Ensure 'audio' exists on older DBs seeded before it was added.
if (!db.prepare("SELECT 1 FROM source_types WHERE key='audio'").get()) {
  db.prepare("INSERT INTO source_types (key,label,sort_order) VALUES ('audio','Audio clip',9)").run();
}

// Languages
if (db.prepare('SELECT COUNT(*) c FROM languages').get().c === 0) {
  const seed = [
    ['en', 'English', 'ltr', 1, 1, 1],
    ['ur', 'Urdu', 'rtl', 0, 1, 2],
    ['hi', 'Hindi', 'ltr', 0, 1, 3],
    ['pa', 'Punjabi', 'ltr', 0, 1, 4],
    ['ks', 'Kashmiri', 'rtl', 0, 1, 5],
  ];
  const ins = db.prepare('INSERT INTO languages (code,label,dir,is_default,enabled,sort_order) VALUES (?,?,?,?,?,?)');
  for (const r of seed) ins.run(...r);
}

// Default settings
function ensureSetting(k, v) {
  if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(k)) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(k, v);
  }
}
ensureSetting('anthropic_api_key', '');
ensureSetting('model', process.env.KN_MODEL || 'claude-opus-4-8');
ensureSetting('theme', 'light');
ensureSetting('accent', '#2b6a5b');
ensureSetting('site_name', 'Kashmir Fact-Check');
ensureSetting('logo_path', '');
ensureSetting('tagline', 'Independent, evidence-based checking of claims and media coverage about Kashmir.');
ensureSetting('about_text', [
  'Kashmir News Fact Check is an editorially independent initiative of the Kashmir Record & Research Centre, dedicated to scrutinising claims, narratives and media coverage related to the Kashmir conflict. Drawing on open-source verification, archival research and on-the-ground testimonies, the project seeks to provide rigorously checked information in a landscape marked by competing state narratives and chronic misinformation.',
  '',
  '## Kashmir as a conflict zone',
  "For more than seven decades, Kashmir has been at the centre of a territorial dispute between India and Pakistan, marked by multiple wars, cycles of insurgency and some of the world's most intense militarisation. The region's complex history—from the 1947 accession of the former princely state to subsequent UN resolutions and the revocation of Jammu and Kashmir's special status in 2019—has shaped both lived realities on the ground and the global conversation around rights, security and self-determination.",
  '',
  '## Propaganda and competing narratives',
  'This prolonged conflict has produced layered propaganda ecosystems, with pro-Indian and pro-Pakistani media, political actors and digital networks advancing sharply divergent narratives about events in Kashmir. In recent years, narrative warfare around militant attacks, counterinsurgency operations and legal changes has intensified across television, print, and social media, often amplifying disinformation and framing Kashmiris either as security threats or passive subjects rather than political agents in their own right.',
  '',
  '## A platform for pro-Kashmiri voices',
  'Kashmir News Fact Check is explicitly committed to centring Kashmiri perspectives and documenting how anti-Kashmiri propaganda operates—whether it originates from state institutions, political parties, or transnational media ecosystems. By foregrounding local voices, contextual data and transparent verification methods, the project aims to help readers distinguish evidence-based reporting from partisan spin, and to better understand how information warfare shapes everyday life, democratic debate and human rights in Kashmir.',
  '',
  '## Editorial stance and scope',
  'We are pro-Kashmiri in a precise sense: we centre Kashmiri rights, experiences and voices. That commitment does not lower our evidential bar. We apply the same universal fact-checking and verification standards to every claim we examine—whether it originates from pro-India, pro-Pakistan, Kashmiri or international sources. A claim is judged on its sourcing and its evidence, not on who makes it or which narrative it happens to serve.',
  '',
  '## Governance and funding',
  'The project is an editorially independent initiative of the Kashmir Record & Research Centre. What we choose to check, and the verdict we reach, is decided by the editorial team alone. The Centre is committed to transparency about how the work is funded, and maintains a strict separation between funding and editorial judgement, so that no political party, institution or donor can influence a verdict.',
  '',
  '## Team and expertise',
  'Our work is produced by a team that combines journalism, research and digital verification—reporting and editing, archival and open-source investigation, and the technical analysis of images, video and online content. Contested or high-stakes cases are reviewed against our published editorial standards, with independent expert guidance where a claim calls for it.',
  '',
  '## Audience participation',
  'Readers are invited to send us claims, links, images, video or audio to be checked through our Submit a tip page—no account is required. We cannot investigate everything, so we prioritise by reach (how widely a claim is spreading), potential for harm, and relevance to Kashmiri communities. Every submission is reviewed by the editorial team, and each published check sets out the evidence and the reasoning behind its verdict.',
].join('\n'));

// Starter editorial policy
if (!db.prepare(`SELECT COUNT(*) c FROM policies WHERE is_active = 1`).get().c) {
  const body = `PURPOSE
This platform fact-checks claims circulating about Kashmir (news and social media).
Our lens is on SOURCING and EVIDENCE, not on imposing a political verdict.

CATEGORIES (choose exactly one)
- verified         : The core claim is well-supported by credible, independent evidence.
- false            : The core claim is contradicted by credible evidence.
- misleading       : Technically true elements arranged to create a false impression.
- missing_context  : Not false, but omits context a reader needs to judge it fairly.
- unverified       : Cannot be confirmed or refuted with available evidence.
- satire           : Satire/parody presented as, or mistaken for, news.
- opinion          : Commentary/analysis, not a checkable factual claim.

SOURCING PRINCIPLES
- Prefer primary sources, on-the-record officials, and named eyewitnesses.
- Treat anonymous social posts, unverified virality, and single-source claims with caution.
- Note when a claim relies on a source with a clear stake in the outcome.
- Flag manipulated, mislabelled, or out-of-context media.

TONE
- Neutral, precise, non-inflammatory. Describe the evidence; avoid loaded language.
- Never republish the full original text; summarise the finding for the reader.`;
  db.prepare(`INSERT INTO policies (title, body, is_active) VALUES (?, ?, 1)`)
    .run('Default Editorial Policy (v1)', body);
}

// Default admin user (from env on first boot; overridable, and changeable in-app)
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'factcheck2026';
  db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)')
    .run(u, 'Administrator', hashPassword(p), 'admin');
}

// ---------------------------------------------------------------------------
// Helpers (settings / categories) + password hashing (scrypt, no native dep)
// ---------------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(String(pw), salt, expected.length);
    return crypto.timingSafeEqual(expected, got);
  } catch (e) { return false; }
}

function settingsGet(key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r && r.value != null ? r.value : (fallback == null ? '' : fallback);
}
function settingsSet(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value == null ? '' : String(value));
}
function listCategories(onlyActive) {
  const sql = 'SELECT * FROM categories' + (onlyActive ? ' WHERE active=1' : '') + ' ORDER BY sort_order, id';
  return db.prepare(sql).all();
}
function categoryMap() {
  const m = {};
  for (const c of listCategories(false)) m[c.key] = { label: c.label, color: c.color };
  return m;
}
function listSourceTypes(onlyActive) {
  const sql = 'SELECT * FROM source_types' + (onlyActive ? ' WHERE active=1' : '') + ' ORDER BY sort_order, id';
  return db.prepare(sql).all();
}
function sourceTypeMap() {
  const m = {};
  for (const s of listSourceTypes(false)) m[s.key] = s.label;
  return m;
}
function listLanguages(enabledOnly) {
  const sql = 'SELECT * FROM languages' + (enabledOnly ? ' WHERE enabled=1' : '') + ' ORDER BY sort_order, code';
  return db.prepare(sql).all();
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.settingsGet = settingsGet;
module.exports.settingsSet = settingsSet;
module.exports.listCategories = listCategories;
module.exports.categoryMap = categoryMap;
module.exports.listSourceTypes = listSourceTypes;
module.exports.sourceTypeMap = sourceTypeMap;
module.exports.listLanguages = listLanguages;
