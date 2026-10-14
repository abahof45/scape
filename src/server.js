const express = require("express");
const cors = require("cors");
const { scrapeSearch } = require("./scrape");
const {
  aiFilterResults,
  formatSearchContext,
  isAiConfigured,
} = require("./aiFilter");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_SECRET = (process.env.API_SECRET || "").trim();
const DEFAULT_SCRAPE_PAGES = Number(process.env.SCRAPE_PAGES ?? 3);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  })
);
app.use(express.json({ limit: "48kb" }));

function readKey(req) {
  return (
    req.headers["x-api-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.query.key ||
    ""
  ).trim();
}

function requireKey(req, res, next) {
  if (!API_SECRET) return next();
  if (readKey(req) !== API_SECRET) {
    return res.status(401).json({
      error: { message: "Invalid or missing API key", type: "auth_error" },
    });
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Witherly Web Scraper + AI Filter",
    ai_configured: isAiConfigured(),
    endpoints: [
      "GET  /health",
      "GET  /v1/search?q=...&num=6&scrape=1&filter=1",
      "POST /v1/search",
    ],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ai: isAiConfigured(),
    time: new Date().toISOString(),
  });
});

async function handleSearch(req, res) {
  const q = String(
    req.body?.q || req.body?.query || req.query.q || ""
  ).trim();
  const num = Number(req.body?.num || req.query.num || 6);
  const scrapeFlag = String(req.body?.scrape ?? req.query.scrape ?? "1");
  const filterFlag = String(req.body?.filter ?? req.query.filter ?? "1");
  const scrapePages =
    scrapeFlag === "0" || scrapeFlag === "false"
      ? 0
      : Number(
          req.body?.scrapePages ?? req.query.scrapePages ?? DEFAULT_SCRAPE_PAGES
        );

  if (!q) {
    return res.status(400).json({
      error: { message: "Missing query `q`", type: "invalid_request" },
    });
  }

  try {
    const raw = await scrapeSearch(q, { num, scrapePages });

    let final = raw;
    let summary = "";
    let method = "none";
    let model;

    if (filterFlag !== "0" && filterFlag !== "false") {
      const filtered = await aiFilterResults(q, raw);
      final = filtered.results;
      summary = filtered.summary || "";
      method = filtered.method || "heuristic";
      model = filtered.model;
    }

    res.json({
      object: "web.search",
      query: q,
      pipeline: "scrape+ai",
      filter_method: method,
      model: model || null,
      raw_count: raw.length,
      count: final.length,
      results: final,
      summary,
      context: formatSearchContext(q, final, summary),
    });
  } catch (e) {
    console.error("[search]", e);
    res.status(502).json({
      error: {
        message: e?.message || "Search failed",
        type: "search_error",
      },
    });
  }
}

app.get("/v1/search", requireKey, handleSearch);
app.post("/v1/search", requireKey, handleSearch);

app.use((_req, res) => {
  res.status(404).json({
    error: { message: "Not found", type: "invalid_request" },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Scraper+AI Search API on :${PORT}`);
});
