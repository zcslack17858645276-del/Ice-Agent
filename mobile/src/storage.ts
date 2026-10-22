import { Preferences } from '@capacitor/preferences';

export type ChatMessage = { role: 'user' | 'assistant'; content: string; ts?: number };

export type Session = {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
};

export type Theme = 'light' | 'dark';

export type Settings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  persona: string;
  theme: Theme;
  notify: boolean;
  serverUrl: string;
  serverToken: string;
  useServer: boolean;
};

export const defaultSettings: Settings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  persona:
    '你是 Ice，一只住在手机里的桌宠。说话自然、简短、有点俏皮，默认用中文。不使用列表和标题，除非用户要求。',
  theme: 'light',
  notify: true,
  serverUrl: '',
  serverToken: '',
  useServer: false
};

const settingsKey = 'ice-agent.settings';
const sessionsKey = 'ice-agent.sessions.v1';
const activeKey = 'ice-agent.active-session.v1';
const legacyHistoryKey = 'ice-agent.history';

/** Where Android stores all Capacitor Preferences data (settings + sessions). */
export const androidStoragePath =
  '/data/data/com.iceagent.mobile/shared_prefs/CapacitorStorage.xml';

export async function loadSettings(): Promise<Settings> {
  const { value } = await Preferences.get({ key: settingsKey });
  if (!value) return defaultSettings;
  try {
    const parsed = JSON.parse(value) as Partial<Settings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await Preferences.set({ key: settingsKey, value: JSON.stringify(settings) });
}

export async function clearSettings(): Promise<void> {
  await Preferences.remove({ key: settingsKey });
}

export function newSession(messages: ChatMessage[] = []): Session {
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: '新的对话',
    createdAt: Date.now(),
    messages
  };
}

export async function loadSessions(): Promise<{ sessions: Session[]; activeId: string }> {
  const [{ value }, { value: active }] = await Promise.all([
    Preferences.get({ key: sessionsKey }),
    Preferences.get({ key: activeKey })
  ]);
  let sessions: Session[] = [];
  if (value) {
    try {
      const parsed = JSON.parse(value) as Session[];
      if (Array.isArray(parsed)) sessions = parsed.filter((item) => item?.id);
    } catch {
      sessions = [];
    }
  }
  if (sessions.length === 0) {
    // Migrate the single-conversation history of the first release.
    const { value: legacy } = await Preferences.get({ key: legacyHistoryKey });
    let messages: ChatMessage[] = [];
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as ChatMessage[];
        if (Array.isArray(parsed)) messages = parsed;
      } catch {
        messages = [];
      }
    }
    sessions = [newSession(messages)];
    await Preferences.remove({ key: legacyHistoryKey });
  }
  const activeId =
    active && sessions.some((session) => session.id === active) ? active : sessions[0].id;
  return { sessions, activeId };
}

export async function saveSessions(sessions: Session[], activeId: string): Promise<void> {
  await Preferences.set({ key: sessionsKey, value: JSON.stringify(sessions.slice(-40)) });
  await Preferences.set({ key: activeKey, value: activeId });
}

export function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!first) return '新的对话';
  const text = first.content.trim().replace(/\s+/g, ' ');
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}
