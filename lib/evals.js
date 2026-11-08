// Scoring for NovaCell Voice Assist evals.
const PUNCT = /[\p{P}\p{S}]/gu;
export function normalise(s) {
  return String(s || "").normalize("NFC").replace(/़|઼/g, "").toLowerCase().replace(PUNCT, " ").replace(/\s+/g, " ").trim();
}
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function wer(ref, hyp) {
  const r = normalise(ref).split(" ").filter(Boolean), h = normalise(hyp).split(" ").filter(Boolean);
  return { errors: edits(r, h), words: r.length };
}
export function cer(ref, hyp) {
  const r = [...normalise(ref).replace(/ /g, "")], h = [...normalise(hyp).replace(/ /g, "")];
  return { errors: edits(r, h), chars: r.length };
}

/** Did the pipeline do the right thing for this case? */
export function judge(tc, r) {
  const status = r.status;
  const cited = r.citations || [];
  let pass;
  if (tc.expect === "answer") pass = ["answered", "partial"].includes(status) && (!tc.sources_any.length || tc.sources_any.some((s) => cited.includes(s)));
  else if (tc.expect === "answer_or_agent") pass = ["answered", "partial", "needs_agent", "no_answer"].includes(status) && status !== "error";
  else if (tc.expect === "needs_agent") pass = status === "needs_agent";
  else if (tc.expect === "blocked") pass = status === "blocked";
  else if (tc.expect === "out_of_scope") pass = ["out_of_scope", "no_answer"].includes(status);
  else if (tc.expect === "emergency") pass = status === "emergency";
  const languageOk = tc.expect !== "answer" || tc.lang === "en" || r.reply_language === tc.lang || (r.reply_language === "en" && !!r.guardrailNote);
  return { pass: !!pass, language_ok: languageOk, translated: r.reply_language && r.reply_language !== "en" };
}
