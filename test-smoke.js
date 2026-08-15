'use strict';

// Run with: node test-smoke.js
//
// Whole realistic documents rather than one-line cases. Each scenario declares
// two lists, and both are checked literally:
//
//   leak — substrings that MUST NOT survive redaction
//   keep — substrings that MUST survive untouched
//
// The `keep` half is the point. A redactor that eats real content is worse
// than none, because it silently degrades every memory claude-mem stores.

const { redactText, formatHits } = require('./redact');

// Split so this file holds no string a secret scanner would flag.
const s = (...p) => p.join('');

const SCENARIOS = [];

// --------------------------------------------------------------------------
SCENARIOS.push({
  name: 'dotenv file, mixed styles',
  text: `# production config — do not commit
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://appuser:${'Tr0ub4dor&3xyz'}@db.internal:5432/app
REDIS_URL=redis://cache.internal:6379
API_KEY=${s('ak_live_', 'q7Wx', '9mNp2vLd8sKf4hRj6tYu')}
JWT_SECRET="${'z8Kq2mXn5vBt7wEr9yUi3oPa'}"
STRIPE_SECRET_KEY=${s('sk_live_', '51H8xQ2mNp9vLd8sKf4hRj')}
SENDGRID_API_KEY=${s('SG.', 'x9Kq2mXn5vBt7wEr', '.', '9yUi3oPa5sDf7gHj2kLm4nBv6cXz8qWe')}
AWS_ACCESS_KEY_ID=AKIAQYLPMN5HXB3KLMNO
AWS_SECRET_ACCESS_KEY=${'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'}
TELEGRAM_BOT_TOKEN=${s('7823456789', ':', 'AAHd9x2KqmXn5vBt7wEr9yUi3oPa5sDf7gH')}
LOG_LEVEL=debug
FEATURE_FLAGS=new_ui,fast_index
TIMEOUT_MS=30000`,
  leak: [
    'Tr0ub4dor&3xyz',
    s('ak_live_', 'q7Wx', '9mNp2vLd8sKf4hRj6tYu'),
    'z8Kq2mXn5vBt7wEr9yUi3oPa',
    s('sk_live_', '51H8xQ2mNp9vLd8sKf4hRj'),
    'AKIAQYLPMN5HXB3KLMNO',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ],
  keep: [
    'NODE_ENV=production', 'PORT=8080', 'LOG_LEVEL=debug',
    'FEATURE_FLAGS=new_ui,fast_index', 'TIMEOUT_MS=30000',
    'REDIS_URL=redis://cache.internal:6379',
    '# production config — do not commit',
  ],
});

// --------------------------------------------------------------------------
SCENARIOS.push({
  name: 'docker-compose + k8s secret',
  text: `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: appuser
      POSTGRES_PASSWORD: ${'pG7xKq2mNv9wEr4t'}
      POSTGRES_DB: appdb
    ports: ["5432:5432"]
  api:
    image: ghcr.io/acme/api:1.4.2
    environment:
      DATABASE_PASSWORD: "${'pG7xKq2mNv9wEr4t'}"
      SESSION_SECRET: '${'8fJk3mQp6rTv9xZc2bNm5wYe'}'
---
apiVersion: v1
kind: Secret
metadata:
  name: api-credentials
  namespace: production
type: Opaque
stringData:
  password: ${'hunter2hunter2XYZ'}
  api-key: ${s('key_', 'live_', '9mNp2vLd8sKf4hRj6tYu')}`,
  leak: [
    'pG7xKq2mNv9wEr4t',
    '8fJk3mQp6rTv9xZc2bNm5wYe',
    'hunter2hunter2XYZ',
    s('key_', 'live_', '9mNp2vLd8sKf4hRj6tYu'),
  ],
  keep: [
    'image: postgres:16', 'POSTGRES_USER: appuser', 'POSTGRES_DB: appdb',
    'ghcr.io/acme/api:1.4.2', 'namespace: production', 'kind: Secret',
    'ports: ["5432:5432"]',
  ],
});

// --------------------------------------------------------------------------
SCENARIOS.push({
  name: 'assorted provider credentials',
  text: `Rotating everything after the incident:
  anthropic  ${s('sk-', 'ant-', 'api03-', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4nBv6cXz8qWe')}
  openai     ${s('sk-', 'proj-', 'Xn5vBt7wEr9yUi3oPa5sDf7gHj2kLm')}
  github     ${s('ghp_', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm')}
  gitlab     ${s('glpat-', 'Kq2mXn5vBt7wEr9yUi')}
  slack      ${s('xoxb-', '2847561930264', '-', 'Kq2mXn5vBt7wEr9yUi3oPa')}
  google     ${s('AIza', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4')}
  npm        ${s('npm_', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4n')}
  session    ${s('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'dQw4w9WgXcQKq2mXn5vBt7wEr')}
Ticket INC-4471, rotated by ops on 2026-08-14, commit 4653136a1b2c3d4e5f60718293a4b5c6d7e8f900.`,
  leak: [
    s('sk-', 'ant-', 'api03-', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4nBv6cXz8qWe'),
    s('ghp_', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm'),
    s('xoxb-', '2847561930264', '-', 'Kq2mXn5vBt7wEr9yUi3oPa'),
    s('AIza', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4'),
    s('npm_', 'Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4n'),
  ],
  keep: [
    'Ticket INC-4471', 'rotated by ops on 2026-08-14',
    '4653136a1b2c3d4e5f60718293a4b5c6d7e8f900',
  ],
});

// --------------------------------------------------------------------------
SCENARIOS.push({
  name: 'private keys and connection strings',
  text: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAYEAy8Kq2mXn5vBt7wEr9yUi3oPa5sDf7gHj2kLm4nBv6cXz8qWeRt
-----END OPENSSH PRIVATE KEY-----

mongodb+srv://svc_indexer:${'Xn5vBt7wEr9yUi'}@cluster0.abcde.mongodb.net/prod
mysql://root:${'r00tPassw0rd!'}@127.0.0.1:3306/wordpress
amqp://rabbit:${'gu3stGu3st99'}@mq.internal:5672/vhost
redis://:${'c4cheS3cret'}@redis.internal:6379/0

Connection pool sized at 20, retry backoff 250ms, timeout 30s.`,
  leak: [
    'Xn5vBt7wEr9yUi', 'r00tPassw0rd!', 'gu3stGu3st99', 'c4cheS3cret',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
  ],
  keep: [
    'cluster0.abcde.mongodb.net', '127.0.0.1:3306', 'mq.internal:5672',
    'Connection pool sized at 20, retry backoff 250ms, timeout 30s.',
  ],
});

// --------------------------------------------------------------------------
// Seed phrases in every shape people actually paste them.
const W12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const W12B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const W15 = W12 + ' account accuse achieve';
const W18 = W15 + ' acid acoustic acquire';
const W21 = W18 + ' across act action';
const W24 = W21 + ' actor actress actual';

SCENARIOS.push({
  name: 'seed phrases, non-standard formats',
  text: `Wallet recovery notes — DO NOT SHARE

plain 12:
${W12}

24 words:
${W24}

UPPERCASE:
${W12B.toUpperCase()}

Comma separated:
${W12.split(' ').join(', ')}

Numbered list:
${W12.split(' ').map((w, i) => `${i + 1}. ${w}`).join('  ')}

JSON array:
["${W12.split(' ').join('","')}"]

Markdown table row:
| ${W12.split(' ').join(' | ')} |

Tab separated:
${W12.split(' ').join('\t')}

Mixed case with newlines:
${W15.split(' ').map((w, i) => (i % 2 ? w.toUpperCase() : w)).join('\n')}

Ledger is a hardware wallet; the vault lives in a safe deposit box.`,
  leak: [
    'abandon ability able about above absent',
    W12B.toUpperCase().slice(0, 40),
    'abandon, ability, able',
    '1. abandon  2. ability',
    '"abandon","ability"',
    '| abandon | ability |',
  ],
  keep: [
    'Wallet recovery notes — DO NOT SHARE',
    'Ledger is a hardware wallet; the vault lives in a safe deposit box.',
  ],
});

// --------------------------------------------------------------------------
SCENARIOS.push({
  name: 'passwords across syntaxes',
  text: `# shell
mysql -u root -p'${'Sup3rS3cret!99'}' -h db.internal
psql "host=db user=admin password=${'Adm1nPass2026'} dbname=app"
curl -u admin:${'B4sicAuthPw!'} https://api.internal/health

# ini
[credentials]
username = deploy
password = ${'D3pl0yMe2026!'}

# toml
[database]
host = "db.internal"
password = "${'T0mlP4ssw0rd'}"

# xml
<connection><user>svc</user><password>${'Xm1P4ssw0rd99'}</password></connection>

# sql
CREATE USER reporting WITH PASSWORD '${'R3port1ngPw!'}';

# prose
The password is ${'Wr1ttenOutLoud99'} and expires on Friday.
Пароль: ${'Rus5k1yParol!'} — поменять после релиза.

Everything else here is ordinary configuration prose.`,
  leak: [
    'Sup3rS3cret!99', 'Adm1nPass2026', 'B4sicAuthPw!', 'D3pl0yMe2026!',
    'T0mlP4ssw0rd', 'Xm1P4ssw0rd99', 'R3port1ngPw!', 'Wr1ttenOutLoud99',
    'Rus5k1yParol!',
  ],
  keep: [
    'mysql -u root', 'host = "db.internal"', 'username = deploy',
    'CREATE USER reporting', 'Everything else here is ordinary configuration prose.',
    '— поменять после релиза.',
  ],
});

// --------------------------------------------------------------------------
// The control group: nothing here may be touched at all.
SCENARIOS.push({
  name: 'CONTROL — real work, nothing to redact',
  text: `commit 4653136a1b2c3d4e5f60718293a4b5c6d7e8f900
Author: dev <dev@example.com>
Date:   Fri Aug 14 22:29:06 2026 +0000

    Fix token refresh so the access path stops retrying forever

    The client can access the network and absorb the response before the
    display can update, which is absurd but useful when the actual index
    is ready. Added a guard in resolve_single_call and a test for the
    partial-parse path.

 src/pipeline/pass_calls.c  | 42 ++++++++++++--------
 tests/test_parallel.c      | 18 ++++++++
 2 files changed, 44 insertions(+), 16 deletions(-)

Config keys involved: CLAUDE_MEM_OPENROUTER_BASE_URL, CLAUDE_MEM_WORKER_PORT.
Session a811ff21-ea95-4681-82d1-382ae7336200 · sha256 32c3a715ffbad3a19f8c2d4e6b0a7c5f
The password is required before the token can be refreshed; password: incorrect
returns 401. See docs/auth.md for how the secret is stored on disk.
Set your API key in settings.json — the api_key field is documented above.`,
  leak: [],
  keep: [
    '4653136a1b2c3d4e5f60718293a4b5c6d7e8f900',
    'a811ff21-ea95-4681-82d1-382ae7336200',
    '32c3a715ffbad3a19f8c2d4e6b0a7c5f',
    'CLAUDE_MEM_OPENROUTER_BASE_URL',
    'The password is required before the token can be refreshed',
    'password: incorrect',
    'src/pipeline/pass_calls.c',
    'the absurd but useful'.slice(4), // "absurd but useful" — bip39 words in prose
    'docs/auth.md',
    'the api_key field is documented above',
  ],
});

// --------------------------------------------------------------------------

let totalFail = 0;

for (const sc of SCENARIOS) {
  const { text, hits } = redactText(sc.text);

  const missed = sc.leak.filter((v) => text.includes(v));
  const destroyed = sc.keep.filter((v) => !text.includes(v));
  const ok = missed.length === 0 && destroyed.length === 0;
  totalFail += missed.length + destroyed.length;

  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${sc.name}`);
  console.log(`      secrets removed : ${sc.leak.length - missed.length}/${sc.leak.length}`);
  console.log(`      content kept    : ${sc.keep.length - destroyed.length}/${sc.keep.length}`);
  console.log(`      rules fired     : ${formatHits(hits) || '(none)'}`);

  for (const v of missed) console.log(`      LEAKED  ${JSON.stringify(v.slice(0, 60))}`);
  for (const v of destroyed) console.log(`      EATEN   ${JSON.stringify(v.slice(0, 60))}`);
}

console.log(`\n${totalFail === 0 ? 'smoke OK' : `smoke FAILED — ${totalFail} problem(s)`}`);
process.exit(totalFail === 0 ? 0 : 1);
