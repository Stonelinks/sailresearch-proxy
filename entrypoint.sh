#!/bin/sh
set -e

# Set up pi SDK config (models.json + auth.json) if not already present
# This is needed in Docker where ~/.pi/agent/ doesn't exist yet
PI_DIR="${PI_DIR:-$HOME/.pi/agent}"
BASE_URL="${PI_SAIL_BASE_URL:-http://localhost:4000/v1}"
API_KEY="${PI_SAIL_API_KEY:-${SAIL_API_KEY:-}}"

mkdir -p "$PI_DIR"

# Write models.json with sail-standard provider if it doesn't have one
if [ ! -f "$PI_DIR/models.json" ] || ! grep -q 'sail-standard' "$PI_DIR/models.json" 2>/dev/null; then
  echo "[entrypoint] Writing $PI_DIR/models.json with sail-standard provider → $BASE_URL"
  # Use a simple approach: if python3 exists, merge; otherwise overwrite
  if command -v python3 >/dev/null 2>&1 && [ -f "$PI_DIR/models.json" ]; then
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
providers = d.setdefault('providers', {})
providers['sail-standard'] = {
    'baseUrl': sys.argv[2],
    'api': 'openai-completions',
    'apiKey': 'sail',
    'models': []
}
providers['sail'] = providers['sail-standard']
with open(sys.argv[1], 'w') as f:
    json.dump(d, f, indent=2)
" "$PI_DIR/models.json" "$BASE_URL"
  else
    cat > "$PI_DIR/models.json" <<MODELS_EOF
{
  "providers": {
    "sail-standard": {
      "baseUrl": "${BASE_URL}",
      "api": "openai-completions",
      "apiKey": "sail",
      "models": []
    },
    "sail": {
      "baseUrl": "${BASE_URL}",
      "api": "openai-completions",
      "apiKey": "sail",
      "models": []
    }
  }
}
MODELS_EOF
  fi
fi

# Write auth.json with API key if it doesn't have sail-standard
if [ ! -f "$PI_DIR/auth.json" ] || ! grep -q 'sail-standard' "$PI_DIR/auth.json" 2>/dev/null; then
  if [ -n "$API_KEY" ]; then
    echo "[entrypoint] Writing $PI_DIR/auth.json with sail-standard API key"
    if command -v python3 >/dev/null 2>&1 && [ -f "$PI_DIR/auth.json" ]; then
      python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
d['sail-standard'] = sys.argv[2]
d['sail'] = sys.argv[2]
with open(sys.argv[1], 'w') as f:
    json.dump(d, f, indent=2)
" "$PI_DIR/auth.json" "$API_KEY"
    else
      cat > "$PI_DIR/auth.json" <<AUTH_EOF
{
  "sail-standard": "${API_KEY}",
  "sail": "${API_KEY}"
}
AUTH_EOF
      chmod 600 "$PI_DIR/auth.json"
    fi
  else
    echo "[entrypoint] WARNING: No API key set (PI_SAIL_API_KEY or SAIL_API_KEY). pi SDK calls may fail."
  fi
fi

# Run prisma db push to ensure schema is up to date (SQLite auto-creates the file)
bunx prisma db push --skip-generate
bunx prisma generate

exec bun run src/index.ts
