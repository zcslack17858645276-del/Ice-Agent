// Ice Agent standalone server.
// Runs independently of the desktop pet. All state lives in D:\IceAgent.
// Start:  node D:\IceAgent\server\server.mjs
import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = process.env.ICE_AGENT_DATA || 'D:\\IceAgent';
const SESSIONS = join(ROOT, 'sessions');
const CHARACTERS = join(ROOT, 'characters');
const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULTS = {
  voice: {
    whisperUrl: 'http://127.0.0.1:8000',
    ttsUrl: 'http://127.0.0.1:9880',
    enabled: true,
    referenceAudio: '',
    referenceTranscript: '',
    referenceLanguage: 'zh',
    commands: {
      whisperStart: '',
      whisperStop: '',
      sovitsStart: '',
      sovitsStop: ''
    }
  },
  port: 8787,
  token: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  persona:
    '你是 Ice，一只住在电脑里的桌宠。说话自然、简短、有点俏皮，默认用中文。不使用列表和标题，除非用户要求。'
};

async function ensureDirs() {
  await mkdir(SESSIONS, { recursive: true });
  await mkdir(CHARACTERS, { recursive: true });
}

async function loadConfig() {
  await ensureDirs();
  let config = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      const stored = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
      config = { ...config, ...stored, voice: { ...config.voice, ...(stored.voice ?? {}) } };
    } catch {
      /* keep defaults */
    }
  }
  if (!config.token) {
    config.token = randomBytes(16).toString('hex');
    await saveConfig(config);
  }
  return config;
}

function personasDir(config) {
  return join(ROOT, config.personasDir || 'personas');
}

async function loadPersona(config) {
  const dir = personasDir(config);
  const id = config.activePersona || 'default';
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function savePersona(config, persona) {
  const dir = personasDir(config);
  await mkdir(dir, { recursive: true });
  const id = config.activePersona || 'default';
  await writeFile(join(dir, `${id}.json`), JSON.stringify(persona, null, 2), 'utf8');
}

async function listPersonas(config) {
  const dir = personasDir(config);
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8'));
      entries.push({ id: name.replace(/\.json$/, ''), name: value.name || name, version: value.version ?? null });
    } catch {
      /* skip broken persona */
    }
  }
  return entries;
}

async function saveConfig(config) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type'
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

function safeJoin(base, relative) {
  const target = resolve(base, relative.replace(/^[/\\]+/, ''));
  if (!target.startsWith(resolve(base) + sep) && target !== resolve(base)) return null;
  return target;
}

async function sessionFiles() {
  try {
    return (await readdir(SESSIONS)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

async function readSession(id) {
  const path = safeJoin(SESSIONS, `${id}.json`);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeSession(session) {
  await writeFile(join(SESSIONS, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8');
}

async function listSessions() {
  const sessions = [];
  for (const name of await sessionFiles()) {
    try {
      sessions.push(JSON.parse(await readFile(join(SESSIONS, name), 'utf8')));
    } catch {
      /* skip broken file */
    }
  }
  return sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

async function listCharacters() {
  const entries = [];
  for (const name of await readdir(CHARACTERS)) {
    const meta = join(CHARACTERS, name, 'character.json');
    if (!existsSync(meta)) continue;
    try {
      entries.push(JSON.parse(await readFile(meta, 'utf8')));
    } catch {
      /* skip */
    }
  }
  return entries;
}

function newSession(title = '新的对话') {
  return {
    id: `s-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title,
    createdAt: Date.now(),
    messages: []
  };
}

async function handleChat(req, res, config, body) {
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return json(res, 400, { error: 'bad json' });
  }
  const messages = payload.messages;
  if (!Array.isArray(messages)) return json(res, 400, { error: 'messages missing' });
  const key = config.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) return json(res, 500, { error: 'DEEPSEEK_API_KEY not set for the server' });
  const model = payload.model || config.model;
  const stream = payload.stream !== false;

  const upstream = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, stream, temperature: 0.8, max_tokens: 1200 })
  });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return json(res, 502, { error: `upstream ${upstream.status}`, detail: text.slice(0, 300) });
  }

  if (!stream) {
    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    return json(res, 200, { content });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const config = await loadConfig();
const LOG_PATH = join(ROOT, 'server', 'requests.log');

function logRequest(req, status, startedAt) {
  const line = `${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${status} ${Date.now() - startedAt}ms\n`;
  void appendFile(LOG_PATH, line).catch(() => undefined);
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    logRequest(req, status, startedAt);
    return originalWriteHead(status, ...rest);
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    return res.end();
  }
  if (path === '/v1/health') {
    return json(res, 200, { ok: true, name: 'Ice Agent Server', root: ROOT, version: 1 });
  }

  if (path.startsWith('/assets/')) {
    const relative = decodeURIComponent(path.slice('/assets/'.length));
    const target = safeJoin(CHARACTERS, relative);
    if (!target || !existsSync(target)) return json(res, 404, { error: 'missing' });
    const ext = extname(target).toLowerCase();
    const types = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.json': 'application/json',
      '.moc3': 'application/octet-stream'
    };
    const buffer = await readFile(target);
    res.writeHead(200, {
      'Content-Type': types[ext] ?? 'application/octet-stream',
      'Content-Length': buffer.length,
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(buffer);
  }

  const auth = (req.headers.authorization ?? '').trim();
  if (!config.token || auth !== `Bearer ${config.token}`) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (path === '/v1/personas' && req.method === 'GET') {
    return json(res, 200, { personas: await listPersonas(config), active: config.activePersona || 'default' });
  }
  if (path === '/v1/personas/active' && req.method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const id = String(payload.id ?? '').trim();
    if (!id) return json(res, 400, { error: 'id required' });
    const file = join(personasDir(config), `${id}.json`);
    if (!existsSync(file)) return json(res, 404, { error: 'persona missing' });
    config.activePersona = id;
    await saveConfig(config);
    return json(res, 200, { active: id });
  }

  if (path === '/v1/config' && req.method === 'GET') {
    const { token, ...safe } = config;
    const persona = await loadPersona(config);
    if (persona) safe.persona = persona;
    return json(res, 200, { config: safe, tokenConfigured: Boolean(token) });
  }
  if (path === '/v1/config' && req.method === 'POST') {
    const patch = JSON.parse((await readBody(req)) || '{}');
    if (patch.persona !== undefined) {
      await savePersona(config, patch.persona);
      delete patch.persona;
    }
    for (const key of ['baseUrl', 'model', 'port', 'apiKey', 'personaFile']) {
      if (patch[key] !== undefined) config[key] = patch[key];
    }
    await saveConfig(config);
    const { token, ...safe } = config;
    const persona = await loadPersona(config);
    if (persona) safe.persona = persona;
    return json(res, 200, { config: safe });
  }


  if (path === '/v1/voice/status' && req.method === 'GET') {
    const probe = async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return response.status < 500;
      } catch {
        return false;
      }
    };
    const [asr, tts] = await Promise.all([
      probe(`${config.voice.whisperUrl}/`),
      probe(`${config.voice.ttsUrl}/`)
    ]);
    return json(res, 200, { asr, tts, whisperUrl: config.voice.whisperUrl, ttsUrl: config.voice.ttsUrl });
  }


  if ((path === '/v1/voice/start' || path === '/v1/voice/stop') && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const service = payload.service === 'sovits' ? 'sovits' : 'whisper';
      const key = `${service}${path.endsWith('start') ? 'Start' : 'Stop'}`;
      const command = config.voice.commands?.[key];
      if (!command) return json(res, 501, { error: `no command configured for voice.commands.${key}` });
      const { spawn } = await import('node:child_process');
      const child = spawn('wsl', ['-e', 'bash', '-lc', command], { detached: true, stdio: 'ignore' });
      child.unref();
      return json(res, 200, { ok: true, service, action: path.endsWith('start') ? 'start' : 'stop' });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (path === '/v1/asr' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const audio = Buffer.from(String(payload.audio ?? ''), 'base64');
      if (audio.length === 0) return json(res, 400, { error: 'audio missing' });
      const form = new FormData();
      form.append('file', new Blob([audio], { type: payload.mime ?? 'audio/wav' }), 'audio.wav');
      form.append('model', 'whisper-1');
      const upstream = await fetch(`${config.voice.whisperUrl}/v1/audio/transcriptions`, { method: 'POST', body: form });
      if (!upstream.ok) return json(res, 502, { error: `whisper ${upstream.status}` });
      const data = await upstream.json();
      return json(res, 200, { text: data.text ?? '' });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (path === '/v1/tts' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const upstream = await fetch(`${config.voice.ttsUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: String(payload.text ?? ''),
          text_lang: payload.lang || config.voice.referenceLanguage || 'zh',
          ref_audio_path: payload.refAudio || config.voice.referenceAudio || '',
          prompt_lang: payload.promptLang || config.voice.referenceLanguage || 'zh',
          prompt_text: payload.promptText || config.voice.referenceTranscript || '',
          media_type: 'wav',
          streaming_mode: false
        })
      });
      if (!upstream.ok) return json(res, 502, { error: `tts ${upstream.status}` });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      return json(res, 200, { audio: buffer.toString('base64'), mime: 'audio/wav' });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if ((path === '/v1/chat' || path === '/v1/chat/completions') && req.method === 'POST') {
    return handleChat(req, res, config, await readBody(req)).catch((error) =>
      json(res, 500, { error: String(error) })
    );
  }

  if (path === '/v1/sessions' && req.method === 'GET') {
    const sessions = (await listSessions()).map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      count: session.messages?.length ?? 0,
      last: session.messages?.at(-1)?.content?.slice(0, 60) ?? ''
    }));
    return json(res, 200, { sessions });
  }
  if (path === '/v1/sessions' && req.method === 'POST') {
    const session = newSession();
    await writeSession(session);
    return json(res, 200, session);
  }
  const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)(\/messages)?$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (sessionMatch[2] && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const session = (await readSession(id)) ?? { ...newSession(), id };
      session.messages = session.messages ?? [];
      session.messages.push({
        role: payload.role === 'assistant' ? 'assistant' : 'user',
        content: String(payload.content ?? ''),
        ts: Date.now()
      });
      if (session.title === '新的对话' && payload.role !== 'assistant') {
        const text = String(payload.content ?? '').slice(0, 18);
        if (text) session.title = text;
      }
      await writeSession(session);
      return json(res, 200, session);
    }
    if (req.method === 'DELETE') {
      const target = safeJoin(SESSIONS, `${id}.json`);
      if (target) await rm(target, { force: true });
      return json(res, 200, { ok: true });
    }
    const session = await readSession(id);
    return session ? json(res, 200, session) : json(res, 404, { error: 'missing' });
  }

  if (path === '/v1/characters' && req.method === 'GET') {
    return json(res, 200, { characters: await listCharacters() });
  }
  if (path === '/v1/characters' && req.method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length === 0) return json(res, 400, { error: 'no files' });
    const slug = String(payload.name ?? 'character')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const id = `${slug || 'character'}-${Date.now() % 100000}`;
    const dir = join(CHARACTERS, id);
    await mkdir(dir, { recursive: true });
    let entry = null;
    for (const file of files) {
      const target = safeJoin(dir, String(file.path ?? ''));
      if (!target) continue;
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, Buffer.from(String(file.data ?? ''), 'base64'));
      const lower = String(file.path ?? '').toLowerCase();
      if (lower.endsWith('.model3.json')) entry = String(file.path);
      else if (!entry && /\.(png|jpg|jpeg|webp)$/.test(lower)) entry = String(file.path);
    }
    if (!entry) {
      await rm(dir, { recursive: true, force: true });
      return json(res, 400, { error: 'no image or model3.json' });
    }
    const meta = { id, name: String(payload.name ?? 'Imported'), kind: payload.kind ?? 'image', entry };
    await writeFile(join(dir, 'character.json'), JSON.stringify(meta, null, 2), 'utf8');
    return json(res, 200, meta);
  }

  json(res, 404, { error: 'not found' });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[ice-server] listening on http://0.0.0.0:${config.port}`);
  console.log(`[ice-server] data root: ${ROOT}`);
  console.log(`[ice-server] token file: ${CONFIG_PATH}`);
});
