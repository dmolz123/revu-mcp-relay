// revu-bridge — the desktop half of the PoC.
//
// Starts the local Bluebeam MCP Server (stdio), then dials OUT to the cloud
// relay over a WebSocket and forwards JSON-RPC calls between them. No inbound
// port is opened on this machine. Every call is printed so the audience can
// watch requests arrive from the cloud. Ctrl+C is the kill switch.
//
// Config: bridge/config.json (see config.example.json) or env vars
//   RELAY_URL      wss://<your-relay>.onrender.com/bridge
//   BRIDGE_TOKEN   shared secret, must match the relay's BRIDGE_TOKEN
//   MCP_SERVER_PATH  path to "Bluebeam MCP Server.exe"
//   BRIDGE_ALLOWED_TOOLS  optional comma list; a second, local allowlist

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const fileCfg = (() => {
  const p = path.join(__dirname, 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
})();
const cfg = {
  relayUrl: process.env.RELAY_URL || fileCfg.relayUrl || 'ws://localhost:8790/bridge',
  token: process.env.BRIDGE_TOKEN || fileCfg.bridgeToken || '',
  mcpPath: process.env.MCP_SERVER_PATH || fileCfg.mcpServerPath ||
    'C:\\Program Files\\Bluebeam Software\\Bluebeam Revu\\21\\Revu\\mcp\\Bluebeam MCP Server.exe',
  allowed: (process.env.BRIDGE_ALLOWED_TOOLS || (fileCfg.allowedTools || []).join(','))
    .split(',').map(s => s.trim()).filter(Boolean)
};
const localAllow = cfg.allowed.length ? new Set(cfg.allowed) : null;

const c = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };
const stamp = () => new Date().toLocaleTimeString();
const log = (color, label, msg = '') => console.log(`${c.dim}${stamp()}${c.reset} ${color}${label}${c.reset} ${msg}`);

// --- stdio MCP client ---------------------------------------------------------

class StdioMcp {
  constructor(exe) {
    this.exe = exe;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.proc = null;
  }

  alive() { return !!(this.proc && this.proc.exitCode === null); }

  async start() {
    if (!fs.existsSync(this.exe)) throw new Error(`Bluebeam MCP server not found at ${this.exe}`);
    this.proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.on('data', d => log(c.dim, '[mcp stderr]', d.toString().trim().slice(0, 300)));
    this.proc.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Bluebeam MCP server exited'));
      this.pending.clear();
      log(c.yellow, 'Bluebeam MCP server exited; it will restart on the next call.');
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'revu-bridge', version: '0.1.0' }
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  }

  request(method, params, timeoutMs = 110000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Revu timed out on ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); }
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const p = msg.id !== undefined && this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message || 'MCP error')) : p.resolve(msg.result);
    }
  }
}

const mcp = new StdioMcp(cfg.mcpPath);
let starting = null; // shared startup promise so concurrent calls spawn one server

function ensureMcp() {
  if (mcp.alive() && !starting) return Promise.resolve();
  if (!starting) {
    starting = mcp.start()
      .then(() => log(c.green, 'Bluebeam MCP server started', c.dim + cfg.mcpPath + c.reset))
      .finally(() => { starting = null; });
  }
  return starting;
}

// --- relay connection ---------------------------------------------------------

async function handleRpc({ id, method, params }) {
  if (method === 'tools/call' && localAllow && !localAllow.has(params?.name)) {
    log(c.red, 'BLOCKED locally', params?.name);
    return { id, result: { isError: true, content: [{ type: 'text', text: `Tool "${params?.name}" is blocked by the desktop bridge policy.` }] } };
  }
  const label = method === 'tools/call' ? params.name : method;
  const args = method === 'tools/call' ? JSON.stringify(params.arguments || {}) : '';
  log(c.cyan, '☁ → Revu', `${label} ${c.dim}${args.slice(0, 160)}${c.reset}`);
  const started = Date.now();
  try {
    await ensureMcp();
    const result = await mcp.request(method, params || {});
    if (method === 'tools/list' && localAllow) {
      result.tools = (result.tools || []).filter(t => localAllow.has(t.name));
    }
    const status = result?.isError ? `${c.red}error` : `${c.green}ok`;
    log(c.cyan, 'Revu → ☁', `${label} ${status}${c.reset} ${c.dim}${Date.now() - started} ms${c.reset}`);
    return { id, result };
  } catch (err) {
    log(c.red, 'Revu error', `${label}: ${err.message}`);
    return { id, error: err.message };
  }
}

let backoff = 1000;

function connect() {
  log(c.dim, 'Connecting to relay', cfg.relayUrl);
  const ws = new WebSocket(cfg.relayUrl, {
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}
  });

  ws.on('open', async () => {
    backoff = 1000;
    let toolCount = 0;
    try {
      await ensureMcp();
      toolCount = ((await mcp.request('tools/list', {})).tools || []).length;
    } catch (err) {
      log(c.red, 'Could not reach Revu MCP:', err.message);
    }
    ws.send(JSON.stringify({ type: 'hello', host: os.hostname(), user: os.userInfo().username, toolCount }));
    log(c.green, '✔ Connected to relay', `(outbound only) · ${toolCount} Revu tools · waiting for cloud calls…`);
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type !== 'rpc') return;
    const reply = await handleRpc(msg);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rpc-result', ...reply }));
  });

  ws.on('close', (code, reason) => {
    log(c.yellow, 'Relay connection closed', `${code} ${reason || ''}`);
    if (code === 4000) return process.exit(0); // replaced by another bridge
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });

  ws.on('error', err => log(c.red, 'Relay error:', err.message || err.code || 'connection failed'));
}

process.on('SIGINT', () => {
  log(c.yellow, 'Kill switch: disconnecting from relay and stopping Revu MCP.');
  if (mcp.proc) mcp.proc.kill();
  process.exit(0);
});

console.log(`\n${c.cyan}Revu MCP Bridge${c.reset} — desktop agent (Ctrl+C to disconnect)\n`);
connect();
