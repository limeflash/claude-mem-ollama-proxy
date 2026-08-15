'use strict';

// Secret redaction for outbound request bodies.
//
// claude-mem sends conversation content to the model verbatim — its own
// redaction only ever touches its log files, never the payload. Anything the
// agent reads or prints (a .env file, a token in command output) therefore
// leaves the machine. This module is the chokepoint that stops it.
//
// Design rule: a false positive costs more than it looks. Over-redacting turns
// the observations into noise, so patterns must be specific. Notably we do NOT
// touch bare hex strings — git SHAs are 40 hex chars and appear constantly in
// this kind of work — nor UUIDs.

// What a secret is replaced with. `{type}` expands to the rule that matched,
// so the model still knows an AWS key stood there rather than seeing a blank —
// which keeps the observation meaningful instead of merely censored.
//
//   CMP_REDACT_PLACEHOLDER='[SECRET:{type}]'   (default)
//   CMP_REDACT_PLACEHOLDER='SECRET'
//   CMP_REDACT_PLACEHOLDER='******'
const TEMPLATE = process.env.CMP_REDACT_PLACEHOLDER || '[SECRET:{type}]';
const ph = (type) => TEMPLATE.replace(/\{type\}/g, type);

const BIP39 = require('./bip39-words');

// Values that match a secret-shaped pattern but are plainly not secrets. Used
// by every rule that keys off a name rather than the value's own shape.
const NOT_SECRET = new Set([
  // placeholders and empties
  'true', 'false', 'null', 'undefined', 'none', 'nil', 'empty', 'nothing',
  'changeme', 'change_me', 'your_api_key_here', 'yourkeyhere', 'xxx', 'xxxx',
  'placeholder', 'example', 'redacted', '[redacted]', 'todo', 'fixme',
  // words that follow "password is …" in ordinary sentences
  'required', 'correct', 'incorrect', 'wrong', 'invalid', 'missing',
  'hidden', 'needed', 'changed', 'reset', 'protected', 'expired', 'strong',
  'weak', 'stored', 'hashed', 'blank', 'unknown', 'above', 'below', 'here',
  'optional', 'disabled', 'enabled', 'rotated', 'revoked', 'valid', 'unset',
  'нужен', 'неверный', 'верный', 'пустой', 'изменён', 'изменен', 'сброшен',
  'обязателен', 'скрыт', 'указан', 'отсутствует',
]);

// Key names whose value is a secret regardless of shape. Deliberately narrow.
const SECRET_KEY = String.raw`(?:api[_-]?keys?|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|credentials?|auth[_-]?token|bearer|mnemonic|seed[_-]?phrase|passphrase)`;

// True when a matched value is a real secret rather than a placeholder or an
// ordinary English/Russian word that happened to follow "password:".
function looksSecret(value) {
  const v = value.toLowerCase();
  if (NOT_SECRET.has(v)) return false;
  if (v.startsWith('[secret') || v.startsWith('[redacted') || v.startsWith('******')) return false;
  return true;
}

const RULES = [
  // --- passwords written out in prose --------------------------------------
  // "password is hunter2", "пароль: hunter2". The stoplist keeps ordinary
  // sentences ("the password is required") intact.
  // Note: no leading \b — JavaScript word boundaries are ASCII-only, so \b
  // never matches before a Cyrillic "п" and "пароль:" would slip through.
  {
    id: 'password-prose',
    // The separator is optional when the value is quoted, so SQL's
    // `WITH PASSWORD 'secret'` is caught alongside `password = secret`.
    re: /(?:^|[^\p{L}\d_])(пароль|пасс|password|passphrase|мнемоника)(?:\s*(?:is|—|–|-|:|=)+\s*|\s+(?=["'`]))(["'`]?)([^\s"'`\n,;]{6,})\2/giu,
    replace: (mark, m, word, quote, value) => {
      if (!looksSecret(value)) return m;
      const lead = m.slice(0, m.indexOf(word));
      return `${lead}${word}: ${quote}${mark}${quote}`;
    },
  },

  // --- provider-specific, effectively zero false positives -----------------
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { id: 'openai-key', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'openrouter-key', re: /\bsk-or-v1-[A-Za-z0-9]{16,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g },

  // --- private key blocks --------------------------------------------------
  {
    id: 'private-key-block',
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },

  // --- credentials embedded in URLs: scheme://user:pass@host ---------------
  // The username may be empty — redis://:password@host is a real and common
  // shape, and requiring a username let it through.
  {
    id: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]{0,64}):([^\s:/@]{1,256})@/gi,
    replace: (mark, _m, scheme, user) => `${scheme}${user}:${mark}@`,
  },

  // --- command-line credential flags ---------------------------------------
  // Quoted form: mysql -p'secret', --password="secret". A quote is required
  // for the short flag so that `docker run -p 8080:8080` is left alone.
  {
    id: 'cli-password',
    re: /(--password[=\s]|--passwd[=\s]|--pass[=\s]|-p)(["'])([^"'\n]{4,})\2/g,
    replace: (mark, m, flag, quote, value) =>
      looksSecret(value) ? `${flag}${quote}${mark}${quote}` : m,
  },
  // Unquoted long form only: --password=secret
  {
    id: 'cli-password',
    re: /(--password=|--passwd=|--pass=)([^\s"'\n]{6,})/g,
    replace: (mark, m, flag, value) => (looksSecret(value) ? `${flag}${mark}` : m),
  },
  // curl -u user:pass  /  --user user:pass
  {
    id: 'cli-basic-auth',
    re: /(\s(?:-u|--user)\s+)([^\s:'"]{1,64}):([^\s'"]{4,})/g,
    replace: (mark, m, flag, user, value) =>
      looksSecret(value) ? `${flag}${user}:${mark}` : m,
  },

  // --- XML / HTML elements -------------------------------------------------
  {
    id: 'xml-secret',
    re: /<(password|passwd|secret|token|apikey|api-key|credential)>([^<\n]{4,})<\/\1>/gi,
    replace: (mark, m, tag, value) =>
      looksSecret(value) ? `<${tag}>${mark}</${tag}>` : m,
  },

  // --- Authorization headers pasted into text ------------------------------
  {
    id: 'auth-header',
    re: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9+/=._~-]{12,})/gi,
    replace: (mark, _m, head) => `${head}${mark}`,
  },

  // --- generic KEY = VALUE assignments -------------------------------------
  // Catches .env lines, JSON settings and shell exports in one rule:
  //   API_KEY="abc"      "CLAUDE_MEM_..._API_KEY": "abc"      token: abc
  {
    id: 'assigned-secret',
    re: new RegExp(
      String.raw`([A-Za-z0-9_.-]*${SECRET_KEY}[A-Za-z0-9_.-]*)` + // 1: key name
      String.raw`(["']?\s*[:=]\s*)` +                             // 2: separator
      String.raw`(["']?)` +                                       // 3: opening quote
      String.raw`([^\s"',;}\])]{8,})` +                           // 4: value
      String.raw`\3`,
      'gi'
    ),
    replace: (mark, m, key, sep, quote, value) => {
      // Leave placeholders, empty values and obvious non-secrets alone.
      if (!looksSecret(value)) return m;
      // A path or URL under a "token"-ish name is usually a location, not a secret.
      if (/^(?:https?:\/\/|\.{0,2}\/)/.test(value) && !/[?&](?:token|key|secret)=/i.test(value)) return m;
      return `${key}${sep}${quote}${mark}${quote}`;
    },
  },
];

// --- BIP-39 seed phrases ---------------------------------------------------
// Not expressible as a regex: a mnemonic is a *run* of dictionary words, so we
// tokenise and look for consecutive hits. Twelve is the shortest valid length,
// and twelve consecutive BIP-39 words do not occur in ordinary text.
const SEED_MIN_WORDS = 12;

// What may sit between two words of a mnemonic: whitespace, commas, and the
// numbering people paste along with it ("1. abandon  2. ability").
const isSeedGap = (gap) => gap.length <= 8 && /^[\s,;.\d)\-\]|"']*$/.test(gap);

function redactSeedPhrases(text, mark) {
  const tokRe = /[A-Za-z]+/g;
  const toks = [];
  let m;
  while ((m = tokRe.exec(text)) !== null) {
    toks.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
  }

  const runs = [];
  let i = 0;
  while (i < toks.length) {
    if (!BIP39.has(toks[i].w)) { i += 1; continue; }
    let j = i;
    while (
      j + 1 < toks.length &&
      BIP39.has(toks[j + 1].w) &&
      isSeedGap(text.slice(toks[j].e, toks[j + 1].s))
    ) j += 1;

    if (j - i + 1 >= SEED_MIN_WORDS) runs.push({ s: toks[i].s, e: toks[j].e });
    i = j + 1;
  }

  if (runs.length === 0) return { text, n: 0 };

  let out = text;
  for (let k = runs.length - 1; k >= 0; k -= 1) {
    out = out.slice(0, runs[k].s) + mark + out.slice(runs[k].e);
  }
  return { text: out, n: runs.length };
}

// Redact one string. Returns the cleaned text plus a per-rule hit count.
//
// Placeholders are "frozen" into NUL-delimited tokens as they are inserted and
// thawed at the very end. Without this, a later rule reads the placeholder it
// just wrote — "[SECRET:seed-phrase]" parses as key `SECRET`, value
// `seed-phrase` — and nests it into "[SECRET:[SECRET:assigned-secret]]".
function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, hits: {} };

  const frozen = [];
  const freeze = (str) => {
    frozen.push(str);
    return `\u0000${frozen.length - 1}\u0000`;
  };
  const thaw = (str) => str.replace(/\u0000(\d+)\u0000/g, (_, i) => frozen[Number(i)]);

  let out = text;
  const hits = {};

  // Seed phrases first: the regex rules must not chop a mnemonic into pieces
  // before we get the chance to see it as one run.
  const seed = redactSeedPhrases(out, freeze(ph('seed-phrase')));
  out = seed.text;
  if (seed.n > 0) hits['seed-phrase'] = seed.n;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const mark = freeze(ph(rule.id));
    let n = 0;
    out = out.replace(rule.re, (...args) => {
      const replaced = rule.replace ? rule.replace(mark, ...args) : mark;
      if (replaced !== args[0]) n += 1;
      return replaced;
    });
    if (n > 0) hits[rule.id] = (hits[rule.id] || 0) + n;
  }

  return { text: thaw(out), hits };
}

// Redact every string inside `messages` (and `system`, if present). Everything
// else in the body — model, temperature, max_tokens — is left untouched.
function redactBody(body) {
  const hits = {};
  const merge = (h) => {
    for (const [k, v] of Object.entries(h)) hits[k] = (hits[k] || 0) + v;
  };

  const walk = (node) => {
    if (typeof node === 'string') {
      const r = redactText(node);
      merge(r.hits);
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(node)) copy[k] = walk(v);
      return copy;
    }
    return node;
  };

  const out = { ...body };
  if (body.messages !== undefined) out.messages = walk(body.messages);
  if (body.system !== undefined) out.system = walk(body.system);

  return { body: out, hits };
}

// "aws-access-key×1, assigned-secret×2" — counts only, never values.
function formatHits(hits) {
  const parts = Object.entries(hits).map(([k, v]) => `${k}\u00d7${v}`);
  return parts.length ? parts.join(', ') : '';
}

module.exports = { redactText, redactBody, formatHits, RULES };
