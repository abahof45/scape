/**
 * Own HTML scraper — DuckDuckGo HTML results + optional page fetch
 * No paid search API keys.
 */

const UA =
  "Mozilla/5.0 (compatible; WitherlyBot/1.0; +https://witherly-api.workers.dev)";

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s) {
  return decodeHtml(String(s || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function unwrapDdgRedirect(href) {
  try {
    let h = href;
    if (h.startsWith("//")) h = "https:" + h;
    const u = new URL(h);
    if (u.hostname.includes("duckduckgo.com") && u.searchParams.has("uddg")) {
      return decodeURIComponent(u.searchParams.get("uddg"));
    }
  } catch {}
  return href;
}

/**
 * Scrape DuckDuckGo HTML search page for organic results
 */
async function scrapeDuckDuckGoHtml(query, num = 8) {
  const target =
    "https://html.duckduckgo.com/html/?" +
    new URLSearchParams({ q: query }).toString();

  const html = await fetchText(target, 14000);
  const results = [];

  // result links
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe =
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/gi;

  const snippets = [];
  let sm;
  while ((sm = snipRe.exec(html))) {
    snippets.push(stripTags(sm[1]));
  }

  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) && results.length < num) {
    let href = unwrapDdgRedirect(decodeHtml(m[1]));
    const title = stripTags(m[2]);
    if (!href || !title) continue;
    if (/duckduckgo\.com/i.test(href)) continue;
    if (!/^https?:\/\//i.test(href)) continue;
    results.push({
      title: title.slice(0, 200),
      link: href,
      snippet: (snippets[i] || "").slice(0, 400),
    });
    i += 1;
  }

  return results;
}

/**
 * Lightweight page scrape: title + meta description + first text
 */
async function scrapePage(url, timeoutMs = 8000) {
  try {
    const html = await fetchText(url, timeoutMs);
    const title =
      stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "") ||
      "";
    const metaDesc =
      stripTags(
        (html.match(
          /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
        ) ||
          html.match(
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
          ) ||
          [])[1] || ""
      ) || "";
    const bodyText = stripTags(
      (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || html
    ).slice(0, 1200);

    return {
      title: title.slice(0, 200),
      description: metaDesc.slice(0, 400),
      text: bodyText,
    };
  } catch {
    return null;
  }
}

/**
 * Enrich top N results with live page snippets
 */
async function enrichResults(results, maxPages = 3) {
  const out = [...results];
  const n = Math.min(maxPages, out.length);
  await Promise.all(
    out.slice(0, n).map(async (r, idx) => {
      const page = await scrapePage(r.link);
      if (!page) return;
      if (!r.snippet && page.description) r.snippet = page.description;
      if (!r.snippet && page.text) r.snippet = page.text.slice(0, 300);
      if (page.title && page.title.length > 5) {
        // keep original title if better; optionally note
        r.pageTitle = page.title;
      }
      r.scraped = true;
    })
  );
  return out;
}

/**
 * Wikipedia open search as extra seed results
 */
async function scrapeWikipedia(query, num = 3) {
  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: String(num),
      format: "json",
      origin: "*",
    });
    const text = await fetchText(
      `https://en.wikipedia.org/w/api.php?${params}`,
      8000
    );
    const data = JSON.parse(text);
    const rows = data?.query?.search || [];
    return rows.map((row) => ({
      title: row.title,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        row.title.replace(/ /g, "_")
      )}`,
      snippet: stripTags(row.snippet || ""),
      source: "wikipedia",
    }));
  } catch {
    return [];
  }
}

/**
 * Full scrape pipeline
 */
async function scrapeSearch(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const num = Math.min(Math.max(Number(options.num) || 6, 1), 12);
  const scrapePages = Math.max(0, Number(options.scrapePages ?? 3));

  let results = [];
  try {
    results = await scrapeDuckDuckGoHtml(q, num);
  } catch (e) {
    console.warn("[scrape] DDG failed:", e.message);
  }

  if (results.length < 3) {
    const wiki = await scrapeWikipedia(q, 4);
    const seen = new Set(results.map((r) => r.link));
    for (const w of wiki) {
      if (!seen.has(w.link)) {
        results.push(w);
        seen.add(w.link);
      }
    }
  }

  results = results.slice(0, num);

  if (scrapePages > 0 && results.length) {
    results = await enrichResults(results, scrapePages);
  }

  return results;
}

module.exports = {
  scrapeSearch,
  scrapePage,
  stripTags,
};
