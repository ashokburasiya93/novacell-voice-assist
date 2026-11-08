// POST {text, language?} -> answer in the caller's language (typed questions, and the text part of the evals).
import { askInLanguage } from "../lib/voice.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const text = String(body.text || "").slice(0, 600);
  if (!text.trim()) return res.status(400).json({ error: "empty" });
  const language = ["hi", "gu", "en"].includes(body.language) ? body.language : undefined;
  const result = await askInLanguage(text, { language });
  console.log(JSON.stringify({ evt: "ask", status: result.status, lang: result.language, ms: result.latencyMs }));
  res.status(200).json(result);
}
