# sailresearch-proxy

OpenAI-compatible proxy for [Sail Research](https://docs.sailresearch.com/). Translates standard `/v1/chat/completions` requests into Sail's async completion window API, letting any OpenAI client use Sail without modification.

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

# Synchronous
response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[{"role": "user", "content": "Hello!"}],
)

# Streaming
stream = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

## Completion Windows

Control the latency/cost tradeoff via `metadata.completion_window` in the request body, or the `X-Completion-Window` header. See https://docs.sailresearch.com/completion-windows for tier details.

| Window | Mode | Behavior |
|--------|------|----------|
| `asap` | Passthrough | Forwards to Sail synchronously on latency-optimized hardware. Premium pricing. |
| `priority` | Batching | Scheduled, ~1–2 min target. For agent loops where latency compounds. |
| `standard` | Batching | Scheduled, ~5 min target. **Default.** |
| `flex` | Batching | Best-effort, off-peak. Cheapest, no SLO. |

```python
# Fast (passthrough)
client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[...],
    extra_body={"metadata": {"completion_window": "asap"}},
)

# Cheap (batching)
client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[...],
    extra_body={"metadata": {"completion_window": "flex"}},
)
```

Streaming is supported in all modes. Since Sail does not support server-sent events natively, the proxy receives the complete response and emits simulated SSE chunks.

## API Compatibility

**Endpoints:**

- `POST /v1/chat/completions` — chat completions (sync and streaming)
- `GET /v1/models` — list available models
- `GET /health` — health check

**Field remapping:**

- `max_tokens` is automatically remapped to `max_completion_tokens` (Sail does not accept the deprecated field)
- `stream` is handled by the proxy — Sail receives a non-streaming request regardless
- In batching mode, the OpenAI chat format is transformed to Sail's Responses API format and the result is transformed back

**Supported features:** temperature, top_p, tools/tool_choice, response_format (json_schema, json_object), reasoning_effort, user.

## Scripts

All scripts are in `bin/` and available on `PATH` after `source env.sh`.

| Script | Description |
|--------|-------------|
| `setup` | Install dependencies, generate Prisma client, push DB schema |
| `dev` | Start proxy in watch mode |
| `run` | Start proxy |
| `check` | Run format + typecheck + test |
| `format` | Run all formatters (format-ts + format-shell) |
| `format-ts` | Prettier on TypeScript files |
| `format-shell` | shfmt on all bash scripts |
| `typecheck` | `tsc --noEmit` |
| `test` | Unit tests (`bun test`) |
| `test-integration` | Live integration tests against Sail API (requires `SAIL_API_KEY`) |
| `db-push` | Push Prisma schema to SQLite |
| `db-studio` | Open Prisma Studio |

## Configuration

**`secrets.sh`** (gitignored, created from `secrets.sh.example`):

- `SAIL_API_KEY` — Sail Research API key (required)
- `PROXY_API_KEY` — optional key to protect the proxy itself

**Environment variables** (set in `env.sh` or override via shell):

| Variable | Default | Description |
|----------|---------|-------------|
| `SAIL_BASE_URL` | `https://api.sailresearch.com/v1` | Sail API base URL |
| `PORT` | `4000` | Proxy listen port |
| `HOST` | `0.0.0.0` | Proxy listen host |
| `DEFAULT_COMPLETION_WINDOW` | `standard` | Default window when not specified by client |
| `MAX_POLL_DURATION_MS` | `900000` | Max time to hold connection open for batching (15 min) |
| `POLL_INTERVAL_MS` | `1000` | Poller tick interval |
| `MAX_CONCURRENT_POLLS` | `10` | Max concurrent poll requests to Sail |
| `STREAM_CHUNK_SIZE` | `20` | Approximate characters per simulated SSE chunk |
| `DATABASE_URL` | `file:$PROJECT_ROOT/data/proxy.db` | SQLite database path |

## Testing

```bash
source env.sh
check               # format + typecheck + unit tests
test-integration     # live tests against Sail API
```

The integration test suite starts an isolated proxy on port 4111, runs 16 tests covering passthrough, batching, streaming, the Python `openai` client, and error handling, then tears down.

## Architecture

The proxy has two modes based on completion window:

- **Passthrough** (`asap`): Forwards directly to Sail's `/v1/chat/completions` endpoint. Synchronous round-trip.
- **Batching** (`priority` / `standard` / `flex`): Submits to Sail's `/v1/responses` API with `background: true`, persists the job handle to SQLite via Prisma, and polls with exponential backoff until the result is ready. The HTTP connection is held open until completion or timeout.

SQLite persistence means in-flight jobs survive proxy restarts. On startup, the poller resumes polling any incomplete jobs from the previous run.

Built with Bun, TypeScript, and Prisma. No frameworks.
