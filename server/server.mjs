// Ice Agent standalone server.
// Runs independently of the desktop pet. All state lives in D:\IceAgent.
// Start:  node D:\IceAgent\server\server.mjs
import { createServer } from 'node:http';
import {
  appendFile,
  open,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  stat,
  truncate
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER_VERSION = 2;
const ROOT = process.env.ICE_AGENT_DATA || 'D:\\IceAgent';
const SESSIONS = join(ROOT, 'sessions');
const CHARACTERS = join(ROOT, 'characters');
const CONFIG_PATH = join(ROOT, 'config.json');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = existsSync(join(SERVER_DIR, 'admin'))
  ? join(SERVER_DIR, 'admin')
  : join(ROOT, 'server', 'admin');
const ADMIN_READY = existsSync(join(ADMIN_DIR, 'index.html'));
const STARTED_AT = Date.now();

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
      entries.push({
        id: name.replace(/\.json$/, ''),
        name: value.name || name,
        version: value.version ?? null
      });
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
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
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

async function readJsonObject(req) {
  const raw = (await readBody(req)).trim();
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw httpError(400, 'JSON 解析失败');
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJoin(base, relative) {
  const target = resolve(base, relative.replace(/^[/\\]+/, ''));
  if (!target.startsWith(resolve(base) + sep) && target !== resolve(base)) return null;
  return target;
}

function sameString(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkToken(req, token = config.token) {
  const header = String(req.headers.authorization ?? '').trim();
  if (!token || !header.startsWith('Bearer ')) return false;
  return sameString(header.slice(7).trim(), token);
}

function text(res, status, body) {
  if (res.headersSent) return res.end();
  const payload = Buffer.from(String(body ?? ''));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  return res.end(payload);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJsonLimited(req, limit = 1000000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw httpError(400, 'JSON 解析失败');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, '请求体需为 JSON 对象');
  }
  return value;
}

function isPortFree(port) {
  return new Promise((settle) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => settle(false));
    probe.once('listening', () => probe.close(() => settle(true)));
    probe.listen(port, '0.0.0.0');
  });
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

// ---------------------------------------------------------------------------
// Admin console: localhost only.
//   GET /admin, /admin/<asset>   static UI (server/admin)
//   /admin/api/*                 privileged JSON API (Bearer token + localhost)
// ---------------------------------------------------------------------------

let listeningPort = config.port;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8'
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${String(req.headers.host ?? '')}`;
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : '';
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return '';
  }
}

function normalizePersona(content, id) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw httpError(400, '人格内容需为 JSON 对象');
  }
  const next = { ...content };
  if (typeof next.name !== 'string' || !next.name.trim()) next.name = id;
  return next;
}

async function walkFiles(dir, base = '', depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length > 800) break;
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(join(dir, entry.name), relative, depth + 1)));
    } else if (entry.isFile()) {
      const info = await stat(join(dir, entry.name)).catch(() => null);
      out.push({ path: relative, size: info ? info.size : 0 });
    }
  }
  return out;
}

async function adminStatus() {
  const [sessionNames, personaList, characterList] = await Promise.all([
    sessionFiles(),
    listPersonas(config),
    listCharacters()
  ]);
  let logSize = 0;
  try {
    logSize = (await stat(LOG_PATH)).size;
  } catch {
    /* no log yet */
  }
  return {
    ok: true,
    name: 'Ice Agent Server',
    version: SERVER_VERSION,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    startedAt: STARTED_AT,
    root: ROOT,
    port: config.port,
    listeningPort,
    portPending: config.port !== listeningPort,
    baseUrl: config.baseUrl,
    model: config.model,
    activePersona: config.activePersona || 'default',
    personasDir: personasDir(config),
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
    adminDir: ADMIN_READY ? ADMIN_DIR : null,
    counts: {
      sessions: sessionNames.length,
      personas: personaList.length,
      characters: characterList.length
    },
    logSize,
    memoryRss: Math.round(process.memoryUsage().rss / 1048576)
  };
}

function adminSettings() {
  const { token, ...rest } = config;
  return {
    config: rest,
    tokenMasked: maskToken(token),
    tokenConfigured: Boolean(token),
    voiceDefaults: DEFAULTS.voice
  };
}

async function readLogTail(maxBytes = 4 * 1024 * 1024) {
  let info;
  try {
    info = await stat(LOG_PATH);
  } catch {
    return { text: '', size: 0, truncated: false };
  }
  if (info.size <= maxBytes) {
    try {
      return { text: await readFile(LOG_PATH, 'utf8'), size: info.size, truncated: false };
    } catch {
      return { text: '', size: info.size, truncated: false };
    }
  }
  const handle = await open(LOG_PATH, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, info.size - maxBytes);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return { text: text.slice(text.indexOf('\n') + 1), size: info.size, truncated: true };
  } finally {
    await handle.close();
  }
}

async function readLog(url) {
  const requested = Number(url.searchParams.get('lines') ?? 300);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 300, 20),
    5000
  );
  const query = String(url.searchParams.get('q') ?? '')
    .trim()
    .toLowerCase();
  const tail = await readLogTail();
  const all = tail.text.split(/\r?\n/).filter((line) => line.length > 0);
  const matched = query ? all.filter((line) => line.toLowerCase().includes(query)) : all;
  return {
    path: LOG_PATH,
    size: tail.size,
    truncated: tail.truncated,
    total: all.length,
    matched: matched.length,
    lines: matched.slice(-limit)
  };
}

async function adminPersonas() {
  const dir = personasDir(config);
  const active = config.activePersona || 'default';
  const names = existsSync(dir) ? await readdir(dir) : [];
  const personas = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const file = join(dir, name);
    try {
      const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      let content = null;
      let invalid = false;
      try {
        content = JSON.parse(raw);
      } catch {
        invalid = true;
      }
      const id = name.replace(/\.json$/, '');
      personas.push({
        id,
        name: content?.name ?? id,
        version: content?.version ?? null,
        active: id === active,
        invalid,
        size: info.size,
        updatedAt: Math.round(info.mtimeMs),
        content
      });
    } catch {
      /* skip unreadable persona */
    }
  }
  personas.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
  return { dir, active, personas };
}

async function adminCharacters() {
  const names = existsSync(CHARACTERS) ? await readdir(CHARACTERS) : [];
  const characters = [];
  for (const id of names) {
    const folder = join(CHARACTERS, id);
    const metaPath = join(folder, 'character.json');
    if (!existsSync(metaPath)) continue;
    let meta = {};
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      meta = {};
    }
    const files = (await walkFiles(folder)).filter((file) => file.path !== 'preview.png');
    const size = files.reduce((sum, file) => sum + file.size, 0);
    const metaInfo = await stat(metaPath).catch(() => null);
    const folderInfo = await stat(folder).catch(() => null);
    const entry = meta.entry ? String(meta.entry) : null;
    const entryPath = entry ? safeJoin(folder, entry) : null;
    const entryExists = Boolean(entryPath && existsSync(entryPath));
    const modelEntry = files.find((file) => /\.model3\.json$/i.test(file.path))?.path ?? null;
    const preview = existsSync(join(folder, 'preview.png')) ? 'preview.png' : null;
    const previewInfo = preview ? await stat(join(folder, 'preview.png')).catch(() => null) : null;
    characters.push({
      id,
      name: meta.name ?? id,
      kind: meta.kind ?? 'image',
      entry,
      entryExists,
      modelEntry,
      preview,
      previewAt: previewInfo ? Math.round(previewInfo.mtimeMs) : null,
      files,
      fileCount: files.length,
      size,
      updatedAt: metaInfo
        ? Math.round(metaInfo.mtimeMs)
        : folderInfo
          ? Math.round(folderInfo.mtimeMs)
          : null
    });
  }
  characters.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return characters;
}

async function serveAdminFile(res, relative) {
  if (!ADMIN_READY) {
    return text(res, 503, `管理后台未安装：缺少 ${join(ADMIN_DIR, 'index.html')}`);
  }
  const target = safeJoin(ADMIN_DIR, relative || 'index.html');
  if (!target) return text(res, 404, 'not found');
  let buffer;
  try {
    buffer = await readFile(target);
  } catch {
    return text(res, 404, 'not found');
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  res.end(buffer);
}

async function handleAdmin(req, res, url) {
  if (!isLoopback(req)) {
    return text(res, 403, '管理后台仅允许本机（127.0.0.1）访问');
  }
  const path = url.pathname;
  if (path.startsWith('/admin/api/')) {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin not allowed' });
    return handleAdminApi(req, res, url);
  }
  if (path === '/admin') {
    res.writeHead(301, { Location: '/admin/', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' });
  }
  return serveAdminFile(res, path.slice('/admin/'.length));
}

async function handleAdminApi(req, res, url) {
  try {
    const method = req.method ?? 'GET';
    const readOnly = method === 'GET' || method === 'HEAD';
    if (!readOnly && req.headers['x-admin-request'] !== '1') {
      return json(res, 400, { error: '缺少 X-Admin-Request 请求头' });
    }
    if (!config.token || !checkToken(req)) return json(res, 401, { error: 'unauthorized' });

    const endpoint = url.pathname.slice('/admin/api/'.length).replace(/\/+$/, '');
    const parts = endpoint.split('/').filter(Boolean);

    if (parts.length === 1 && parts[0] === 'status' && readOnly) {
      return json(res, 200, await adminStatus());
    }
    if (parts.length === 1 && parts[0] === 'settings' && readOnly) {
      return json(res, 200, adminSettings());
    }
    if (parts.length === 1 && parts[0] === 'token' && method === 'POST') {
      const payload = await readJsonLimited(req);
      const token =
        payload.generate === true
          ? randomBytes(16).toString('hex')
          : String(payload.token ?? '').trim();
      if (!/^[A-Za-z0-9._~-]{16,128}$/.test(token)) {
        return json(res, 400, { error: 'token 需为 16–128 位字母、数字或 . _ ~ -' });
      }
      config.token = token;
      await saveConfig(config);
      console.log('[ice-server] admin rotated the access token');
      return json(res, 200, { ok: true, token });
    }
    if (parts.length === 1 && parts[0] === 'port' && method === 'POST') {
      const payload = await readJsonLimited(req);
      const port = Number(payload.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return json(res, 400, { error: '端口需为 1–65535 的整数' });
      }
      if (port === config.port) return json(res, 200, { ok: true, port, changed: false });
      if (!(await isPortFree(port))) return json(res, 409, { error: `端口 ${port} 已被占用` });
      const previous = config.port;
      config.port = port;
      await saveConfig(config);
      console.log(`[ice-server] port ${previous} -> ${port} (restart required)`);
      return json(res, 200, { ok: true, port, previous, restartRequired: true });
    }
    if (parts.length === 1 && parts[0] === 'log') {
      if (readOnly) return json(res, 200, await readLog(url));
      if (method === 'DELETE') {
        await truncate(LOG_PATH, 0).catch(() => undefined);
        return json(res, 200, { ok: true });
      }
    }
    if (parts.length === 2 && parts[0] === 'log' && parts[1] === 'download' && readOnly) {
      const raw = await readFile(LOG_PATH, 'utf8').catch(() => '');
      const payload = Buffer.from(raw);
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="requests-${day}.log"`,
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
      });
      return res.end(payload);
    }

    if (parts[0] === 'personas') {
      const dir = personasDir(config);
      if (parts.length === 1 && readOnly) return json(res, 200, await adminPersonas());
      if (parts.length === 1 && method === 'POST') {
        const payload = await readJsonLimited(req);
        const id = normalizeId(payload.id);
        if (!id) return json(res, 400, { error: 'id 需为 1–64 位字母、数字、点、下划线或短横线' });
        const file = safeJoin(dir, `${id}.json`);
        if (!file) return json(res, 400, { error: 'invalid id' });
        if (existsSync(file) && payload.overwrite !== true) {
          return json(res, 409, { error: '人格已存在' });
        }
        const content = normalizePersona(payload.content, id);
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(content, null, 2), 'utf8');
        return json(res, 200, { ok: true, id, name: content.name });
      }
      if (parts.length === 2 && method === 'POST') {
        const id = normalizeId(decodeSegment(parts[1]));
        if (!id) return json(res, 400, { error: 'invalid id' });
        const file = safeJoin(dir, `${id}.json`);
        if (!file || !existsSync(file)) return json(res, 404, { error: '人格不存在' });
        const payload = await readJsonLimited(req);
        const content = normalizePersona(payload.content, id);
        await writeFile(file, JSON.stringify(content, null, 2), 'utf8');
        return json(res, 200, { ok: true, id, name: content.name });
      }
      if (parts.length === 2 && method === 'DELETE') {
        const id = normalizeId(decodeSegment(parts[1]));
        if (!id) return json(res, 400, { error: 'invalid id' });
        if ((config.activePersona || 'default') === id) {
          return json(res, 409, { error: '不能删除正在使用的人格' });
        }
        const file = safeJoin(dir, `${id}.json`);
        if (!file || !existsSync(file)) return json(res, 404, { error: '人格不存在' });
        await rm(file, { force: true });
        return json(res, 200, { ok: true, id });
      }
    }

    if (parts[0] === 'characters') {
      if (parts.length === 1 && readOnly) {
        return json(res, 200, { characters: await adminCharacters() });
      }
      if (parts.length === 3 && parts[2] === 'preview' && method === 'POST') {
        const id = decodeSegment(parts[1]);
        if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
          return json(res, 400, { error: 'invalid id' });
        }
        const folder = safeJoin(CHARACTERS, id);
        if (!folder || !existsSync(folder)) return json(res, 404, { error: '角色不存在' });
        const payload = await readJsonLimited(req, 12 * 1024 * 1024);
        const raw = String(payload.data || '').replace(/^data:image\/png;base64,/, '');
        if (!raw) return json(res, 400, { error: '缺少预览图数据' });
        const buffer = Buffer.from(raw, 'base64');
        if (buffer.length < 64 || buffer.length > 6 * 1024 * 1024) {
          return json(res, 400, { error: '预览图大小无效' });
        }
        if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          return json(res, 400, { error: '预览图必须是 PNG' });
        }
        await writeFile(join(folder, 'preview.png'), buffer);
        return json(res, 200, { ok: true, preview: 'preview.png', bytes: buffer.length });
      }
      if (parts.length === 3 && parts[2] === 'preview' && method === 'DELETE') {
        const id = decodeSegment(parts[1]);
        if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
          return json(res, 400, { error: 'invalid id' });
        }
        const folder = safeJoin(CHARACTERS, id);
        if (!folder || !existsSync(folder)) return json(res, 404, { error: '角色不存在' });
        await rm(join(folder, 'preview.png'), { force: true });
        return json(res, 200, { ok: true });
      }
      if (parts.length === 2 && method === 'DELETE') {
        const id = decodeSegment(parts[1]);
        if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
          return json(res, 400, { error: 'invalid id' });
        }
        const target = safeJoin(CHARACTERS, id);
        if (!target || target === resolve(CHARACTERS)) {
          return json(res, 400, { error: 'invalid id' });
        }
        if (!existsSync(target)) return json(res, 404, { error: '角色不存在' });
        await rm(target, { recursive: true, force: true });
        return json(res, 200, { ok: true, id });
      }
    }

    return json(res, 404, { error: `unknown admin endpoint: ${endpoint}` });
  } catch (error) {
    if (!res.headersSent) {
      return json(res, error?.status ?? 500, { error: String(error?.message ?? error) });
    }
    res.end();
  }
  return undefined;
}

async function route(req, res) {
  const startedAt = Date.now();
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    logRequest(req, status, startedAt);
    return originalWriteHead(status, ...rest);
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Admin console is handled before CORS/auth: it has its own localhost-only guard.
  if (path === '/admin' || path.startsWith('/admin/')) {
    return handleAdmin(req, res, url);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    return res.end();
  }
  if (path === '/v1/health') {
    return json(res, 200, {
      ok: true,
      name: 'Ice Agent Server',
      root: ROOT,
      version: SERVER_VERSION
    });
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

  if (!config.token || !checkToken(req)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (path === '/v1/personas' && req.method === 'GET') {
    return json(res, 200, {
      personas: await listPersonas(config),
      active: config.activePersona || 'default'
    });
  }
  if (path === '/v1/personas/active' && req.method === 'POST') {
    const payload = await readJsonObject(req);
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
    const patch = await readJsonObject(req);
    if (patch.persona !== undefined) {
      await savePersona(config, patch.persona);
      delete patch.persona;
    }
    if (patch.voice && typeof patch.voice === 'object' && !Array.isArray(patch.voice)) {
      const nextVoice = { ...config.voice, ...patch.voice };
      if (patch.voice.commands && typeof patch.voice.commands === 'object') {
        nextVoice.commands = { ...config.voice.commands, ...patch.voice.commands };
      }
      config.voice = nextVoice;
    }
    for (const key of ['baseUrl', 'model', 'port', 'apiKey', 'personaFile']) {
      if (patch[key] !== undefined) config[key] = patch[key];
    }
    if (typeof patch.personasDir === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(patch.personasDir)) {
      config.personasDir = patch.personasDir;
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
    return json(res, 200, {
      asr,
      tts,
      whisperUrl: config.voice.whisperUrl,
      ttsUrl: config.voice.ttsUrl
    });
  }

  if ((path === '/v1/voice/start' || path === '/v1/voice/stop') && req.method === 'POST') {
    try {
      const payload = await readJsonObject(req);
      const service = payload.service === 'sovits' ? 'sovits' : 'whisper';
      const key = `${service}${path.endsWith('start') ? 'Start' : 'Stop'}`;
      const command = config.voice.commands?.[key];
      if (!command)
        return json(res, 501, { error: `no command configured for voice.commands.${key}` });
      const { spawn } = await import('node:child_process');
      const child = spawn('wsl', ['-e', 'bash', '-lc', command], {
        detached: true,
        // Without this Windows gives the console child (wsl.exe) a visible
        // console window every time the pet autostarts the voice services.
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
      return json(res, 200, {
        ok: true,
        service,
        action: path.endsWith('start') ? 'start' : 'stop'
      });
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
      const upstream = await fetch(`${config.voice.whisperUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form
      });
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
      const payload = await readJsonObject(req);
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
    const payload = await readJsonObject(req);
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
    const meta = {
      id,
      name: String(payload.name ?? 'Imported'),
      kind: payload.kind ?? 'image',
      entry
    };
    await writeFile(join(dir, 'character.json'), JSON.stringify(meta, null, 2), 'utf8');
    return json(res, 200, meta);
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  void route(req, res).catch((error) => {
    console.error('[ice-server] request failed', error);
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, error?.status ?? 500, { error: String(error?.message ?? error) });
  });
});

server.listen(config.port, '0.0.0.0', () => {
  listeningPort = config.port;
  console.log(`[ice-server] listening on http://0.0.0.0:${config.port}`);
  console.log(`[ice-server] data root: ${ROOT}`);
  console.log(`[ice-server] token file: ${CONFIG_PATH}`);
  if (ADMIN_READY) {
    console.log(`[ice-server] admin console: http://127.0.0.1:${config.port}/admin/`);
  } else {
    console.log(`[ice-server] admin console unavailable: ${join(ADMIN_DIR, 'index.html')} missing`);
  }
});
