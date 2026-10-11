// fetch-news.js
const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

const ROOT = path.join(__dirname, "..");
const KEYWORDS_FILE = path.join(ROOT, "keywords.json");
const SOURCES_FILE = path.join(ROOT, "sources.json");
const RESULTS_FILE = path.join(ROOT, "data", "results.json");

const MAX_AGE_DAYS = 45;
const MAX_ITEMS = 1500;
const FETCH_TIMEOUT_MS = 15000;

const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

// کوتیشن‌دار کردن attributeهای بی‌کوتیشن در XML خراب
function sanitizeXml(xml) {
  return xml.replace(/<([a-zA-Z!?/][^<>]*)>/g, (fullMatch, inner) => {
    const fixed = inner.replace(
      /([a-zA-Z_:][\w:.-]*)=([^"'\s>][^\s>]*)/g,
      (m, attr, val) => `${attr}="${val.replace(/"/g, "&quot;")}"`
    );
    return `<${fixed}>`;
  });
}

async function fetchRawXml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(str) {
  return (str || "")
    .replace(/\u064A/g, "ی")
    .replace(/\u0643/g, "ک")
    .replace(/\u200c/g, " ")
    .toLowerCase();
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function matchKeywords(text, keywords) {
  const normText = normalize(text);
  return keywords.filter((k) => normText.includes(normalize(k)));
}

function safeDate(item) {
  const d = item.isoDate || item.pubDate;
  const parsed = d ? new Date(d) : null;
  if (parsed && !isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

async function fetchSource(source, keywords) {
  const matched = [];
  try {
    const rawXml = await fetchRawXml(source.url);
    let feed;
    try {
      feed = await parser.parseString(rawXml);
    } catch (parseErr) {
      feed = await parser.parseString(sanitizeXml(rawXml));
    }
    for (const item of feed.items || []) {
      const haystack = [item.title, item.contentSnippet, item.content, item.summary]
        .filter(Boolean)
        .join(" \n ");
      const hits = matchKeywords(haystack, keywords);
      if (hits.length === 0) continue;
      matched.push({
        title: (item.title || "").trim(),
        link: item.link || item.guid || "",
        source: source.name,
        pubDate: safeDate(item),
        matchedKeywords: hits,
        snippet: (item.contentSnippet || "").trim().slice(0, 300),
      });
    }
    return { name: source.name, status: "ok", found: matched.length, items: matched };
  } catch (err) {
    return { name: source.name, status: "error", error: err.message, found: 0, items: [] };
  }
}

async function main() {
  const { keywords } = loadJson(KEYWORDS_FILE, { keywords: [] });
  const sources = loadJson(SOURCES_FILE, []);
  const previous = loadJson(RESULTS_FILE, { items: [] });

  if (!keywords.length) {
    console.error("keywords.json خالیه.");
    process.exit(1);
  }
  if (!sources.length) {
    console.error("sources.json خالیه.");
    process.exit(1);
  }

  console.log(`جستجوی ${keywords.length} کلمه‌ی کلیدی در ${sources.length} منبع...`);

  const results = await Promise.all(sources.map((s) => fetchSource(s, keywords)));
  const sourceReport = results.map(({ items, ...rest }) => rest);
  const newItems = results.flatMap((r) => r.items);

  const byLink = new Map();
  for (const item of [...previous.items, ...newItems]) {
    if (!item.link) continue;
    const existing = byLink.get(item.link);
    if (!existing) {
      byLink.set(item.link, item);
    } else {
      existing.matchedKeywords = Array.from(
        new Set([...existing.matchedKeywords, ...item.matchedKeywords])
      );
    }
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let merged = Array.from(byLink.values()).filter(
    (item) => new Date(item.pubDate).getTime() >= cutoff
  );
  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  merged = merged.slice(0, MAX_ITEMS);

  const output = {
    lastUpdated: new Date().toISOString(),
    keywords,
    totalItems: merged.length,
    sourceReport,
    items: merged,
  };

  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2), "utf8");

  console.log(`تمام شد. ${newItems.length} خبر مرتبط پیدا شد. مجموع خبرهای ذخیره‌شده: ${merged.length}`);
  const failed = sourceReport.filter((s) => s.status === "error");
  if (failed.length) {
    console.log("منابعی که خطا دادن:");
    failed.forEach((s) => console.log(`  - ${s.name}: ${s.error}`));
  }
}

main().catch((err) => {
  console.error("خطای کلی:", err);
  process.exit(1);
});
