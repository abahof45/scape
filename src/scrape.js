/**
 * Own HTML scraper — DuckDuckGo + SearXNG + Wikipedia
 * No paid search API keys.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

async function fetchText(url, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

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
 * Parse both HTML and Lite result pages
 */
function parseDdgHtml(html, num) {
  const results = [];

  // Classic HTML results
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

  // Lite results (different markup)
  if (results.length === 0) {
    const liteRe =
      /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRe.exec(html)) && results.length < num) {
      let href = unwrapDdgRedirect(decodeHtml(m[1]));
      const title = stripTags(m[2]);
      if (!href || !title) continue;
      if (/duckduckgo\.com/i.test(href)) continue;
      if (!/^https?:\/\//i.test(href)) continue;

      results.push({
        title: title.slice(0, 200),
        link: href,
        snippet: "",
      });
    }
  }

  return results;
}

/**
 * Try HTML endpoint, then Lite endpoint as fallback
 */
async function scrapeDuckDuckGoHtml(query, num = 8) {
  const attempts = [
    "https://html.duckduckgo.com/html/?" +
      new URLSearchParams({ q: query }).toString(),
    "https://lite.duckduckgo.com/lite/?" +
      new URLSearchParams({ q: query }).toString(),
  ];

  let lastError = null;

  for (const target of attempts) {
    for (let tryCount = 1; tryCount <= 2; tryCount++) {
      try {
        const html = await fetchText(target, 14000);
        const results = parseDdgHtml(html, num);

        if (results.length > 0) {
          console.log(
            `[scrape] DDG ok via ${target.includes("lite") ? "lite" : "html"} (${results.length} results)`
          );
          return results;
        }
      } catch (e) {
        lastError = e;
        console.warn(
          `[scrape] DDG attempt failed (${target.includes("lite") ? "lite" : "html"} try ${tryCount}):`,
          e.message
        );
        await new Promise((r) => setTimeout(r, 400 * tryCount));
      }
    }
  }

  throw lastError || new Error("DDG scrape failed after all attempts");
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
    out.slice(0, n).map(async (r) => {
      const page = await scrapePage(r.link);
      if (!page) return;
      if (!r.snippet && page.description) r.snippet = page.description;
      if (!r.snippet && page.text) r.snippet = page.text.slice(0, 300);
      if (page.title && page.title.length > 5) {
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
 * Scrape a public SearXNG instance (JSON API)
 */
async function scrapeSearx(query, num = 6) {
  const instances = [
    "https://searx.be",
    "https://search.sapti.me",
    "https://searx.tiekoetter.com",
    "https://searx.prvcy.eu",
  ];

  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: "general",
    language: "en",
  });

  for (const base of instances) {
    try {
      const url = `${base}/search?${params.toString()}`;
      const text = await fetchText(url, 10000);
      const data = JSON.parse(text);

      const rows = Array.isArray(data?.results) ? data.results : [];
      if (!rows.length) continue;

      console.log(`[scrape] SearXNG ok via ${base} (${rows.length} results)`);

      return rows
        .slice(0, num)
        .map((r) => ({
          title: stripTags(r.title || "").slice(0, 200),
          link: r.url || r.link || "",
          snippet: stripTags(r.content || r.snippet || "").slice(0, 400),
          source: "searx",
        }))
        .filter((r) => r.link && r.title);
    } catch (e) {
      console.warn(`[scrape] SearXNG failed (${base}):`, e.message);
    }
  }

  return [];
}

/**
 * Full scrape pipeline
 * Order: DuckDuckGo → SearXNG → Wikipedia
 */
async function scrapeSearch(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const num = Math.min(Math.max(Number(options.num) || 6, 1), 12);
  const scrapePages = Math.max(0, Number(options.scrapePages ?? 3));

  let results = [];

  // 1. DuckDuckGo
  try {
    results = await scrapeDuckDuckGoHtml(q, num);
  } catch (e) {
    console.warn("[scrape] DDG failed:", e.message);
  }

  // 2. SearXNG if DDG gave almost nothing
  if (results.length < 3) {
    const searx = await scrapeSearx(q, num);
    const seen = new Set(results.map((r) => r.link));
    for (const r of searx) {
      if (!seen.has(r.link)) {
        results.push(r);
        seen.add(r.link);
      }
    }
  }

  // 3. Wikipedia as final safety net
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
