const TOKEN_KEY = 'ice.admin.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function isTokenRemembered() {
  try {
    return Boolean(localStorage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

export function setToken(token, remember) {
  clearToken();
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    /* storage may be unavailable in private mode */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(status, data, ms) {
    const message =
      data && typeof data === 'object' && data.error ? String(data.error) : `HTTP ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.ms = ms;
  }
}

let unauthorizedHandler = null;

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export async function request(path, options = {}) {
  const { method = 'GET', body, token, admin = false } = options;
  const headers = {};
  const authToken = token === undefined ? getToken() : token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && method !== 'GET') headers['X-Admin-Request'] = '1';

  const started = performance.now();
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
  } catch (error) {
    throw new ApiError(
      0,
      { error: `网络错误：${error && error.message ? error.message : error}` },
      0
    );
  }
  const ms = Math.round(performance.now() - started);
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }
  if (!response.ok) {
    if (response.status === 401 && token === undefined) {
      if (unauthorizedHandler) unauthorizedHandler();
    }
    throw new ApiError(response.status, data, ms);
  }
  return { status: response.status, ms, data, raw };
}

export const v1 = {
  health: () => request('/v1/health', { token: '' }),
  config: () => request('/v1/config'),
  patchConfig: (patch) => request('/v1/config', { method: 'POST', body: patch }),
  personas: () => request('/v1/personas'),
  activatePersona: (id) => request('/v1/personas/active', { method: 'POST', body: { id } }),
  sessions: () => request('/v1/sessions'),
  createSession: () => request('/v1/sessions', { method: 'POST', body: {} }),
  session: (id) => request(`/v1/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id) => request(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  characters: () => request('/v1/characters'),
  importCharacter: (payload) => request('/v1/characters', { method: 'POST', body: payload }),
  voiceStatus: () => request('/v1/voice/status'),
  voice: (action, service) => request(`/v1/voice/${action}`, { method: 'POST', body: { service } }),
  chat: (payload) => request('/v1/chat', { method: 'POST', body: payload })
};

export const admin = {
  status: () => request('/admin/api/status'),
  settings: () => request('/admin/api/settings'),
  log: (params = {}) => {
    const lines = Number(params.lines) || 300;
    const query = String(params.q || '');
    return request(`/admin/api/log?lines=${lines}&q=${encodeURIComponent(query)}`);
  },
  clearLog: () => request('/admin/api/log', { method: 'DELETE', admin: true }),
  personas: () => request('/admin/api/personas'),
  createPersona: (payload) =>
    request('/admin/api/personas', { method: 'POST', body: payload, admin: true }),
  updatePersona: (id, payload) =>
    request(`/admin/api/personas/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: payload,
      admin: true
    }),
  deletePersona: (id) =>
    request(`/admin/api/personas/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  characters: () => request('/admin/api/characters'),
  deleteCharacter: (id) =>
    request(`/admin/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  savePreview: (id, data) =>
    request(`/admin/api/characters/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body: { data },
      admin: true
    }),
  clearPreview: (id) =>
    request(`/admin/api/characters/${encodeURIComponent(id)}/preview`, {
      method: 'DELETE',
      admin: true
    }),
  rotateToken: (token) =>
    request('/admin/api/token', {
      method: 'POST',
      body: token ? { token } : { generate: true },
      admin: true
    }),
  setPort: (port) => request('/admin/api/port', { method: 'POST', body: { port }, admin: true })
};

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatShortTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

export function relativeTime(value) {
  const stamp = Number(value);
  if (!stamp) return '—';
  const diff = Date.now() - stamp;
  if (diff < 0) return formatShortTime(stamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatShortTime(stamp);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
