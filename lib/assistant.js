import { search, CHUNKS } from "./retrieval.js";
import { inputGuard, ungroundedNumbers, promiseViolations, internalLeak, ungroundedSpecifics, ACCOUNT_ACTION } from "./guardrails.js";

export const MODELS = {
  primary: { provider: "Groq", model: process.env.PRIMARY_MODEL || "openai/gpt-oss-120b" },
  // Same provider, separate free-tier quota: keeps the assistant up when the primary's daily token cap is hit.
  secondary: { provider: "Groq", model: process.env.SECONDARY_MODEL || "openai/gpt-oss-20b" },
  fallback: { provider: "OpenRouter", model: process.env.FALLBACK_MODEL || "google/gemma-4-31b-it:free" },
};

// Below this BM25 score nothing in the knowledge base is about the question: abstain without a model call.
export const MIN_RETRIEVAL_SCORE = 3.0;
const HANDOFF = "You can reach a NovaCell agent by calling 611 (free from your mobile) or through live chat in the MyTelecom app (8am-10pm).";

const SYSTEM_PROMPT = `You are NovaCell's customer support assistant for Tier-1 questions (mobile data, bills and charges, SIM/eSIM, roaming, calls, account and app).

RULES - follow all of them:
1. Use ONLY the facts in the SOURCES block. Never use outside knowledge for prices, fees, allowances, timings, policies, settings paths or phone numbers.
2. Every factual sentence must be supported by a source; list the ids you used in "citations".
3. If the sources do not answer the question, set status "no_answer" and say briefly that you don't have verified information on that. Do not guess.
4. If the sources answer only part of it, answer that part, say what you could not confirm, and set status "partial".
5. You cannot see or change any customer account. If the customer wants something done to their account (refund, credit, cancel, change plan for them, check their specific bill or usage, fix a charge, unblock, replace a SIM), give the self-serve steps from the sources if any exist, explain an agent is needed for the rest, and set status "needs_agent". Never promise refunds, credits, waivers or compensation, even if a past ticket shows one was given; say an agent can review it, not that they will issue anything.
6. Past tickets ("Resolved support ticket" or "Escalated support ticket") describe one customer's case. Use them as "a similar issue was fixed by ...", never as a guarantee.
7. If sources conflict, trust the higher priority source (Plan catalogue > Technical guide > FAQ > Past ticket). When a lower-priority source quotes a price and the Plan catalogue lists a similar product at a different price, mention both with their names and tell the customer to confirm the current price in the app.
8. Questions not about NovaCell telecom service (general knowledge, coding, other companies, legal/medical advice): status "out_of_scope", one polite sentence redirecting to what you can help with.
9. Do not mention internal systems (HLR, BSS, RNC, back-end tools) or describe what agents do internally. Speak to the customer in plain language.
11. Never invent settings values, APN names, menu paths, web addresses, codes or product names. Copy menu paths exactly as a source writes them. If a source says settings were sent to a customer but does not list them, say an agent can provide them.
12. Do not put source ids in the answer text; list them only in "citations".
13. If the customer reports changes, charges or logins they did not make (possible account compromise), do not give steps to make further changes. Set status "needs_agent", tell them to contact support on 611 straight away, and include any security steps the sources give.
10. Be concise: at most about 120 words. For troubleshooting use short numbered steps, each on its own line ("1. ...
2. ..."). No markdown headings or bold.

Reply with JSON only, no prose around it:
{"status":"answered|partial|no_answer|needs_agent|out_of_scope","answer":"<text for the customer>","citations":["<source id>", ...]}`;

function formatSources(results) {
  return results
    .map(({ chunk }) => `[${chunk.id}] (${chunk.source}; priority ${chunk.priority}) ${chunk.title}\n${chunk.text}`)
    .join("\n\n");
}

const OPENROUTER_ALTERNATES = ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"];

async function callChat({ provider, model }, messages, timeoutMs) {
  const isGroq = provider === "Groq";
  const url = isGroq ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const key = isGroq ? process.env.GROQ_API_KEY : process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error(`${provider} API key is not configured`);
  const body = { model, messages, temperature: 0.1, max_tokens: 1200 };
  if (isGroq) {
    body.response_format = { type: "json_object" };
    if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  } else {
    // Free OpenRouter models are often rate-limited upstream; let OpenRouter route to a second one.
    body.models = [model, ...OPENROUTER_ALTERNATES.filter((m) => m !== model)];
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const send = () =>
      fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(isGroq ? {} : { "HTTP-Referer": "https://novacell-voice-assist.vercel.app", "X-Title": "NovaCell Voice Assist" }),
        },
        body: JSON.stringify(body),
      });
    let res = await send();
    // A per-minute rate limit on the primary usually clears in a few seconds: wait once rather than
    // dropping straight to the weaker fallback.
    const wait = Number(res.headers.get("retry-after"));
    if (res.status === 429 && isGroq && wait > 0 && wait <= 8) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await send();
    }
    if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return { content, usage: data.usage || {}, provider, model };
  } finally {
    clearTimeout(t);
  }
}

function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("model did not return JSON");
  const obj = JSON.parse(m[0]);
  if (typeof obj.answer !== "string" || !obj.status) throw new Error("model JSON missing fields");
  obj.citations = Array.isArray(obj.citations) ? obj.citations.map(String) : [];
  obj.answer = cleanAnswer(obj.answer);
  return obj;
}

// Normalise model typography (narrow no-break spaces, non-breaking hyphens) and drop inline
// source ids: sources are shown as cards, and "GUIDE-3.2" would otherwise read as a number.
function cleanAnswer(text) {
  return text
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2010\u2011\u2012]/g, "-")
    .replace(/\s*[\[(]?\b(?:FAQ|TK|GUIDE|PLAN)-[A-Z0-9.\-]*[A-Z0-9](?:\s*,\s*(?:FAQ|TK|GUIDE|PLAN)-[A-Z0-9.\-]*[A-Z0-9])*[\])]?/g, "")
    .replace(/\(?\s*Sources?:[^)]*\)?\s*$/i, "")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
}

// Primary first; on any error (rate limit, outage, timeout, bad JSON) fall back.
async function generate(messages) {
  const errors = [];
  for (const [tier, cfg, timeout] of [["primary", MODELS.primary, 25000], ["secondary", MODELS.secondary, 20000], ["fallback", MODELS.fallback, 30000]]) {
    try {
      const r = await callChat(cfg, messages, timeout);
      return { ...r, parsed: parseJSON(r.content), tier, errors };
    } catch (e) {
      errors.push(`${cfg.provider}: ${e.message}`);
    }
  }
  const err = new Error("All models failed");
  err.details = errors;
  throw err;
}

function validate(parsed, results, question) {
  const ids = new Set(results.map((r) => r.chunk.id));
  const cited = parsed.citations.filter((c) => ids.has(c));
  const problems = [];
  const answering = ["answered", "partial", "needs_agent"].includes(parsed.status);
  if (answering && cited.length === 0 && parsed.status !== "needs_agent") problems.push("no valid citation");
  const citedText = results.filter((r) => cited.includes(r.chunk.id)).map((r) => r.chunk.text).join("\n");
  const contextText = answering ? citedText + "\n" + HANDOFF : results.map((r) => r.chunk.text).join("\n") + "\n" + HANDOFF;
  const nums = ungroundedNumbers(parsed.answer, contextText, question);
  if (nums.length) problems.push(`numbers not found in cited sources: ${nums.join(", ")}`);
  const promises = promiseViolations(parsed.answer);
  if (promises.length) problems.push(`promises an account action: "${promises[0]}"`);
  const leaks = internalLeak(parsed.answer);
  if (leaks.length) problems.push(`mentions internal system: ${leaks[0]}`);
  const specifics = ungroundedSpecifics(parsed.answer, contextText);
  if (specifics.length) problems.push(`settings paths or addresses not in cited sources: ${specifics.join(", ")}`);
  return { cited, problems };
}

function sourceCards(results, cited) {
  return results
    .filter((r) => cited.includes(r.chunk.id))
    .map(({ chunk }) => ({ id: chunk.id, type: chunk.type, title: chunk.title, source: chunk.source, snippet: chunk.text.slice(0, 280), synthetic: !!chunk.synthetic }));
}

function confidenceOf(status, topScore) {
  if (!["answered", "partial", "needs_agent"].includes(status)) return null;
  if (status === "answered" && topScore >= 8) return "high";
  if (status === "partial" || topScore < 5) return "low";
  return "medium";
}

/**
 * Answer one customer message.
 * @param {string} message
 * @param {{role:'user'|'assistant', content:string}[]} history  last few turns, oldest first
 */
export async function answer(message, history = []) {
  const started = Date.now();
  const guard = inputGuard(message);
  const base = { models: MODELS, sources: [], citations: [], confidence: null, usage: null, modelUsed: null };
  if (guard.block) return { ...base, ...guard.block, handoff: guard.block.status === "emergency" ? null : undefined, latencyMs: Date.now() - started };

  const question = guard.text;
  const prevUser = [...history].reverse().find((h) => h.role === "user")?.content || "";
  // Short follow-ups ("what about Japan?") inherit the topic of the previous question.
  const retrievalQuery = question.split(/\s+/).length < 7 && prevUser ? `${prevUser} ${question}` : question;
  const { results, topScore } = search(retrievalQuery);
  const piiNote = guard.piiFound.length
    ? `For your security I removed the ${guard.piiFound.join(" and ")} from your message. Please never share card numbers, passwords or PINs in chat.`
    : null;

  if (topScore < MIN_RETRIEVAL_SCORE || results.length === 0) {
    return {
      ...base,
      status: "no_answer",
      answer: `I don't have verified NovaCell information on that, so I'd rather not guess. I can help with mobile data, bills, SIM and eSIM, roaming, calls and the app. ${HANDOFF}`,
      handoff: HANDOFF,
      piiNote,
      retrieval: { topScore, ids: results.map((r) => r.chunk.id) },
      latencyMs: Date.now() - started,
    };
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-4).map((h) => ({ role: h.role, content: String(h.content).slice(0, 600) })),
    { role: "user", content: `SOURCES:\n${formatSources(results)}\n\nCUSTOMER QUESTION: ${question}` },
  ];

  const usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  const addUsage = (u) => {
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.calls += 1;
  };

  let gen, check, attempts = 0;
  try {
    gen = await generate(messages);
    addUsage(gen.usage);
    check = validate(gen.parsed, results, question);
    // One repair attempt: tell the model exactly what failed validation.
    if (check.problems.length) {
      attempts = 1;
      const retry = await generate([
        ...messages,
        { role: "assistant", content: gen.content },
        { role: "user", content: `Your answer failed these checks: ${check.problems.join("; ")}. Rewrite it using only facts that appear word-for-word in the cited SOURCES, and cite them. Return JSON only.` },
      ]);
      addUsage(retry.usage);
      const recheck = validate(retry.parsed, results, question);
      gen = retry;
      check = recheck;
    }
  } catch (e) {
    console.error(JSON.stringify({ evt: "answer_error", message: e.message, details: e.details || null }));
    return {
      ...base,
      status: "error",
      answer: `Sorry, I can't reach my answer service right now. ${HANDOFF}`,
      handoff: HANDOFF,
      piiNote,
      errors: e.details?.length ? e.details : [e.message],
      latencyMs: Date.now() - started,
    };
  }

  let { status, answer: text } = gen.parsed;
  const validStatus = ["answered", "partial", "no_answer", "needs_agent", "out_of_scope"];
  if (!validStatus.includes(status)) status = "partial";
  // Account-action requests always end with an agent, whatever the model decided.
  if (ACCOUNT_ACTION.test(question) && ["answered", "partial"].includes(status)) status = "needs_agent";
  let guardrailNote = null;
  if (check.problems.length) {
    // Still failing after repair: never show an unverified answer.
    guardrailNote = check.problems.join("; ");
    status = "no_answer";
    text = `I found related information but couldn't verify a complete answer, so I won't guess. The sources below may help. ${HANDOFF}`;
  }
  const showSources = status !== "out_of_scope";
  const cited = check.cited.length ? check.cited : status === "no_answer" && guardrailNote ? results.slice(0, 3).map((r) => r.chunk.id) : [];
  const handoff = ["no_answer", "needs_agent", "partial"].includes(status) && !text.includes("611") ? HANDOFF : null;

  return {
    ...base,
    status,
    answer: text,
    handoff,
    piiNote,
    guardrailNote,
    citations: cited,
    sources: showSources ? sourceCards(results, cited) : [],
    confidence: confidenceOf(status, topScore),
    modelUsed: { tier: gen.tier, provider: gen.provider, model: gen.model },
    fallbackReason: gen.tier !== "primary" ? gen.errors[0] : undefined,
    repairAttempted: attempts > 0,
    usage,
    retrieval: { topScore: +topScore.toFixed(2), ids: results.map((r) => r.chunk.id) },
    latencyMs: Date.now() - started,
  };
}

export function kbStats() {
  const counts = {};
  for (const c of CHUNKS) counts[c.type] = (counts[c.type] || 0) + 1;
  return { chunks: CHUNKS.length, byType: counts };
}
