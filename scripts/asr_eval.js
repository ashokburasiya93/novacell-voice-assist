// Speech-model evals on the recorded clips. For each clip and each configuration
// (whisper-large-v3 / whisper-large-v3-turbo, with / without the domain-word prompt) it transcribes through the
// deployment, scores WER and CER against the reference, then sends the large-v3+prompt transcript through /api/ask.
// Usage: node scripts/asr_eval.js <deployment URL> <folder with HI-01.m4a ...>
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { wer, cer, judge } from "../lib/evals.js";

const [base, dir] = [process.argv[2].replace(/\/$/, ""), process.argv[3]];
const clips = JSON.parse(readFileSync(new URL("../evals/clips.json", import.meta.url), "utf8"));
const files = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(extname(f), "").toUpperCase(), join(dir, f)]));
const MIME = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".aac": "audio/aac", ".mp4": "audio/mp4" };
const CONFIGS = [["large-v3", true], ["large-v3", false], ["turbo", true], ["turbo", false]];
const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
for (const c of clips) {
  const f = files[c.id];
  if (!f) { console.log("missing", c.id); continue; }
  const audio = readFileSync(f).toString("base64"), mime = MIME[extname(f).toLowerCase()] || "audio/mp4";
  const row = { id: c.id, lang: c.lang, reference: c.text, asr: {} };
  for (const [model, prompt] of CONFIGS) {
    const r = await post("/api/transcribe", { audio, mime, model, prompt });
    const w = wer(c.text, r.text || ""), ch = cer(c.text, r.text || "");
    row.asr[`${model}${prompt ? "+prompt" : ""}`] = { text: r.text, detected: r.language, duration: r.duration, latency_ms: r.latencyMs, wer_errors: w.errors, words: w.words, cer_errors: ch.errors, chars: ch.chars, error: r.error };
    await sleep(3500);
  }
  const best = row.asr["large-v3+prompt"];
  const a = await post("/api/ask", { text: best.text || "" });
  row.end_to_end = { status: a.status, reply_language: a.reply_language, citations: a.citations, english_query: a.english_query, latency_ms: (best.latency_ms || 0) + (a.latencyMs || 0), ...judge(c, a) };
  rows.push(row);
  console.log(c.id, Object.entries(row.asr).map(([k, v]) => `${k}:${v.words ? (v.wer_errors / v.words).toFixed(2) : "?"}`).join(" "), row.end_to_end.pass);
  await sleep(3500);
}
const summary = {};
for (const cfg of Object.keys(rows[0]?.asr || {})) {
  for (const lang of ["hi-script", "gu", "hinglish-en", "all"]) {
    const sel = rows.filter((r) => lang === "all" || (lang === "gu" && r.id.startsWith("GU")) || (lang === "hi-script" && r.id.startsWith("HI")) || (lang === "hinglish-en" && r.id.startsWith("HE")));
    const s = (k) => sel.reduce((t, r) => t + (r.asr[cfg][k] || 0), 0);
    const lat = sel.map((r) => r.asr[cfg].latency_ms).filter(Boolean).sort((a, b) => a - b);
    (summary[cfg] ||= {})[lang] = { clips: sel.length, wer: +(s("wer_errors") / s("words")).toFixed(3), cer: +(s("cer_errors") / s("chars")).toFixed(3), p95_ms: lat[Math.floor(0.95 * (lat.length - 1))] };
  }
}
const e2e = { clips: rows.length, task_success: +(rows.filter((r) => r.end_to_end.pass).length / rows.length).toFixed(3), language_ok: +(rows.filter((r) => r.end_to_end.language_ok).length / rows.length).toFixed(3) };
mkdirSync(new URL("../evals/results/", import.meta.url), { recursive: true });
writeFileSync(new URL("../evals/results/asr.json", import.meta.url), JSON.stringify({ run_at: new Date().toISOString(), summary, end_to_end: e2e, rows }, null, 1));
console.log(JSON.stringify({ summary, e2e }, null, 1));
