// Speech-model eval runner for preview deployments (protected by Vercel Authentication, so it is reached through
// an authenticated GET). It fetches each test clip from a URL you control, transcribes it with every configuration,
// and returns compact scores. Off unless this is a preview deployment or EVALS_ENABLED=true.
// GET /api/asr_batch?base=<clip host>&set=clean|noisy&from=0&n=3
import { readFileSync } from "node:fs";
import { transcribe, ASR_MODELS } from "../lib/voice.js";
import { wer, cer } from "../lib/evals.js";

const CLIPS = JSON.parse(readFileSync(new URL("../evals/clips.json", import.meta.url), "utf8"));
const CONFIGS = [["large-v3", true], ["large-v3", false], ["turbo", true], ["turbo", false]];
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== "preview" && process.env.EVALS_ENABLED !== "true") return res.status(404).json({ error: "not found" });
  const base = String(req.query.base || "").replace(/\/$/, "");
  const set = req.query.set === "noisy" ? "noisy" : "clean";
  if (!/^https:\/\//.test(base)) return res.status(400).json({ error: "base must be an https URL" });
  const from = Math.max(0, Number(req.query.from) || 0), n = Math.min(6, Math.max(1, Number(req.query.n) || 3));
  const rows = [];
  for (const c of CLIPS.slice(from, from + n)) {
    const audio = Buffer.from(await (await fetch(`${base}/${set}/${c.id}.wav`)).arrayBuffer());
    const row = { id: c.id };
    for (const [m, prompt] of CONFIGS) {
      const key = `${m}${prompt ? "+prompt" : ""}`;
      try {
        const r = await transcribe(audio, "audio/wav", { model: ASR_MODELS[m], prompt });
        const w = wer(c.text, r.text), ch = cer(c.text, r.text);
        row[key] = [w.errors, w.words, ch.errors, ch.chars, r.latencyMs, r.language, key === "large-v3+prompt" ? r.text : undefined];
      } catch (e) {
        row[key] = { error: String(e.message).slice(0, 120) };
      }
      await new Promise((r) => setTimeout(r, 3200)); // free tier: 20 requests a minute
    }
    rows.push(row);
  }
  res.status(200).json({ set, from, next: from + rows.length, total: CLIPS.length, rows });
}
