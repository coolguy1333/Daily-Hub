'use strict';
// The app's MCP server: stateless Streamable HTTP with JSON responses (one Server + transport per
// request). Tools return compact JSON (counts and ids), never echoed content.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const V = require('./validate');
const { S } = require('./hub');

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function tools(hub) {
  return [
    {
      name: 'get_state',
      description: 'Current hub state: latest timestamps, site states, open alerts, Need to Read emails, counts.',
      spec: S.empty, annotations: { ...READ, title: 'Get state' },
      run: () => hub.getState(),
    },
    {
      name: 'publish',
      description: 'Publish any of update, network, news, emails, alerts, sites in one call. All parts optional; bad items are rejected one by one. Max 200 items per call. Plain text only.',
      spec: S.publish, annotations: { ...WRITE, title: 'Publish' },
      run: a => hub.publish(a),
    },
    {
      name: 'raise_alert',
      description: 'Open an alert, or update the open alert with this key.',
      spec: S.alert, annotations: { ...WRITE, idempotentHint: true, title: 'Raise alert' },
      run: a => hub.raiseAlert(a),
    },
    {
      name: 'resolve_alert',
      description: 'Resolve the open alert with this key. No-op if none is open.',
      spec: S.resolve, annotations: { ...WRITE, idempotentHint: true, title: 'Resolve alert' },
      run: a => hub.resolveAlert(a),
    },
    {
      name: 'set_need_to_read',
      description: 'Set the Need to Read flag of emails by id (usually value=false to clear).',
      spec: S.setNeedToRead, annotations: { ...WRITE, idempotentHint: true, title: 'Set Need to Read' },
      run: a => hub.setNeedToRead(a),
    },
    {
      name: 'list_entries',
      description: 'List entries of one section, newest first (short fields only).',
      spec: S.list, annotations: { ...READ, title: 'List entries' },
      run: a => hub.listEntries(a),
    },
    {
      name: 'delete_entry',
      description: 'Delete one entry by id (alerts: by key).',
      spec: S.del, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Delete entry' },
      run: a => hub.deleteEntry(a),
    },
  ];
}

const json = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) });

function createMcp({ hub, version, title, log = () => {} }) {
  const list = tools(hub);
  const byName = new Map(list.map(t => [t.name, t]));
  const listed = list.map(t => ({ name: t.name, description: t.description, inputSchema: V.toJsonSchema(t.spec), annotations: t.annotations }));

  function makeServer() {
    const server = new Server(
      { name: 'daily-hub', title, version },
      { capabilities: { tools: { listChanged: false } }, instructions: 'Daily hub dashboard. Write with publish (one call per run); read with get_state.' },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const t = byName.get(req.params.name);
      if (!t) return json({ ok: false, error: `unknown tool ${req.params.name}` }, true);
      try {
        const result = t.run(req.params.arguments || {});
        log(`[mcp] ${t.name} client=${extra.authInfo?.clientId || '-'}`);
        return json(result);
      } catch (err) {
        if (err instanceof V.ValidationError) return json({ ok: false, error: err.message }, true);
        console.error(`[mcp] ${t.name} failed: ${err.message}`);
        return json({ ok: false, error: 'internal error' }, true);
      }
    });
    return server;
  }

  // Handle one POST /mcp (already authenticated; `auth` is the token's info).
  async function handle(req, res, body, auth) {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    req.auth = { token: '', clientId: auth.client_id, scopes: auth.scope.split(' ').filter(Boolean), expiresAt: Math.floor(auth.exp / 1000) };
    await transport.handleRequest(req, res, body);
  }

  return { handle, tools: listed };
}

module.exports = { createMcp };
