# indiankanoon-mcp

An MCP server for the [Indian Kanoon API](https://api.indiankanoon.org/). It lets Claude, Codex, Cursor, ChatGPT and other MCP clients search Indian judgments, statutes and tribunal orders and read them accurately, while keeping API spend and token use low.

You can run it in two ways:

- **Hosted (multi-user).** One server, many users. Each user creates a connection key on the web page and connects any MCP client by URL. A REST API and an OpenAPI spec are included for clients that do not speak MCP.
- **Local (stdio).** The server runs on your machine for your own clients, using your own Indian Kanoon token.

## Tools

| Tool | API endpoint | Price | Use it for |
|---|---|---|---|
| `ik_search` | `/search/` | Rs 0.50 per page (10 results) | Finding documents. Filters: court (`doctypes`), date range, title, citation, author, bench, "cited by", sort order |
| `ik_fragments` | `/docfragment/` | Rs 0.05 | Only the passages of one document that match a query, trimmed around the matches |
| `ik_metadata` | `/docmeta/` | Rs 0.02 (free if the document is cached) | Title, court, date, case number, and the "cites" and "cited by" lists |
| `ik_document` | `/doc/` | Rs 0.20 once, then free | Clean plain text in chunks. Can return only selected sections, such as the issues or the conclusion |
| `ik_court_copy` | `/origdoc/` | Rs 0.50 | The original court copy (usually PDF). Hosted: a download link valid for 24 hours. Local: a file on disk |
| `ik_usage` | none | free | Spend today, remaining cap, and cache savings |

The server tells the model to work cheapest-first: search, then fragments, then metadata, and the full document only when needed.

## Connecting a client to a hosted server

1. Open the server's home page, for example `https://kanoon.wx8.org/`.
2. Create a connection key. Either enter your own Indian Kanoon API token, which is checked with one Rs 0.02 call and stored encrypted, or, if you are the owner, enter the admin token so the key spends from the server's own token.
3. The page shows the key once, with setup for each client. In summary:

| Client | Setup |
|---|---|
| Claude Code | `claude mcp add --transport http --scope user indiankanoon https://HOST/mcp --header "Authorization: Bearer ikm_…"` |
| Claude.ai and Claude Desktop | Settings → Connectors → Add custom connector. URL: `https://HOST/mcp/ikm_…`. Leave the OAuth fields empty |
| Codex CLI | `export IKMCP_KEY=ikm_…`, then `codex mcp add indiankanoon --url https://HOST/mcp --bearer-token-env-var IKMCP_KEY` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers":{"indiankanoon":{"url":"https://HOST/mcp","headers":{"Authorization":"Bearer ikm_…"}}}}` |
| VS Code | `.vscode/mcp.json`: `{"servers":{"indiankanoon":{"type":"http","url":"https://HOST/mcp","headers":{"Authorization":"Bearer ikm_…"}}}}` |
| Gemini CLI | `~/.gemini/settings.json`: `{"mcpServers":{"indiankanoon":{"httpUrl":"https://HOST/mcp","headers":{"Authorization":"Bearer ikm_…"}}}}` |
| ChatGPT | Developer mode → Connectors → Create. URL `https://HOST/mcp/ikm_…`, no authentication. For a custom GPT, import Actions from `https://HOST/openapi.json` with Bearer API-key auth |
| Anything else | REST: `POST https://HOST/api/v1/tools/<tool>` with `Authorization: Bearer ikm_…` and the tool arguments as a JSON body |

Claude.ai and ChatGPT connectors cannot send custom headers, so the key goes in the URL path. Treat that URL as a password.

On the home page, a key holder can check usage or revoke the key.

## How it saves money and tokens

- **Persistent cache.** Responses are stored gzip-compressed on disk. A judgment is fetched once and is free for 30 days after that (configurable). Search results are kept for 24 hours. On a hosted server the cache is shared between keys by default (`IK_SHARE_CACHE`).
- **One fetch per document.** `/doc/` and `/docmeta/` are always asked for the maximum 50 citations, at the same price. So one cache entry serves any later citation limit. `ik_metadata` reuses a cached full document instead of paying for `/docmeta/`.
- **Section filter.** Indian Kanoon tags each judgment paragraph with its role. `ik_document` accepts `sections` (`facts`, `issues`, `petitioner_arguments`, `respondent_arguments`, `provisions`, `precedents`, `court_reasoning`, `conclusion`) and returns only those paragraphs. On *Puttaswamy* (2017), `conclusion` alone is 70k characters against 847k for the full text.
- **Free chunking.** Every chunk after the first comes from the cache. Chunks end on paragraph boundaries.
- **Compact results.** HTML becomes plain text. Line breaks left over from the source PDF are rejoined and page numbers removed. Search results drop snippets that only repeat the title, drop the date from titles (it is shown separately), and fold duplicate entries for the same case into one line. Fragments are trimmed to the window with the most matched terms (`max_chars_per_fragment`, default 900).
- **Spend caps.** Each key has a daily cap. Keys on the server's own token also share one combined cap (`HOUSE_DAILY_BUDGET_INR`). Local mode has `IK_DAILY_BUDGET_INR`. Days reset at midnight IST. Cached results stay available after a cap is reached.
- **Duplicate suppression and validation.** Identical concurrent requests share one API call. Bad dates, unknown court codes and filter injection are rejected before any money is spent.

## How it keeps results accurate

- Filters use Indian Kanoon's own query syntax, matching the official reference client.
- Uppercase `AND`, `OR` and `NOT` are converted to `ANDD`, `ORR` and `NOTT`. Quoted phrases are left alone.
- Dates are accepted as `DD-MM-YYYY`, `YYYY-MM-DD` or `YYYY`, and are validated as real calendar dates.
- Document text keeps paragraph numbers and block quotes, for pin-point citation.
- Every result carries the document id and its URL, `https://indiankanoon.org/doc/<id>/`.
- API errors are returned as tool errors and are never cached. Timeouts, HTTP 429 and 5xx responses are retried with backoff.

## Deploying a hosted server

Docker (the image defaults to HTTP mode on port 3000, with all state in `/data`):

```bash
docker build -t indiankanoon-mcp .
```

```bash
docker run -d -p 3000:3000 -v ikdata:/data -e PUBLIC_URL=https://kanoon.example.com indiankanoon-mcp
```

- Put it behind HTTPS (Coolify, Traefik, Caddy or nginx). Set `PUBLIC_URL` to the public address.
- `SECRET_KEY` is optional. Without it, the server creates `/data/secret.key` on first start and reuses it. Keep it stable: changing or losing it makes stored Indian Kanoon tokens unreadable, and those keys stop working.
- `IK_API_TOKEN` and `ADMIN_TOKEN` are optional in hosted mode. Without them, every key must bring its own Indian Kanoon token. Set both to let the owner issue keys that spend from the server's token.
- Mount `/data` on a persistent volume. It holds `keys.db` (SQLite), the spend ledgers, the cache and court-copy downloads.
- Health check: `GET /healthz`.

### Admin API

Send `Authorization: Bearer <ADMIN_TOKEN>`.

- `POST /api/keys` with `{"label":"…","admin_token":"…","daily_budget_inr":100}` creates a key on the server token. Add `"ik_token"` to use that token instead.
- `GET /api/admin/keys` lists keys and the combined spend on the server token.
- `PATCH /api/admin/keys/<id>` with `{"disabled":true}` or `{"daily_budget_inr":200}` changes a key.

## Local use (stdio)

Requires Node.js 22.13 or later.

```bash
npm install
```

```bash
npm run build
```

```bash
claude mcp add indiankanoon --scope user -e IK_API_TOKEN=your-token -e IK_DAILY_BUDGET_INR=50 -- node "/absolute/path/to/dist/index.js"
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.indiankanoon]
command = "node"
args = ["/absolute/path/to/dist/index.js"]
env = { IK_API_TOKEN = "your-token", IK_DAILY_BUDGET_INR = "50" }
```

## Configuration

`.env.example` lists every variable. The main ones:

| Variable | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (the Docker image sets `http`) |
| `IK_API_TOKEN` | required for stdio | The server's own Indian Kanoon token |
| `SECRET_KEY` | auto-created in `DATA_DIR` | 32+ random characters |
| `ADMIN_TOKEN` | empty | Owner token for keys on the server token and for the admin API |
| `PUBLIC_SIGNUP` | `true` | Anyone can create a key with their own Indian Kanoon token |
| `PUBLIC_URL` | from request | Public base URL used in links |
| `HOUSE_DAILY_BUDGET_INR` | `200` | Combined daily cap for keys on the server token |
| `KEY_DEFAULT_BUDGET_INR` | `50` | Default per-key daily cap |
| `IK_DAILY_BUDGET_INR` | `0` (no cap) | Daily cap in stdio mode |
| `IK_SHARE_CACHE` | `true` | Share cached documents between keys |
| `RATE_LIMIT_PER_MIN` | `120` | Requests per minute per key |
| `IK_MAX_PAGES_PER_SEARCH` | `5` | Most pages one search may fetch |
| `IK_ENABLE_ORIGDOC` | `true` | Offer `ik_court_copy` |
| `LOG_LEVEL` | `info` | JSON logs on stderr. API tokens and keys are never logged |

Spend figures are estimates from the [published prices](https://api.indiankanoon.org/pricing/). The Indian Kanoon account statement is authoritative. Before sharing a cache between many users, check that this fits your Indian Kanoon API terms.

## Development

```bash
npm test
```

The tests run the MCP server, the HTTP server and the REST API against a mocked Indian Kanoon API. They cover request format, caching, retries, per-key and shared budgets, key creation and revocation, signed downloads, chunking and error handling.
