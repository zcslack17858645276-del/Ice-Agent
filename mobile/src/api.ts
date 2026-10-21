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
