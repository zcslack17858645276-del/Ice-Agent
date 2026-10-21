import { Preferences } from '@capacitor/preferences';

export type Settings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  persona: string;
};

export const defaultSettings: Settings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  persona:
    '你是 Ice，一只住在手机里的桌宠。说话自然、简短、有点俏皮，默认用中文。不使用列表和标题，除非用户要求。'
};

const settingsKey = 'ice-agent.settings';
const historyKey = 'ice-agent.history';

/** Where Android stores the Capacitor Preferences file (for manual edit/delete). */
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

export async function loadHistory(): Promise<ChatMessage[]> {
  const { value } = await Preferences.get({ key: historyKey });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.slice(-80) : [];
  } catch {
    return [];
  }
}

export async function saveHistory(messages: ChatMessage[]): Promise<void> {
  await Preferences.set({ key: historyKey, value: JSON.stringify(messages.slice(-80)) });
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
