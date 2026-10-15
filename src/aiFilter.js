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
 */
async function openRouterChat(messages, { temperature = 0, max_tokens = 500 } = {}) {
  const { apiKey, model } = getAiConfig();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const body = {
    model,
    messages,
    temperature,
    max_tokens,
    stream: false,
    // Force the model to treat this as structured output
    response_format: { type: "json_object" },
  };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://witherly-api.witherly-api.workers.dev",
      "X-Title": "Witherly Web Search Filter",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.error?.message || data?.message || `OpenRouter HTTP ${res.status}`
    );
  }

  // Prefer content; some providers put final answer in reasoning_content
  const message = data?.choices?.[0]?.message || {};
  const content =
    message.content ||
    message.reasoning_content ||
    message.reasoning ||
    "";

  return {
    content: String(content || ""),
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

  // Extremely strict prompt — Nemotron otherwise spends all tokens on reasoning
  const system = `You are a JSON-only web relevance filter.

You MUST reply with ONE valid JSON object and NOTHING else.
No markdown, no <think>, no explanation, no reasoning text.

Exact schema:
{"keep":[1,3],"summary":"2-4 sentence briefing from the kept sources only"}

Rules:
- keep = 1-based indexes of the most useful results (max 6)
- Drop spam, login walls, pure ads, off-topic pages
- summary must be neutral and based only on the kept snippets
- If nothing is useful, return {"keep":[],"summary":""}`;

  const user = `Query: ${query}

Results:
${catalog}

Return the JSON object now.`;

  try {
    const { content, model, usage } = await openRouterChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0, max_tokens: 450 }
    );

    if (usage) {
      console.log("[aiFilter] usage", usage);
    }

    // Strip any leftover reasoning / think tags / fences
    let text = String(content || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```json\s*/gi, "")
      .replace(/```/g, "")
      .trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[aiFilter] raw content (no JSON):", text.slice(0, 300));
      throw new Error("Model returned no JSON object");
    }

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
