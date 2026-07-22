'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const { scrape, normalizeUrl } = require('./lib/scrape');
const { analyse, CATEGORIES, CATEGORY_META } = require('./lib/analyse');

const app = express();
const PORT = process.env.PORT || 3925;
const BASE = process.env.BASE_PATH || '/kn';         // mounted under /kn behind nginx
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'factcheck2026';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(BASE + '/static', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'kn-factcheck-dev-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));

// Make base path, category metadata and login state available to every view.
app.use((req, res, next) => {
  res.locals.base = BASE;
  res.locals.CATEGORY_META = CATEGORY_META;
  res.locals.CATEGORIES = CATEGORIES;
  res.locals.isAdmin = !!(req.session && req.session.admin);
  res.locals.aiEnabled = !!process.env.ANTHROPIC_API_KEY;
  res.locals.path = req.path;
  next();
});

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect(BASE + '/admin/login');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'fact-check';
}
function uniqueSlug(base) {
  let slug = base, n = 1;
  while (db.prepare('SELECT 1 FROM reviews WHERE slug = ?').get(slug)) {
    slug = base + '-' + (++n);
  }
  return slug;
}

// --------------------------------------------------------------------------
// Public
// --------------------------------------------------------------------------
router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT r.*, s.url, s.source_domain, s.raw_title
    FROM reviews r JOIN submissions s ON s.id = r.submission_id
    WHERE s.status = 'published'
    ORDER BY r.published_at DESC
  `).all();
  res.render('public-list', { title: 'Kashmir Fact-Check', items });
});

router.get('/fact-check/:slug', (req, res) => {
  const item = db.prepare(`
    SELECT r.*, s.url, s.source_domain, s.raw_title, s.raw_author, s.created_at AS submitted_at
    FROM reviews r JOIN submissions s ON s.id = r.submission_id
    WHERE r.slug = ? AND s.status = 'published'
  `).get(req.params.slug);
  if (!item) return res.status(404).render('notfound', { title: 'Not found' });
  const ai = db.prepare(`SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1`).get(item.submission_id);
  let claims = [];
  try { claims = ai && ai.extracted_claims ? JSON.parse(ai.extracted_claims) : []; } catch (e) {}
  res.render('public-item', { title: item.public_summary.slice(0, 60), item, claims });
});

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------
router.get('/admin/login', (req, res) => {
  res.render('login', { title: 'Sign in', error: null });
});
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = { user: username };
    return res.redirect(BASE + '/admin');
  }
  res.status(401).render('login', { title: 'Sign in', error: 'Invalid credentials' });
});
router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect(BASE + '/'));
});

// --------------------------------------------------------------------------
// Admin - queue / dashboard
// --------------------------------------------------------------------------
router.get('/admin', requireAdmin, (req, res) => {
  const queue = db.prepare(`
    SELECT s.*, a.suggested_category, a.confidence
    FROM submissions s
    LEFT JOIN ai_analyses a ON a.id = (SELECT id FROM ai_analyses WHERE submission_id = s.id ORDER BY id DESC LIMIT 1)
    WHERE s.status IN ('pending','analyzed')
    ORDER BY s.created_at DESC
  `).all();
  const published = db.prepare(`
    SELECT s.id, s.source_domain, r.slug, r.final_category, r.public_summary, r.published_at
    FROM submissions s JOIN reviews r ON r.submission_id = s.id
    WHERE s.status = 'published' ORDER BY r.published_at DESC LIMIT 20
  `).all();
  res.render('admin-queue', { title: 'Review queue', queue, published });
});

// Submit a URL -> scrape -> analyse -> create submission + ai_analysis.
router.get('/admin/submit', requireAdmin, (req, res) => {
  res.render('admin-submit', { title: 'Submit a URL', error: null, url: '' });
});
router.post('/admin/submit', requireAdmin, async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).render('admin-submit', { title: 'Submit a URL', error: 'Please enter a valid http(s) URL.', url });
  }
  const normalized = normalizeUrl(url);
  const existing = db.prepare('SELECT id FROM submissions WHERE normalized_url = ?').get(normalized);
  if (existing) return res.redirect(BASE + '/admin/review/' + existing.id);

  let scraped;
  try {
    scraped = await scrape(url);
  } catch (e) {
    return res.status(502).render('admin-submit', { title: 'Submit a URL', error: 'Could not fetch that URL: ' + e.message, url });
  }

  const info = db.prepare(`
    INSERT INTO submissions (url, normalized_url, source_domain, raw_title, raw_text, raw_author, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(url, normalized, scraped.domain, scraped.title, scraped.text, scraped.author);
  const submissionId = info.lastInsertRowid;

  const policy = db.prepare('SELECT * FROM policies WHERE is_active = 1').get();
  let a;
  try {
    a = await analyse({ policyBody: policy ? policy.body : '', title: scraped.title, text: scraped.text, url });
  } catch (e) {
    a = { extracted_claims: [], suggested_category: 'unverified', reasoning: 'AI analysis failed: ' + e.message,
          confidence: 0, public_summary: '', model_used: 'error', input_tokens: null, output_tokens: null, raw_response: null };
  }

  db.prepare(`
    INSERT INTO ai_analyses (submission_id, policy_id, extracted_claims, suggested_category, reasoning,
                             confidence, public_summary, model_used, input_tokens, output_tokens, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submissionId, policy ? policy.id : null, JSON.stringify(a.extracted_claims || []),
    a.suggested_category, a.reasoning, a.confidence, a.public_summary, a.model_used,
    a.input_tokens, a.output_tokens, a.raw_response);

  db.prepare(`UPDATE submissions SET status = 'analyzed' WHERE id = ?`).run(submissionId);
  res.redirect(BASE + '/admin/review/' + submissionId);
});

// Review one submission.
router.get('/admin/review/:id', requireAdmin, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).render('notfound', { title: 'Not found' });
  const ai = db.prepare('SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  const review = db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  let claims = [];
  try { claims = ai && ai.extracted_claims ? JSON.parse(ai.extracted_claims) : []; } catch (e) {}
  res.render('admin-review', { title: 'Review #' + sub.id, sub, ai, review, claims });
});

// Publish / reject.
router.post('/admin/review/:id', requireAdmin, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).render('notfound', { title: 'Not found' });

  const action = req.body.action;
  if (action === 'reject') {
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE id = ?`).run(sub.id);
    return res.redirect(BASE + '/admin');
  }

  const category = CATEGORIES.includes(req.body.final_category) ? req.body.final_category : 'unverified';
  const publicSummary = String(req.body.public_summary || '').trim();
  const editorNotes = String(req.body.editor_notes || '').trim();
  const ai = db.prepare('SELECT * FROM ai_analyses WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  const overrode = ai && ai.suggested_category !== category ? 1 : 0;

  if (!publicSummary) {
    const claims = (() => { try { return JSON.parse(ai.extracted_claims || '[]'); } catch (e) { return []; } })();
    return res.status(400).render('admin-review', {
      title: 'Review #' + sub.id, sub, ai,
      review: db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id),
      claims, error: 'A public summary is required before publishing.',
    });
  }

  const existing = db.prepare('SELECT * FROM reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(sub.id);
  if (existing) {
    db.prepare(`UPDATE reviews SET final_category=?, public_summary=?, editor_notes=?, overrode_ai=?, published_at=datetime('now') WHERE id=?`)
      .run(category, publicSummary, editorNotes, overrode, existing.id);
  } else {
    const slug = uniqueSlug(slugify(sub.raw_title || sub.source_domain || 'fact-check'));
    db.prepare(`INSERT INTO reviews (submission_id, final_category, public_summary, slug, editor_notes, overrode_ai, published_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(sub.id, category, publicSummary, slug, editorNotes, overrode);
  }
  db.prepare(`UPDATE submissions SET status = 'published' WHERE id = ?`).run(sub.id);
  res.redirect(BASE + '/admin');
});

// --------------------------------------------------------------------------
// Admin - editorial policy (policy is a DB row, editable without deploy)
// --------------------------------------------------------------------------
router.get('/admin/policy', requireAdmin, (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE is_active = 1').get();
  const history = db.prepare('SELECT id, title, created_at, is_active FROM policies ORDER BY id DESC').all();
  res.render('admin-policy', { title: 'Editorial policy', policy, history, saved: req.query.saved === '1' });
});
router.post('/admin/policy', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim() || 'Editorial Policy';
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect(BASE + '/admin/policy');
  // New active version; deactivate the current one (one-active-policy index).
  const tx = db.transaction(() => {
    db.prepare('UPDATE policies SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('INSERT INTO policies (title, body, is_active) VALUES (?, ?, 1)').run(title, body);
  });
  tx();
  res.redirect(BASE + '/admin/policy?saved=1');
});

app.use(BASE, router);
app.get('/', (req, res) => res.redirect(BASE + '/'));

app.listen(PORT, () => console.log(`kn-factcheck listening on :${PORT} (base ${BASE})`));
