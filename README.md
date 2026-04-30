# sailresearch-proxy

OpenAI-compatible proxy for [Sail Research](https://docs.sailresearch.com/). Translates standard `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` requests into Sail's async completion window API, letting any OpenAI, Anthropic, or Sail-native client use Sail without modification.

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

Or use the Anthropic SDK:

```python
from anthropic import Anthropic

client = Anthropic(
    auth_token="your-sail-api-key",  # Use auth_token, not api_key
    base_url="http://localhost:4000",
)

response = client.messages.create(
    model="deepseek-ai/DeepSeek-V3.2",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

Or call the Sail Responses API directly:

```python
import requests

response = requests.post(
    "http://localhost:4000/v1/responses",
    headers={
        "Authorization": "Bearer your-sail-api-key",
        "Content-Type": "application/json",
    },
    json={
        "model": "deepseek-ai/DeepSeek-V3.2",
        "input": "Hello!",
    },
)
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

Streaming is supported for chat completions in all modes. Since Sail does not support server-sent events natively, the proxy receives the complete response and emits simulated SSE chunks.

You can also use [window-prefixed routes](#window-prefixed-routes) to pin a client to a specific window via the base URL.

## Window-Prefixed Routes

Every `/v1/*` endpoint is also available under a window prefix, so you can pin a client to a specific completion window without modifying request bodies or headers:

```
/asap/v1/chat/completions
/priority/v1/chat/completions
/standard/v1/chat/completions
/flex/v1/chat/completions
/asap/v1/messages
/flex/v1/messages
/asap/v1/responses
/flex/v1/responses
/asap/v1/models
/flex/v1/models
...etc
```

The easiest way to use this is to point your client at the prefixed base URL:

```python
from openai import OpenAI

# All requests use the flex window automatically — no extra config needed
client = OpenAI(base_url="http://localhost:4000/flex/v1", api_key="anything")

response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3.2",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

```python
from anthropic import Anthropic

# All Anthropic requests use the flex window
client = Anthropic(
    auth_token="your-sail-api-key",
    base_url="http://localhost:4000/flex",
)

response = client.messages.create(
    model="deepseek-ai/DeepSeek-V3.2",
    max_tokens=1024,
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

| Endpoint | Description | Maturity |
|----------|-------------|----------|
| `POST /v1/chat/completions` | OpenAI Chat Completions (sync and streaming) | Full support |
| `POST /v1/messages` | Anthropic Messages API | Full support (passthrough + batching) |
| `POST /v1/responses` | Sail Responses API (native) | Full support (passthrough + batching) |
| `GET /v1/models` | List available models | Full support |
| `GET /health` | Health check | — |

All endpoints also support window-prefixed variants (e.g. `/flex/v1/chat/completions`).

**Field remapping:**

- `max_tokens` is automatically remapped to `max_completion_tokens` for chat completions (Sail does not accept the deprecated field)
- `stream` is handled by the proxy — Sail receives a non-streaming request regardless
- In batching mode, chat completions and messages are transformed to Sail's Responses API format and the result is transformed back

**Supported features:** temperature, top_p, tools/tool_choice, response_format (json_schema, json_object), reasoning_effort, user, **image input**.

### Chat Completions

Full OpenAI Chat Completions compatibility. Supports all completion windows, streaming, tools, structured outputs, and image input.

### Anthropic Messages

The proxy accepts Anthropic Messages API requests at `POST /v1/messages`. This works with the official Anthropic SDK:

- **`asap` window:** Forwards directly to Sail's native `/v1/messages` endpoint. No format transformation needed.
- **Batched windows** (`priority`/`standard`/`flex`): Transforms the request to Sail's Responses API format, submits with `background: true`, polls until complete, then transforms the result back to Anthropic Messages format. Jobs appear on the dashboard with `apiType: "messages"`.

**Auth:** The proxy accepts both `Authorization: Bearer <key>` and `x-api-key: <key>` headers. Use `auth_token` (not `api_key`) when initializing the Anthropic SDK:

```python
client = Anthropic(
    auth_token="your-sail-api-key",  # sends Authorization: Bearer
    base_url="http://localhost:4000",
)
```

**Unsupported fields stripped automatically:** `system`, `thinking`, `tools`, `tool_choice`, `stop_sequences`, `top_k`, `stream`, `service_tier`, `inference_geo`. These are not supported by Sail's Messages API (Alpha) and will be removed from the request before forwarding.

### Responses API

The proxy supports Sail's native Responses API at `POST /v1/responses`. This is Sail's primary/stable API surface.

- **`asap` window:** Forwards directly to Sail's `/v1/responses`.
- **Batched windows:** Submits with `background: true`, creates a `pendingJob` with `apiType: "responses"`, polls until complete, returns the Responses API result as-is. No format transformation needed.

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

## Dashboard

The built-in dashboard at `http://localhost:4000/dashboard` shows all batched jobs with their status, model, completion window, and timing. Each job's `apiType` field indicates which API surface was used:

| `apiType` | API Surface |
|-----------|-------------|
| `chat-completions` | OpenAI Chat Completions (`/v1/chat/completions`) |
| `messages` | Anthropic Messages (`/v1/messages`) |
| `responses` | Sail Responses API (`/v1/responses`) |

The dashboard API is available at `GET /api/dashboard/jobs`.

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

The integration test suite starts an isolated proxy on a random port, runs tests covering passthrough, batching, streaming, the Python `openai` and `anthropic` clients (via `uvx`), the Responses API, image input, and error handling, then tears down.

Set `SAIL_SLOW_INTEGRATION=1` to also test batched windows (priority/standard/flex), which wait for Sail to process and can take several minutes each.

## Architecture

The proxy supports three API surfaces, all with both passthrough and batching modes:

- **Passthrough** (`asap`): Forwards directly to the corresponding Sail endpoint (`/v1/chat/completions`, `/v1/messages`, or `/v1/responses`). Synchronous round-trip. Image content parts are forwarded as-is.
- **Batching** (`priority` / `standard` / `flex`): Submits to Sail's `/v1/responses` API with `background: true`, persists the job handle to SQLite via Prisma, and polls with exponential backoff until the result is ready. The HTTP connection is held open until completion or timeout. Each window has its own timeout (5 min / 15 min / 60 min by default), so the proxy returns a 504 quickly for latency-sensitive windows while giving flex jobs ample time.

For chat completions and messages, the proxy transforms the request to Sail's Responses API format and transforms the result back. For the Responses API, no transformation is needed — the body is submitted as-is.

OpenAI `image_url` and Anthropic `image` content blocks are transformed to Sail's `input_image` format when going through the batching path.

SQLite persistence means in-flight jobs survive proxy restarts. On startup, the poller resumes polling any incomplete jobs from the previous run. Jobs that exceed their window-specific timeout are automatically expired by the poller, even if they were orphaned by a restart.

Built with Bun, TypeScript, and Prisma. No frameworks.
