'use strict';

// Run with: node test-redact.js
//
// Two halves, and the second matters more than the first. Missing a secret is
// bad; redacting a git SHA or a file path is worse, because it quietly poisons
// every observation claude-mem stores.

const { redactText } = require('./redact');

// Assembled at runtime so this file itself contains no string that looks like
// a live credential to a secret scanner.
const s = (...p) => p.join('');

const MUST_REDACT = [
  ['anthropic key', s('sk-', 'ant-', 'api03-', 'A'.repeat(24))],
  ['openai key', s('sk-', 'B'.repeat(32))],
  ['github pat', s('ghp_', 'C'.repeat(36))],
  ['github fine-grained', s('github_pat_', 'D'.repeat(30))],
  ['slack token', s('xoxb-', '123456789012-', 'E'.repeat(24))],
  ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
  ['google api key', s('AIza', 'F'.repeat(35))],
  ['stripe live key', s('sk_live_', 'G'.repeat(24))],
  ['npm token', s('npm_', 'H'.repeat(36))],
  ['jwt', s('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'I'.repeat(20))],
  ['dotenv line', 'API_KEY=abc123def456ghi789'],
  ['dotenv quoted', 'DATABASE_PASSWORD="hunter2hunter2"'],
  ['json settings', '"CLAUDE_MEM_OPENROUTER_API_KEY": "7d104ceeaa11bb22cc33dd44ee55ff66"'],
  ['shell export', 'export GITHUB_TOKEN=zzzzzzzzzzzzzzzzzzzz'],
  ['yaml secret', 'client_secret: s3cr3tv4lu3here'],
  ['url credentials', 'postgres://admin:s3cr3tpass@db.example.com:5432/app'],
  ['auth header in text', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
  ['pem block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],

  // passwords in prose
  ['password prose en', 'the password is hunter2hunter'],
  ['password prose ru', 'пароль: mySup3rP4ss'],

  // BIP-39 mnemonics — 12 and 24 words, plus the numbered paste format
  ['seed 12 words',
    'abandon ability able about above absent absorb abstract absurd abuse access accident'],
  ['seed 24 words',
    'legal winner thank year wave sausage worth useful legal winner thank year ' +
    'wave sausage worth useful legal winner thank year wave sausage worth title'],
  ['seed numbered',
    '1. abandon 2. ability 3. able 4. about 5. above 6. absent ' +
    '7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident'],
  ['seed newline separated',
    'abandon\nability\nable\nabout\nabove\nabsent\nabsorb\nabstract\nabsurd\nabuse\naccess\naccident'],
  ['seed labelled', 'mnemonic: abandon ability able about above absent absorb abstract absurd abuse access accident'],
];

const MUST_NOT_REDACT = [
  ['git sha', 'commit 4653136a1b2c3d4e5f60718293a4b5c6d7e8f900 landed'],
  ['short sha', 'see a811ff21 for the fix'],
  ['uuid', 'session a811ff21-ea95-4681-82d1-382ae7336200 started'],
  ['file path', 'read src/store/store.c and pipeline.c'],
  ['token null', 'token: null'],
  ['secret false', 'has_secret: false'],
  ['prose', 'the secret sauce here is the call graph, not the parser'],
  ['empty key', '"CLAUDE_MEM_OPENROUTER_API_KEY": ""'],
  ['version', 'claude-mem v13.15.0 with bun 1.3.14'],
  ['key name only', 'set CLAUDE_MEM_OPENROUTER_API_KEY in settings.json'],
  ['url under token name', 'token_url: https://ollama.com/settings/keys'],
  ['hex digest', 'content_hash = 32c3a715ffbad3a1'],
  ['port and numbers', 'listening on 127.0.0.1:11435 upstream ollama.com'],

  // password prose that is not a password
  ['password required', 'the password is required for this step'],
  ['password incorrect', 'password: incorrect'],

  // Text that brushes against BIP-39 without being a mnemonic. These are the
  // cases that would quietly ruin every observation if the rule were sloppy.
  ['prose with bip39 words',
    'the client can access the network and absorb the response before the ' +
    'display can update, which is absurd but useful when the actual index is ready'],
  ['short bip39 run', 'able about above absent absorb'],
  ['code identifiers',
    'const access = require("./access"); return access.ready && index.valid'],
  ['long technical prose',
    'The indexing pipeline runs in memory, releases the buffer after the write, ' +
    'and reports partial parses so the caller can fall back to text search when ' +
    'a file was only partially understood by the parser during the second pass'],
];

let pass = 0;
let fail = 0;

console.log('MUST redact:');
for (const [name, input] of MUST_REDACT) {
  const { text, hits } = redactText(input);
  // The secret must be gone and something must have matched. We do not assert
  // on the placeholder text itself — it is configurable.
  const ok = text !== input && Object.keys(hits).length > 0;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(22)} ${ok ? Object.keys(hits).join(',') : '-> ' + text.slice(0, 60)}`);
  ok ? pass++ : fail++;
}

console.log('\nMUST NOT redact:');
for (const [name, input] of MUST_NOT_REDACT) {
  const { text } = redactText(input);
  const ok = text === input;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(22)} ${ok ? '' : '-> ' + text.slice(0, 70)}`);
  ok ? pass++ : fail++;
}

// The placeholder is a separate process-level setting, so exercise it in a
// child process rather than mutating the already-loaded module.
console.log('\nplaceholder shapes:');
{
  const { execFileSync } = require('node:child_process');
  const sample = 'AWS_SECRET_ACCESS_KEY=abcd1234efgh5678';
  const probe = 'const {redactText}=require("./redact");process.stdout.write(redactText(process.argv[1]).text)';

  for (const [label, tpl, expect] of [
    ['default', null, '[SECRET:assigned-secret]'],
    ['plain word', 'SECRET', 'SECRET'],
    ['stars', '******', '******'],
  ]) {
    const env = { ...process.env };
    if (tpl === null) delete env.CMP_REDACT_PLACEHOLDER;
    else env.CMP_REDACT_PLACEHOLDER = tpl;

    const out = execFileSync(process.execPath, ['-e', probe, sample], {
      env, cwd: __dirname, encoding: 'utf8',
    });
    const ok = out.includes(expect) && !out.includes('abcd1234');
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${out}`);
    ok ? pass++ : fail++;
  }
}

// A placeholder must never be re-matched by a later rule. Before the freeze/
// thaw pass this produced "[SECRET:[SECRET:assigned-secret]]".
console.log('\nno nested placeholders:');
{
  const cases = [
    ['seed under a key', 'seed: abandon ability able about above absent absorb abstract absurd abuse access accident'],
    ['url under a key', 'DATABASE_URL=postgres://appuser:Tr0ub4dor3xyz@db.internal:5432/app'],
    ['password then key', 'the password is Wr1ttenOutLoud99 and API_KEY=abc123def456'],
    ['xml then assignment', '<password>Xm1P4ssw0rd99</password> token=zzzzzzzzzzzz'],
  ];
  for (const [name, input] of cases) {
    const { text } = redactText(input);
    // Nested placeholder, or a freeze token that was never thawed back.
    const nested = /\[SECRET:[^\]]*\[SECRET/.test(text)
      || text.includes(String.fromCharCode(0));
    console.log(`  ${nested ? 'FAIL' : 'ok  '}  ${name.padEnd(22)} ${nested ? text.slice(0, 80) : ''}`);
    nested ? fail++ : pass++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
