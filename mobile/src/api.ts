import type { Settings } from './storage';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function streamChat(
  settings: Settings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<void> {
  const base = settings.baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Base URL 需要以 http(s):// 开头');
  if (!settings.apiKey.trim()) throw new Error('请先在设置里填写 API Key');

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'system', content: settings.persona }, ...messages],
      stream: true,
      temperature: 0.8,
      max_tokens: 1200
    }),
    signal
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`请求失败 ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  if (!response.body) throw new Error('响应没有内容');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        /* ignore malformed keep-alive chunks */
      }
    }
  }
}


export async function streamChatViaServer(
  serverUrl: string,
  token: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
  model = 'deepseek-chat'
): Promise<void> {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Server URL 需要以 http(s):// 开头');
  const response = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.trim()}`
    },
    body: JSON.stringify({ model, messages }),
    signal
  });
  if (!response.ok) throw new Error(`server ${response.status}`);
  if (!response.body) throw new Error('no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        /* ignore */
      }
    }
  }
}


export async function chatViaServerOnce(
  serverUrl: string,
  token: string,
  settings: { model: string; persona: string },
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Server URL 需要以 http(s):// 开头');
  const response = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      messages: [{ role: 'system', content: settings.persona }, ...messages]
    }),
    signal
  });
  if (!response.ok) throw new Error(`server ${response.status}`);
  const payload = (await response.json()) as { content?: string };
  return (payload.content ?? '').trim();
}


export type ServerSession = { id: string; title: string; createdAt: number; count: number };
export type ServerSessionDetail = {
  id: string;
  title: string;
  createdAt: number;
  messages: { role: 'user' | 'assistant'; content: string; ts: number }[];
};

function serverBase(url: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Server URL 需要以 http(s):// 开头');
  return base;
}

export async function serverSessionList(url: string, token: string): Promise<ServerSession[]> {
  const response = await fetch(`${serverBase(url)}/v1/sessions`, {
    headers: { Authorization: `Bearer ${token.trim()}` }
  });
  if (!response.ok) throw new Error(`sessions ${response.status}`);
  const payload = (await response.json()) as { sessions?: ServerSession[] };
  return payload.sessions ?? [];
}

export async function serverSessionDetail(url: string, token: string, id: string): Promise<ServerSessionDetail> {
  const response = await fetch(`${serverBase(url)}/v1/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token.trim()}` }
  });
  if (!response.ok) throw new Error(`session ${response.status}`);
  return (await response.json()) as ServerSessionDetail;
}

export async function serverSessionCreate(url: string, token: string): Promise<ServerSessionDetail> {
  const response = await fetch(`${serverBase(url)}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({})
  });
  if (!response.ok) throw new Error(`create ${response.status}`);
  return (await response.json()) as ServerSessionDetail;
}

export async function serverSessionAppend(
  url: string,
  token: string,
  id: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await fetch(`${serverBase(url)}/v1/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({ role, content })
  }).catch(() => undefined);
}

export async function serverSessionDelete(url: string, token: string, id: string): Promise<void> {
  await fetch(`${serverBase(url)}/v1/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token.trim()}` }
  }).catch(() => undefined);
}
