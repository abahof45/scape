/**
 * Witherly — call scraper + AI filter API on Render
 *
 * VITE_WEBSEARCH_API_BASE=https://your-service.onrender.com
 * VITE_WEBSEARCH_API_KEY=optional
 */

const BASE = (import.meta.env.VITE_WEBSEARCH_API_BASE || "").replace(/\/$/, "");
const KEY = (import.meta.env.VITE_WEBSEARCH_API_KEY || "").trim();

export function isWebSearchApiConfigured() {
  return Boolean(BASE);
}

export async function webSearch(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  if (!BASE) {
    console.warn("[webSearchApi] Set VITE_WEBSEARCH_API_BASE");
    return [];
  }

  const num = Math.min(Math.max(options.num || 6, 1), 12);
  const headers = { Accept: "application/json" };
  if (KEY) headers["x-api-key"] = KEY;

  const params = new URLSearchParams({
    q,
    num: String(num),
    scrape: options.scrape === false ? "0" : "1",
    filter: options.filter === false ? "0" : "1",
  });

  const res = await fetch(`${BASE}/v1/search?${params}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Search API ${res.status}`);
  }
  // Attach context for callers that want it
  if (options.returnMeta) {
    return {
      results: data.results || [],
      context: data.context || "",
      summary: data.summary || "",
      source: data.pipeline || "scrape+ai",
    };
  }
  return Array.isArray(data.results) ? data.results : [];
}

export function formatSearchContext(query, results) {
  if (!results?.length) return `No live web results for: ${query}`;
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.link}\n${r.snippet || ""}`.trim()
    )
    .join("\n\n");
}
