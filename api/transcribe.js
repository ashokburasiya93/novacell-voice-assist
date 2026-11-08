// ASR-only endpoint for the speech-model evals. Off unless EVALS_ENABLED=true or a preview deployment.
// POST {audio: base64, mime, model: 'large-v3'|'turbo', prompt: true|false, language?}
import { transcribe, ASR_MODELS } from "../lib/voice.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (process.env.EVALS_ENABLED !== "true" && process.env.VERCEL_ENV !== "preview") return res.status(404).json({ error: "not found" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    const r = await transcribe(Buffer.from(String(body.audio || ""), "base64"), String(body.mime || "audio/webm"), {
      model: ASR_MODELS[body.model] || ASR_MODELS["large-v3"], prompt: body.prompt !== false, language: ["hi", "gu", "en"].includes(body.language) ? body.language : undefined,
    });
    res.status(200).json(r);
  } catch (e) {
    res.status(200).json({ error: String(e.message).slice(0, 300) });
  }
}
