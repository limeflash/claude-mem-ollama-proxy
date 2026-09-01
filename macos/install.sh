#!/usr/bin/env bash
# Install the proxy as a launchd user agent and point claude-mem at it.
#
#   ./macos/install.sh                       # deepseek-v4-flash:0731
#   ./macos/install.sh --model gpt-oss:120b  # any Ollama Cloud model
#   ./macos/install.sh --port 11500
#
# Re-running is safe: the agent is reloaded and settings are rewritten.
set -euo pipefail

PORT=11435
MODEL="deepseek-v4-flash:0731"
LABEL="com.claude-mem.ollama-proxy"
DEST="$HOME/.claude-mem-proxy"
SETTINGS="$HOME/.claude-mem/settings.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --port)  PORT="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "error: node not found on PATH (brew install node)" >&2; exit 1; }
[ -f "$SETTINGS" ] || { echo "error: $SETTINGS not found — run 'npx claude-mem install' first" >&2; exit 1; }

echo "==> installing proxy to $DEST"
mkdir -p "$DEST"
# Every runtime module, tests excluded. A hardcoded list silently shipped a
# broken install once think.js was added: proxy.js required it, the installer
# did not copy it, and the agent died on MODULE_NOT_FOUND at launch.
for f in "$REPO_ROOT"/*.js; do
    base=$(basename "$f")
    case "$base" in test-*) continue ;; esac
    cp "$f" "$DEST/$base"
done

echo "==> writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$DEST/proxy.js</string>
    </array>
    <key>WorkingDirectory</key><string>$DEST</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$DEST/proxy.log</string>
    <key>StandardErrorPath</key><string>$DEST/proxy.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CMP_PORT</key><string>$PORT</string>
        <key>CMP_UPSTREAM</key><string>ollama.com</string>
        <key>CMP_REASONING_EFFORT</key><string>none</string>
    </dict>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null

echo "==> (re)loading launch agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# bootout only *starts* the teardown. Bootstrapping while the old service is
# still dying fails with "Bootstrap failed: 5: Input/output error", so wait for
# the label to actually disappear before loading the new one.
for _ in $(seq 1 50); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.2
done

launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2

echo "==> pointing claude-mem at the proxy"
cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
PORT="$PORT" MODEL="$MODEL" SETTINGS="$SETTINGS" python3 - <<'PY'
import json, os
p = os.environ["SETTINGS"]
d = json.load(open(p))
d["CLAUDE_MEM_PROVIDER"] = "openrouter"
d["CLAUDE_MEM_OPENROUTER_BASE_URL"] = f'http://127.0.0.1:{os.environ["PORT"]}/v1'
d["CLAUDE_MEM_OPENROUTER_MODEL"] = os.environ["MODEL"]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
print(f'  base URL = {d["CLAUDE_MEM_OPENROUTER_BASE_URL"]}')
print(f'  model    = {d["CLAUDE_MEM_OPENROUTER_MODEL"]}')
PY

if [ -z "$(python3 -c "import json,os;print(json.load(open('$SETTINGS'))['CLAUDE_MEM_OPENROUTER_API_KEY'])")" ]; then
    echo
    echo "WARNING: CLAUDE_MEM_OPENROUTER_API_KEY is empty."
    echo "Put your Ollama key (https://ollama.com/settings/keys) into $SETTINGS"
fi

echo "==> restarting claude-mem worker"
npx --yes claude-mem restart >/dev/null 2>&1 || echo "  (could not restart automatically — run 'npx claude-mem restart')"

echo
echo "Done. Verify with:"
echo "  launchctl print gui/$(id -u)/$LABEL | grep -E 'state|pid'"
echo "  tail -f $DEST/proxy.log"
