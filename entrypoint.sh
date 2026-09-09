#!/bin/sh
set -e

# Set up pi SDK config (models.json + auth.json) if not already present
# This is needed in Docker where ~/.pi/agent/ doesn't exist yet
PI_DIR="${PI_DIR:-$HOME/.pi/agent}"
BASE_URL="${PI_SAIL_BASE_URL:-http://localhost:4000/v1}"
API_KEY="${PI_SAIL_API_KEY:-${SAIL_API_KEY:-}}"

# `sail` targets the bare /v1 route (the proxy's DEFAULT_COMPLETION_WINDOW);
# `sail-balanced` pins the balanced window explicitly.
HOST_URL="${BASE_URL%/}"
HOST_URL="${HOST_URL%/v1}"
BALANCED_URL="${HOST_URL}/balanced/v1"

mkdir -p "$PI_DIR"

# Write models.json with sail provider if it doesn't have one
if [ ! -f "$PI_DIR/models.json" ] || ! grep -q 'sail' "$PI_DIR/models.json" 2>/dev/null; then
  echo "[entrypoint] Writing $PI_DIR/models.json with sail provider → $BASE_URL"
  # Use a simple approach: if python3 exists, merge; otherwise overwrite
  if command -v python3 >/dev/null 2>&1 && [ -f "$PI_DIR/models.json" ]; then
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
providers = d.setdefault('providers', {})
base = sys.argv[2].rstrip('/')
if base.endswith('/v1'):
    base = base[:-3]
providers['sail'] = {
    'baseUrl': base + '/v1',
    'api': 'openai-completions',
    'apiKey': 'sail',
    'models': []
}
providers['sail-balanced'] = {
    'baseUrl': base + '/balanced/v1',
    'api': 'openai-completions',
    'apiKey': 'sail',
    'models': []
}
with open(sys.argv[1], 'w') as f:
    json.dump(d, f, indent=2)
" "$PI_DIR/models.json" "$BASE_URL"
  else
    cat > "$PI_DIR/models.json" <<MODELS_EOF
{
  "providers": {
    "sail": {
      "baseUrl": "${BASE_URL}",
      "api": "openai-completions",
      "apiKey": "sail",
      "models": []
    },
    "sail-balanced": {
      "baseUrl": "${BALANCED_URL}",
      "api": "openai-completions",
      "apiKey": "sail",
      "models": []
    }
  }
}
MODELS_EOF
  fi
fi

# Write auth.json with API key if it doesn't have sail
if [ ! -f "$PI_DIR/auth.json" ] || ! grep -q 'sail' "$PI_DIR/auth.json" 2>/dev/null; then
  if [ -n "$API_KEY" ]; then
    echo "[entrypoint] Writing $PI_DIR/auth.json with sail API key"
    if command -v python3 >/dev/null 2>&1 && [ -f "$PI_DIR/auth.json" ]; then
      python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
d['sail'] = sys.argv[2]
d['sail-balanced'] = sys.argv[2]
with open(sys.argv[1], 'w') as f:
    json.dump(d, f, indent=2)
" "$PI_DIR/auth.json" "$API_KEY"
    else
      cat > "$PI_DIR/auth.json" <<AUTH_EOF
{
  "sail": "${API_KEY}",
  "sail-balanced": "${API_KEY}"
}
AUTH_EOF
      chmod 600 "$PI_DIR/auth.json"
    fi
  else
    echo "[entrypoint] WARNING: No API key set (PI_SAIL_API_KEY or SAIL_API_KEY). pi SDK calls may fail."
  fi
fi

# Apply committed migrations (SQLite auto-creates the file)
bunx prisma migrate deploy
bunx prisma generate

exec bun run src/index.ts
