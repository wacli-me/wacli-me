# wacli.me

Hosted MCP gateway in front of the [wacli](https://wacli.sh) WhatsApp CLI.

The idea: someone links their WhatsApp account once (QR, like WhatsApp Web) and gets a URL plus a
bearer token. Any MCP client can then read, search — and optionally send — without running anything
locally.

Status: **public alpha**. Single host, single process. Live at <https://wacli.me>.

MIT licensed. Self-hosting is a first-class path — see "Running" below.

## Layout

```
server/      Node MCP server (Streamable HTTP) + static file serving
site/        website sources (pages + layout + assets)
web/         generated site, built from site/ by scripts/build.mjs — never edit
config/      tenants.json (gitignored) — token -> store mapping
bin/wacli    pinned wacli binary, isolated from any system install
stores/      one wacli store directory per tenant (gitignored)
scripts/     start/stop/tunnel helpers
```

## Endpoints

| Path       | Purpose                                             |
|------------|-----------------------------------------------------|
| `/`        | landing page                                        |
| `/mcp`     | MCP over Streamable HTTP, `Authorization: Bearer …`  |
| `/healthz` | liveness + tenant count                             |
| `/connect` | self-service linking: live QR, issues a token        |
| `/.well-known/oauth-*` | OAuth 2.1 discovery — clients fetch their own credentials |

## Tenants

`config/tenants.json`:

```json
{
  "tenants": [
    { "id": "demo", "token": "<32 random bytes, hex>", "store": "/Users/<user>/wacli-me/stores/demo", "plan": "self-hosted", "allowSend": false }
  ]
}
```

The file is re-read every 5 seconds — adding a tenant needs no restart. A token maps to exactly one
store directory; tools are constructed per request against that store, so two tenants cannot see each
other's data. `allowSend` registers `send_message`, `send_image`, and the other live/write tools;
leave it `false` unless the account owner explicitly asked for write access. `send_image` accepts
JPEG, PNG, WebP, and GIF bytes as base64 or a public HTTPS image URL (up to 5 MB). `get_media`
returns synced images as MCP image content when they are up to 5 MB.

Generate a token with `openssl rand -hex 32`.

For a server you operate yourself, use `"plan": "self-hosted"` as in the
example. It has no monthly tool-call limit and does not prune message history
or delete an inactive tenant; you are responsible for store retention and
backups. Tenants created through `/connect` can inherit a server-wide plan:
set `WACLI_ME_DEFAULT_PLAN=self-hosted` to make that the default on a private
host. An explicit valid `plan` in `tenants.json` takes precedence. If neither
is set, the server uses Free: 50 tool calls per UTC month, 30 days of history,
and deletion after 14 days of inactivity. Pro is the paid hosted plan and is
not needed for self-hosting.

## Running

```bash
npm install --prefix server
node scripts/build.mjs                        # site/ -> web/
PORT=8787 HOST=127.0.0.1 node server/server.mjs
```

Environment:

| Variable            | Default              | Meaning                      |
|---------------------|----------------------|------------------------------|
| `PORT`              | `8787`               | listen port                  |
| `HOST`              | `127.0.0.1`          | bind address — keep loopback, expose via tunnel |
| `WACLI_BIN`         | `./bin/wacli`        | wacli binary                 |
| `WACLI_ME_TENANTS`  | `./config/tenants.json` | tenant file               |
| `WACLI_ME_DEFAULT_PLAN` | `free`           | `free` or `self-hosted` for tenants without a valid plan |
| `WACLI_SYNC_MODE`   | `on-request`         | `on-request` or `continuous` |
| `WACLI_SYNC_IDLE_MS`| `5000`               | idle time in milliseconds before on-request sync disconnects |

For a personal WhatsApp number, the default `on-request` mode avoids keeping
the linked device connected between MCP tool calls. A tool call starts a quiet
sync when needed, waits up to 90 seconds for WhatsApp's offline sync to finish,
and keeps the connection briefly after the last call before disconnecting.
This can make calls take longer, especially the first call after a pause. Quiet
presence may help the primary phone keep receiving push notifications, but
WhatsApp controls notification routing, so this cannot be guaranteed. Set
`WACLI_SYNC_MODE=continuous` to keep syncing in the background instead.

For a private connection from ChatGPT through the OpenAI Secure MCP Tunnel,
see [the Docker setup guide](docs/docker-openai-tunnel.en.md). The tunnel
deployment keeps the MCP port off the public network.

## Linking an account

```bash
bin/wacli --store stores/<tenant> auth        # prints a QR, scan it on the phone
bin/wacli --store stores/<tenant> sync        # backfill history (long-running; run as a daemon)
```

Without a sync daemon the store only holds what was fetched during the last run.

## Security notes

- Bind to loopback and publish through a tunnel; never expose the port directly.
- Every MCP request needs a valid bearer token; tokens are compared in constant time.
- Reads run wacli with `--read-only`, so a compromised tool call cannot mutate the store.
- The QR link is a *linked device*. Whoever holds the store can read that account's messages —
  treat store directories and tenant tokens as credentials.

## License

MIT, see [LICENSE](LICENSE). `site/assets/qrcode.min.js` is Kazuhiko Arase's
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), vendored unchanged (MIT). wacli itself is a separate MIT project — this repository only drives it.

Linking an account uses an unofficial WhatsApp client. That is against WhatsApp's terms of service,
and Meta may block a number for it. Run it on accounts you own, and tell your users the same.
