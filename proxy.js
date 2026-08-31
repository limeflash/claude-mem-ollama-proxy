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
const think = require('./think');

const PORT = Number(process.env.CMP_PORT || 11435);
const HOST = process.env.CMP_HOST || '127.0.0.1';
const EFFORT = process.env.CMP_REASONING_EFFORT || 'none';
const REDACT = process.env.CMP_REDACT !== 'false';
// Model to retry with when a thinking model is refused (usage limits, outages).
// Empty string disables the fallback.
const FALLBACK = process.env.CMP_THINK_FALLBACK ?? 'deepseek-v4-flash:0731';

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
    return { buf: raw, effort: false, hits: {}, body: null };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { buf: raw, effort: false, hits: {}, body: null };
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

  return { buf: Buffer.from(JSON.stringify(body), 'utf8'), effort, hits, body };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => res.destroy());

  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const isCompletion = req.url.includes('/chat/completions');

    const { buf, effort, hits, body } = isCompletion && raw.length
      ? transform(raw)
      : { buf: raw, effort: false, hits: {}, body: null };

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = UP.host;
    if (buf.length) headers['content-length'] = String(buf.length);


    // Thinking models cannot be handled on the OpenAI-compatible endpoint, so
    // they are translated to native /api/chat and back. Redaction has already
    // been applied to `body` above, so nothing unredacted takes this path.
    if (body && think.isThinkModel(body.model)) {
      const nativeBody = Buffer.from(JSON.stringify(think.toNative(body)), 'utf8');
      const nHeaders = { ...headers, 'content-type': 'application/json', 'content-length': String(nativeBody.length) };
      const nReq = UP_CLIENT.request(
        { hostname: UPSTREAM, port: UP_PORT, path: '/api/chat', method: 'POST', headers: nHeaders },
        (up) => {
          const parts = [];
          up.on('data', (c) => parts.push(c));
          up.on('end', () => {
            const notes = ['native think'];
            const redacted = formatHits(hits);
            if (redacted) notes.push(`redacted: ${redacted}`);
            let out;
            try {
              const converted = think.fromNative(JSON.parse(Buffer.concat(parts).toString('utf8')), body.model);
              out = Buffer.from(JSON.stringify(converted.body), 'utf8');
              notes.push(`thoughts dropped: ${converted.thoughtChars} ch`);
            } catch (err) {
              // Upstream sent something we cannot convert (an error page, a
              // rate-limit body). Pass it through rather than inventing a shape.
              out = Buffer.concat(parts);
              notes.push(`passthrough: ${err.message}`);
            }
            // A thinking model burns roughly ten times the tokens of a terse
            // one, so it is the first thing to hit a rolling usage limit. If
            // upstream refuses, fall back to a cheap model rather than letting
            // the caller record nothing -- silent memory loss is the failure
            // this proxy exists to prevent.
            if (up.statusCode >= 400 && FALLBACK && body) {
              log(`${req.method} ${req.url} -> ${up.statusCode} [${notes.join('] [')}] [falling back to ${FALLBACK}]`);
              const fb = Buffer.from(JSON.stringify({ ...body, model: FALLBACK }), 'utf8');
              const fbReq = UP_CLIENT.request(
                { hostname: UPSTREAM, port: UP_PORT, path: '/v1/chat/completions', method: 'POST',
                  headers: { ...headers, 'content-type': 'application/json', 'content-length': String(fb.length) } },
                (fbUp) => {
                  log(`${req.method} ${req.url} -> ${fbUp.statusCode} [fallback ${FALLBACK}]`);
                  res.writeHead(fbUp.statusCode, fbUp.headers);
                  fbUp.pipe(res);
                }
              );
              fbReq.on('error', () => {
                if (!res.headersSent) res.writeHead(up.statusCode, { 'content-type': 'application/json' });
                res.end(out);
              });
              fbReq.write(fb);
              fbReq.end();
              return;
            }

            log(`${req.method} ${req.url} -> ${up.statusCode} [${notes.join('] [')}]`);
            res.writeHead(up.statusCode, { 'content-type': 'application/json', 'content-length': String(out.length) });
            res.end(out);
          });
        }
      );
      nReq.on('error', (err) => {
        log(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
      });
      nReq.write(nativeBody);
      nReq.end();
      return;
    }

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
      `(reasoning_effort=${EFFORT}, redact=${REDACT ? 'on' : 'OFF'}, ` +
      `native-think=${process.env.CMP_THINK_MODELS ?? 'glm-*'}, ` +
      `fallback=${FALLBACK || 'off'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
