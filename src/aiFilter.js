/**
 * AI filter — ranks scraped results with OpenRouter
 * Default model: nvidia/nemotron-3.5-lightning:free
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_MODEL=nvidia/nemotron-3.5-lightning:free
 */

const DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function getAiConfig() {
  const apiKey = (
    process.env.OPENROUTER_API_KEY ||
    process.env.AI_API_KEY ||
    ""
  ).trim();
  const model =
    process.env.OPENROUTER_MODEL ||
    process.env.AI_MODEL ||
    DEFAULT_MODEL;
  return { apiKey, model };
}

function isAiConfigured() {
  return Boolean(getAiConfig().apiKey);
}

function heuristicFilter(query, results) {
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const scored = results.map((r) => {
    const blob = `${r.title} ${r.snippet}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (blob.includes(t)) score += 1;
    }
    if (r.scraped) score += 0.5;
    return { ...r, relevance: score };
  });
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.filter((r) => r.relevance > 0 || scored.length <= 3);
}

/**
 * Non-streaming OpenRouter chat (filter needs full JSON)
 * Same auth/model family as:
 *   openrouter.chat.send({ model: "nvidia/nemotron-3.5-lightning:free", ... })
 */
async function openRouterChat(messages, { temperature = 0.2, max_tokens = 900 } = {}) {
  const { apiKey, model } = getAiConfig();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://witherly-api.witherly-api.workers.dev",
      "X-Title": "Witherly Web Search Filter",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      stream: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.error?.message || data?.message || `OpenRouter HTTP ${res.status}`
    );
  }

  return {
    content: data?.choices?.[0]?.message?.content || "",
    model: data?.model || model,
    usage: data?.usage || null,
  };
}

async function aiFilterResults(query, results) {
  if (!results.length) {
    return { results: [], summary: "", filtered: false };
  }

  if (!isAiConfigured()) {
    return {
      results: heuristicFilter(query, results),
      summary: "",
      filtered: true,
      method: "heuristic",
    };
  }

  const catalog = results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.link}\n   ${r.snippet || ""}`
    )
    .join("\n\n");

  const system = `You are Witherly AI's web relevance filter.
Given a user query and scraped web results, keep only useful sources.
Reply with STRICT JSON only — no markdown fences:
{
  "keep": [1, 3, 5],
  "summary": "2-4 sentence neutral briefing from the kept sources only"
}
Rules:
- keep = 1-based indexes, max 6
- Drop spam, off-topic, login walls, pure ads
- Do not invent facts not present in the snippets`;

  const user = `Query: ${query}\n\nResults:\n${catalog}`;

  try {
    const { content, model, usage } = await openRouterChat([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    if (usage) {
      console.log("[aiFilter] usage", usage);
    }

    let text = String(content || "")
      .replace(/```json\s*/gi, "")
      .replace(/```/g, "")
      .trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Model returned no JSON object");

    const parsed = JSON.parse(jsonMatch[0]);
    const keep = Array.isArray(parsed.keep) ? parsed.keep : [];
    const summary = String(parsed.summary || "").trim();

    const filtered = keep
      .map((n) => results[Number(n) - 1])
      .filter(Boolean);

    return {
      results: filtered.length ? filtered : heuristicFilter(query, results),
      summary,
      filtered: true,
      method: "ai",
      model,
    };
  } catch (e) {
    console.warn("[aiFilter] fallback heuristic:", e.message);
    return {
      results: heuristicFilter(query, results),
      summary: "",
      filtered: true,
      method: "heuristic",
      error: e.message,
    };
  }
}

function formatSearchContext(query, results, summary) {
  const parts = [];
  if (summary) parts.push(`AI briefing:\n${summary}`);
  if (results?.length) {
    parts.push(
      results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title}\nURL: ${r.link}\n${r.snippet || ""}`.trim()
        )
        .join("\n\n")
    );
  } else {
    parts.push(`No useful web results for: ${query}`);
  }
  return parts.join("\n\n");
}

module.exports = {
  aiFilterResults,
  formatSearchContext,
  isAiConfigured,
  openRouterChat,
};
