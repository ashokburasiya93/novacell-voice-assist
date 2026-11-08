// POST {audio: base64, mime, language?: 'hi'|'gu'|'en', asr?: 'large-v3'|'turbo'} -> transcript + answer in the caller's language.
import { transcribe, askInLanguage, ASR_MODELS, wrongScriptHint } from "../lib/voice.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const audio = Buffer.from(String(body.audio || ""), "base64");
  if (audio.length < 1000) return res.status(400).json({ error: "no audio" });
  if (audio.length > 3_500_000) return res.status(413).json({ error: "clip too long; keep it under 60 seconds" });
  const language = ["hi", "gu", "en"].includes(body.language) ? body.language : undefined;
  const model = ASR_MODELS[body.asr] || ASR_MODELS["large-v3"];
  try {
    let asr = await transcribe(audio, String(body.mime || "audio/webm"), { model, language });
    const retry = !language && wrongScriptHint(asr.text);
    if (retry) asr = { ...(await transcribe(audio, String(body.mime || "audio/webm"), { model, language: retry })), retriedWith: retry };
    if (!asr.text) return res.status(200).json({ status: "no_speech", transcript: "", asr });
    const result = await askInLanguage(asr.text, { language: language || asr.language || undefined });
    console.log(JSON.stringify({ evt: "voice", status: result.status, lang: result.language, asr: model, ms: asr.latencyMs + (result.latencyMs || 0) }));
    res.status(200).json({ transcript: asr.text, asr, ...result });
  } catch (e) {
    res.status(200).json({ status: "error", error: String(e.message).slice(0, 200) });
  }
}
