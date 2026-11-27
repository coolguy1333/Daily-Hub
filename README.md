# Daily hub

A small private dashboard. Claude fills it through the app's own **remote MCP server**; there is no
other data source: the app makes no checks of its own.

The page (one page, mobile-friendly, light/dark, refreshes every 60 s):

0. **Alerts** – open alerts, most severe first.
1. **Sites** – one card per site Claude reports on: its status and the newest things that happened
   (outages, recoveries, updates, backups, certificates, …), worst status first.
2. **Today** – the newest updates, newest first.
3. **Network** – the latest snapshot grouped by group, down → warn → ok, with when it was taken.
4. **Email** – last 24 hours: *Need to Read* on top, the rest grouped by label. Time, sender, subject
   and label only, as plain text (never links).
5. **News** – newest first, grouped by topic. A headline is a link only if its URL starts with `https://`.
6. **Connected clients** – the MCP clients you approved, with **Revoke**.

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

To disconnect, use **Revoke** under *Connected clients* on the page (or remove the connector in Claude).

**Claude Code:** set `MCP_ALLOW_LOOPBACK=true`, then
`claude mcp add --transport http daily-hub https://hub.example.com/mcp` and run `/mcp` to sign in.

## MCP tools

Endpoint `POST /mcp` (Streamable HTTP, stateless, JSON responses). Every response is compact JSON
with counts and ids, not your content echoed back. Every text field is plain text, at most 500
characters (summaries 4000); unknown fields are rejected; at most 200 items per call. Dates are
ISO 8601 with a time zone.

| Tool | Arguments | Returns |
|---|---|---|
| `get_state` *(read-only)* | – | `{latest: {update, network_at, news_at, email_received_at, site_note_at}, sites: [{site, status, updated_at}], open_alerts: [{key, severity, title, since}], need_to_read: [{id, sender, subject, received_at}], counts}` |
| `publish` | any of `update`, `network`, `news`, `emails`, `alerts`, `sites` (below) | `{ok, added: {…}, updated: {…}, rejected: [{part, index, reason}]}` |
| `raise_alert` | `{key, severity: info\|warn\|critical, title, detail?}` | `{ok, key, result: added\|updated}` |
| `resolve_alert` | `{key}` | `{ok, key, result: resolved\|already_resolved\|not_found}` |
| `set_need_to_read` | `{ids: [...], value?: false}` | `{ok, updated, unchanged, not_found}` |
| `list_entries` *(read-only)* | `{section: updates\|network\|news\|emails\|alerts\|sites, since?, limit? (1-50, default 20)}` | `{section, total, items, more}` (short fields) |
| `delete_entry` *(destructive)* | `{section, id}` (alerts: the key) | `{ok, deleted}` |

`publish` parts (all optional, applied in one transaction; bad items are rejected one by one, the rest
is applied; `ok` is `false` when anything was rejected):

```jsonc
{
  "update":  { "kind": "daily|hourly|note", "status": "ok|warn|down", "title": "…",
               "summary": "plain text, max 4000", "items": [{ "name": "…", "state": "…", "detail": "…" }] },
  "network": { "taken_at": "2026-11-26T07:00:00Z",          // replaces the current snapshot
               "items": [{ "group": "proxmox|unifi|cloudflare|services|other", "name": "…", "state": "ok|warn|down", "detail": "…" }] },
  "news":    [{ "topic": "…", "source": "…", "headline": "…", "summary": "…", "url": "https://…" }],  // deduplicated by url
  "emails":  [{ "id": "<gmail message id>", "received_at": "…", "sender": "…", "subject": "…", "label": "…", "need_to_read": true }],  // upserted by id
  "alerts":  { "raise": [{ "key": "…", "severity": "info|warn|critical", "title": "…", "detail": "…" }], "resolve": ["key"] },
  "sites":   [{ "site": "WebManager", "key": "…", "status": "ok|warn|down|info", "title": "…", "detail": "…" }]  // key optional: same site+key replaces
}
```

- **Emails** accept only those six fields. The id is used for dedupe and never shown. URLs are
  stripped from sender and subject; in subjects about a code, verification, OTP or passcode, runs of
  4–8 digits become `•••`.
- **Alerts** are idempotent by key: raising an open alert updates it (keeping its start time);
  resolving a closed or unknown one is a no-op. In one `publish`, `resolve` runs after `raise`.
- **Site notes** make up the Sites section. `site` is any name (matched case-insensitively; use
  the same one every time). A site's status is that of its newest note with `ok`, `warn` or `down`;
  `info` (the default) adds a note without changing the status. The card shows the newest 8 notes.
  With a `key`, a note replaces the earlier one with the same site and key (e.g. `cert`), so a daily
  run doesn't pile up copies. `get_state.sites` lists each site's status and last update.
- **Retention** (daily): entries and site notes older than 30 days, alerts resolved over 30 days ago, network
  snapshots older than 7 days.
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

## Development

```bash
npm install
npm test
```

Locally: copy `.env.example` to `.env`, fill it in, then `npm run dev`. Without Cloudflare Access in
front, the page answers 403 (it needs the Access token); the MCP and OAuth endpoints work.
