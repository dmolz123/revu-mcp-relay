// Revu MCP Relay — the cloud half of the PoC.
//
//   Cloud AI ──HTTPS /mcp──▶ this relay ◀──WSS /bridge── revu-bridge (desktop) ──stdio──▶ Bluebeam MCP Server ──▶ Revu
//
// The relay exposes a standard remote MCP endpoint (Streamable HTTP, JSON
// responses) that any MCP-capable cloud agent can use: Claude's MCP connector
// here, Copilot Studio in production. The desktop never accepts inbound
// connections: the bridge dials OUT to the relay over a WebSocket and the
// relay routes JSON-RPC calls down that socket.
//
// Governance lives here, independent of which AI vendor is calling:
//   - bearer-token auth on /mcp (MCP_TOKEN) and /bridge (BRIDGE_TOKEN)
//   - a tool allowlist (ALLOWED_TOOLS) applied to tools/list AND tools/call
//   - an audit log of every call, streamed live to the demo page

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./system-prompt');

const PORT = Number(process.env.PORT || 8790);
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const CHAT_KEY = process.env.CHAT_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// Render sets RENDER_EXTERNAL_URL automatically; locally, set PUBLIC_URL to a tunnel URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RPC_TIMEOUT_MS = 120000;

// Read tools + markup creation. Destructive or document-level tools (delete,
// redact, open_file, color processing, Studio) are deliberately left out.
const DEFAULT_ALLOWED = [
  'get_page_count', 'get_page_information', 'save_as_text', 'search',
  'list_markups_in_pdf', 'get_markup_state', 'get_markup_shape',
  'get_bookmarks', 'list_view_ports', 'list_links_in_pdf', 'create_markup_thumbnail',
  'add_markup', 'set_markup_state'
];
const ALLOWED_TOOLS = new Set(
  (process.env.ALLOWED_TOOLS ? process.env.ALLOWED_TOOLS.split(',') : DEFAULT_ALLOWED)
    .map(s => s.trim()).filter(Boolean)
);

for (const [name, val] of [['MCP_TOKEN', MCP_TOKEN], ['BRIDGE_TOKEN', BRIDGE_TOKEN]]) {
  if (!val) console.warn(`[relay] WARNING: ${name} is not set — that endpoint is unauthenticated.`);
}

// --- audit log + live trace ---------------------------------------------------

const audit = [];          // ring buffer of trace events
const sseClients = new Set();

function trace(hop, detail = {}) {
  const evt = { ts: new Date().toISOString(), hop, ...detail };
  audit.push(evt);
  if (audit.length > 500) audit.shift();
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) res.write(line);
  console.log(`[relay] ${hop}`, detail.tool || detail.method || '', detail.status || '');
}

function summarize(value, max = 400) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s && s.length > max ? s.slice(0, max) + ` … (+${s.length - max} chars)` : s;
}

// --- bridge connection (one desktop at a time for the PoC) ---------------------

let bridge = null;         // { ws, info, pending: Map }
let rpcSeq = 1;

function bridgeCall(method, params) {
  if (!bridge) return Promise.reject(new Error('No Revu desktop bridge is connected.'));
  const id = rpcSeq++;
  const { ws, pending } = bridge;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Revu (${method}).`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); }
    });
    ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
  });
}

// --- MCP endpoint (Streamable HTTP, JSON response mode) ------------------------

function bearerOk(req, token) {
  if (!token) return true;
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRpc(msg, caller) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      // The bridge already ran the real handshake with the stdio server, so the
      // relay answers initialize itself rather than re-initializing Revu.
      trace('cloud→relay', { method, caller, status: 'session opened' });
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bluebeam-revu-relay', version: '0.1.0' },
        instructions: 'Tools operate on the PDF currently active in Bluebeam Revu on the connected desktop.'
      });
    case 'ping':
      return rpcResult(id, {});
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    case 'tools/list': {
      const res = await bridgeCall('tools/list', params || {});
      const all = res.tools || [];
      const tools = all.filter(t => ALLOWED_TOOLS.has(t.name));
      trace('cloud→relay', { method, caller, status: `${tools.length} of ${all.length} tools exposed (allowlist)` });
      return rpcResult(id, { ...res, tools });
    }
    case 'tools/call': {
      const tool = params?.name;
      if (!ALLOWED_TOOLS.has(tool)) {
        trace('relay BLOCKED', { tool, caller, status: 'not on allowlist' });
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `Tool "${tool}" is blocked by the relay's allowlist policy.` }]
        });
      }
      trace('cloud→relay', { tool, caller, args: summarize(params.arguments) });
      trace('relay→desktop', { tool });
      const started = Date.now();
      const res = await bridgeCall('tools/call', params);
      const text = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const images = (res.content || []).filter(c => c.type === 'image').length;
      trace('desktop→relay', {
        tool, ms: Date.now() - started,
        status: res.isError ? 'error' : 'ok',
        result: summarize(text) + (images ? ` [+${images} image]` : '')
      });
      return rpcResult(id, res);
    }
    default:
      if (isNotification) return null; // notifications/initialized etc. need no reply
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const app = express();
app.use(express.json({ limit: '20mb' }));

app.post('/mcp', async (req, res) => {
  if (!bearerOk(req, MCP_TOKEN)) {
    trace('relay REJECTED', { status: 'bad or missing bearer token on /mcp', caller: req.ip });
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
  }
  const caller = req.get('user-agent') || 'unknown client';
  const batch = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];
  for (const msg of batch) {
    try {
      const r = await handleRpc(msg, caller);
      if (r) replies.push(r);
    } catch (err) {
      trace('relay error', { method: msg.method, status: err.message });
      if (msg.id !== undefined) replies.push(rpcError(msg.id, -32000, err.message));
    }
  }
  if (!replies.length) return res.status(202).end();
  if (batch[0]?.method === 'initialize') res.set('Mcp-Session-Id', crypto.randomUUID());
  res.json(Array.isArray(req.body) ? replies : replies[0]);
});
// No server-initiated SSE stream in this PoC; the spec allows 405 here.
app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
app.delete('/mcp', (_req, res) => res.status(200).end());

// --- demo page API ------------------------------------------------------------

function chatKeyOk(req) {
  return !CHAT_KEY || req.get('x-chat-key') === CHAT_KEY || req.query.key === CHAT_KEY;
}

app.get('/api/status', (_req, res) => {
  res.json({
    bridge: bridge ? { connected: true, ...bridge.info } : { connected: false },
    allowedTools: [...ALLOWED_TOOLS],
    mcpUrl: `${PUBLIC_URL}/mcp`,
    model: MODEL,
    chatKeyRequired: !!CHAT_KEY,
    aiConfigured: !!process.env.ANTHROPIC_API_KEY
  });
});

app.get('/api/events', (req, res) => {
  if (!chatKeyOk(req)) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const evt of audit.slice(-50)) res.write(`data: ${JSON.stringify({ ...evt, replay: true })}\n\n`);
  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
});

app.get('/api/audit', (req, res) => {
  if (!chatKeyOk(req)) return res.status(401).end();
  res.json(audit);
});

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// The browser keeps the conversation (exact content blocks, so thinking blocks
// are passed back unchanged) and sends it on every turn.
app.post('/api/chat', async (req, res) => {
  if (!chatKeyOk(req)) return res.status(401).json({ error: 'Invalid access key.' });
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the relay.' });
  if (!bridge) return res.status(503).json({ error: 'No Revu desktop is connected. Start the bridge on the PC running Revu.' });

  const messages = req.body.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages[] required' });

  trace('user→cloud AI', { status: `prompt sent to ${MODEL}` });
  try {
    const added = [];
    let final;
    // Server-side tool loops can pause (pause_turn); resume until Claude is done.
    for (let i = 0; i < 5; i++) {
      final = await anthropic.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM_PROMPT,
        mcp_servers: [{
          type: 'url',
          url: `${PUBLIC_URL}/mcp`,
          name: 'bluebeam-revu',
          ...(MCP_TOKEN ? { authorization_token: MCP_TOKEN } : {})
        }],
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'bluebeam-revu' }],
        messages: [...messages, ...added]
      }).finalMessage();
      added.push({ role: 'assistant', content: final.content });
      if (final.stop_reason !== 'pause_turn') break;
    }
    // Collapse the resumed turns into one assistant message for the history.
    const content = added.flatMap(m => m.content);
    trace('cloud AI→user', {
      status: final.stop_reason === 'refusal' ? 'refused' : 'answer returned',
      tokens: `${final.usage.input_tokens} in / ${final.usage.output_tokens} out`
    });
    res.json({ assistant: { role: 'assistant', content }, stop_reason: final.stop_reason });
  } catch (err) {
    trace('cloud AI error', { status: err.message });
    const status = err instanceof Anthropic.APIError && err.status ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket endpoint for the desktop bridge --------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/bridge') return socket.destroy();
  if (!bearerOk({ get: h => req.headers[h.toLowerCase()] }, BRIDGE_TOKEN)) {
    trace('relay REJECTED', { status: 'bridge connection with bad token' });
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  if (bridge) {
    trace('desktop bridge replaced', { status: 'a newer bridge connected' });
    bridge.ws.close(4000, 'replaced by newer bridge');
  }
  const me = { ws, info: {}, pending: new Map() };
  bridge = me;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type === 'hello') {
      me.info = { host: msg.host, user: msg.user, toolCount: msg.toolCount, connectedAt: new Date().toISOString() };
      trace('desktop bridge connected', { status: `${msg.host} · ${msg.toolCount} Revu tools available` });
    } else if (msg.type === 'rpc-result') {
      const p = me.pending.get(msg.id);
      if (!p) return;
      me.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  ws.on('close', () => {
    for (const p of me.pending.values()) p.reject(new Error('Desktop bridge disconnected.'));
    if (bridge === me) {
      bridge = null;
      trace('desktop bridge disconnected');
    }
  });
});

// Keep the bridge socket alive through proxies/load balancers.
setInterval(() => { if (bridge) bridge.ws.ping(); }, 25000);

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
  console.log(`[relay] MCP endpoint for cloud AI: ${PUBLIC_URL}/mcp`);
  console.log(`[relay] allowlist: ${[...ALLOWED_TOOLS].join(', ')}`);
});
