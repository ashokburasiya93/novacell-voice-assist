# NovaCell Voice Assist

Voice support for NovaCell customers in **Hindi, Gujarati, Hinglish and English**. The caller speaks; a deep-learning speech model (OpenAI **Whisper** on Groq) transcribes it with NovaCell product words as a hint; the question is turned into English and answered by NovaCell's existing **grounded** support assistant (verified FAQ, guide, tickets and plans only); the answer is translated back with every number, code and menu path checked, and the phone reads it aloud.

> **All data is synthetic** (NovaCell is a made-up operator from an earlier project). The 30 test clips are recorded by the PM reading a fixed script; no customer audio is used.

- **Live app:** https://novacell-voice-assist.vercel.app (no sign-in)

## Why it is a deep-learning product

The core decision is which speech model to run, and whether a domain-word prompt fixes the words Whisper mishears ("eSIM", "VoLTE", "roaming" said in Hindi or Gujarati). `scripts/asr_eval.js` scores four configurations on the recorded clips:

| Configuration | What it tests |
|---|---|
| whisper-large-v3 + product-word prompt | default (best expected accuracy) |
| whisper-large-v3, no prompt | does vocabulary biasing help? |
| whisper-large-v3-turbo + prompt | 2.8x cheaper ($0.04 vs $0.111 per audio hour): is accuracy close enough? |
| whisper-large-v3-turbo, no prompt | cheapest baseline |

Metrics: word error rate (WER) by language, character error rate (CER, fairer for Gujarati and mixed scripts), latency, cost per hour of audio, and **end-to-end task success** (did the caller get the right answer, an agent handoff, or a refusal?).

## How it works

```
mic ─► Whisper (Groq) ─► understand (gpt-oss-20b → English question) ─► grounded answer (NovaCell assistant: BM25 + gpt-oss-120b + checks) ─► translate back (numbers checked) ─► read aloud (device voice)
```

| Piece | File |
|---|---|
| Speech + language pipeline | `lib/voice.js` |
| Grounded answer, guardrails, retrieval (reused from the NovaCell assistant) | `lib/assistant.js`, `lib/guardrails.js`, `lib/retrieval.js`, `kb/knowledge.json` |
| API | `api/voice.js` (audio), `api/ask.js` (typed), `api/health.js`; eval-only `api/transcribe.js`, `api/evals.js` (off unless `EVALS_ENABLED=true`) |
| UI | `public/index.html` |
| Evals | `evals/clips.json` (30 recorded clips), `evals/text_dev.json` (54 text cases), `scripts/asr_eval.js`, `scripts/run_text_evals.js`, `npm test` (offline) |

Guardrails: prompt-injection and emergency checks run on the original words and again on the English question; personal data is redacted before any model call; account actions (refunds, cancellations) always go to an agent; a translation that drops or changes any number falls back to the verified English answer; audio is never stored.

## Run locally

```bash
cp .env.example .env            # GROQ_API_KEY, OPENROUTER_API_KEY; never commit .env
npm test                        # offline checks
node --env-file=.env scripts/dev_server.js
```
Microphone access needs `localhost` or HTTPS.
