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
// request, strips credentials out of the conversation, and forwards everything
// else untouched.
//
// The redaction matters as much as the reasoning switch: claude-mem sends
// message content to the model verbatim — its own scrubber only ever touches
// its log files — so a .env file or a token in command output would otherwise
// leave the machine. This is the last point where that can be stopped.
//
// The Authorization header is passed straight through and never logged.
//
// Requires Node 18+ (no dependencies). Runs on macOS, Windows and Linux.

const http = require('node:http');
const https = require('node:https');
const { redactBody, formatHits } = require('./redact');

const PORT = Number(process.env.CMP_PORT || 11435);
const HOST = process.env.CMP_HOST || '127.0.0.1';
const EFFORT = process.env.CMP_REASONING_EFFORT || 'none';
const REDACT = process.env.CMP_REDACT !== 'false';

// CMP_UPSTREAM accepts a bare host ("ollama.com", HTTPS assumed) or a full URL
// ("http://127.0.0.1:11434"). The URL form points the proxy at a local Ollama —
// nothing leaves the machine then — and is what the integration test uses.
const RAW_UPSTREAM = process.env.CMP_UPSTREAM || 'ollama.com';
const UP = RAW_UPSTREAM.includes('://')
  ? new URL(RAW_UPSTREAM)
  : new URL(`https://${RAW_UPSTREAM}`);
const UPSTREAM = UP.hostname;
const UP_PORT = UP.port ? Number(UP.port) : (UP.protocol === 'http:' ? 80 : 443);
const UP_CLIENT = UP.protocol === 'http:' ? http : https;

// Hop-by-hop headers that must not be forwarded verbatim.
const DROP = new Set(['host', 'content-length', 'connection']);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Parse once, apply both transforms, serialise once. A body that is not a JSON
// object passes through untouched — we never fail a request over this.
function transform(raw) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { buf: raw, effort: false, hits: {} };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { buf: raw, effort: false, hits: {} };
  }

  let effort = false;
  if (!('reasoning_effort' in body)) {
    body.reasoning_effort = EFFORT;
    effort = true;
  }

  let hits = {};
  if (REDACT) {
    const r = redactBody(body);
    body = r.body;
    hits = r.hits;
  }

  return { buf: Buffer.from(JSON.stringify(body), 'utf8'), effort, hits };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => res.destroy());

  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const isCompletion = req.url.includes('/chat/completions');

    const { buf, effort, hits } = isCompletion && raw.length
      ? transform(raw)
      : { buf: raw, effort: false, hits: {} };

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = UP.host;
    if (buf.length) headers['content-length'] = String(buf.length);

    const upstream = UP_CLIENT.request(
      { hostname: UPSTREAM, port: UP_PORT, path: req.url, method: req.method, headers },
      (up) => {
        const notes = [];
        if (effort) notes.push(`reasoning_effort=${EFFORT}`);
        const redacted = formatHits(hits);
        if (redacted) notes.push(`redacted: ${redacted}`);
        log(`${req.method} ${req.url} -> ${up.statusCode}${notes.length ? ` [${notes.join('] [')}]` : ''}`);
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
  log(`claude-mem proxy: http://${HOST}:${PORT} -> ${UP.protocol}//${UP.host} ` +
      `(reasoning_effort=${EFFORT}, redact=${REDACT ? 'on' : 'OFF'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
