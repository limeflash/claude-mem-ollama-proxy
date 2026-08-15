'use strict';

// A tiny local proxy that sits between claude-mem and Ollama Cloud.
//
// Why it exists: claude-mem builds its request body with a fixed shape
// (model / messages / temperature / max_tokens) and offers no way to pass
// extra fields. Reasoning models such as deepseek-v4-flash therefore always
// run with reasoning enabled, which burns output tokens and occasionally
// returns an empty `content` while the text lands in `reasoning` — a field
// claude-mem never reads.
//
// This proxy injects `reasoning_effort: "none"` into every chat-completion
// request and forwards everything else untouched.
//
// The Authorization header is passed straight through and never logged.
//
// Requires Node 18+ (no dependencies). Runs on macOS, Windows and Linux.

const http = require('node:http');
const https = require('node:https');

const PORT = Number(process.env.CMP_PORT || 11435);
const HOST = process.env.CMP_HOST || '127.0.0.1';
const UPSTREAM = process.env.CMP_UPSTREAM || 'ollama.com';
const EFFORT = process.env.CMP_REASONING_EFFORT || 'none';

// Hop-by-hop headers that must not be forwarded verbatim.
const DROP = new Set(['host', 'content-length', 'connection']);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Add reasoning_effort without disturbing anything else. If the body is not
// a JSON object, or the caller already set the field, the bytes pass through
// unchanged.
function injectEffort(raw) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { buf: raw, changed: false };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { buf: raw, changed: false };
  }
  if ('reasoning_effort' in body) return { buf: raw, changed: false };

  body.reasoning_effort = EFFORT;
  return { buf: Buffer.from(JSON.stringify(body), 'utf8'), changed: true };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => res.destroy());

  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const isCompletion = req.url.includes('/chat/completions');

    const { buf, changed } = isCompletion && raw.length
      ? injectEffort(raw)
      : { buf: raw, changed: false };

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = UPSTREAM;
    if (buf.length) headers['content-length'] = String(buf.length);

    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
      (up) => {
        log(`${req.method} ${req.url} -> ${up.statusCode}${changed ? ` [reasoning_effort=${EFFORT}]` : ''}`);
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res); // streamed responses pass through untouched
      }
    );

    upstream.on('error', (err) => {
      log(`upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
    });

    if (buf.length) upstream.write(buf);
    upstream.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`claude-mem proxy: http://${HOST}:${PORT} -> https://${UPSTREAM} (reasoning_effort=${EFFORT})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
