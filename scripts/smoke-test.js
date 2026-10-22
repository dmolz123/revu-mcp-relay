// Plays the role of a cloud MCP client against the relay's /mcp endpoint,
// the same calls Claude's MCP connector (or Copilot Studio) makes.
//   RELAY_HTTP=http://localhost:8790 MCP_TOKEN=... node scripts/smoke-test.js
// Without env vars it reads relayUrl + mcpToken from bridge/config.json.

const fs = require('fs');
const path = require('path');
const cfgPath = path.join(__dirname, '..', 'bridge', 'config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const fromBridgeUrl = cfg.relayUrl && cfg.relayUrl.replace(/^ws/, 'http').replace(/\/bridge$/, '');
const base = (process.env.RELAY_HTTP || fromBridgeUrl || 'http://localhost:8790').replace(/\/$/, '');
const token = process.env.MCP_TOKEN || cfg.mcpToken || '';
let id = 1;

async function rpc(method, params, auth = token) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params })
  });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}

(async () => {
  const bad = await rpc('initialize', {}, 'wrong-token');
  console.log('1. Wrong token rejected:', bad.status === 401 || !token ? 'PASS' : `FAIL (${bad.status})`);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log('2. initialize:', init.body.result?.serverInfo?.name || JSON.stringify(init.body));

  const list = await rpc('tools/list', {});
  const names = (list.body.result?.tools || []).map(t => t.name);
  console.log(`3. tools/list: ${names.length} tools exposed →`, names.join(', ') || JSON.stringify(list.body));

  const count = await rpc('tools/call', { name: 'get_page_count', arguments: { transactionText: 'Relay smoke test' } });
  console.log('4. get_page_count via relay →', JSON.stringify(count.body.result?.content?.[0]?.text ?? count.body).slice(0, 200));

  const blocked = await rpc('tools/call', { name: 'delete_markup', arguments: {} });
  console.log('5. delete_markup blocked by allowlist:', blocked.body.result?.isError ? 'PASS' : 'FAIL', '-', blocked.body.result?.content?.[0]?.text);
})().catch(e => { console.error('Smoke test failed:', e.message); process.exit(1); });
