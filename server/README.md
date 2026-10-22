# Ice Agent server

Standalone Node server (no dependencies) that owns config, sessions and characters.

- Data root: `D:\IceAgent` (override with `ICE_AGENT_DATA`)
- Start: `node server/server.mjs` or `server/start-server.cmd`
- Config: `D:\IceAgent\config.json` (port, token, apiKey, baseUrl, model, persona)
- Admin console: `http://127.0.0.1:8787/admin/` — localhost only, log in with `config.token`
- Deploy: `server/sync-to-runtime.ps1` copies `server.mjs` + `admin/` into the runtime directory
  (and fills `admin/vendor/live2d/` from `assets/live2d`, which is not committed)
- Live2D thumbnails: `server/admin/src/live2d-preview.ts` → `server/admin/vendor/live2d-preview.js`

  ```powershell
  node_modules\.bin\esbuild server/admin/src/live2d-preview.ts --bundle --format=iife --minify --target=es2020 --outfile=server/admin/vendor/live2d-preview.js
  ```

- Self-test: `node server/selftest.mjs` (temp data root, exercises `/v1` + `/admin` + `/admin/api`)

Endpoints: `/v1/health`, `/v1/chat`, `/v1/sessions*`, `/v1/characters`, `/assets/*`, `/v1/config`,
`/v1/personas*`, `/v1/voice/*`, `/v1/asr`, `/v1/tts`, plus the localhost-only admin console
(`/admin`, `/admin/api/*`). See `docs/API.md` for the full contract.
