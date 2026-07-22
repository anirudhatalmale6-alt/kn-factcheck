'use strict';
const cheerio = require('cheerio');

// Normalise a URL so the same article submitted twice collapses to one row.
function normalizeUrl(input) {
  try {
    const url = new URL(String(input).trim());
    url.hash = '';
    url.host = url.host.toLowerCase();
    for (const k of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(k) || /^(fbclid|gclid|mc_cid|mc_eid|igshid)$/i.test(k)) {
        url.searchParams.delete(k);
      }
    }
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return String(input).trim();
  }
}

function domainOf(input) {
  try { return new URL(input).host.replace(/^www\./, ''); } catch (e) { return ''; }
}

// Best-guess the source/content type from the URL. Editors can override it.
function detectSourceType(input) {
  const u = String(input).toLowerCase();
  const host = domainOf(input);
  if (/facebook\.com|fb\.watch|fb\.me/.test(host)) return 'facebook';
  if (/twitter\.com|x\.com|t\.co/.test(host)) return 'twitter';
  if (/instagram\.com/.test(host)) return 'instagram';
  if (/youtube\.com|youtu\.be/.test(host)) return 'youtube';
  if (/tiktok\.com/.test(host)) return 'tiktok';
  if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/.test(u)) return 'image';
  if (/\.(mp4|mov|webm|avi|mkv)(\?|$)/.test(u)) return 'video';
  if (/\.(pdf|docx?|pptx?)(\?|$)/.test(u)) return 'document';
  return 'website';
}

// Lightweight readability-style extraction. Enough for most news pages; social
// posts (X/Facebook) return thin text on purpose - we link+describe, not scrape.
async function scrape(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; KashmirFactCheck/0.1; +prototype)' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, aside, form, header').remove();

  const title =
    ($('meta[property="og:title"]').attr('content') ||
      $('title').first().text() ||
      $('h1').first().text() ||
      '').trim();

  const author =
    ($('meta[name="author"]').attr('content') ||
      $('meta[property="article:author"]').attr('content') ||
      $('[rel="author"]').first().text() ||
      '').trim();

  let container = $('article').first();
  if (!container.length) container = $('main').first();
  if (!container.length) container = $('body');

  const paras = [];
  container.find('p').each((i, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 40) paras.push(t);
  });
  let text = paras.join('\n\n');
  if (text.length < 120) text = container.text().replace(/\s+/g, ' ').trim();

  return {
    title: title.slice(0, 500),
    author: author.slice(0, 200),
    text: text.slice(0, 20000),
    domain: domainOf(url),
  };
}

module.exports = { scrape, normalizeUrl, domainOf, detectSourceType };
