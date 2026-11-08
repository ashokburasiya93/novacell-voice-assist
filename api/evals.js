// Text-pipeline evals. Off unless EVALS_ENABLED=true or a preview deployment. GET /api/evals?from=0&n=6
import { readFileSync } from "node:fs";
import { askInLanguage } from "../lib/voice.js";
import { judge } from "../lib/evals.js";

const SET = JSON.parse(readFileSync(new URL("../evals/text_dev.json", import.meta.url), "utf8"));
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (process.env.EVALS_ENABLED !== "true" && process.env.VERCEL_ENV !== "preview") return res.status(404).json({ error: "not found" });
  const from = Math.max(0, Number(req.query.from) || 0), n = Math.min(12, Math.max(1, Number(req.query.n) || 6));
  const gap = Math.min(10000, Number(req.query.gap_ms) || 0);
  const rows = [];
  for (const tc of SET.slice(from, from + n)) {
    const t = Date.now();
    const r = await askInLanguage(tc.text);
    rows.push({ id: tc.id, lang: tc.lang, expect: tc.expect, status: r.status, reply_language: r.reply_language, citations: r.citations, english_query: r.english_query,
      guardrailNote: r.guardrailNote, latency_ms: r.latencyMs, usage: r.usage, ...judge(tc, r) });
    const spare = gap - (Date.now() - t);
    if (spare > 0) await new Promise((x) => setTimeout(x, spare));
  }
  res.status(200).json({ from, next: from + rows.length, total: SET.length, rows });
}
