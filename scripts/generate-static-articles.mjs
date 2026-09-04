#!/usr/bin/env node
/**
 * generate-static-articles.mjs
 * ----------------------------------------------------------------
 * Pre-renders a real, static, crawlable HTML page for every
 * PUBLISHED article in Firestore, and regenerates sitemap.xml with
 * real per-article URLs.
 *
 * WHY THIS EXISTS
 * The live site (index.html) is a single-page app: it fetches
 * article content from Firestore in the browser after the page
 * loads. Search engines that execute JavaScript (Googlebot) can
 * usually still index it, but a lot of things that DON'T run
 * JavaScript — Twitter/X's link-preview bot, many Slack/Discord
 * unfurlers, some older crawlers — will only ever see an empty
 * shell. This script produces a plain, permanent, readable HTML
 * copy of each article at:
 *
 *     /articles/<id>/index.html
 *
 * with the correct <title>, meta description, Open Graph/Twitter
 * tags, and NewsArticle structured data baked in as real static
 * text — no JavaScript required to see it. Each static page also
 * links to the full interactive site for readers who want dark
 * mode, related stories, etc.
 *
 * USAGE
 *   node scripts/generate-static-articles.mjs
 *
 * Run this after publishing/editing articles, or wire it up to run
 * automatically — see .github/workflows/rebuild-static-pages.yml
 * for a scheduled GitHub Action that does this for you.
 *
 * REQUIRES: Node 18+ (built-in fetch). No npm dependencies.
 * ----------------------------------------------------------------
 */

import { writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---- Configuration — matches the values in index.html ----
const PROJECT_ID = 'nzbrief-d6305';
const SITE_BASE = 'https://dupedogdeving.github.io/TheNewZealandBrief/';
const SITE_NAME = 'The New Zealand Brief';
const OUTPUT_DIR = path.join(REPO_ROOT, 'articles');
const SITEMAP_PATH = path.join(REPO_ROOT, 'sitemap.xml');

// ---- Fetch published articles from Firestore via the public REST API ----
// This mirrors the exact query the live app uses for anonymous visitors:
// where('draft','==',false), where('date','<=', now), orderBy('date','desc').
// Firestore security rules only allow a *list* query to return documents
// that satisfy the rule's condition (draft == false) if the query itself
// carries that same filter — an unfiltered request is correctly rejected
// with 403. So this has to use the structured runQuery endpoint (which
// supports filters), not the plain "list documents" endpoint.
async function fetchPublishedArticles() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const nowIso = new Date().toISOString();

  const body = {
    structuredQuery: {
      from: [{ collectionId: 'articles' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'draft' },
                op: 'EQUAL',
                value: { booleanValue: false },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'date' },
                op: 'LESS_THAN_OR_EQUAL',
                value: { stringValue: nowIso },
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: 300,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore runQuery failed: ${res.status} ${res.statusText} ${text}`);
  }
  const rows = await res.json();

  return rows
    .filter((row) => row.document) // skip entries with no document (e.g. skipped-results markers)
    .map((row) => ({
      id: row.document.name.split('/').pop(),
      ...firestoreFieldsToObject(row.document.fields || {}),
    }));
}

// Minimal Firestore REST "Value" decoder for the field types this app uses.
function firestoreFieldsToObject(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = firestoreValueToJs(value);
  }
  return out;
}
function firestoreValueToJs(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs);
  if ('mapValue' in value) return firestoreFieldsToObject(value.mapValue.fields || {});
  return null;
}

// ---- HTML helpers ----
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function teaser(description, maxLen = 160) {
  const flat = String(description).replace(/\s+/g, ' ').trim();
  return flat.length > maxLen ? flat.slice(0, maxLen - 1).trim() + '\u2026' : flat;
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-NZ', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Pacific/Auckland',
    }) + ' NZT';
  } catch { return iso; }
}

function renderArticlePage(article) {
  const url = `${SITE_BASE}articles/${article.id}/`;
  const title = `${article.heading} \u2014 ${SITE_NAME}`;
  const description = teaser(article.description);
  const image = article.image || `${SITE_BASE}social-share.png`;
  const paragraphs = String(article.description)
    .split(/\n+/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ');

  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.heading,
    description,
    image: [image],
    datePublished: article.date,
    dateModified: article.date,
    articleSection: article.category || undefined,
    author: { '@type': 'Organization', name: SITE_NAME },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: `${SITE_BASE}social-share.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  });

  return `<!DOCTYPE html>
<html lang="en-NZ">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${url}" />
<meta name="robots" content="index, follow" />

<meta property="og:type" content="article" />
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:locale" content="en_NZ" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />

<script type="application/ld+json">${ld}</script>

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;0,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #F5F4EF; color: #14181C; font-family: 'IBM Plex Sans', -apple-system, sans-serif;
    line-height: 1.6;
  }
  header.masthead { background: #0B1F2A; color: #fff; padding: 18px 24px; }
  header.masthead a { color: #fff; text-decoration: none; font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 20px; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 24px 80px; }
  .eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #1C6B57; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: clamp(28px, 4vw, 40px); line-height: 1.15; margin: 10px 0 14px; }
  .dateline { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: #57626C; margin-bottom: 24px; }
  .cover { width: 100%; border-radius: 12px; margin-bottom: 28px; display: block; }
  .body p { font-size: 18px; margin: 0 0 18px; }
  .cta { display: inline-block; margin-top: 36px; background: #1C6B57; color: #fff; text-decoration: none; font-weight: 600; padding: 12px 24px; border-radius: 100px; }
  .back { display: inline-block; margin-top: 18px; color: #1C6B57; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<header class="masthead"><a href="${SITE_BASE}">${escapeHtml(SITE_NAME)}</a></header>
<main>
  <span class="eyebrow">${escapeHtml(article.category || 'News')}</span>
  <h1>${escapeHtml(article.heading)}</h1>
  <div class="dateline">${escapeHtml(fmtDate(article.date))}</div>
  ${article.image ? `<img class="cover" src="${escapeHtml(article.image)}" alt="${escapeHtml(article.heading)}" />` : ''}
  <div class="body">
      ${paragraphs}
  </div>
  <a class="cta" href="${SITE_BASE}?article=${encodeURIComponent(article.id)}">Open the interactive site \u2192</a>
  <br />
  <a class="back" href="${SITE_BASE}">\u2190 Back to all stories</a>
</main>
</body>
</html>
`;
}

function renderSitemap(articles) {
  const staticUrls = [
    { loc: SITE_BASE, changefreq: 'hourly', priority: '1.0' },
    { loc: `${SITE_BASE}privacy.html`, changefreq: 'yearly', priority: '0.3' },
  ];
  const articleUrls = articles.map((a) => ({
    loc: `${SITE_BASE}articles/${a.id}/`,
    lastmod: new Date(a.date).toISOString().slice(0, 10),
    changefreq: 'monthly',
    priority: '0.7',
  }));
  const all = [...staticUrls, ...articleUrls];
  const body = all.map((u) => `  <url>
    <loc>${u.loc}</loc>
${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

async function main() {
  console.log('Fetching published articles from Firestore\u2026');
  const articles = await fetchPublishedArticles();
  console.log(`Found ${articles.length} published article(s).`);

  // Clean out any pages for articles that were deleted or unpublished.
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const article of articles) {
    const dir = path.join(OUTPUT_DIR, article.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderArticlePage(article), 'utf8');
  }

  await writeFile(SITEMAP_PATH, renderSitemap(articles), 'utf8');

  console.log(`Wrote ${articles.length} static article page(s) to ${path.relative(REPO_ROOT, OUTPUT_DIR)}/`);
  console.log(`Wrote ${path.relative(REPO_ROOT, SITEMAP_PATH)}`);
}

main().catch((err) => {
  console.error('generate-static-articles failed:', err);
  process.exit(1);
});
