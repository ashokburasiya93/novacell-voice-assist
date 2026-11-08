import { MODELS, kbStats } from "../lib/assistant.js";
import { ASR_MODELS } from "../lib/voice.js";

export default function handler(_req, res) {
  res.status(200).json({ ok: true, asr: ASR_MODELS, models: MODELS, keys: { groq: !!process.env.GROQ_API_KEY, openrouter: !!process.env.OPENROUTER_API_KEY }, kb: kbStats() });
}
