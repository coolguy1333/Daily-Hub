# Daily hub

A small private dashboard. Claude fills it through the app's own **remote MCP server**; there is no
other data source: the app makes no checks of its own.

The page has the same layout as [homelab-status](https://github.com/coolguy1333/homelab-status): a top
bar, a sidebar of pages with badges (a scrolling tab bar under 900 px), light and dark themes, and it
refreshes every 60 s. It keeps to what matters: no server details, only daily updates and the alerts
Claude raises.

| Page | Shows | Badge |
|---|---|---|
| **Overview** (`#overview`) | *Homelab* on top: **All OK** when no alert is open, otherwise the open alerts, newest first. Then *What's happening* (the newest daily update with its items and how long ago Claude sent it) and tiles for open alerts, Need to Read and news in the last 24 h. A banner warns when Claude hasn't checked in (any update) for over 2 hours. | open critical alerts (red) |
| **Updates** | Daily updates only (newest 100), items as a table. Hourly updates and notes are accepted but not shown. | – |
| **Email** | Tiles for the last 24 h and Need to Read; Need to Read on top (until Claude clears it), then the last 24 h by label. Time, sender, subject and label only, as plain text, never links. | Need to Read (blue) |
| **News** | Newest first, grouped by topic. A headline is a link only if its URL starts with `https://`. | – |
| **Alerts** | Open alerts, then those resolved in the last 30 days. | open alerts (red if any is critical, amber otherwise) |
| **Clients** | Connected MCP clients with **Revoke**, the signed-in email and **Sign out**. | – |

Node 22, one dependency (`@modelcontextprotocol/sdk`), plain HTML/CSS/JS, JSON files in `/data`.

## Setup

You need: WebManager with app hosting on, a hostname on a Cloudflare zone (through Cloudflare Tunnel
to WebManager), and Cloudflare Zero Trust. Below, the hostname is `hub.example.com`.

### 1. Cloudflare Access: two applications

Access sits in front of the page; the MCP and OAuth endpoints protect themselves and must bypass it.
In **Zero Trust → Access → Applications**, add two **Self-hosted** applications:

| | Application 1 – "Daily hub" | Application 2 – "Daily hub MCP" |
|---|---|---|
| Destinations | `hub.example.com` (no path) | `hub.example.com/mcp`<br>`hub.example.com/oauth/token`<br>`hub.example.com/oauth/register`<br>`hub.example.com/.well-known`<br>`hub.example.com/api/health` |
| Policy | **Allow** – Include: Emails – your address | **Bypass** – Include: Everyone |

The more specific paths of application 2 win over application 1. Don't bypass `/oauth` as a whole:
`/oauth/authorize` must stay behind application 1, because that's where you approve connections.

From application 1's **Overview** tab, copy the **Application Audience (AUD) tag**. Your team domain
is under **Zero Trust → Settings** (e.g. `myteam.cloudflareaccess.com`).

The app verifies the Access token itself on every page and page-API request (signature, `aud`, `iss`,
`exp`, `nbf`, email), so a misconfigured Access policy still can't expose the page.

### 2. Cloudflare bot settings

Either of these blocks Claude's connector, so for the zone of `hub.example.com`:

- turn off **Block AI Bots** and **Bot Fight Mode** (Security → Bots), **or**
- add **IP Access rules** (Security → WAF → Tools) with action **Allow** for Anthropic's outbound
  addresses. IP Access rules only accept `/24` or `/16` for IPv4, so add eight Allow rules:
  `160.79.104.0/24` through `160.79.111.0/24` (`160.79.104.0/24`, `160.79.105.0/24`, …,
  `160.79.111.0/24`). Optionally also add `153.61.208.0/24` through `153.61.223.0/24`
  (sixteen more rules).

### 3. Deploy on WebManager

1. **Sources → add** this repository, and on *Choose folders* pick **Deploy as an app** for the root.
2. Set the variables on the app's **Variables** page:

| Variable | Required | Value |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | yes | e.g. `myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | yes | AUD tag of application 1 (several: comma-separated) |
| `ALLOWED_EMAILS` | yes | your email (comma-separated for more) |
| `HUB_SECRET` | yes, secret | 32+ random characters: `openssl rand -hex 32`. Changing it disconnects all clients. |
| `OAUTH_REDIRECT_ALLOWLIST` | no | default `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` |
| `MCP_ALLOW_LOOPBACK` | no | `true` also allows `http://localhost/callback` and `http://127.0.0.1/callback` on any port (Claude Code). Default `false`. |
| `SITE_TITLE` | no | default `Daily hub` |

WebManager sets `PORT`, `DATA_DIR` and `PUBLIC_URL` itself. `PUBLIC_URL` must be the `https://`
address Claude uses (the OAuth metadata is built from it).

Check: `https://hub.example.com/api/health` returns `{"status":"ok","version":"…"}`, and opening
`https://hub.example.com` asks you to sign in through Access.

### 4. Add the connector in Claude

1. In Claude: **Settings → Connectors → Add custom connector**. Name: `Daily hub`,
   URL: `https://hub.example.com/mcp`. Leave the OAuth client ID and secret empty (Claude registers itself).
2. Click **Connect**. You sign in through Cloudflare Access, then see an **Approve / Deny** page naming
   the client and the host it sends you back to (`claude.ai`). Approve.
3. In the connector's tool permissions, set **publish**, **raise_alert**, **resolve_alert** and
   **set_need_to_read** to **Always allow**, so scheduled runs never wait for an approval.

To disconnect, use **Revoke** on the **Clients** page (or remove the connector in Claude).

**Claude Code:** set `MCP_ALLOW_LOOPBACK=true`, then
`claude mcp add --transport http daily-hub https://hub.example.com/mcp` and run `/mcp` to sign in.

## MCP tools

Endpoint `POST /mcp` (Streamable HTTP, stateless, JSON responses). Every response is compact JSON
with counts and ids, not your content echoed back. Every text field is plain text, at most 500
characters (summaries 4000); unknown fields are rejected; at most 200 items per call. Dates are
ISO 8601 with a time zone.

| Tool | Arguments | Returns |
|---|---|---|
| `get_state` *(read-only)* | – | `{latest: {update, news_at, email_received_at}, open_alerts: [{key, severity, title, since}], need_to_read: [{id, sender, subject, received_at}], counts}` |
| `publish` | any of `update`, `news`, `emails`, `alerts` (below) | `{ok, added: {…}, updated: {…}, rejected: [{part, index, reason}]}` |
| `raise_alert` | `{key, severity: info\|warn\|critical, title, detail?}` | `{ok, key, result: added\|updated}` |
| `resolve_alert` | `{key}` | `{ok, key, result: resolved\|already_resolved\|not_found}` |
| `set_need_to_read` | `{ids: [...], value?: false}` | `{ok, updated, unchanged, not_found}` |
| `list_entries` *(read-only)* | `{section: updates\|news\|emails\|alerts, since?, limit? (1-50, default 20)}` | `{section, total, items, more}` (short fields) |
| `delete_entry` *(destructive)* | `{section, id}` (alerts: the key) | `{ok, deleted}` |

`publish` parts (all optional, applied in one transaction; bad items are rejected one by one, the rest
is applied; `ok` is `false` when anything was rejected):

```jsonc
{
  "update":  { "kind": "daily|hourly|note", "status": "ok|warn|down", "title": "…",   // only daily is shown
               "summary": "plain text, max 4000", "items": [{ "name": "…", "state": "…", "detail": "…" }] },
  "news":    [{ "topic": "…", "source": "…", "headline": "…", "summary": "…", "url": "https://…" }],  // deduplicated by url
  "emails":  [{ "id": "<gmail message id>", "received_at": "…", "sender": "…", "subject": "…", "label": "…", "need_to_read": true }],  // upserted by id
  "alerts":  { "raise": [{ "key": "…", "severity": "info|warn|critical", "title": "…", "detail": "…" }], "resolve": ["key"] }
}
```

- **Emails** accept only those six fields. The id is used for dedupe and never shown. URLs are
  stripped from sender and subject; in subjects about a code, verification, OTP or passcode, runs of
  4–8 digits become `•••`.
- **Alerts** are idempotent by key: raising an open alert updates it (keeping its start time);
  resolving a closed or unknown one is a no-op. In one `publish`, `resolve` runs after `raise`.
- **Alerts are the server news.** There are no server details any more: raise an alert only for
  something that needs attention, and resolve it when it's fixed. The Overview shows **All OK** when
  none is open.
- **Removed in 1.3.0:** the `network` and `sites` parts of `publish`, and those sections in
  `list_entries` / `delete_entry`. A run that still sends them gets them back in `rejected`
  (`unknown part`); the rest of its call is applied as usual. Stored network snapshots and site notes
  are dropped from `hub.json` on the first start of 1.3.0.
- **Retention** (daily): entries older than 30 days and alerts resolved over 30 days ago.
- **Rate limit**: 60 MCP calls per minute per client (HTTP 429 after that).

## Security

- `/mcp` requires a Bearer token issued by this app; without one it answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
- OAuth 2.1 per the MCP authorization spec: protected resource metadata (`/.well-known/oauth-protected-resource`
  and `…/mcp`), authorization server metadata, dynamic client registration, authorization code with
  PKCE (S256 only), refresh tokens. Redirect URIs must be on the allowlist.
- Access tokens last 1 hour; refresh tokens 30 days and rotate on every use. A used refresh token
  presented again by the same client within 120 seconds (a retry after a lost response) gets a new
  token pair; after that, reusing it revokes that connection. Tokens are signed with `HUB_SECRET`; `/data/oauth.json` holds only their
  SHA-256 hashes.
- Page: strict Content-Security-Policy (no inline script or style), `X-Frame-Options: DENY`, all stored
  text rendered with `textContent`. Changing requests must come from the page's own origin.
- Public without Access (protected by the app itself): `GET /api/health`, `/mcp`, `/oauth/token`,
  `/oauth/register`, `/.well-known/*`. Everything else needs a valid Access token for an allowed email.
- The client IP for rate limits comes from `CF-Connecting-IP`. Logs never contain tokens, query
  strings or email subjects.

## Data

All in `/data` (`DATA_DIR`): `hub.json` (everything published) and
`oauth.json` (clients and token hashes). WebManager backs `/data` up before each restart.
A `sites.json` left by versions before 1.1.0 (which checked sites themselves) is ignored; you can
delete it.

## Releases

Raising `version` in `package.json` and merging to `main` is all it takes:
`.github/workflows/release.yml` runs the tests, then tags the merge commit with that version and
publishes a GitHub release with notes generated from the merged pull requests. If the version is
already released, it does nothing.

## Development

```bash
npm install
npm test
```

Locally: copy `.env.example` to `.env`, fill it in, then `npm run dev`. Without Cloudflare Access in
front, the page answers 403 (it needs the Access token); the MCP and OAuth endpoints work.
