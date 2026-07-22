'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kn.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ---------------------------------------------------------------------------
// Schema. This is the SQLite prototype of the corrected Postgres schema
// (policies created before ai_analyses; one-active-policy + unique-URL guards;
// public_summary/slug on reviews; corrections table). Kept intentionally close
// to the reviewed spec so the move to Postgres later is mechanical.
// ---------------------------------------------------------------------------
db.exec(`
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
  normalized_url TEXT NOT NULL UNIQUE,     -- one fact-check per URL: kills duplicates
  source_domain TEXT,
  raw_title  TEXT,
  raw_text   TEXT,
  raw_author TEXT,
  archive_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','analyzed','published','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id),
  extracted_claims TEXT,          -- JSON array
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

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  final_category TEXT NOT NULL
    CHECK (final_category IN ('verified','false','misleading','missing_context','unverified','satire','opinion')),
  public_summary TEXT NOT NULL,
  slug TEXT UNIQUE,
  editor_notes TEXT,
  overrode_ai INTEGER DEFAULT 0,
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
`);

// Only one active policy at a time.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_policy ON policies (is_active) WHERE is_active = 1;`);

// ---------------------------------------------------------------------------
// Seed a starter editorial policy the client can edit. The whole design
// principle is "policy is a DB row, not hardcoded logic" - so this is just a
// sensible default, fully editable at /admin/policy.
// ---------------------------------------------------------------------------
const haveActive = db.prepare(`SELECT COUNT(*) c FROM policies WHERE is_active = 1`).get().c;
if (!haveActive) {
  const body = `PURPOSE
This platform fact-checks claims circulating about Kashmir (news and social media).
Our lens is on SOURCING and EVIDENCE, not on imposing a political verdict. We assess
how well a claim is supported, who is making it, and what evidence exists - we do not
decide contested political questions for the reader.

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

module.exports = db;
