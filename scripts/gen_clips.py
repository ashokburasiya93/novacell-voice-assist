"""Generate the 30 synthetic test clips with open-source text-to-speech (Meta MMS-TTS, CC-BY-NC 4.0).

Clean clips: evals/audio/clean/<ID>.wav  (16 kHz mono)
Noisy clips: evals/audio/noisy/<ID>.wav  (same speech + street-like noise at 10 dB SNR, seed 42)

Hindi lines use facebook/mms-tts-hin, Gujarati facebook/mms-tts-guj, English facebook/mms-tts-eng.
Hinglish lines are spoken by the Hindi voice from a Devanagari spelling (as a Hindi speaker would say them);
the reference transcript stays in the Latin spelling people type.
Synthetic speech is cleaner than real calls, so these results are optimistic: see the README.
Usage: python3 scripts/gen_clips.py   (needs torch, transformers, scipy and Hugging Face access)
"""
import json
import os

import numpy as np
import scipy.io.wavfile as wav
import scipy.signal as sig
import torch
from transformers import AutoTokenizer, VitsModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPOKEN_HINGLISH = {
    "HE-01": "मेरा ई-सिम एक्टिवेट नहीं हो रहा, क्या करूं?",
    "HE-02": "इंटरनेशनल डे पास का प्राइस क्या है?",
    "HE-03": "हॉटस्पॉट से लैपटॉप कनेक्ट नहीं हो रहा।",
    "HE-04": "प्रीमियम एस एम एस चार्जेस मेरे बिल पे क्यों आए?",
    "HE-05": "वी ओ एल टी ई कैसे ऑन करते हैं?",
}
VOICE = {"hi": "facebook/mms-tts-hin", "gu": "facebook/mms-tts-guj", "en": "facebook/mms-tts-eng"}


def main():
    torch.manual_seed(42)
    rng = np.random.default_rng(42)
    clips = json.load(open(os.path.join(ROOT, "evals", "clips.json"), encoding="utf-8"))
    cache = {}
    for d in ("clean", "noisy"):
        os.makedirs(os.path.join(ROOT, "evals", "audio", d), exist_ok=True)
    meta = []
    for c in clips:
        text = SPOKEN_HINGLISH.get(c["id"], c["text"])
        voice = "en" if c["id"] in ("HE-06", "HE-07", "HE-08", "HE-09", "HE-10") else ("gu" if c["id"].startswith("GU") else "hi")
        if voice not in cache:
            cache[voice] = (AutoTokenizer.from_pretrained(VOICE[voice]), VitsModel.from_pretrained(VOICE[voice]))
        tok, model = cache[voice]
        with torch.no_grad():
            audio = model(**tok(text, return_tensors="pt")).waveform[0].numpy()
        sr = model.config.sampling_rate
        audio = sig.resample_poly(audio, 16000, sr) if sr != 16000 else audio
        audio = np.concatenate([np.zeros(4000), audio, np.zeros(4000)])  # 0.25 s silence each side
        audio = 0.9 * audio / (np.abs(audio).max() + 1e-9)
        wav.write(os.path.join(ROOT, "evals", "audio", "clean", f"{c['id']}.wav"), 16000, (audio * 32767).astype(np.int16))
        # street-like noise: brown-ish noise + occasional bursts, at 10 dB SNR
        n = np.cumsum(rng.normal(0, 1, len(audio)))
        n = sig.lfilter([1, -1], [1, -0.98], n)
        n += (rng.random(len(audio)) < 0.0005) * rng.normal(0, 8, len(audio))
        p_s, p_n = np.mean(audio ** 2), np.mean(n ** 2)
        noisy = audio + n * np.sqrt(p_s / (p_n * 10 ** (10 / 10)))
        noisy = 0.9 * noisy / np.abs(noisy).max()
        wav.write(os.path.join(ROOT, "evals", "audio", "noisy", f"{c['id']}.wav"), 16000, (noisy * 32767).astype(np.int16))
        meta.append({"id": c["id"], "voice": VOICE[voice], "spoken_text": text, "seconds": round(len(audio) / 16000, 2)})
        print(c["id"], voice, round(len(audio) / 16000, 1), "s")
    json.dump(meta, open(os.path.join(ROOT, "evals", "audio", "clips_meta.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
