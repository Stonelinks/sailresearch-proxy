# sailresearch-proxy

A thin completion-window injector for [Sail Research](https://docs.sailresearch.com/), plus a model-research pipeline and a `models.json` generator for the [pi coding agent](https://pi.dev/).

> **Status: downscoped.** This project used to be a full translation/batching proxy: it converted OpenAI-shaped requests into Sail's async batch API, polled for results, and simulated SSE streaming. Sail now supports all of that natively — `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` accept `metadata.completion_window` directly and stream real SSE on every window. If your client can set a request-body field, **you don't need this proxy**; point it straight at `https://api.sailresearch.com/v1`.
>
> The proxy remains for one reason: pi's `models.json` cannot inject custom request-body fields (verified through pi 0.82.x — providers support custom headers only, and Sail reads the window from the body). So this proxy keeps the window-prefixed routes (`/flex/v1/...`) that pi providers can target via `baseUrl`, injects `metadata.completion_window`, and forwards everything else to Sail verbatim.

What it does today:

1. **Window injection** — `/{asap|priority|standard|flex}/v1/{chat/completions,messages,responses}` sets `metadata.completion_window` and forwards to Sail unchanged (streaming included, no retries, no persistence).
2. **Model research** — scrapes Sail's docs for capabilities/pricing, uses an embedded pi session to research sampling presets/context sizes, smoke-tests presets and window support, and stores the results in SQLite (browse/refresh via the dashboard).
3. **`generate-models-json`** — emits a pi `models.json` with one provider per completion window, enriched with researched pricing, presets, context windows, and thinking-level maps.

## Setup

```bash
cp secrets.sh.example secrets.sh   # add your SAIL_API_KEY
source env.sh
setup
```

## Running

```bash
source env.sh
dev       # watch mode
run       # production
```

The proxy listens on `http://0.0.0.0:4000` by default.

## Usage

Point any OpenAI-compatible client at the proxy:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4000/v1", api_key="anything")

response = client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Hello!"}],
)

# Streaming (forwarded verbatim from Sail's native SSE)
stream = client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Or use the Anthropic SDK:

```python
from anthropic import Anthropic

client = Anthropic(
    auth_token="your-sail-api-key",  # Use auth_token, not api_key
    base_url="http://localhost:4000/asap",
)

response = client.messages.create(
    model="openai/gpt-oss-120b",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Completion Windows

Sail schedules each request according to `metadata.completion_window`; cheaper windows may take minutes to serve. See https://docs.sailresearch.com/completion-windows for tiers and pricing. **Window support varies per model** — Sail returns a structured 400 naming the supported windows when a model doesn't offer the requested one. `GET /v1/models` on this proxy includes researched `x_supported_windows` per model.

The proxy resolves the window in this order (highest priority first):

1. URL prefix (e.g. `/flex/v1/...`)
2. `X-Completion-Window` header
3. `metadata.completion_window` in the request body
4. `DEFAULT_COMPLETION_WINDOW` config (defaults to `standard`)

The resolved window is always written into `metadata.completion_window` before forwarding.

### Window-prefixed routes

Every `/v1/*` endpoint is also available under a window prefix, so a client that can only set a base URL (like pi) can still pin a window:

```
/asap/v1/chat/completions
/priority/v1/messages
/flex/v1/responses
/asap/v1/models        # filters the model list to that window
...etc
```

```python
# All requests use the flex window automatically — no extra config needed
client = OpenAI(base_url="http://localhost:4000/flex/v1", api_key="anything")
```

## API Compatibility

| Endpoint | Behavior |
|----------|----------|
| `POST /v1/chat/completions` | Forwarded verbatim (+ window injection) |
| `POST /v1/messages` | Forwarded verbatim (+ window injection, small field strip) |
| `POST /v1/responses` | Forwarded verbatim (+ window injection) |
| `GET /v1/models` | Sail's list enriched with researched metadata from the local DB |
| `GET /health`, `GET /api/version` | Local |
| `POST /graphql` (+ WS) | Dashboard API (models + research) |

Bodies, streams, status codes, and error payloads pass through unmodified, with two small normalizations for fields Sail still rejects (verified against the live API, 2026-07):

- chat completions: `store: false` is dropped (Sail always stores; `store: true` passes through)
- messages: `top_k`, `stop_sequences`, `service_tier`, `inference_geo` are dropped

Everything else — `system`, `tools`, `thinking`, `stream`, `stream_options`, `max_tokens`, `prompt_cache_key`, image content parts — is now supported natively by Sail and forwarded untouched.

**Auth:** the proxy accepts both `Authorization: Bearer <key>` and `x-api-key: <key>` when `PROXY_API_KEY` is set, and always uses its own `SAIL_API_KEY` upstream.

**Timeouts:** the proxy applies no timeout of its own to forwarded requests; the client's disconnect aborts the upstream call. Bun's HTTP server caps *idle* time at 255 s, so use `stream: true` for batched windows — Sail's SSE (including `ping` events on `/v1/messages`) keeps the connection non-idle. A non-streaming request that sits silent past 255 s will be cut.

## Model Research

The research pipeline populates the SQLite DB behind `/v1/models` enrichment and `generate-models-json`:

- `src/docs-scraper.ts` — deterministic scrapers for `docs.sailresearch.com/models.md` (capabilities) and `/pricing.md` (per-window pricing)
- `src/research-models.ts` + `src/graphql/research-models-runner.ts` — pi-driven research (context size, sampling presets, thinking levels), preset smoke tests, and window-compatibility smoke tests (now exercising Sail's native windows through the injector)
- `bin/research-models` — CLI (requires the proxy running); also available from the dashboard via **Refetch** / **Research All**

## Pi models.json Generation

```bash
source env.sh
generate-models-json                 # reads the proxy's enriched /v1/models
generate-models-json --smoke-test    # additionally validates presets via live requests
```

Emits providers `sail-asap` / `sail-priority` / `sail-standard` / `sail-flex` (plus a `sail` alias for standard), each pointing at the corresponding window-prefixed proxy URL, with per-window pricing and per-model presets. Output follows pi's models.json spec: https://pi.dev/docs/latest/models

## Dashboard

`http://localhost:4000/` serves the Models dashboard: researched metadata, per-window pricing, sampling presets, and research controls with live progress (GraphQL subscriptions over WebSocket).

## Reverse Proxy Configuration

When deploying behind a reverse proxy (nginx, Caddy, etc.), allow long-lived connections — batched windows can take minutes to start returning bytes:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_read_timeout 7200s;    # ≥ your slowest expected flex job
    proxy_buffering off;         # SSE chunks reach the client immediately
    proxy_cache off;
    proxy_set_header Connection '';
    chunked_transfer_encoding off;
}
```

Use `stream: true` for batched requests behind a reverse proxy so Sail's SSE traffic keeps the connection alive.

## Scripts

All scripts are in `bin/` and available on `PATH` after `source env.sh`.

| Script | Description |
|--------|-------------|
| `setup` | Install dependencies, generate Prisma client, apply migrations |
| `dev` / `run` | Start proxy (watch / production) |
| `check` | codegen + format + typecheck + tests (backend + frontend) |
| `format`, `format-ts`, `format-shell` | Formatters |
| `typecheck` | `tsc --noEmit` |
| `test` | Backend tests; live integration tests run when a real `SAIL_API_KEY` is sourced |
| `research-models` | Run model research against a running proxy |
| `generate-models-json` | Emit pi models.json from the proxy's enriched `/v1/models` |
| `pi-setup` | Write a local pi provider config pointing at the proxy |
| `db-studio` | Open Prisma Studio |
| `publish` | Build and push Docker image to registry |

## Docker Deployment

The proxy runs as a single Docker image with an embedded SQLite database. The container applies committed Prisma migrations on start.

```bash
docker run -d \
  --name sailresearch-proxy \
  -p 4000:4000 \
  -e SAIL_API_KEY=sk-sail-... \
  -v sailresearch-proxy-data:/app/data \
  --restart unless-stopped \
  containers.cricket.routers.stonelinks.org/sailresearch-proxy:latest
```

Optional: set `PROXY_API_KEY` to require client auth. A `docker-compose.yaml` is included (`cp .env.docker .env`, add your key, `docker compose up -d`). Publish a new image with `publish [--version vX.Y.Z]`.

## Configuration

**`secrets.sh`** (gitignored, created from `secrets.sh.example`): `SAIL_API_KEY` (required), `PROXY_API_KEY` (optional), `CONTAINER_REG_*` (for `publish`).

| Variable | Default | Description |
|----------|---------|-------------|
| `SAIL_BASE_URL` | `https://api.sailresearch.com/v1` | Sail API base URL |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Listen address |
| `DEFAULT_COMPLETION_WINDOW` | `standard` | Window when the client specifies none |
| `TIMEOUT_PRIORITY_MS` / `TIMEOUT_STANDARD_MS` / `TIMEOUT_FLEX_MS` | 5 min / 30 min / 2 h | Client-side caps for research window smoke tests |
| `RESEARCH_WINDOW` | `asap` | Window used for research LLM calls |
| `MAX_CONCURRENT_RESEARCH` | `5` | Parallel model-research bound |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `DATABASE_URL` | `file:$PROJECT_ROOT/data/proxy.db` | SQLite database path |

## Testing

```bash
source env.sh
check                # codegen + format + typecheck + tests
SAIL_SLOW_INTEGRATION=1 bin/test   # also test batched windows (minutes each)
```

`src/integration.test.ts` starts an isolated proxy on a random port with a temp SQLite DB and covers all three API surfaces, streaming, the Python `openai`/`anthropic` SDKs (via `uvx`), a pi CLI smoke test, and image input. Batched-window tests discover a model supporting each window at runtime (support varies) and skip windows no model currently offers. The suite skips automatically when `SAIL_API_KEY` is unset or the placeholder `test`.

## Architecture

Single Bun process, no frameworks:

- `src/app.ts` — `Bun.serve` routing: window-prefix rewrite → forwarder routes, `/v1/models`, GraphQL (HTTP + WS), static dashboard
- `src/services/forward.ts` — the thin forwarder: normalize body, inject window, `fetch` Sail, stream the response back verbatim
- `src/models-meta.ts` + Prisma (`ModelMeta`/`ModelPrice`/`SamplingPreset`) — researched enrichment for `/v1/models`
- `src/research-models*.ts`, `src/docs-scraper.ts`, `src/pi-session.ts` — the research pipeline
- `src/generate-models-json.ts` — pi models.json emitter
- `frontend/` — Svelte 5 + Houdini dashboard (Models pages)
