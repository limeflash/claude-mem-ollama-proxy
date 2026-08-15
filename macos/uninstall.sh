#!/usr/bin/env bash
# Remove the launch agent and point claude-mem straight back at Ollama Cloud.
set -euo pipefail

LABEL="com.claude-mem.ollama-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SETTINGS="$HOME/.claude-mem/settings.json"

echo "==> unloading launch agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

if [ -f "$SETTINGS" ]; then
    echo "==> restoring direct upstream in claude-mem settings"
    cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
    SETTINGS="$SETTINGS" python3 - <<'PY'
import json, os
p = os.environ["SETTINGS"]
d = json.load(open(p))
d["CLAUDE_MEM_OPENROUTER_BASE_URL"] = "https://ollama.com/v1"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
print("  base URL = https://ollama.com/v1")
PY
    npx --yes claude-mem restart >/dev/null 2>&1 || true
fi

echo "==> done (proxy files left in ~/.claude-mem-proxy — remove manually if you want)"
