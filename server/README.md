# Ice Agent server

Standalone Node server (no dependencies) that owns config, sessions and characters.

- Data root: `D:\IceAgent` (override with `ICE_AGENT_DATA`)
- Start: `node server/server.mjs` or `server/start-server.cmd`
- Config: `D:\IceAgent\config.json` (port, token, apiKey, baseUrl, model, persona)

Endpoints: `/v1/health`, `/v1/chat`, `/v1/sessions*`, `/v1/characters`, `/assets/*`, `/v1/config`.
