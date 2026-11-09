# NovaCell Voice Assist

Voice support for NovaCell customers in **Hindi, Gujarati, Hinglish and English**. The caller speaks; a deep-learning speech model (OpenAI **Whisper** on Groq) transcribes it with NovaCell product words as a hint; the question is turned into English and answered by NovaCell's existing **grounded** support assistant (verified FAQ, guide, tickets and plans only); the answer is translated back with every number, code and menu path checked, and the phone reads it aloud.

> **All data is synthetic** (NovaCell is a made-up operator from an earlier project). The 30 test clips are synthetic speech generated with Meta's open-source MMS voices from a fixed script (`scripts/gen_clips.py`; audio is regenerated, not committed); no customer audio is used.

- **Live app:** https://novacell-voice-assist.vercel.app (no sign-in)
- **AI opportunity map (Miro):** https://miro.com/app/board/uXjVEQWyt5Y=/

## Why it is a deep-learning product

The core decision is which speech model to run, and whether a domain-word prompt fixes the words Whisper mishears ("eSIM", "VoLTE", "roaming" said in Hindi or Gujarati). `api/asr_batch.js` scores five configurations on the 30 clips:

| Configuration | What it tests |
|---|---|
| whisper-large-v3 + product-word prompt + language hint | **chosen** |
| whisper-large-v3 + product-word prompt | does the prompt alone help? |
| whisper-large-v3, no prompt | does vocabulary biasing help? |
| whisper-large-v3-turbo + prompt + language hint | 2.8x cheaper ($0.04 vs $0.111 per audio hour): is accuracy close enough? |
| whisper-large-v3-turbo, no prompt | cheapest baseline |

Metrics: word error rate (WER) by language, character error rate (CER, fairer for Gujarati and mixed scripts), latency, cost per hour of audio, and **end-to-end task success** (did the caller get the right answer, an agent handoff, or a refusal?).

### Results on clean clips (9 Nov 2026)

| Configuration | CER Hindi | CER Gujarati | WER English | Wrong alphabet | $/audio hour |
|---|---|---|---|---|---|
| large-v3 + words + language (chosen) | 11% | 18% | 12% | 0 / 30 | $0.111 |
| large-v3 + words | 47% | 72% | 12% | 9 / 30 | $0.111 |
| large-v3 | 53% | 61% | 18% | 9 / 30 | $0.111 |
| turbo + words + language | 40% | 101% | 18% | 11 / 30 | $0.04 |
| turbo | 46% | 59% | 20% | 9 / 30 | $0.04 |

Without a language hint, Whisper wrote 9 of the 20 Hindi and Gujarati clips in the wrong alphabet (Urdu for Hindi; Telugu or Gurmukhi for Gujarati). The hint fixed every one and cut character errors by more than half. Turbo ignored the Gujarati hint, so large-v3 stays, and the app re-transcribes with the implied language whenever it sees the wrong alphabet. Hinglish is scored against Roman spelling while Whisper writes Devanagari, so it is judged on task success, not WER. Synthetic speech is clean: these numbers are optimistic until a real-caller pilot.

The 54 text cases (task success by language, number fidelity, safety) run next.

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
| Evals | `evals/clips.json` (30 synthetic clips), `evals/text_dev.json` (54 text cases), `scripts/asr_eval.js`, `scripts/run_text_evals.js`, `npm test` (offline) |

Guardrails: prompt-injection and emergency checks run on the original words and again on the English question; personal data is redacted before any model call; account actions (refunds, cancellations) always go to an agent; a translation that drops or changes any number falls back to the verified English answer; audio is never stored.

## Deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | Problem discovery and user research | [deliverables/](deliverables/) |
| 2 | AI opportunity map (Excel + Miro import CSV; board linked above) | [deliverables/](deliverables/) |
| 3 | AI PRD | [deliverables/3. AI PRD - NovaCell Voice Assist.docx](deliverables/) |
| 4 | Cost estimation (about $0.0014 per voice question) | [deliverables/4. Cost Estimation - NovaCell Voice Assist.xlsx](deliverables/) |
| 5 | Working prototype + README | this repo |
| 6 | Presentation | [deliverables/6. Presentation - NovaCell Voice Assist.pptx](deliverables/) |

## Run locally

```bash
cp .env.example .env            # GROQ_API_KEY, OPENROUTER_API_KEY; never commit .env
npm test                        # offline checks
node --env-file=.env scripts/dev_server.js
```
Microphone access needs `localhost` or HTTPS.
