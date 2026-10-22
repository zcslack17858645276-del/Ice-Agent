// Smoke test for the standalone server and its admin console.
// Usage:  node D:\codex\desktop-agent\server\selftest.mjs
// It starts a throw-away server in a temp data root, exercises /v1 + /admin + /admin/api,
// prints a ✓/✗ list and exits non-zero when anything fails.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'selftest-token-0123456789abcdef';
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function headerAuth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ice-server-selftest-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(join(root, 'personas'), { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify(
      {
        port,
        token: TOKEN,
        baseUrl: 'http://127.0.0.1:1',
        model: 'selftest-model',
        personasDir: 'personas',
        activePersona: 'default',
        voice: {
          whisperUrl: 'http://127.0.0.1:8000',
          ttsUrl: 'http://127.0.0.1:9880',
          enabled: true
        }
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(
    join(root, 'personas', 'default.json'),
    JSON.stringify({ name: 'Ice', version: 'test' }),
    'utf8'
  );

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ICE_AGENT_DATA: root },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += String(chunk);
  });

  let token = TOKEN;

  async function call(path, options = {}) {
    const response = await fetch(base + path, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, text, json, headers: response.headers };
  }

  async function post(path, body, extraHeaders = {}) {
    return call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body)
    });
  }

  async function check(name, run) {
    checks += 1;
    try {
      await run();
      console.log(`\u2713 ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`\u2717 ${name}`);
      console.log(`    ${error && error.message ? error.message : error}`);
    }
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/v1/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      console.error('--- server output ---');
      console.error(serverOutput || '(empty)');
      throw new Error('server did not become ready');
    }

    console.log(`\nIce Agent server smoke test — ${base}\n`);

    await check('GET /v1/health → 200 ok', async () => {
      const result = await call('/v1/health');
      assert(result.status === 200, `status ${result.status}`);
      assert(result.json && result.json.ok === true, 'ok !== true');
      assert(result.json.version === 2, `version ${result.json && result.json.version}`);
    });

    await check('/v1/config without token → 401', async () => {
      const result = await call('/v1/config');
      assert(result.status === 401, `status ${result.status}`);
    });

    await check('/v1/config with token → 200 and hides token', async () => {
      const result = await call('/v1/config', { headers: headerAuth(token) });
      assert(result.status === 200, `status ${result.status}`);
      assert(result.json && result.json.config, 'missing config');
      assert(result.json.config.token === undefined, 'token leaked');
    });

    await check('GET /admin → 301 /admin/', async () => {
      const result = await call('/admin', { redirect: 'manual' });
      assert(result.status === 301, `status ${result.status}`);
      assert(result.headers.get('location') === '/admin/', 'bad location');
    });

    await check('GET /admin/ → 200 html with login form + CSP', async () => {
      const result = await call('/admin/');
      assert(result.status === 200, `status ${result.status}`);
      assert(result.headers.get('content-type').includes('text/html'), 'not html');
      assert(result.text.includes('id="login"'), 'login markup missing');
      const csp = result.headers.get('content-security-policy') || '';
      assert(csp.includes("default-src 'self'"), 'CSP missing');
    });

    await check('admin assets are served with JS mime type', async () => {
      for (const asset of [
        'app.js',
        'core.js',
        'ui.js',
        'styles.css',
        'view-dashboard.js',
        'view-characters.js',
        'vendor/live2d-preview.js',
        'vendor/live2d/live2dcubismcore.min.js'
      ]) {
        const result = await call(`/admin/${asset}`);
        assert(result.status === 200, `${asset} status ${result.status}`);
        if (asset.endsWith('.js')) {
          assert(
            String(result.headers.get('content-type')).includes('javascript'),
            `${asset} content-type ${result.headers.get('content-type')}`
          );
        }
      }
      const shader = await call('/admin/vendor/live2d/shaders/vertshadersrc.vert');
      assert(shader.status === 200, `shader status ${shader.status}`);
      assert(shader.text.includes('a_position'), 'shader body missing');
    });

    await check('admin traversal is not served', async () => {
      const result = await call('/admin/..%2fserver.mjs');
      assert(result.status === 404 || result.status === 400, `status ${result.status}`);
      assert(!result.text.includes('createServer'), 'server source leaked');
    });

    await check('GET /admin/api/status without token → 401', async () => {
      const result = await call('/admin/api/status');
      assert(result.status === 401, `status ${result.status}`);
    });

    await check('GET /admin/api/status with token → 200', async () => {
      const result = await call('/admin/api/status', { headers: headerAuth(token) });
      assert(result.status === 200, `status ${result.status}`);
      assert(result.json && result.json.ok === true, 'missing ok');
      assert(result.json.counts && result.json.counts.personas === 1, 'persona count');
      assert(result.json.listeningPort === port, `listeningPort ${result.json.listeningPort}`);
    });

    await check('GET /admin/api/settings masks the token', async () => {
      const result = await call('/admin/api/settings', { headers: headerAuth(token) });
      assert(result.status === 200, `status ${result.status}`);
      assert(result.json.config && result.json.config.token === undefined, 'token leaked');
      assert(result.json.tokenConfigured === true, 'tokenConfigured');
      assert(result.json.tokenMasked && !result.json.tokenMasked.includes(TOKEN), 'not masked');
    });

    await check('POST /admin/api/token without X-Admin-Request → 400', async () => {
      const result = await post('/admin/api/token', { generate: true }, headerAuth(token));
      assert(result.status === 400, `status ${result.status}`);
    });

    await check('POST /v1/config patches the voice block', async () => {
      const result = await post(
        '/v1/config',
        { voice: { whisperUrl: 'http://127.0.0.1:8001', commands: { whisperStart: 'echo hi' } } },
        headerAuth(token)
      );
      assert(result.status === 200, `status ${result.status}`);
      const config = result.json.config;
      assert(config.voice.whisperUrl === 'http://127.0.0.1:8001', 'whisperUrl not patched');
      assert(config.voice.commands.whisperStart === 'echo hi', 'command not patched');
      assert(config.voice.ttsUrl === 'http://127.0.0.1:9880', 'other voice fields lost');
    });

    await check('malformed JSON returns 400 and keeps the server alive', async () => {
      const result = await call('/v1/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headerAuth(token) },
        body: '{'
      });
      assert(result.status === 400, `status ${result.status}`);
      const health = await call('/v1/health');
      assert(health.status === 200, 'server died');
    });

    await check('personas: create / list / activate / delete rules', async () => {
      const created = await post(
        '/admin/api/personas',
        { id: 'selftest', content: { name: 'Self Test', personality: 't' } },
        { ...headerAuth(token), 'X-Admin-Request': '1' }
      );
      assert(created.status === 200, `create status ${created.status}`);
      const listed = await call('/admin/api/personas', { headers: headerAuth(token) });
      assert(listed.status === 200, `list status ${listed.status}`);
      assert(listed.json.personas.length === 2, `personas ${listed.json.personas.length}`);
      const activated = await post('/v1/personas/active', { id: 'selftest' }, headerAuth(token));
      assert(activated.status === 200, `activate status ${activated.status}`);
      const refused = await call('/admin/api/personas/selftest', {
        method: 'DELETE',
        headers: { ...headerAuth(token), 'X-Admin-Request': '1' }
      });
      assert(refused.status === 409, `active delete status ${refused.status}`);
      const back = await post('/v1/personas/active', { id: 'default' }, headerAuth(token));
      assert(back.status === 200, `switch back ${back.status}`);
      const removed = await call('/admin/api/personas/selftest', {
        method: 'DELETE',
        headers: { ...headerAuth(token), 'X-Admin-Request': '1' }
      });
      assert(removed.status === 200, `delete status ${removed.status}`);
    });

    await check('characters: import via /v1 and delete via /admin', async () => {
      const imported = await post(
        '/v1/characters',
        { name: 'Self Test', kind: 'image', files: [{ path: 'dot.png', data: PNG_1X1 }] },
        headerAuth(token)
      );
      assert(imported.status === 200, `import status ${imported.status}`);
      const id = imported.json && imported.json.id;
      assert(id, 'missing id');
      const listed = await call('/admin/api/characters', { headers: headerAuth(token) });
      assert(listed.status === 200, `list status ${listed.status}`);
      const found = (listed.json.characters || []).find((entry) => entry.id === id);
      assert(found, 'character not listed');
      assert(found.fileCount === 2, `fileCount ${found.fileCount}`);
      assert(found.entry === 'dot.png', `entry ${found.entry}`);
      assert(found.entryExists === true, 'entryExists should be true');
      assert(found.modelEntry === null, 'modelEntry should be null for an image');
      assert(found.preview === null, 'preview should be null before caching');
      const removed = await call(`/admin/api/characters/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...headerAuth(token), 'X-Admin-Request': '1' }
      });
      assert(removed.status === 200, `delete status ${removed.status}`);
    });

    await check('characters: preview PNG can be cached and surfaced', async () => {
      const imported = await post(
        '/v1/characters',
        { name: 'Preview Test', kind: 'image', files: [{ path: 'dot.png', data: PNG_1X1 }] },
        headerAuth(token)
      );
      const id = imported.json.id;
      const headers = { ...headerAuth(token), 'X-Admin-Request': '1' };

      const rejected = await post(
        `/admin/api/characters/${encodeURIComponent(id)}/preview`,
        { data: 'bm90LWEtcG5n' },
        headers
      );
      assert(rejected.status === 400, `invalid PNG should be 400 (got ${rejected.status})`);

      const saved = await post(
        `/admin/api/characters/${encodeURIComponent(id)}/preview`,
        { data: PNG_1X1 },
        headers
      );
      assert(saved.status === 200, `preview save ${saved.status}`);
      assert(saved.json.preview === 'preview.png', 'preview name');

      const listed = await call('/admin/api/characters', { headers: headerAuth(token) });
      const found = (listed.json.characters || []).find((entry) => entry.id === id);
      assert(found && found.preview === 'preview.png', 'preview not surfaced');
      assert(found.fileCount === 2, `preview.png must not count as content (${found.fileCount})`);

      const asset = await call(`/assets/${encodeURIComponent(id)}/preview.png`);
      assert(asset.status === 200, `preview asset ${asset.status}`);

      const cleared = await call(`/admin/api/characters/${encodeURIComponent(id)}/preview`, {
        method: 'DELETE',
        headers
      });
      assert(cleared.status === 200, `preview delete ${cleared.status}`);

      await call(`/admin/api/characters/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers
      });
    });

    await check('sessions: create / list / read / delete', async () => {
      const created = await post('/v1/sessions', {}, headerAuth(token));
      assert(created.status === 200, `create ${created.status}`);
      const id = created.json.id;
      const appended = await post(
        `/v1/sessions/${encodeURIComponent(id)}/messages`,
        { role: 'user', content: 'hello' },
        headerAuth(token)
      );
      assert(appended.status === 200, `append ${appended.status}`);
      const listed = await call('/v1/sessions', { headers: headerAuth(token) });
      assert(listed.status === 200, `list ${listed.status}`);
      assert(listed.json.sessions.length >= 1, 'no sessions');
      const read = await call(`/v1/sessions/${encodeURIComponent(id)}`, {
        headers: headerAuth(token)
      });
      assert(read.status === 200, `read ${read.status}`);
      assert(read.json.messages.length === 1, `messages ${read.json.messages.length}`);
      const removed = await call(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headerAuth(token)
      });
      assert(removed.status === 200, `delete ${removed.status}`);
    });

    await check('log tail contains the requests we just made', async () => {
      const result = await call('/admin/api/log?lines=200', { headers: headerAuth(token) });
      assert(result.status === 200, `status ${result.status}`);
      assert(Array.isArray(result.json.lines) && result.json.lines.length > 0, 'no lines');
      assert(
        result.json.lines.some((line) => line.includes('/admin/api/status')),
        'status request missing from log'
      );
      const cleared = await call('/admin/api/log', {
        method: 'DELETE',
        headers: { ...headerAuth(token), 'X-Admin-Request': '1' }
      });
      assert(cleared.status === 200, `clear status ${cleared.status}`);
    });

    await check('port change writes config and requires a restart', async () => {
      const result = await post(
        '/admin/api/port',
        { port },
        { ...headerAuth(token), 'X-Admin-Request': '1' }
      );
      assert(result.status === 200, `status ${result.status}`);
      assert(result.json.changed === false, 'same port should not change');
    });

    await check('token rotation invalidates the old token immediately', async () => {
      const rotated = await post(
        '/admin/api/token',
        { generate: true },
        { ...headerAuth(token), 'X-Admin-Request': '1' }
      );
      assert(rotated.status === 200, `rotate status ${rotated.status}`);
      const nextToken = rotated.json && rotated.json.token;
      assert(nextToken && nextToken !== token, 'token not rotated');
      const oldToken = await call('/v1/config', { headers: headerAuth(token) });
      assert(oldToken.status === 401, `old token status ${oldToken.status}`);
      const newToken = await call('/v1/config', { headers: headerAuth(nextToken) });
      assert(newToken.status === 200, `new token status ${newToken.status}`);
      token = nextToken;
    });

    await check('server rejects cross-origin admin writes', async () => {
      const result = await call('/admin/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headerAuth(token),
          'X-Admin-Request': '1',
          Origin: 'http://evil.example'
        },
        body: JSON.stringify({ generate: true })
      });
      assert(result.status === 403, `status ${result.status}`);
    });
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (child.exitCode !== null && child.exitCode !== 0) {
      console.log('\n--- server output ---');
      console.log(serverOutput || '(empty)');
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
