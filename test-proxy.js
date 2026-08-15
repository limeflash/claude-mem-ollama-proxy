'use strict';

// Run with: node test-proxy.js
//
// Integration test: boots a fake upstream, boots the real proxy against it, and
// sends a request through. The unit tests exercise the redactor in isolation —
// they all passed while a typo in the logging line was crashing the server on
// every response. Only this test catches that class of bug.

const http = require('node:http');
const { spawn } = require('node:child_process');

const UPSTREAM_PORT = 19434;
const PROXY_PORT = 19435;

const SECRET = 'wJalrXUtnFEMI7K7MDENGbPxRfiCYEXAMPLEKEY';
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

let received = null; // what the upstream actually saw

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = { url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
});

const fail = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) fail.push(name);
};

upstream.listen(UPSTREAM_PORT, '127.0.0.1', () => {
  const proxy = spawn(process.execPath, [require.resolve('./proxy.js')], {
    env: {
      ...process.env,
      CMP_PORT: String(PROXY_PORT),
      CMP_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let proxyOut = '';
  proxy.stdout.on('data', (d) => { proxyOut += d.toString(); });
  proxy.stderr.on('data', (d) => { proxyOut += d.toString(); });

  const done = (code) => {
    proxy.kill('SIGTERM');
    upstream.close();
    process.exit(code);
  };

  setTimeout(() => {
    const payload = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: `AWS_SECRET_ACCESS_KEY=${SECRET}\nseed: ${SEED}` }],
      temperature: 0.3,
      max_tokens: 100,
    });

    const req = http.request(
      {
        hostname: '127.0.0.1', port: PROXY_PORT, path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: 'Bearer test-key-must-pass-through',
        },
      },
      (res) => {
        const out = [];
        res.on('data', (c) => out.push(c));
        res.on('end', () => {
          const clientBody = Buffer.concat(out).toString('utf8');

          console.log('proxy integration:');
          check('upstream was reached', received !== null);
          if (!received) return done(1);

          const sent = JSON.parse(received.body);
          const content = sent.messages[0].content;

          check('secret never left the machine', !received.body.includes(SECRET));
          check('seed phrase never left the machine', !received.body.includes('abandon ability able'));
          check('placeholder present', /\[SECRET:/.test(content), content.slice(0, 80));
          check('reasoning_effort injected', sent.reasoning_effort === 'none', JSON.stringify(sent.reasoning_effort));
          check('non-secret fields untouched', sent.model === 'test-model' && sent.temperature === 0.3);
          check('Authorization forwarded intact', received.auth === 'Bearer test-key-must-pass-through');
          check('path preserved', received.url === '/v1/chat/completions');
          check('response relayed to client', clientBody.includes('"ok"'));
          check('proxy did not crash', !/Error|not defined/.test(proxyOut), proxyOut.slice(0, 200));
          check('log mentions redaction', /redacted:/.test(proxyOut), proxyOut.slice(0, 200));
          check('secret absent from proxy log', !proxyOut.includes(SECRET));

          console.log(`\n${fail.length === 0 ? 'proxy integration OK' : `FAILED: ${fail.join(', ')}`}`);
          done(fail.length === 0 ? 0 : 1);
        });
      }
    );

    req.on('error', (e) => {
      console.log(`  FAIL  could not reach proxy: ${e.message}`);
      done(1);
    });
    req.end(payload);
  }, 700);
});
