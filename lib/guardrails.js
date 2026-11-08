// Deterministic guardrails. They run before and after the model and never depend on the model's judgement.

// ---------- Input guards (before retrieval / model) ----------

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (your|the|all) (rules|instructions|guidelines)/i,
  /(reveal|show|print|repeat|tell me) (me )?(your|the) (system|hidden|original) (prompt|instructions)/i,
  /\b(system prompt|developer mode|jailbreak|DAN mode)\b/i,
  /you are (now|no longer) /i,
  /pretend (to be|you are)/i,
  /act as (an? )?(unrestricted|different|evil)/i,
];

const EMERGENCY = /\b(i need (an )?(ambulance|police)|someone is (hurt|dying|unconscious)|heart attack|kill (myself|me)|suicid|want to die|overdos|being attacked|house is on fire)\b/i;

const GREETING = /^\s*(hi|hello|hey|hiya|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|great)[\s!.?]*$/i;

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

// Redact personal data so it never reaches the model provider or the logs.
export function redactPII(text) {
  const found = [];
  let out = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) { found.push("payment card number"); return "[card number removed]"; }
    return m;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { found.push("government ID number"); return "[ID number removed]"; });
  out = out.replace(/\b(password|passcode|pin|puk|pwd|otp|verification code)(\s*(is|:|=)\s*)(\S+)/gi, (_m, k, sep) => {
    found.push(k.toLowerCase()); return `${k}${sep}[removed]`;
  });
  out = out.replace(/\b(cvv|cvc|security code)\b\D{0,10}\d{3,4}\b/gi, (m) => { found.push("card security code"); return m.replace(/\d{3,4}$/, "[removed]"); });
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => { found.push("email address"); return "[email removed]"; });
  return { text: out, found: [...new Set(found)] };
}

export function inputGuard(message) {
  const text = String(message || "").trim();
  if (!text) return { block: { status: "no_answer", answer: "Please type a question about your NovaCell service." } };
  if (text.length > 800)
    return { block: { status: "no_answer", answer: "That message is a bit long for me. Please ask one question in a sentence or two." } };
  if (EMERGENCY.test(text))
    return {
      block: {
        status: "emergency",
        answer: "If you or someone else is in danger, please call your local emergency number (for example 911, 112 or 999) right now. I am an automated support assistant and cannot contact emergency services for you.",
      },
    };
  if (INJECTION.some((r) => r.test(text)))
    return {
      block: {
        status: "blocked",
        answer: "I can only help with NovaCell support questions, such as mobile data, bills, SIM or eSIM, roaming, calls and the app. I can't change how I work or share my instructions. What can I help you with?",
      },
    };
  if (GREETING.test(text))
    return {
      block: {
        status: "greeting",
        answer: "Hi! I'm the NovaCell support assistant. I can help with slow data, bill questions, SIM and eSIM activation, roaming before you travel, call problems and the app. What's going on?",
      },
    };
  const { text: clean, found } = redactPII(text);
  return { text: clean, piiFound: found };
}

// ---------- Output validators (after the model) ----------

// Numbers that matter to customers: prices, allowances, durations, phone numbers.
const NUM = /\$?\d[\d,]*(?:\.\d+)?/g;

function normNum(s) {
  return s.replace(/[$,]/g, "").replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
}

export function ungroundedNumbers(answer, contextText, question) {
  const allowed = new Set([...(contextText.match(NUM) || []), ...(question.match(NUM) || [])].map(normNum));
  const bad = [];
  // Ignore list markers like "1)" or "2." at the start of a line or after a space.
  const cleaned = answer
    .replace(/\b(?:FAQ|TK|GUIDE|PLAN)-[A-Z0-9.\-]+/g, "")
    .replace(/(^|\n|\s)\d{1,2}[).](?=\s)/g, "$1");
  for (const m of cleaned.match(NUM) || []) {
    const n = normNum(m);
    if (!n || allowed.has(n)) continue;
    if (/^[1-9]$/.test(n) && !m.startsWith("$")) continue; // small counts ("2 steps") are not facts we sell
    bad.push(m);
  }
  return [...new Set(bad)];
}

// Claims that an account action happened or will happen. Broad on purpose: the assistant has no
// account access, so any such claim is false. (A backup model once wrote "We have already processed
// a refund of $45", which the first version of this list missed.)
const ACTIONS = "issued|applied|processed|credited|refunded|reimbursed|reversed|waived|cancell?ed|changed|switched|upgraded|downgraded|reset|activated|unlocked|blocked|unblocked|restored|fixed|escalated|submitted|raised|logged";
const PROMISES = [
  new RegExp(`\\b(I|we)(?:'ve|'ll| have| will| had| already)*(?: already| now| just)? (${ACTIONS})\\b`, "i"),
  /\b(has|have|had) (already |now |just )?been (issued|processed|credited|refunded|reimbursed|reversed|waived|cancell?ed)\b/i,
  /\byou (will|'ll|should|are going to) (receive|get|see) (a |an |the |your )?(\$?\d[\d.,]* )?(refund|credit|compensation|discount|reimbursement)\b/i,
  /\b(refund|credit|reimbursement)s? (of \$?[\d.,]+ )?(will|should|is going to) (appear|arrive|be (issued|applied|credited|processed))/i,
  /\b(I|we) (will|'ll|can|am going to|are going to) (refund|credit|waive|compensate|reimburse|cancel|switch|change|upgrade|downgrade)\b/i,
  /\b(will|to) (issue|process|apply) (the|your|a) (refund|credit)\b/i,
];

// Any statement that someone will issue a refund or credit, unless negated ("I can't issue refunds").
const ISSUE_REFUND = /\b(issue|process|apply|give you|arrange) (a |the |your |any )?(full |partial )?(refund|credit)s?\b/gi;
const NEGATION = /\b(can['’]t|cannot|can not|not able to|unable to|don['’]t|do not|won['’]t|not)\b[^.]{0,30}$/i;

export function promiseViolations(answer) {
  const hits = PROMISES.filter((r) => r.test(answer)).map((r) => answer.match(r)[0]);
  for (const m of answer.matchAll(ISSUE_REFUND)) {
    if (!NEGATION.test(answer.slice(Math.max(0, m.index - 40), m.index))) hits.push(m[0]);
  }
  return hits;
}

// Requests to act on the customer's account. These are always routed to an agent, whatever the model says.
export const ACCOUNT_ACTION = /\b(refund|reimburse|credit (me|my|it|back)|give me (a |my )?(credit|refund|money)|waive|compensat|cancel (my|the|this)|terminate my|close my account|switch me|move me to|change my plan (for me|to)|upgrade me|downgrade me|unblock my|reactivate my|reverse (the|this|my) charge)\b/i;

// Web addresses, APN-style values and menu paths are as dangerous as invented prices: a made-up
// "internet.novacell.com" or "Settings > Network > X" sends the customer down a dead end.
const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|example|co|uk)\b|\b[a-z0-9-]+\.example\b/gi;
const PATH = /[A-Za-z][^\n>→.:;]{0,40}(?:\s*(?:>|→)\s*[A-Za-z][^\n>→.:;,()]{0,40})+/g;

export function ungroundedSpecifics(answer, contextText) {
  const ctx = contextText.toLowerCase().replace(/\s+/g, " ");
  const bad = [];
  for (const d of answer.match(DOMAIN) || []) if (!ctx.includes(d.toLowerCase())) bad.push(d);
  for (const path of answer.match(PATH) || []) {
    const segs = path.split(/\s*(?:>|→)\s*/).slice(1).map((s) => s.trim().toLowerCase().replace(/^(the|your)\s+/, ""));
    for (const s of segs) {
      // Compare on the first 3 words so "Wi-Fi Calling and toggle it on" still matches "Wi-Fi Calling".
      const key = s.split(" ").slice(0, 3).join(" ").replace(/[^a-z0-9&+\- ]/g, "").trim();
      if (key && !ctx.includes(key)) { bad.push(path.trim()); break; }
    }
  }
  return [...new Set(bad)];
}

// Agent-only tooling that must not appear in customer answers even if a ticket mentions it.
const INTERNAL = /\b(HLR|BSS|RNC|subscriber management system|MILENAGE|Ki key|idempotency|unbar)\b/;
export function internalLeak(answer) {
  const m = answer.match(INTERNAL);
  return m ? [m[0]] : [];
}
