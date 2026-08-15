# claude-mem ↔ Ollama Cloud proxy

A zero-dependency local proxy that lets [claude-mem](https://github.com/thedotmack/claude-mem) use **Ollama Cloud** models with **reasoning turned off** and **credentials stripped out of the conversation**.

Three problems it solves, in order of how much they hurt:

1. **Secrets leave your machine.** claude-mem sends conversation content to the model verbatim. Its own redaction only ever touches its log files — never the payload. A `.env` file the agent reads, or a token printed by a command, goes straight to the provider.
2. claude-mem has no Ollama option in its installer — you have to route it through the "OpenAI-compatible" path, and the installer never asks for a base URL. Left alone it sends your Ollama key to `openrouter.ai` and every request fails with `401`.
3. Even once the URL is fixed, reasoning models keep reasoning. claude-mem cannot turn that off, because it builds its request body with a fixed shape and never reads the `reasoning` field back.

---

## Why the proxy is necessary

claude-mem assembles the upstream request in `worker-service.cjs` like this:

```js
body: JSON.stringify({
  model: n, messages: s, temperature: .3, max_tokens: 4096,
  ...e.includes("openrouter.ai") ? {usage:{include:!0}} : {}
})
```

There is no hook for extra fields. Across the whole bundle:

```
reasoning_effort : 0 occurrences
reasoning        : 0 occurrences
```

The second zero is the one that bites. When a reasoning model puts its output in `reasoning` and leaves `content` empty, claude-mem sees nothing and logs:

```
[ERROR] [SDK] Empty response from OpenRouter
[ERROR] [SDK] Empty OpenRouter init response - session may lack context
```

Ollama Cloud *does* accept `reasoning_effort: "none"` — claude-mem just can't send it. So the proxy adds that one field and forwards everything else untouched.

### Measured on `deepseek-v4-flash:0731`

Same prompt (`Reply with exactly: OK`), same model:

| request | `reasoning` | `content` | completion tokens |
|---|---|---|---|
| as claude-mem sends it | 92 chars | `OK` | **27** |
| `"think": false` | 92 chars | `OK` | 27 — *silently ignored* |
| `"reasoning_effort": "none"` | 0 chars | `OK` | **2** |

13× fewer output tokens, and the empty-response failure mode disappears.

---

## Secret redaction

Everything in `messages` is scanned before it leaves the machine. `model`,
`temperature` and the rest of the body are never touched, and the
`Authorization` header is forwarded intact — the proxy strips secrets *out of
the conversation*, not out of your authentication.

Covered:

| category | examples |
|---|---|
| provider keys | Anthropic, OpenAI, GitHub (classic + fine-grained), GitLab, Slack, AWS, Google, Stripe, npm, OpenRouter |
| tokens | JWTs, `Authorization: Bearer …` pasted into text |
| private keys | any `-----BEGIN … PRIVATE KEY-----` block |
| connection strings | `scheme://user:pass@host`, including the password-only `redis://:pass@host` form |
| assignments | `.env`, JSON, YAML, TOML, INI, shell `export` |
| command lines | `mysql -p'…'`, `--password=…`, `curl -u user:pass` |
| markup | `<password>…</password>` and friends |
| prose | "the password is …", "пароль: …" |
| **seed phrases** | BIP-39 mnemonics, 12–24 words, in any layout |

Seed phrases get real treatment rather than a guess: the canonical 2048-word
BIP-39 list is embedded, and a run of twelve or more consecutive dictionary
words is redacted whatever the layout — plain, uppercase, comma-separated,
numbered, newline-separated, JSON array, or a markdown table row.

### What it deliberately does not touch

Over-redaction is the worse failure: it silently degrades every memory
claude-mem stores. So git SHAs, UUIDs, file paths, hex digests, version
numbers, `password: incorrect`, and ordinary prose that happens to contain
BIP-39 words are all left alone. The test suite asserts this explicitly.

### The placeholder

A secret is replaced, not deleted, so the surrounding structure survives and
the model still understands the shape of what it is reading:

```
AWS_SECRET_ACCESS_KEY=[SECRET:assigned-secret]
seed: [SECRET:seed-phrase]
DATABASE_URL=postgres://appuser:[SECRET:url-credentials]@db.internal:5432/app
```

Set `CMP_REDACT_PLACEHOLDER` to change it — `{type}` expands to the rule that
matched. `'SECRET'` or `'******'` work if you prefer something plainer.
`CMP_REDACT=false` disables redaction entirely.

Each request logs counts only, never values:

```
POST /v1/chat/completions -> 200 [reasoning_effort=none] [redacted: seed-phrase×1, url-credentials×1, assigned-secret×3]
```

---

## Tests

```bash
npm test          # all three suites
node test-redact.js   # unit — 51 cases, both "must redact" and "must not"
node test-smoke.js    # whole realistic documents, incl. a control with nothing to redact
node test-proxy.js    # integration — boots a fake upstream and the real proxy
```

The integration suite exists because it is the only one that catches a broken
server: the unit tests all passed once while a typo in the logging line was
crashing the proxy on every response.

---

## Requirements

- **Node.js 18+** on `PATH`. You already have it if `npx claude-mem install` worked.
- claude-mem installed, with `~/.claude-mem/settings.json` present.
- An Ollama API key from <https://ollama.com/settings/keys>.

The proxy binds to `127.0.0.1` only and has no dependencies. Your API key is forwarded upstream and never written to the log.

---

## Install

### macOS

```bash
git clone https://github.com/limeflash/claude-mem-ollama-proxy.git
cd claude-mem-ollama-proxy
./macos/install.sh
```

Installs the proxy to `~/.claude-mem-proxy`, registers a launchd **user agent** with `RunAtLoad` + `KeepAlive`, rewrites `~/.claude-mem/settings.json` (backing it up first) and restarts the worker.

### Windows

```powershell
git clone https://github.com/limeflash/claude-mem-ollama-proxy.git
cd claude-mem-ollama-proxy
.\windows\install.ps1
```

Same thing via a **Scheduled Task** with an at-logon trigger. No admin rights needed. If PowerShell blocks the script:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Options

```bash
./macos/install.sh --model gpt-oss:120b --port 11500
```
```powershell
.\windows\install.ps1 -Model "gpt-oss:120b" -Port 11500
```

Both installers are idempotent — re-run them to change the model or port.

---

## The API key

The installers do **not** touch `CLAUDE_MEM_OPENROUTER_API_KEY`. Either paste your Ollama key when `npx claude-mem install` asks for an "OpenRouter API key", or put it in `~/.claude-mem/settings.json` yourself:

```json
"CLAUDE_MEM_OPENROUTER_API_KEY": "<your ollama key>"
```

---

## Verify

```bash
# macOS
launchctl print gui/$(id -u)/com.claude-mem.ollama-proxy | grep -E 'state|pid'
tail -f ~/.claude-mem-proxy/proxy.log
```
```powershell
# Windows
Get-ScheduledTask -TaskName claude-mem-ollama-proxy
Get-Content "$env:USERPROFILE\.claude-mem-proxy\proxy.log" -Tail 20 -Wait
```

A healthy log line looks like:

```
2026-08-15T00:39:32.440Z POST /v1/chat/completions -> 200 [reasoning_effort=none]
```

Then confirm claude-mem is actually generating — not just that the service answers:

```bash
grep 'OpenRouter API usage' ~/.claude-mem/logs/claude-mem-*.log | tail -3
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
```

Note that claude-mem logs your own shell commands, so `grep -c 'Empty response'` over its log will count the grep itself. Anchor the pattern:

```bash
grep -cE '^\[.*\[ERROR\] \[SDK   \] Empty response' ~/.claude-mem/logs/claude-mem-*.log
```

---

## Does it survive a reboot?

**macOS** — yes, at *login*, not at boot. A LaunchAgent is per-user and starts when you log into your account. `KeepAlive` also restarts it if the process dies (verified: `kill -9` → new pid within ~10s). Boot-time start without login would need a LaunchDaemon running as root, which cannot read `~/.claude-mem`, so an agent is the right scope here.

**Windows** — same shape: the task triggers at logon, with `RestartCount 999` / `RestartInterval 1 minute`.

In both cases claude-mem itself only runs while your coding agent is running, so "at login" is early enough.

---

## Picking a model

Any model from `https://ollama.com/v1/models`. Current cloud line-up includes:

```
deepseek-v4-flash:0731    deepseek-v4-pro:preview   glm-5.2
kimi-k2.7-code            kimi-k3                   minimax-m3
gpt-oss:120b              qwen3.5:397b              nemotron-3-ultra
```

**The `-cloud` suffix is a CLI-only convention.** `ollama run deepseek-v4-flash:0731-cloud` works, but over the OpenAI-compatible API that tag does not exist — use `deepseek-v4-flash:0731`. Check the real list with:

```bash
curl -s https://ollama.com/v1/models | python3 -m json.tool
```

If you switch to a non-reasoning model, the proxy becomes harmless rather than useless — `reasoning_effort` is simply ignored.

---

## Uninstall

```bash
./macos/uninstall.sh
```
```powershell
.\windows\uninstall.ps1
```

Removes the autostart entry and points `CLAUDE_MEM_OPENROUTER_BASE_URL` back at `https://ollama.com/v1`.

---

## Troubleshooting

| symptom | cause |
|---|---|
| `401` in claude-mem log | base URL still points at `openrouter.ai`, or the key is not an Ollama key |
| `404` on every call | model name includes `-cloud`; drop the suffix |
| `502 proxy upstream error` | no network, or `ollama.com` unreachable |
| proxy log empty, claude-mem works | base URL not applied — restart the worker: `npx claude-mem restart` |
| port already in use | pass `--port` / `-Port` and re-run the installer |

claude-mem reads settings at worker start, so **always** `npx claude-mem restart` after editing `settings.json`.

---

## Configuration

Environment variables read by `proxy.js` (set by the installers):

| var | default | meaning |
|---|---|---|
| `CMP_PORT` | `11435` | local listen port |
| `CMP_HOST` | `127.0.0.1` | local bind address |
| `CMP_UPSTREAM` | `ollama.com` | upstream: bare host (HTTPS assumed) or a full URL |
| `CMP_REASONING_EFFORT` | `none` | value injected into each request |
| `CMP_REDACT` | `true` | set to `false` to disable secret redaction |
| `CMP_REDACT_PLACEHOLDER` | `[SECRET:{type}]` | replacement text; `{type}` = matching rule |

---

## License

MIT
