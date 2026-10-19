import { useEffect, useState } from 'react';
import { AvatarRegistry } from './avatar/registry';
import { AVATAR_EXPRESSIONS, type AvatarExpression } from './avatar/types';
import { WindowService } from './windowService';
import { invoke } from '@tauri-apps/api/core';
import { ConversationService } from './ai/conversation';
import { TauriOpenAIProvider } from './ai/openaiProvider';
import type { ChatMessage, ModelConfig } from './ai/types';

type PanelKind = 'chat' | 'settings' | 'chat-config';
type Preferences = {
  characterId: string;
  animationEnabled: boolean;
};

const preferencesKey = 'ice-agent.avatar-preferences.v1';
const expressionKey = 'ice-agent.avatar-expression.v1';
const defaults: Preferences = {
  characterId: 'xglk',
  animationEnabled: true
};
const conversationId = 'default';
const modelConfigKey = 'ice-agent.model-config.v1';
const defaultModelConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.7,
  maxOutputTokens: 800, contextWindow: 16, timeoutMs: 30000, retryCount: 2
};

function readModelConfig(): ModelConfig {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(modelConfigKey) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return defaultModelConfig;
    const value = parsed as Record<string, unknown>;
    return { ...defaultModelConfig, baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : defaultModelConfig.baseUrl, model: typeof value.model === 'string' ? value.model : defaultModelConfig.model, temperature: typeof value.temperature === 'number' ? Math.max(0, Math.min(2, value.temperature)) : defaultModelConfig.temperature, maxOutputTokens: typeof value.maxOutputTokens === 'number' ? Math.max(1, Math.min(4096, value.maxOutputTokens)) : defaultModelConfig.maxOutputTokens };
  } catch { return defaultModelConfig; }
}

const conversationService = new ConversationService(
  new TauriOpenAIProvider(),
  undefined,
  readModelConfig()
);

function readPreferences(): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return defaults;
    const stored = raw as Record<string, unknown>;
    return {
      characterId: AvatarRegistry.list().some((asset) => asset.characterId === stored.characterId)
        ? String(stored.characterId)
        : defaults.characterId,
      animationEnabled: stored.animationEnabled === true
    };
  } catch {
    return defaults;
  }
}

export function PanelWindow({ kind }: { kind: PanelKind }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [expression, setExpression] = useState<AvatarExpression>(() => {
    const value = localStorage.getItem(expressionKey);
    return AVATAR_EXPRESSIONS.find((candidate) => candidate === value) ?? 'NEUTRAL';
  });
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(() => conversationService.getConversation(conversationId).messages.filter((item) => item.role !== 'system'));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState(readModelConfig);
  const [apiKey, setApiKey] = useState('');
  const [configStatus, setConfigStatus] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem(expressionKey, expression);
  }, [expression]);

  return (
    <main className="panel-window">
      <header className="panel-window-header">
        <h1>{kind === 'chat' ? 'Chat' : 'Settings'}</h1>
        <button
          className="icon-button"
          aria-label="Close window"
          title="Close window"
          onClick={() => WindowService.closeCurrent().catch(console.error)}
        >
          ×
        </button>
      </header>
      {kind === 'chat' ? (
        <>
          <div className="chat-messages" aria-live="polite">
            {messages.length === 0 && <div className="empty-state"><strong>Start a conversation</strong><span>Responses stream as they are generated.</span></div>}
            {messages.map((item) => <div className={`chat-message ${item.role}`} key={item.id}><span>{item.content || (item.incomplete ? '…' : '')}</span>{item.incomplete && <small> incomplete</small>}</div>)}
            {error && <div className="chat-error" role="alert">{error}</div>}
          </div>
          <form
            className="chat-input"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!message.trim() || sending) return;
              const text = message; setMessage(''); setError(null); setSending(true); localStorage.setItem('ice-agent.pet-state.v1', 'THINKING');
              conversationService.setConfig(modelConfig);
              setMessages([...conversationService.getConversation(conversationId).messages.filter((item) => item.role !== 'system')]);
              try {
                const result = await conversationService.sendMessage(conversationId, text, () => setMessages([...conversationService.getConversation(conversationId).messages.filter((item) => item.role !== 'system')]));
                setMessages([...conversationService.getConversation(conversationId).messages.filter((item) => item.role !== 'system')]);
                localStorage.setItem('ice-agent.pet-state.v1', result.content ? 'HAPPY' : 'SAD');
              } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'The AI request failed.'); setMessages([...conversationService.getConversation(conversationId).messages.filter((item) => item.role !== 'system')]); }
              finally { setSending(false); }
            }}
          >
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write a message"
              aria-label="Message"
            />
            <button aria-label="Send message" title="Send message" disabled={!message.trim() || sending}>
              ➤
            </button>
          </form>
        </>
      ) : kind === 'chat-config' ? (
        <ChatConfiguration config={modelConfig} apiKey={apiKey} onConfigChange={(next) => { setModelConfig(next); localStorage.setItem(modelConfigKey, JSON.stringify(next)); }} onApiKeyChange={setApiKey} status={configStatus} onStatus={setConfigStatus} />
      ) : (
        <div className="panel-window-settings">
          <button className="setting-row setting-link" onClick={() => WindowService.openPanel('chat-config')}> <span>Chat Configuration</span><span aria-hidden="true">›</span></button>
          <label className="setting-row" htmlFor="character-select">
            <span>Character</span>
            <select
              id="character-select"
              value={preferences.characterId}
              onChange={(event) =>
                setPreferences((current) => ({ ...current, characterId: event.target.value }))
              }
            >
              {AvatarRegistry.list().map((character) => (
                <option key={character.characterId} value={character.characterId}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row" htmlFor="animation-toggle">
            <span>Animations</span>
            <input
              id="animation-toggle"
              type="checkbox"
              checked={preferences.animationEnabled}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  animationEnabled: event.target.checked
                }))
              }
            />
          </label>
          <label className="setting-row" htmlFor="expression-select">
            <span>Expression</span>
            <select
              id="expression-select"
              value={expression}
              onChange={(event) => setExpression(event.target.value as AvatarExpression)}
            >
              {AVATAR_EXPRESSIONS.map((value) => (
                <option key={value} value={value}>
                  {value[0] + value.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </main>
  );
}

function ChatConfiguration({ config, apiKey, onConfigChange, onApiKeyChange, status, onStatus }: { config: ModelConfig; apiKey: string; onConfigChange: (config: ModelConfig) => void; onApiKeyChange: (value: string) => void; status: string | null; onStatus: (value: string | null) => void }) {
  const update = (patch: Partial<ModelConfig>) => onConfigChange({ ...config, ...patch });
  const save = async () => { try { await invoke('secure_store_set', { key: 'deepseek_api_key', value: apiKey }); onStatus('Settings saved securely.'); } catch { onStatus('Unable to save the API key securely.'); } };
  const test = async () => { onStatus('Testing connection...'); try { await invoke('ai:test_connection', { config: { base_url: config.baseUrl, model: config.model } }); onStatus('Connection successful.'); } catch (reason: unknown) { onStatus(reason instanceof Error ? reason.message : 'Connection test failed.'); } };
  return <div className="chat-config-page"><p className="setting-help">DeepSeek uses an OpenAI-compatible Chat Completions API.</p><label className="setting-row" htmlFor="chat-api-key"><span>API key</span><input id="chat-api-key" type="password" value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} autoComplete="off" /></label><label className="setting-row" htmlFor="chat-base-url"><span>Base URL</span><input id="chat-base-url" value={config.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label><label className="setting-row" htmlFor="chat-model"><span>Model</span><input id="chat-model" value={config.model} onChange={(event) => update({ model: event.target.value })} /></label><div className="config-actions"><button onClick={() => void save()}>Save</button><button onClick={() => void test()}>Test connection</button></div>{status && <p className="setting-help" role="status">{status}</p>}</div>;
}
