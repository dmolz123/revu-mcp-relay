# Revu MCP Relay: PoC

Shows how Bluebeam Revu's **local** MCP server can be reached by a **cloud** AI
through a secure proxy, without opening inbound ports on the desktop. Claude
(through the Messages API's remote-MCP connector) stands in for M365 Copilot /
Copilot Studio. Both connect to a remote MCP server the same way, so the relay
URL is what you'd register in Copilot Studio later.

```
Cloud AI ──HTTPS /mcp (Bearer MCP_TOKEN)──▶ Relay (Render) ◀──WSS /bridge (Bearer BRIDGE_TOKEN)── revu-bridge (PC) ──stdio──▶ Bluebeam MCP Server ──▶ Revu
```

| Piece | Where | Job |
|---|---|---|
| `relay/server.js` | Cloud (Render) | Standard remote MCP endpoint (`POST /mcp`, Streamable HTTP, JSON responses), token auth, **tool allowlist**, audit log, demo chat page, Claude API calls |
| `bridge/bridge.js` | PC running Revu | Starts `Bluebeam MCP Server.exe`, dials **out** to the relay, forwards JSON-RPC, prints every call; Ctrl+C is the kill switch. Optional second allowlist |
| `relay/public/index.html` | Served by relay | Chat with the active drawing + live hop trace (Cloud AI → Relay → Bridge → Revu) |
| `scripts/smoke-test.js` | Anywhere | Acts as a cloud MCP client: auth rejection, tools/list, a real call, a blocked call |

**Allowed tools (default):** read tools plus `add_markup` and `set_markup_state`.
Delete, redact, open_file, color processing and Studio tools are blocked at the relay.
Override with `ALLOWED_TOOLS` (comma list).

## Deploy the relay (Render)

1. Push this folder to a GitHub repo, then in Render choose **New → Blueprint** and point it at the repo. It uses `render.yaml`.
2. Set `ANTHROPIC_API_KEY` and `CHAT_KEY`. Render generates `MCP_TOKEN` and `BRIDGE_TOKEN`. Copy `BRIDGE_TOKEN` for step 3.
3. Open `https://<service>.onrender.com/api/status` and check that `mcpUrl` shows the public URL.

## Run the bridge (on the PC with Revu open)

```
copy bridge\config.example.json bridge\config.json   # set relayUrl = wss://<service>.onrender.com/bridge and bridgeToken
npm install
npm run bridge
```

Open `https://<service>.onrender.com`, enter the `CHAT_KEY`, and ask about the active drawing.

## Local testing

The Claude hop needs a **public** URL: Anthropic's servers connect to `/mcp`, so `localhost` won't work for chat.
Everything else can be tested locally:

```
set MCP_TOKEN=test-mcp& set BRIDGE_TOKEN=test-bridge& set CHAT_KEY=test-chat& npm start
set RELAY_URL=ws://localhost:8790/bridge& set BRIDGE_TOKEN=test-bridge& npm run bridge
set MCP_TOKEN=test-mcp& npm run smoke
```

To test chat locally, expose port 8790 with a tunnel and set `PUBLIC_URL` to the tunnel URL.

## Mapping to a production M365 deployment

| PoC | Production |
|---|---|
| Relay on Render | Azure App Service / Functions behind API Management, in the customer tenant |
| Static bearer tokens | Entra ID OAuth (On-Behalf-Of); per-user bridge identity |
| Claude + demo page | Copilot Studio agent with an MCP connector pointed at `/mcp` |
| One bridge at a time | Bridge registry keyed by user / device; per-user routing |
| In-memory audit log | Log Analytics / Sentinel |

**Known PoC limits:** a single desktop; no server-initiated SSE stream on `/mcp` (JSON response mode); the audit log resets on restart; the demo page is protected only by `CHAT_KEY`.
