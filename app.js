'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const helmet = require('helmet');
const QRCode = require('qrcode');

const db = require('./db');
const { hashPassword, verifyPassword, settingsGet, settingsSet, listCategories, categoryMap, listSourceTypes, sourceTypeMap, listLanguages } = db;
const { scrape, normalizeUrl, detectSourceType, archiveSnapshot } = require('./lib/scrape');
const { analyse } = require('./lib/analyse');
const { translate } = require('./lib/translate');
const { generateSecret, totpVerify, otpauthURL } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3925;
// BASE_PATH='/kn' (default, sub-path) or '/' (serve at domain root, e.g. a dedicated domain)
const RAW_BASE = process.env.BASE_PATH != null ? process.env.BASE_PATH : '/kn';
const BASE = (RAW_BASE === '/' || RAW_BASE === '') ? '' : RAW_BASE.replace(/\/+$/, '');
app.set('trust proxy', true);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers + content-security policy (allows Google Fonts; blocks external scripts/objects/framing).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'media-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(express.urlencoded({ extended: true }));
app.use(BASE + '/static', express.static(path.join(__dirname, 'public')));

// Uploaded media (images/video/audio/docs)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(BASE + '/uploads', express.static(UPLOAD_DIR));
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  // Reject types that can execute in the browser when served (stored-XSS defence).
  fileFilter: (req, file, cb) => {
    if (/svg|xml|html?|javascript|ecmascript|x-msdownload|x-sh|x-httpd/i.test(file.mimetype || '')) {
      return cb(new Error('That file type is not allowed.'));
    }
    cb(null, true);
  },
});
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).render('admin-submit', { title: 'Submit', error: 'Upload failed: ' + err.message, url: '' });
    next();
  });
}
function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (err) req.file = null;   // rejected type / too large -> just skip the logo, keep saving other settings
    if (req.file && !String(req.file.mimetype || '').startsWith('image/')) { req.file = null; } // images only
    next();
  });
}
function sourceTypeFromMime(m) {
  m = String(m || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/pdf|word|presentation|document|excel|sheet/.test(m)) return 'document';
  return 'other';
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'kn-factcheck-dev-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 },
}));

// --------------------------------------------------------------------------
// Roles & permissions
// --------------------------------------------------------------------------
const ROLES = ['admin', 'editor', 'policy_writer', 'submitter'];
const ROLE_LABEL = { admin: 'Admin', editor: 'Web editor', policy_writer: 'Policy writer', submitter: 'Submitter' };
const PERMS = {
  submit:       ['submitter', 'editor', 'admin'],
  review:       ['editor', 'admin'],
  policy:       ['policy_writer', 'admin'],
  users:        ['admin'],
  settings:     ['admin'],
  categories:   ['admin'],
  source_types: ['admin'],
  languages:    ['admin'],
};
function can(user, action) {
  return !!(user && PERMS[action] && PERMS[action].includes(user.role));
}

// Per-request locals
app.use((req, res, next) => {
  const cats = listCategories(true);
  res.locals.base = BASE;
  res.locals.user = (req.session && req.session.user) || null;
  res.locals.can = (action) => can(res.locals.user, action);
  res.locals.CATEGORY_META = categoryMap();
  res.locals.CATEGORIES = cats.map((c) => c.key);
  res.locals.categories = cats;
  res.locals.sourceTypes = listSourceTypes(true);
  res.locals.SOURCE_TYPE_MAP = sourceTypeMap();
  res.locals.enabledLanguages = listLanguages(true);
  // Reader's chosen public language (cookie), used across the public site.
  const _cm = (req.headers.cookie || '').match(/(?:^|;\s*)kn-lang=([a-z-]+)/);
  const _enabled = res.locals.enabledLanguages.map((l) => l.code);
  const _def = (res.locals.enabledLanguages.find((l) => l.is_default) || { code: 'en' }).code;
  res.locals.uiLang = (_cm && _enabled.includes(_cm[1])) ? _cm[1] : _def;
  res.locals.defaultLangCode = _def;
  res.locals.ROLE_LABEL = ROLE_LABEL;
  res.locals.site_name = settingsGet('site_name', 'Kashmir Fact-Check');
  res.locals.theme = settingsGet('theme', 'light');
  res.locals.accent = settingsGet('accent', '#2b6a5b');
  res.locals.logo = settingsGet('logo_path', '');
  res.locals.aiEnabled = !!(settingsGet('anthropic_api_key', '') || process.env.ANTHROPIC_API_KEY);
  res.locals.path = req.path;
  next();
});

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect(BASE + '/admin/login');
}
function requireRole(action) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect(BASE + '/admin/login');
    if (!can(req.session.user, action)) return res.status(403).render('notfound', { title: 'No access' });
    next();
  };
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'fact-check';
}
function uniqueSlug(base) {
  let slug = base, n = 1;
  while (db.prepare('SELECT 1 FROM reviews WHERE slug = ?').get(slug)) slug = base + '-' + (++n);
  return slug;
}
function absUrl(req, p) {
  const configured = settingsGet('public_base', '');
  const root = configured ? configured.replace(/\/+$/, '') : ('https://' + (req.get('host') || '') + BASE);
  return root + (p || '');
}
// schema.org ClaimReview numeric rating per verdict (1 worst .. 5 best)
const CLAIM_RATING = { verified: 5, false: 1, misleading: 2, missing_context: 2, unverified: 3, satire: 3, opinion: 3 };

const defaultLang = () => (db.prepare('SELECT code FROM languages WHERE is_default=1').get() || { code: 'en' }).code;

// Generate AI translations of a published fact-check into every enabled non-default language. Best-effort.
async function translateReview(reviewId) {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  if (!r) return;
  const def = defaultLang();
  const targets = listLanguages(true).filter((l) => l.code !== def);
  if (!targets.length) return;
  const ai = db.prepare('SELECT extracted_claims FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(r.submission_id);
  let claims = []; try { claims = JSON.parse((ai && ai.extracted_claims) || '[]'); } catch (e) {}
  let map;
  try {
    map = await translate({
      apiKey: settingsGet('anthropic_api_key', ''),
      model: settingsGet('model', 'claude-opus-4-8'),
      targets: targets.map((t) => ({ code: t.code, label: t.label })),
      text: { public_summary: r.public_summary, claims, editor_notes: r.editor_notes || '' },
    });
  } catch (e) { return; }
  const del = db.prepare('DELETE FROM fc_translations WHERE review_id = ? AND lang = ?');
  const ins = db.prepare('INSERT INTO fc_translations (review_id, lang, public_summary, claims_json, editor_notes) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (const code of Object.keys(map)) {
      del.run(reviewId, code);
      ins.run(reviewId, code, map[code].public_summary, JSON.stringify(map[code].claims || []), map[code].editor_notes || '');
    }
  })();
}

// Generic insert. f carries the column values; dedups on normalized_url.
function insertSubmission(f, opts) {
  opts = opts || {};
  const existing = db.prepare('SELECT id FROM submissions WHERE normalized_url = ?').get(f.normalized_url);
  if (existing) return { id: existing.id, existed: true };
  const info = db.prepare(`
    INSERT INTO submissions (url, normalized_url, source_domain, raw_title, raw_text, raw_author, status,
                             submitted_by, source_type, submitter_note, file_path, file_mime, content_kind, archive_url)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(f.url || '', f.normalized_url, f.source_domain || '', f.raw_title || '', f.raw_text || '', f.raw_author || '',
    opts.submittedBy || null, f.source_type || 'other', opts.note || null, f.file_path || null, f.file_mime || null, f.content_kind || 'url', f.archive_url || null);
  return { id: info.lastInsertRowid, existed: false };
}

// Submitted URL (scrape + Wayback snapshot + insert).
async function createSubmission(url, opts) {
  const s = await scrape(url);
  let archive_url = '';
  try { archive_url = await archiveSnapshot(url); } catch (e) {}
  return insertSubmission({
    url, normalized_url: normalizeUrl(url), source_domain: s.domain, raw_title: s.title,
    raw_text: s.text, raw_author: s.author, source_type: detectSourceType(url), content_kind: 'url', archive_url,
  }, opts);
}

// Pasted text (no URL). Dedups on a hash of the text.
function createTextSubmission(title, body, opts) {
  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  return insertSubmission({
    url: '', normalized_url: 'text:' + hash, source_domain: 'Pasted text',
    raw_title: title || body.slice(0, 90), raw_text: body, source_type: 'text_post', content_kind: 'text',
  }, opts);
}

// Uploaded file (image / video / audio / document). Dedups on file bytes.
function createFileSubmission(file, opts) {
  opts = opts || {};
  const bytes = fs.readFileSync(file.path);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  return insertSubmission({
    url: '', normalized_url: 'file:' + hash, source_domain: 'Uploaded file',
    raw_title: opts.title || file.originalname || 'Uploaded file', raw_text: opts.note || '',
    source_type: sourceTypeFromMime(file.mimetype), content_kind: 'file',
    file_path: '/uploads/' + file.filename, file_mime: file.mimetype,
  }, opts);
}

// Run Claude analysis on a stored submission (idempotent-ish: adds a fresh analysis row).
async function runAnalysis(submissionId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return;
  // Claude can't watch video / hear audio - leave those for a human unless a text description was given.
  const untranscribable = (sub.source_type === 'video' || sub.source_type === 'audio') && !(sub.raw_text && sub.raw_text.trim());
  if (untranscribable) return;
  const policy = db.prepare('SELECT * FROM policies WHERE is_active = 1').get();
  // Images -> Claude vision.
  let imageBase64 = null, imageMediaType = null;
  if (sub.source_type === 'image' && sub.file_path) {
    try {
      imageBase64 = fs.readFileSync(path.join(__dirname, sub.file_path)).toString('base64');
      imageMediaType = sub.file_mime || 'image/png';
    } catch (e) {}
  }
  let a;
  try {
    a = await analyse({
      policyBody: policy ? policy.body : '',
      title: sub.raw_title, text: sub.raw_text, url: sub.url,
      apiKey: settingsGet('anthropic_api_key', ''),
      model: settingsGet('model', 'claude-opus-4-8'),
      categories: listCategories(true).map((c) => c.key),
      imageBase64, imageMediaType,
    });
  } catch (e) {
    const first = (listCategories(true)[0] || {}).key || 'unverified';
    a = { extracted_claims: [], suggested_category: first, reasoning: 'AI analysis failed: ' + e.message,
          confidence: 0, public_summary: '', model_used: 'error', input_tokens: null, output_tokens: null, raw_response: null };
  }
  db.prepare(`
    INSERT INTO ai_analyses (submission_id, policy_id, extracted_claims, suggested_category, reasoning,
                             confidence, public_summary, model_used, input_tokens, output_tokens, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submissionId, policy ? policy.id : null, JSON.stringify(a.extracted_claims || []),
    a.suggested_category, a.reasoning, a.confidence, a.public_summary, a.model_used,
    a.input_tokens, a.output_tokens, a.raw_response);
  db.prepare(`UPDATE submissions SET status = 'analyzed' WHERE id = ? AND status = 'pending'`).run(submissionId);
}

// --------------------------------------------------------------------------
// Public
// --------------------------------------------------------------------------
router.get('/', (req, res) => {
  const cat = res.locals.CATEGORIES.includes(req.query.cat) ? req.query.cat : '';
  const type = Object.keys(res.locals.SOURCE_TYPE_MAP).includes(req.query.type) ? req.query.type : '';
  const where = ["s.status = 'published'"]; const args = [];
  if (cat) { where.push('r.final_category = ?'); args.push(cat); }
  if (type) { where.push('s.source_type = ?'); args.push(type); }
  const uiLang = res.locals.uiLang, def = res.locals.defaultLangCode;
  const items = db.prepare(`
    SELECT r.id, r.slug, r.final_category, r.published_at, s.source_domain, s.source_type,
           COALESCE(tr.public_summary, r.public_summary) AS public_summary
    FROM reviews r JOIN submissions s ON s.id = r.submission_id
    LEFT JOIN fc_translations tr ON tr.review_id = r.id AND tr.lang = ?
    WHERE ${where.join(' AND ')} ORDER BY r.published_at DESC
  `).all(uiLang === def ? '' : uiLang, ...args);
  const uiDir = (res.locals.enabledLanguages.find((l) => l.code === uiLang) || {}).dir || 'ltr';
  res.render('public-list', {
    title: res.locals.site_name, items, cat, type, uiLang, uiDir,
    tagline: settingsGet('tagline', ''),
    filtered: !!(cat || type),
    seo: { title: res.locals.site_name, description: settingsGet('tagline', 'Fact-checks of claims circulating about Kashmir.'), url: absUrl(req, '/'), type: 'website' },
  });
});
router.get('/fact-check', (req, res) => res.redirect(BASE + '/'));   // no slug -> the feed
router.get('/fact-check/:slug', (req, res) => {
  const item = db.prepare(`
    SELECT r.*, s.url, s.source_domain, s.raw_title, s.raw_author, s.source_type, s.file_path, s.content_kind, s.archive_url
    FROM reviews r JOIN submissions s ON s.id = r.submission_id
    WHERE r.slug = ? AND s.status = 'published'
  `).get(req.params.slug);
  if (!item) return res.status(404).render('notfound', { title: 'Not found' });
  const ai = db.prepare(`SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1`).get(item.submission_id);
  let claims = [];
  try { claims = ai && ai.extracted_claims ? JSON.parse(ai.extracted_claims) : []; } catch (e) {}

  // ----- Language selection -----
  const langs = listLanguages(true);
  const def = defaultLang();
  const have = new Set(db.prepare('SELECT lang FROM fc_translations WHERE review_id = ?').all(item.id).map((x) => x.lang));
  const availLangs = langs.filter((l) => l.code === def || have.has(l.code));
  const prefer = req.query.lang || res.locals.uiLang;
  let curLang = langs.find((l) => l.code === prefer && (l.code === def || have.has(l.code))) ? prefer : def;
  let dir = 'ltr';
  let display = { public_summary: item.public_summary, claims, editor_notes: item.editor_notes };
  if (curLang !== def) {
    const tr = db.prepare('SELECT * FROM fc_translations WHERE review_id = ? AND lang = ?').get(item.id, curLang);
    if (tr) {
      let tclaims = []; try { tclaims = JSON.parse(tr.claims_json || '[]'); } catch (e) {}
      display = { public_summary: tr.public_summary, claims: tclaims, editor_notes: tr.editor_notes };
      dir = (langs.find((l) => l.code === curLang) || {}).dir || 'ltr';
    } else { curLang = def; }
  }

  const url = absUrl(req, '/fact-check/' + item.slug);
  const alternates = availLangs.map((l) => ({ code: l.code, href: url + (l.code === def ? '' : '?lang=' + l.code) }));
  const label = (res.locals.CATEGORY_META[item.final_category] || {}).label || item.final_category;
  const claimText = String((claims && claims[0]) || item.raw_title || item.public_summary || '').slice(0, 300);
  const ld = {
    '@context': 'https://schema.org', '@type': 'ClaimReview', url,
    datePublished: (item.published_at || '').slice(0, 10),
    author: { '@type': 'Organization', name: res.locals.site_name },
    claimReviewed: claimText,
    reviewRating: { '@type': 'Rating', ratingValue: CLAIM_RATING[item.final_category] || 3, bestRating: 5, worstRating: 1, alternateName: label },
    itemReviewed: { '@type': 'Claim', appearance: { '@type': 'CreativeWork', url: item.url }, author: { '@type': 'Organization', name: item.source_domain || '' } },
  };
  res.render('public-item', {
    title: display.public_summary.slice(0, 60), item, display, dir, curLang, availLangs,
    seo: { title: label + ': ' + display.public_summary.slice(0, 80), description: display.public_summary, url: alternates.find((a) => a.code === curLang).href, type: 'article' },
    ldjson: JSON.stringify(ld), alternates,
  });
});
router.get('/standards', (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE is_active = 1').get();
  res.render('standards', {
    title: 'Editorial standards', policy,
    seo: { title: 'Editorial standards', description: 'The editorial policy our fact-checks are assessed against.', url: absUrl(req, '/standards'), type: 'website' },
  });
});
router.get('/about', (req, res) => {
  const raw = settingsGet('about_text', '');
  // Split into blocks; "## X" lines become sub-headings.
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
    if (b.startsWith('## ')) {
      const nl = b.indexOf('\n');
      if (nl === -1) return { heading: b.slice(3).trim() };
      return { heading: b.slice(3, nl).trim(), text: b.slice(nl + 1).trim() };
    }
    return { text: b };
  });
  res.render('about', {
    title: 'About', blocks,
    seo: { title: 'About ' + res.locals.site_name, description: 'About ' + res.locals.site_name + ' - an independent Kashmir fact-checking initiative.', url: absUrl(req, '/about'), type: 'website' },
  });
});

// --------------------------------------------------------------------------
// Auth (with optional 2FA second step)
// --------------------------------------------------------------------------
// In-memory login rate limiter (per IP): 10 attempts / 15 min - brute-force defence.
const loginHits = new Map();
function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now(), WINDOW = 15 * 60 * 1000, MAX = 10;
  let rec = loginHits.get(ip);
  if (!rec || now - rec.first > WINDOW) { rec = { count: 0, first: now }; loginHits.set(ip, rec); }
  if (rec.count >= MAX) {
    const view = String(req.path).includes('2fa') ? 'twofa-verify' : 'login';
    return res.status(429).render(view, { title: 'Sign in', error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  req._loginRec = rec;
  next();
}
const loginFail = (req) => { if (req._loginRec) req._loginRec.count++; };
const loginOK = (req) => loginHits.delete(req.ip || 'unknown');
// Regenerate the session on successful login (session-fixation defence).
function finishLogin(req, res, u) {
  loginOK(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', { title: 'Sign in', error: 'Session error - please try again.' });
    req.session.user = { id: u.id, username: u.username, name: u.name, role: u.role };
    res.redirect(BASE + '/admin');
  });
}

router.get('/admin/login', (req, res) => res.render('login', { title: 'Sign in', error: null }));
router.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    loginFail(req);
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid credentials' });
  }
  if (u.twofa_enabled) {
    req.session.pending2fa = u.id;
    return res.render('twofa-verify', { title: 'Two-factor', error: null });
  }
  finishLogin(req, res, u);
});
router.post('/admin/2fa-verify', loginLimiter, (req, res) => {
  const uid = req.session.pending2fa;
  if (!uid) return res.redirect(BASE + '/admin/login');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!u || !totpVerify(u.twofa_secret, req.body.code)) {
    loginFail(req);
    return res.status(401).render('twofa-verify', { title: 'Two-factor', error: 'Incorrect code, try again' });
  }
  finishLogin(req, res, u);
});
router.post('/admin/logout', (req, res) => req.session.destroy(() => res.redirect(BASE + '/')));

// --------------------------------------------------------------------------
// Admin dashboard
// --------------------------------------------------------------------------
router.get('/admin', requireAuth, (req, res) => {
  const stats = {
    pending: db.prepare(`SELECT COUNT(*) c FROM submissions WHERE status IN ('pending','analyzed')`).get().c,
    published: db.prepare(`SELECT COUNT(*) c FROM submissions WHERE status='published'`).get().c,
    rejected: db.prepare(`SELECT COUNT(*) c FROM submissions WHERE status='rejected'`).get().c,
    users: db.prepare(`SELECT COUNT(*) c FROM users WHERE active=1`).get().c,
  };
  const byCat = db.prepare(`
    SELECT r.final_category cat, COUNT(*) n FROM reviews r JOIN submissions s ON s.id=r.submission_id
    WHERE s.status='published' GROUP BY r.final_category ORDER BY n DESC
  `).all();
  const queue = db.prepare(`
    SELECT s.*, a.suggested_category, a.confidence
    FROM submissions s
    LEFT JOIN ai_analyses a ON a.id = (SELECT id FROM ai_analyses WHERE submission_id=s.id ORDER BY id DESC LIMIT 1)
    WHERE s.status IN ('pending','analyzed') ORDER BY s.created_at DESC
  `).all();
  res.render('admin-dashboard', { title: 'Dashboard', stats, byCat, queue, submitted: req.query.submitted === '1' });
});

// --------------------------------------------------------------------------
// Submit -> scrape -> analyse
// --------------------------------------------------------------------------
router.get('/admin/submit', requireRole('submit'), (req, res) =>
  res.render('admin-submit', { title: 'Submit a URL', error: null, url: '' }));

router.post('/admin/submit', requireRole('submit'), uploadSingle, async (req, res) => {
  const kind = ['url', 'text', 'file'].includes(req.body.kind) ? req.body.kind : 'url';
  const afterSubmit = (id) => can(req.session.user, 'review') ? (BASE + '/admin/review/' + id) : (BASE + '/admin?submitted=1');
  const err = (msg, code) => res.status(code || 400).render('admin-submit', { title: 'Submit', error: msg, url: kind === 'url' ? String(req.body.url || '') : '' });
  try {
    let created;
    if (kind === 'text') {
      const body = String(req.body.text || '').trim();
      if (!body) return err('Please paste some text to check.');
      created = createTextSubmission(String(req.body.title || '').trim(), body, { submittedBy: req.session.user.id });
    } else if (kind === 'file') {
      if (!req.file) return err('Please choose a file to upload.');
      created = createFileSubmission(req.file, { submittedBy: req.session.user.id, title: String(req.body.title || '').trim(), note: String(req.body.text || '').trim() });
    } else {
      const url = String(req.body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return err('Please enter a valid http(s) URL.');
      created = await createSubmission(url, { submittedBy: req.session.user.id });
    }
    if (created.existed) return res.redirect(afterSubmit(created.id));
    await runAnalysis(created.id);
    res.redirect(afterSubmit(created.id));
  } catch (e) {
    return err('Could not process that submission: ' + e.message, 502);
  }
});

// On-demand analysis for stored items (e.g. public tips) - editors/admin.
router.post('/admin/analyse/:id', requireRole('review'), async (req, res) => {
  await runAnalysis(req.params.id);
  res.redirect(BASE + '/admin/review/' + req.params.id);
});

// All submissions archive - every URL, whatever its status.
router.get('/admin/submissions', requireAuth, (req, res) => {
  const status = ['pending', 'analyzed', 'published', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const stype = req.query.type || '';
  const mine = !can(req.session.user, 'review');   // submitters see only their own
  const where = [];
  const args = [];
  if (status) { where.push('s.status = ?'); args.push(status); }
  if (stype) { where.push('s.source_type = ?'); args.push(stype); }
  if (mine) { where.push('s.submitted_by = ?'); args.push(req.session.user.id); }
  const sql = `
    SELECT s.*, a.suggested_category, a.confidence, r.final_category, r.slug
    FROM submissions s
    LEFT JOIN ai_analyses a ON a.id = (SELECT id FROM ai_analyses WHERE submission_id=s.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN reviews r ON r.id = (SELECT id FROM reviews WHERE submission_id=s.id ORDER BY id DESC LIMIT 1)
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC LIMIT 300`;
  const rows = db.prepare(sql).all(...args);
  res.render('admin-submissions', { title: 'All submissions', rows, status, stype });
});

// Public tip intake - no account needed. Stored for admin; no AI runs automatically.
router.get('/submit-tip', (req, res) => res.render('submit-tip', { title: 'Submit a tip', error: null, done: false, url: '' }));
router.post('/submit-tip', async (req, res) => {
  const url = String(req.body.url || '').trim();
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (req.body.website) return res.render('submit-tip', { title: 'Submit a tip', error: null, done: true, url: '' }); // honeypot
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).render('submit-tip', { title: 'Submit a tip', error: 'Please enter a valid http(s) link.', done: false, url });
  }
  try { await createSubmission(url, { note }); }
  catch (e) { return res.status(502).render('submit-tip', { title: 'Submit a tip', error: 'Could not fetch that link, but your tip was noted. ' + e.message, done: true, url: '' }); }
  res.render('submit-tip', { title: 'Submit a tip', error: null, done: true, url: '' });
});

// --------------------------------------------------------------------------
// Review
// --------------------------------------------------------------------------
router.get('/admin/review/:id', requireRole('review'), (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).render('notfound', { title: 'Not found' });
  const ai = db.prepare('SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  const review = db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  let claims = [];
  try { claims = ai && ai.extracted_claims ? JSON.parse(ai.extracted_claims) : []; } catch (e) {}
  res.render('admin-review', { title: 'Review #' + sub.id, sub, ai, review, claims });
});
router.post('/admin/review/:id', requireRole('review'), async (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).render('notfound', { title: 'Not found' });
  if (Object.keys(res.locals.SOURCE_TYPE_MAP).includes(req.body.source_type)) {
    db.prepare('UPDATE submissions SET source_type=? WHERE id=?').run(req.body.source_type, sub.id);
  }
  if (req.body.action === 'reject') {
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE id = ?`).run(sub.id);
    return res.redirect(BASE + '/admin');
  }
  const validKeys = res.locals.CATEGORIES;
  const category = validKeys.includes(req.body.final_category) ? req.body.final_category : validKeys[0];
  const publicSummary = String(req.body.public_summary || '').trim();
  const editorNotes = String(req.body.editor_notes || '').trim();
  const ai = db.prepare('SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  const overrode = ai && ai.suggested_category !== category ? 1 : 0;

  if (!publicSummary) {
    let claims = []; try { claims = JSON.parse((ai && ai.extracted_claims) || '[]'); } catch (e) {}
    return res.status(400).render('admin-review', {
      title: 'Review #' + sub.id, sub, ai,
      review: db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id),
      claims, error: 'A public summary is required before publishing.',
    });
  }
  const existing = db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  let reviewId;
  if (existing) {
    db.prepare(`UPDATE reviews SET final_category=?, public_summary=?, editor_notes=?, overrode_ai=?, reviewed_by=?, published_at=datetime('now') WHERE id=?`)
      .run(category, publicSummary, editorNotes, overrode, req.session.user.id, existing.id);
    reviewId = existing.id;
  } else {
    const slug = uniqueSlug(slugify(sub.raw_title || sub.source_domain || 'fact-check'));
    const info = db.prepare(`INSERT INTO reviews (submission_id, final_category, public_summary, slug, editor_notes, overrode_ai, reviewed_by, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(sub.id, category, publicSummary, slug, editorNotes, overrode, req.session.user.id);
    reviewId = info.lastInsertRowid;
  }
  db.prepare(`UPDATE submissions SET status = 'published' WHERE id = ?`).run(sub.id);
  try { await translateReview(reviewId); } catch (e) { /* translations are best-effort */ }
  res.redirect(BASE + '/admin');
});

// Manual (re)translate for a published fact-check.
router.post('/admin/translate/:reviewId', requireRole('review'), async (req, res) => {
  const r = db.prepare('SELECT submission_id FROM reviews WHERE id = ?').get(req.params.reviewId);
  if (!r) return res.status(404).render('notfound', { title: 'Not found' });
  try { await translateReview(req.params.reviewId); } catch (e) {}
  res.redirect(BASE + '/admin/review/' + r.submission_id);
});

// --------------------------------------------------------------------------
// Editorial policy
// --------------------------------------------------------------------------
router.get('/admin/policy', requireRole('policy'), (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE is_active = 1').get();
  const history = db.prepare('SELECT id, title, created_at, is_active FROM policies ORDER BY id DESC').all();
  res.render('admin-policy', { title: 'Editorial policy', policy, history, saved: req.query.saved === '1' });
});
router.post('/admin/policy', requireRole('policy'), (req, res) => {
  const title = String(req.body.title || '').trim() || 'Editorial Policy';
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect(BASE + '/admin/policy');
  db.transaction(() => {
    db.prepare('UPDATE policies SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('INSERT INTO policies (title, body, is_active) VALUES (?, ?, 1)').run(title, body);
  })();
  res.redirect(BASE + '/admin/policy?saved=1');
});

// --------------------------------------------------------------------------
// Categories (database of verdict categories)
// --------------------------------------------------------------------------
router.get('/admin/categories', requireRole('categories'), (req, res) => {
  res.render('admin-categories', { title: 'Categories', cats: listCategories(false), saved: req.query.saved === '1' });
});
router.post('/admin/categories', requireRole('categories'), (req, res) => {
  const a = req.body.action;
  if (a === 'add') {
    const key = slugify(req.body.key || req.body.label).replace(/-/g, '_');
    const label = String(req.body.label || '').trim() || key;
    const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#6b7280';
    if (key && !db.prepare('SELECT 1 FROM categories WHERE key=?').get(key)) {
      const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM categories').get().m;
      db.prepare('INSERT INTO categories (key,label,color,sort_order) VALUES (?,?,?,?)').run(key, label, color, max + 1);
    }
  } else if (a === 'update') {
    const id = req.body.id;
    const label = String(req.body.label || '').trim();
    const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#6b7280';
    const sort = parseInt(req.body.sort_order, 10) || 0;
    const active = req.body.active ? 1 : 0;
    db.prepare('UPDATE categories SET label=?, color=?, sort_order=?, active=? WHERE id=?').run(label, color, sort, active, id);
  } else if (a === 'delete') {
    const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.body.id);
    const used = cat && db.prepare('SELECT 1 FROM reviews WHERE final_category=? LIMIT 1').get(cat.key);
    if (cat && !used) db.prepare('DELETE FROM categories WHERE id=?').run(cat.id);
    else if (cat) db.prepare('UPDATE categories SET active=0 WHERE id=?').run(cat.id); // in use -> deactivate
  }
  res.redirect(BASE + '/admin/categories?saved=1');
});

// --------------------------------------------------------------------------
// Source types (Website / Facebook / Video / ...)
// --------------------------------------------------------------------------
router.get('/admin/source-types', requireRole('source_types'), (req, res) => {
  res.render('admin-source-types', { title: 'Source types', types: listSourceTypes(false), saved: req.query.saved === '1' });
});
router.post('/admin/source-types', requireRole('source_types'), (req, res) => {
  const a = req.body.action;
  if (a === 'add') {
    const key = slugify(req.body.label).replace(/-/g, '_');
    const label = String(req.body.label || '').trim() || key;
    if (key && !db.prepare('SELECT 1 FROM source_types WHERE key=?').get(key)) {
      const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM source_types').get().m;
      db.prepare('INSERT INTO source_types (key,label,sort_order) VALUES (?,?,?)').run(key, label, max + 1);
    }
  } else if (a === 'update') {
    db.prepare('UPDATE source_types SET label=?, sort_order=?, active=? WHERE id=?')
      .run(String(req.body.label || '').trim(), parseInt(req.body.sort_order, 10) || 0, req.body.active ? 1 : 0, req.body.id);
  } else if (a === 'delete') {
    const t = db.prepare('SELECT * FROM source_types WHERE id=?').get(req.body.id);
    const used = t && db.prepare('SELECT 1 FROM submissions WHERE source_type=? LIMIT 1').get(t.key);
    if (t && !used) db.prepare('DELETE FROM source_types WHERE id=?').run(t.id);
    else if (t) db.prepare('UPDATE source_types SET active=0 WHERE id=?').run(t.id);
  }
  res.redirect(BASE + '/admin/source-types?saved=1');
});

// --------------------------------------------------------------------------
// Languages (public fact-checks are auto-translated into the enabled ones)
// --------------------------------------------------------------------------
router.get('/admin/languages', requireRole('languages'), (req, res) => {
  res.render('admin-languages', { title: 'Languages', langs: listLanguages(false), saved: req.query.saved === '1' });
});
router.post('/admin/languages', requireRole('languages'), (req, res) => {
  const a = req.body.action;
  if (a === 'add') {
    const code = String(req.body.code || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 8);
    const label = String(req.body.label || '').trim() || code;
    const dir = req.body.dir === 'rtl' ? 'rtl' : 'ltr';
    if (code && !db.prepare('SELECT 1 FROM languages WHERE code=?').get(code)) {
      const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM languages').get().m;
      db.prepare('INSERT INTO languages (code,label,dir,sort_order) VALUES (?,?,?,?)').run(code, label, dir, max + 1);
    }
  } else if (a === 'update') {
    const l = db.prepare('SELECT * FROM languages WHERE code=?').get(req.body.code);
    if (l && !l.is_default) {   // default language (English) always stays enabled
      db.prepare('UPDATE languages SET label=?, dir=?, enabled=?, sort_order=? WHERE code=?')
        .run(String(req.body.label || '').trim() || l.label, req.body.dir === 'rtl' ? 'rtl' : 'ltr',
          req.body.enabled ? 1 : 0, parseInt(req.body.sort_order, 10) || 0, l.code);
    }
  } else if (a === 'delete') {
    const l = db.prepare('SELECT * FROM languages WHERE code=?').get(req.body.code);
    if (l && !l.is_default) {
      db.prepare('DELETE FROM fc_translations WHERE lang=?').run(l.code);
      db.prepare('DELETE FROM languages WHERE code=?').run(l.code);
    }
  }
  res.redirect(BASE + '/admin/languages?saved=1');
});

// --------------------------------------------------------------------------
// Settings (API key, model, theme, accent, site name)
// --------------------------------------------------------------------------
router.get('/admin/settings', requireRole('settings'), (req, res) => {
  const keySet = !!settingsGet('anthropic_api_key', '');
  res.render('admin-settings', {
    title: 'Settings', keySet,
    model: settingsGet('model', 'claude-opus-4-8'),
    theme: settingsGet('theme', 'light'),
    accent: settingsGet('accent', '#2b6a5b'),
    site_name: settingsGet('site_name', 'Kashmir Fact-Check'),
    tagline: settingsGet('tagline', ''),
    logo: settingsGet('logo_path', ''),
    about_text: settingsGet('about_text', ''),
    saved: req.query.saved === '1',
  });
});
router.post('/admin/settings', requireRole('settings'), uploadLogo, (req, res) => {
  settingsSet('site_name', String(req.body.site_name || '').trim() || 'Kashmir Fact-Check');
  if (typeof req.body.tagline === 'string') settingsSet('tagline', req.body.tagline.trim());
  settingsSet('model', ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'].includes(req.body.model) ? req.body.model : 'claude-opus-4-8');
  settingsSet('theme', req.body.theme === 'dark' ? 'dark' : 'light');
  settingsSet('accent', /^#[0-9a-f]{6}$/i.test(req.body.accent) ? req.body.accent : '#2b6a5b');
  const key = String(req.body.anthropic_api_key || '').trim();
  if (key === '__CLEAR__') settingsSet('anthropic_api_key', '');
  else if (key) settingsSet('anthropic_api_key', key);   // only overwrite when a new value is given
  if (req.body.remove_logo) settingsSet('logo_path', '');
  else if (req.file) settingsSet('logo_path', '/uploads/' + req.file.filename);
  if (typeof req.body.about_text === 'string') settingsSet('about_text', req.body.about_text.trim());
  res.redirect(BASE + '/admin/settings?saved=1');
});

// --------------------------------------------------------------------------
// Users
// --------------------------------------------------------------------------
router.get('/admin/users', requireRole('users'), (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, twofa_enabled, active, created_at FROM users ORDER BY id').all();
  res.render('admin-users', { title: 'Users', users, ROLES, error: req.query.error || null, saved: req.query.saved === '1' });
});
router.post('/admin/users', requireRole('users'), (req, res) => {
  const a = req.body.action;
  const activeAdmins = () => db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1`).get().c;

  if (a === 'add') {
    const username = String(req.body.username || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const role = ROLES.includes(req.body.role) ? req.body.role : 'submitter';
    const pw = String(req.body.password || '');
    if (!username || !pw) return res.redirect(BASE + '/admin/users?error=' + encodeURIComponent('Username and password are required'));
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.redirect(BASE + '/admin/users?error=' + encodeURIComponent('Username already exists'));
    db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)').run(username, name, hashPassword(pw), role);
  } else if (a === 'update') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.body.id);
    if (!u) return res.redirect(BASE + '/admin/users');
    const role = ROLES.includes(req.body.role) ? req.body.role : u.role;
    const name = String(req.body.name || '').trim();
    const active = req.body.active ? 1 : 0;
    // Guard: never remove the last active admin
    if ((u.role === 'admin' && (role !== 'admin' || !active)) && activeAdmins() <= 1) {
      return res.redirect(BASE + '/admin/users?error=' + encodeURIComponent('Cannot demote/disable the last admin'));
    }
    db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(name, role, active, u.id);
    if (String(req.body.password || '')) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(req.body.password), u.id);
  } else if (a === 'delete') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.body.id);
    if (u && !(u.role === 'admin' && activeAdmins() <= 1) && u.id !== req.session.user.id) {
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    }
  }
  res.redirect(BASE + '/admin/users?saved=1');
});

// --------------------------------------------------------------------------
// Two-factor setup (each user manages their own)
// --------------------------------------------------------------------------
router.get('/admin/2fa', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  let qr = null, secret = null;
  if (!u.twofa_enabled) {
    secret = req.session.twofaSetup || generateSecret();
    req.session.twofaSetup = secret;
    qr = await QRCode.toDataURL(otpauthURL(u.username, secret, res.locals.site_name || 'KashmirFactCheck'));
  }
  res.render('admin-2fa', { title: 'Two-factor', enabled: !!u.twofa_enabled, qr, secret, error: null });
});
router.post('/admin/2fa', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (req.body.action === 'disable') {
    db.prepare('UPDATE users SET twofa_enabled=0, twofa_secret=NULL WHERE id=?').run(u.id);
    return res.redirect(BASE + '/admin/2fa');
  }
  const secret = req.session.twofaSetup;
  if (!secret || !totpVerify(secret, req.body.code)) {
    const qr = await QRCode.toDataURL(otpauthURL(u.username, secret || generateSecret(), res.locals.site_name || 'KashmirFactCheck'));
    return res.status(400).render('admin-2fa', { title: 'Two-factor', enabled: false, qr, secret, error: 'Code did not match. Try again.' });
  }
  db.prepare('UPDATE users SET twofa_enabled=1, twofa_secret=? WHERE id=?').run(secret, u.id);
  delete req.session.twofaSetup;
  res.redirect(BASE + '/admin/2fa');
});

app.use(BASE || '/', router);
if (BASE) app.get('/', (req, res) => res.redirect(BASE + '/'));
app.listen(PORT, () => console.log(`kn-factcheck listening on :${PORT} (base "${BASE}")`));
