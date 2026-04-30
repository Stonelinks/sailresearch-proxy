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

| Window | Mode | Behavior | Default timeout |
|--------|------|----------|----------------|
| `asap` | Passthrough | Forwards to Sail synchronously on latency-optimized hardware. Premium pricing. | N/A (sync) |
| `priority` | Batching | Scheduled, ~1–2 min target. For agent loops where latency compounds. | 5 min |
| `standard` | Batching | Scheduled, ~5 min target. **Default.** | 15 min |
| `flex` | Batching | Best-effort, off-peak. Cheapest, no SLO. | 60 min |

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

You can also use [window-prefixed routes](#window-prefixed-routes) to pin a client to a specific window via the base URL.

## Window-Prefixed Routes

Every `/v1/*` endpoint is also available under a window prefix, so you can pin a client to a specific completion window without modifying request bodies or headers:

```
/asap/v1/chat/completions
/priority/v1/chat/completions
/standard/v1/chat/completions
/flex/v1/chat/completions
/asap/v1/models
/flex/v1/models
...etc
```

The easiest way to use this is to point your OpenAI client at the prefixed base URL:

```python
from openai import OpenAI

# All requests use the flex window automatically — no extra config needed
client = OpenAI(base_url="http://localhost:4000/flex/v1", api_key="anything")

response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

**Resolution order** (highest priority first):

1. URL prefix (e.g. `/flex/v1/...`)
2. `X-Completion-Window` header
3. `metadata.completion_window` in the request body
4. `DEFAULT_COMPLETION_WINDOW` config (defaults to `standard`)

## API Compatibility

**Endpoints:**

- `POST /v1/chat/completions` — chat completions (sync and streaming)
- `POST /<window>/v1/chat/completions` — same, with window prefilled (e.g. `/flex/v1/chat/completions`)
- `POST /v1/messages` — Anthropic Messages API (Alpha)
- `POST /<window>/v1/messages` — same, with window prefilled
- `GET /v1/models` — list available models
- `GET /<window>/v1/models` — same, with window prefilled
- `GET /health` — health check

**Field remapping:**

- `max_tokens` is automatically remapped to `max_completion_tokens` (Sail does not accept the deprecated field)
- `stream` is handled by the proxy — Sail receives a non-streaming request regardless
- In batching mode, the OpenAI chat format is transformed to Sail's Responses API format and the result is transformed back

**Supported features:** temperature, top_p, tools/tool_choice, response_format (json_schema, json_object), reasoning_effort, user, **image input**.

## Image Input

Send images to multimodal models via the OpenAI `image_url` content part or the Anthropic `image` content block. Images are accepted as HTTP(S) URLs or base64 data URIs.

**Supported models:** See [Sail's supported models](https://docs.sailresearch.com/supported-models) for multimodal capability flags. Currently `moonshotai/Kimi-K2.5`.

**Limits:** Max 20 images per request, max 20 MB per image. Formats: JPEG, PNG, WebP, GIF.

### OpenAI format (chat completions)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4000/v1", api_key="anything")

response = client.chat.completions.create(
    model="moonshotai/Kimi-K2.5",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What's in this image?"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "https://example.com/cat.jpg",
                        "detail": "auto",  # optional: "auto" | "low" | "high"
                    },
                },
            ],
        }
    ],
)
```

Data URIs are also accepted:

```python
import base64

b64 = base64.b64encode(open("cat.jpg", "rb").read()).decode()
response = client.chat.completions.create(
    model="moonshotai/Kimi-K2.5",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image"},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }
    ],
)
```

### Anthropic format (messages)

```python
import anthropic

client = anthropic.Anthropic(
    auth_token="your-sail-api-key",  # Use auth_token, not api_key
    base_url="http://localhost:4000",
)

# URL source
response = client.messages.create(
    model="moonshotai/Kimi-K2.5",
    max_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": "https://example.com/cat.jpg"}},
                {"type": "text", "text": "What's in this image?"},
            ],
        }
    ],
)

# Base64 source
response = client.messages.create(
    model="moonshotai/Kimi-K2.5",
    max_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
                },
                {"type": "text", "text": "What's in this image?"},
            ],
        }
    ],
)
```

**How it works:** In passthrough mode (`asap`), image content parts are forwarded to Sail's native API as-is. In batching mode (`priority`/`standard`/`flex`), the proxy transforms OpenAI `image_url` and Anthropic `image` blocks into Sail's `input_image` format for the Responses API.

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
| `TIMEOUT_PRIORITY_MS` | `300000` | Max wait for `priority` jobs (5 min) |
| `TIMEOUT_STANDARD_MS` | `900000` | Max wait for `standard` jobs (15 min) |
| `TIMEOUT_FLEX_MS` | `3600000` | Max wait for `flex` jobs (60 min) |
| `POLL_INTERVAL_MS` | `1000` | Poller tick interval |
| `MAX_CONCURRENT_POLLS` | `10` | Max concurrent poll requests to Sail |
| `STREAM_CHUNK_SIZE` | `20` | Approximate characters per simulated SSE chunk |
| `LOG_LEVEL` | `info` | Verbosity: `debug` / `info` / `warn` / `error` |
| `DATABASE_URL` | `file:$PROJECT_ROOT/data/proxy.db` | SQLite database path |

## Testing

```bash
source env.sh
check               # format + typecheck + unit tests
test-integration     # live tests against Sail API
```

The integration test suite starts an isolated proxy on a random port, runs tests covering passthrough, batching, streaming, the Python `openai` client, image input, and error handling, then tears down.

## Architecture

The proxy has two modes based on completion window:

- **Passthrough** (`asap`): Forwards directly to Sail's `/v1/chat/completions` or `/v1/messages` endpoint. Synchronous round-trip. Image content parts are forwarded as-is.
- **Batching** (`priority` / `standard` / `flex`): Submits to Sail's `/v1/responses` API with `background: true`, persists the job handle to SQLite via Prisma, and polls with exponential backoff until the result is ready. The HTTP connection is held open until completion or timeout. Each window has its own timeout (5 min / 15 min / 60 min by default), so the proxy returns a 504 quickly for latency-sensitive windows while giving flex jobs ample time. OpenAI `image_url` and Anthropic `image` content blocks are transformed to Sail's `input_image` format.

SQLite persistence means in-flight jobs survive proxy restarts. On startup, the poller resumes polling any incomplete jobs from the previous run. Jobs that exceed their window-specific timeout are automatically expired by the poller, even if they were orphaned by a restart.

Built with Bun, TypeScript, and Prisma. No frameworks.
