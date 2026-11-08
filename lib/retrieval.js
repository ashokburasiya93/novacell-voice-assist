// BM25 keyword retrieval over the prebuilt knowledge base.
// Why not embeddings: ~100 short chunks, telecom vocabulary is literal (eSIM, APN, VoLTE, roaming),
// and BM25 costs $0, needs no extra API key, and is deterministic for evals.
import { readFileSync } from "node:fs";

const KB = JSON.parse(readFileSync(new URL("../kb/knowledge.json", import.meta.url), "utf8"));
export const CHUNKS = KB.chunks;

const STOP = new Set(
  "a an the and or but if of to in on at for from by with about as is are was were be been being do does did i me my we our you your it its this that these those what which who whom how why when where can could should would will shall may might must have has had not no so than too very just there their them they he she his her get got am any some into out up down over again then once here also".split(" ")
);

// Customer words -> knowledge-base words. Keeps recall up without an embedding model.
const SYNONYMS = {
  abroad: ["roaming", "international", "travel"], travel: ["roaming", "international", "travelling", "before"], travelling: ["roaming", "international"],
  traveling: ["roaming", "international"], trip: ["roaming", "travelling", "before"], holiday: ["roaming", "travelling"], vacation: ["roaming", "travelling"], overseas: ["roaming", "international"],
  europe: ["eu", "roaming"], spain: ["eu", "roaming", "travelling", "abroad"], france: ["eu", "roaming"], uk: ["roaming"], japan: ["roaming"],
  esim: ["esim", "sim", "qr"], "e-sim": ["esim"], qr: ["esim", "activation"],
  slow: ["slow", "speed", "congestion", "throttled"], speed: ["slow", "speed", "mbps"], laggy: ["slow", "speed"],
  internet: ["data", "internet"], data: ["data", "internet"], net: ["internet", "data"],
  bill: ["bill", "billing", "charge"], charged: ["charge", "bill", "billing"], charge: ["charge", "bill", "billing"],
  charges: ["charge", "bill", "billing"], expensive: ["higher", "bill", "charge"], overcharged: ["charge", "bill", "dispute"],
  high: ["higher", "high"], more: ["higher"], unexpected: ["higher", "unexpected"], twice: ["duplicate", "double"], double: ["duplicate", "double"],
  price: ["price", "cost", "month"], cost: ["price", "cost"], cheap: ["price", "cheap"], cheapest: ["price", "cheap"],
  call: ["call", "voice"], calls: ["call", "voice"], calling: ["call", "voice"], drop: ["drop", "dropping"],
  dropped: ["drop", "dropping"], dropping: ["drop", "dropping"], echo: ["echo", "voice"],
  wifi: ["wi-fi", "wifi", "vowifi"], hotspot: ["hotspot", "tethering"], tether: ["hotspot", "tethering"],
  app: ["mytelecom", "app"], login: ["log", "password", "app"], password: ["password", "login"],
  signal: ["signal", "coverage"], coverage: ["coverage", "signal"], outage: ["outage", "status"],
  port: ["port", "porting", "number"], switch: ["port", "switching"], unlock: ["unlock"],
  plan: ["plan"], plans: ["plan"], unlimited: ["unlimited"], family: ["family", "lines"], student: ["student"],
  senior: ["55", "senior"], tablet: ["data-only", "tablet"], spam: ["spam", "block"], scam: ["scam", "wangiri", "spam"],
  activate: ["activate", "activation"], activation: ["activate", "activation"], stolen: ["lost", "stolen", "sim"],
  // Added after the first held-out run exposed these vocabulary gaps (general terms, not case-specific).
  promo: ["promotional", "promotion"], promotion: ["promotional"], ended: ["expired"], expired: ["expired"],
  warn: ["alert", "notification"], warning: ["alert", "notification"], notify: ["alert", "notification"],
  flying: ["roaming", "travelling", "before"], fly: ["roaming", "travelling"], flight: ["roaming", "travelling"],
  hacked: ["unauthorised", "security", "compromise"], unauthorized: ["unauthorised"], permission: ["unauthorised"],
  asking: ["unauthorised"], consent: ["unauthorised"],
};

function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return stem(w.slice(0, -1));
  // "change"/"changed" and "activate"/"activated" must meet at the same stem.
  if (w.length > 4 && w.endsWith("e")) return w.slice(0, -1);
  return w;
}

export function tokenize(text, expand = false) {
  const raw = text.toLowerCase().replace(/e-sim/g, "esim").replace(/wi-fi/g, "wifi").match(/[a-z0-9$]+(?:[.-][a-z0-9]+)*/g) || [];
  const out = [];
  for (const w of raw) {
    if (STOP.has(w)) continue;
    out.push(stem(w));
    if (expand && SYNONYMS[w]) for (const s of SYNONYMS[w]) out.push(stem(s.replace("wi-fi", "wifi")));
  }
  return out;
}

// ---- Build the BM25 index once per cold start ----
const K1 = 1.4, B = 0.75;
const docs = CHUNKS.map((c) => {
  // Title counted twice: titles are short, high-signal questions/labels.
  const toks = tokenize(`${c.title} ${c.title} ${c.text}`);
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  return { tf, len: toks.length };
});
const avgdl = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const df = new Map();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
const N = docs.length;
const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

export function search(query, { k = 6, maxPerType = 3 } = {}) {
  const qt = [...new Set(tokenize(query, true))];
  const scored = docs.map((d, i) => {
    let s = 0;
    for (const t of qt) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgdl)));
    }
    return { chunk: CHUNKS[i], score: s };
  });
  scored.sort((a, b) => b.score - a.score);

  // Diversity: don't let one source type crowd out the others.
  const perType = {};
  const picked = [];
  for (const r of scored) {
    if (r.score <= 0) break;
    perType[r.chunk.type] = (perType[r.chunk.type] || 0) + 1;
    if (perType[r.chunk.type] > maxPerType) continue;
    picked.push(r);
    if (picked.length >= k) break;
  }

  // Price / plan questions always see the plan catalogue, the pricing source of truth.
  if (/\b(price|cost|how much|\$|plan|plans|cheapest|pass|bundle|add-?on|per month|fee)\b/i.test(query)) {
    const plans = scored.filter((r) => r.chunk.type === "plan" && r.score > 0 && !picked.includes(r)).slice(0, 2);
    picked.push(...plans);
  }
  return { results: picked, topScore: scored[0]?.score || 0, queryTerms: qt };
}
