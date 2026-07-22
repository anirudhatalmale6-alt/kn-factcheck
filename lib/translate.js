'use strict';

// Translate a fact-check's reader-facing text into several languages via Claude.
// targets: [{code, label}]  text: {public_summary, claims:[...], editor_notes}
// Returns { code: {public_summary, claims:[...], editor_notes} } or {} if no key / on failure.
async function translate({ apiKey, model, targets, text }) {
  apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !targets || !targets.length) return {};

  const langList = targets.map((t) => `${t.code} (${t.label})`).join(', ');
  const system =
    'You are a professional translator for a Kashmir news fact-checking site. Translate the given ' +
    'fact-check text faithfully and naturally into each target language. Preserve meaning and neutral ' +
    'tone precisely; do not add, remove, editorialise or explain. Keep proper nouns sensible for the ' +
    'target script. Target languages: ' + langList + '. Return one object per target language.';

  const payload = {
    public_summary: String(text.public_summary || ''),
    claims: Array.isArray(text.claims) ? text.claims : [],
    editor_notes: String(text.editor_notes || ''),
  };

  const body = {
    model: model || process.env.KN_MODEL || 'claude-opus-4-8',
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: 'Translate this fact-check text:\n\n' + JSON.stringify(payload, null, 2) }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  lang: { type: 'string' },
                  public_summary: { type: 'string' },
                  claims: { type: 'array', items: { type: 'string' } },
                  editor_notes: { type: 'string' },
                },
                required: ['lang', 'public_summary', 'claims', 'editor_notes'],
                additionalProperties: false,
              },
            },
          },
          required: ['translations'],
          additionalProperties: false,
        },
      },
    },
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Translate API error: ' + ((data.error && data.error.message) || resp.status));
  const tb = (data.content || []).find((b) => b.type === 'text');
  if (!tb) throw new Error('Translate: no text block');
  const parsed = JSON.parse(tb.text);
  const out = {};
  const valid = new Set(targets.map((t) => t.code));
  for (const tr of parsed.translations || []) {
    if (valid.has(tr.lang)) {
      out[tr.lang] = {
        public_summary: String(tr.public_summary || ''),
        claims: Array.isArray(tr.claims) ? tr.claims : [],
        editor_notes: String(tr.editor_notes || ''),
      };
    }
  }
  return out;
}

module.exports = { translate };
