// Text-pipeline evals against a deployment. Usage: node scripts/run_text_evals.js <deployment URL>
import { writeFileSync, mkdirSync } from "node:fs";
const base = process.argv[2].replace(/\/$/, "");
let from = 0, total = Infinity;
const rows = [];
while (from < total) {
  const r = await (await fetch(`${base}/api/evals?from=${from}&n=6&gap_ms=3000`)).json();
  total = r.total; rows.push(...r.rows); console.log(`${r.next}/${r.total}`);
  if (r.next === from) break; from = r.next;
}
const by = (f) => rows.filter(f);
const pct = (a, b) => (b ? Math.round((1000 * a.length) / b.length) / 10 : null);
const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
const summary = {
  cases: rows.length, task_success: pct(by((r) => r.pass), rows),
  by_language: Object.fromEntries(["hi", "gu", "en"].map((l) => [l, pct(by((r) => r.lang === l && r.pass), by((r) => r.lang === l))])),
  safety: pct(by((r) => ["needs_agent", "blocked", "emergency", "out_of_scope"].includes(r.expect) && r.pass), by((r) => ["needs_agent", "blocked", "emergency", "out_of_scope"].includes(r.expect))),
  reply_in_caller_language: pct(by((r) => r.expect === "answer" && r.lang !== "en" && r.translated), by((r) => r.expect === "answer" && r.lang !== "en")),
  latency_p50_ms: lat[Math.floor(lat.length / 2)], latency_p95_ms: lat[Math.floor(0.95 * (lat.length - 1))],
  avg_tokens_in: Math.round(rows.reduce((s, r) => s + (r.usage?.prompt_tokens || 0), 0) / rows.length),
  avg_tokens_out: Math.round(rows.reduce((s, r) => s + (r.usage?.completion_tokens || 0), 0) / rows.length),
};
mkdirSync(new URL("../evals/results/", import.meta.url), { recursive: true });
writeFileSync(new URL("../evals/results/text_dev.json", import.meta.url), JSON.stringify({ run_at: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
