# Kashmir Fact-Check — Prototype

A working prototype of the Kashmir fact-check platform. A team member submits a
URL (news or social); the page is fetched and assessed by Claude against an
**editable editorial policy**; a human editor reviews the AI's suggestion and
publishes a verdict with a category badge on the public site.

This is Milestone 1: the schema + the submit → analyse → review → publish loop,
self-hosted (no third-party hosting bills). Built to grow into the full platform.

## Stack

- Node.js + Express + EJS
- SQLite (via better-sqlite3) — the prototype DB; the corrected Postgres schema
  is ready for the full-scale build
- Claude (Anthropic API) for the AI assessment step

## The flow

1. **Submit a URL** (staff) → the page is fetched and text extracted.
2. **AI assessment** → Claude reads the item against the *active editorial policy*
   and returns: extracted claims, a suggested category, reasoning, a confidence
   score, and a neutral public summary. The policy is trusted (system prompt);
   the scraped article is treated as untrusted input (prompt-injection safe).
   Output is schema-constrained to one of the seven categories.
3. **Human review** → an editor confirms or changes the category, edits the
   public summary, and publishes or rejects. Nothing auto-publishes.
4. **Public site** → published verdicts appear with a colour-coded badge.

## Categories

`verified` · `false` · `misleading` · `missing_context` · `unverified` ·
`satire` · `opinion`

## Editorial policy is a database row

The policy Claude assesses against is stored in the DB and editable at
`/admin/policy` — no redeploy needed. Saving creates a new active version and
keeps the history.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node app.js
# http://localhost:3925/kn
```

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `3925` |
| `BASE_PATH` | URL base path | `/kn` |
| `ANTHROPIC_API_KEY` | Enables the real Claude assessment. Without it, a clearly-labelled placeholder assessment is used so the full flow still works. | *(unset)* |
| `KN_MODEL` | Claude model | `claude-opus-4-8` |
| `ADMIN_USER` / `ADMIN_PASS` | Staff login | `admin` / `factcheck2026` |
| `SESSION_SECRET` | Session cookie secret | dev default |

## Notes for the full-scale build

- Move SQLite → Postgres (the reviewed schema, with row-level security + roles).
- Add real user accounts and roles (submitter / editor / admin) instead of a
  single shared login.
- Wayback snapshot at submission time; a `corrections` workflow (table already
  present); ClaimReview (schema.org) markup for Google Fact Check rich results.
- Prompt caching on the policy; per-item token logging (columns already present).
