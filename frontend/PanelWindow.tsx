import { useEffect, useState } from 'react';
import { AvatarRegistry } from './avatar/registry';
import { AVATAR_EXPRESSIONS, type AvatarExpression } from './avatar/types';
import { WindowService } from './windowService';
import { invoke } from '@tauri-apps/api/core';
import { ConversationService } from './ai/conversation';
import { TauriOpenAIProvider } from './ai/openaiProvider';
import type { ChatMessage, ModelConfig } from './ai/types';
import { DurableMemoryRepository, extractAndQueue } from './memory/index.ts';

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
const resumeConversationKey = 'ice-agent.resume-conversation.v1';
const lastConversationKey = 'ice-agent.last-conversation.v1';
const modelConfigKey = 'ice-agent.model-config.v1';
const defaultModelConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.7,
  maxOutputTokens: 800,
  contextWindow: 16,
  timeoutMs: 30000,
  retryCount: 2
};
const memoryRepository = new DurableMemoryRepository();

function readModelConfig(): ModelConfig {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(modelConfigKey) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return defaultModelConfig;
    const value = parsed as Record<string, unknown>;
    return {
      ...defaultModelConfig,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : defaultModelConfig.baseUrl,
      model: typeof value.model === 'string' ? value.model : defaultModelConfig.model,
      temperature:
        typeof value.temperature === 'number'
          ? Math.max(0, Math.min(2, value.temperature))
          : defaultModelConfig.temperature,
      maxOutputTokens:
        typeof value.maxOutputTokens === 'number'
          ? Math.max(1, Math.min(4096, value.maxOutputTokens))
          : defaultModelConfig.maxOutputTokens
    };
  } catch {
    return defaultModelConfig;
  }
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
  const [activeConversationId] = useState(() => {
    const shouldResume = kind === 'chat' && localStorage.getItem(resumeConversationKey) === 'true';
    return shouldResume
      ? localStorage.getItem(lastConversationKey) || conversationId
      : `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const restored = memoryRepository.listMessages(activeConversationId, { limit: 100 });
    return restored.length
      ? restored
          .map((item) => ({
            id: item.id,
            role: item.role,
            content: item.content,
            createdAt: item.createdAt,
            incomplete: item.incomplete
          }))
          .filter((item) => item.role !== 'system')
      : conversationService
          .getConversation(activeConversationId)
          .messages.filter((item) => item.role !== 'system');
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState(readModelConfig);
  const [apiKey, setApiKey] = useState('');
  const [configStatus, setConfigStatus] = useState<string | null>(null);

  useEffect(() => {
    if (kind === 'chat') localStorage.removeItem(resumeConversationKey);
  }, [kind]);

  useEffect(() => {
    if (kind !== 'chat') return;
    const restored = memoryRepository.listMessages(activeConversationId, { limit: 100 });
    if (restored.length) {
      conversationService.restoreConversation(
        activeConversationId,
        restored.map((item) => ({
          id: item.id,
          role: item.role,
          content: item.content,
          createdAt: item.createdAt,
          incomplete: item.incomplete
        }))
      );
    }
  }, [activeConversationId, kind]);

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem(expressionKey, expression);
  }, [expression]);

  useEffect(() => {
    void invoke('memory:initialize').catch((reason: unknown) =>
      console.warn('[memory:init]', reason)
    );
  }, []);

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
            {messages.length === 0 && (
              <div className="empty-state">
                <strong>Start a conversation</strong>
                <span>Responses stream as they are generated.</span>
              </div>
            )}
            {messages.map((item) => (
              <div className={`chat-message ${item.role}`} key={item.id}>
                <span>{item.content || (item.incomplete ? '…' : '')}</span>
                {item.incomplete && <small> incomplete</small>}
              </div>
            ))}
            {error && (
              <div className="chat-error" role="alert">
                {error}
              </div>
            )}
          </div>
          <form
            className="chat-input"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!message.trim() || sending) return;
              const text = message;
              localStorage.setItem(lastConversationKey, activeConversationId);
              setMessage('');
              setError(null);
              setSending(true);
              localStorage.setItem('ice-agent.pet-state.v1', 'THINKING');
              conversationService.setConfig(modelConfig);
              setMessages([
                ...conversationService
                  .getConversation(activeConversationId)
                  .messages.filter((item) => item.role !== 'system')
              ]);
              try {
                const result = await conversationService.sendMessage(
                  activeConversationId,
                  text,
                  () =>
                    setMessages([
                      ...conversationService
                        .getConversation(activeConversationId)
                        .messages.filter((item) => item.role !== 'system')
                    ])
                );
                for (const item of conversationService.getConversation(activeConversationId)
                  .messages)
                  memoryRepository.saveMessage({ ...item, conversationId: activeConversationId });
                const source = conversationService
                  .getConversation(activeConversationId)
                  .messages.find((item) => item.role === 'user' && item.content === text);
                if (source)
                  extractAndQueue(
                    { ...source, conversationId: activeConversationId },
                    memoryRepository
                  );
                setMessages([
                  ...conversationService
                    .getConversation(activeConversationId)
                    .messages.filter((item) => item.role !== 'system')
                ]);
                localStorage.setItem('ice-agent.pet-state.v1', result.content ? 'HAPPY' : 'SAD');
              } catch (reason: unknown) {
                setError(reason instanceof Error ? reason.message : 'The AI request failed.');
                setMessages([
                  ...conversationService
                    .getConversation(activeConversationId)
                    .messages.filter((item) => item.role !== 'system')
                ]);
              } finally {
                setSending(false);
              }
            }}
          >
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write a message"
              aria-label="Message"
            />
            <button
              aria-label="Send message"
              title="Send message"
              disabled={!message.trim() || sending}
            >
              ➤
            </button>
          </form>
        </>
      ) : kind === 'chat-config' ? (
        <ChatConfiguration
          config={modelConfig}
          apiKey={apiKey}
          onConfigChange={(next) => {
            setModelConfig(next);
            localStorage.setItem(modelConfigKey, JSON.stringify(next));
          }}
          onApiKeyChange={setApiKey}
          status={configStatus}
          onStatus={setConfigStatus}
        />
      ) : (
        <div className="panel-window-settings">
          <button
            className="setting-row setting-link"
            onClick={() => WindowService.openPanel('chat-config')}
          >
            {' '}
            <span>Chat Configuration</span>
            <span aria-hidden="true">›</span>
          </button>
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
          <MemorySettings repository={memoryRepository} />
        </div>
      )}
    </main>
  );
}

function MemorySettings({ repository }: { repository: DurableMemoryRepository }) {
  const [memories, setMemories] = useState(() => repository.listMemories({ limit: 100 }));
  const [conversations] = useState(() => repository.listConversations());
  const [selectedConversationId, setSelectedConversationId] = useState(
    () => localStorage.getItem(lastConversationKey) || conversations[0]?.id || ''
  );
  const refresh = () => setMemories(repository.listMemories({ limit: 100 }));
  return (
    <section className="memory-settings" aria-labelledby="memory-heading">
      <div className="memory-actions conversation-actions">
        <select
          aria-label="Previous conversations"
          value={selectedConversationId}
          disabled={!conversations.length}
          onChange={(event) => setSelectedConversationId(event.target.value)}
        >
          {!conversations.length && <option value="">No previous conversations</option>}
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {new Date(conversation.updatedAt).toLocaleString()} - {conversation.preview}
            </option>
          ))}
        </select>
        <button
          disabled={!selectedConversationId}
          onClick={() => {
            localStorage.setItem(lastConversationKey, selectedConversationId);
            localStorage.setItem(resumeConversationKey, 'true');
            void WindowService.openPanel('chat');
          }}
        >
          Resume selected chat
        </button>
        <span className="setting-help">New chats start fresh automatically.</span>
      </div>
      <div className="memory-heading">
        <h2 id="memory-heading">Memory</h2>
        <span>{memories.length} saved</span>
      </div>
      <div className="memory-actions">
        <button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([repository.exportData()], { type: 'application/json' })
            );
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'ice-agent-memory.json';
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export
        </button>
        <button
          className="danger-button"
          onClick={() => {
            repository.clearMemories();
            refresh();
          }}
        >
          Clear all
        </button>
      </div>
      {memories.length === 0 ? (
        <p className="setting-help">No memories saved yet.</p>
      ) : (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <div>
                <strong>{memory.kind}</strong>
                <span>{memory.content}</span>
                <small>
                  {memory.status} · {Math.round(memory.confidence * 100)}% confidence
                </small>
              </div>
              <div className="memory-item-actions">
                {memory.status === 'pending' && (
                  <>
                    <button
                      onClick={() => {
                        repository.updateMemory(memory.id, { status: 'confirmed' });
                        refresh();
                      }}
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => {
                        repository.updateMemory(memory.id, { status: 'rejected' });
                        refresh();
                      }}
                    >
                      Reject
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    repository.deleteMemory(memory.id);
                    refresh();
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatConfiguration({
  config,
  apiKey,
  onConfigChange,
  onApiKeyChange,
  status,
  onStatus
}: {
  config: ModelConfig;
  apiKey: string;
  onConfigChange: (config: ModelConfig) => void;
  onApiKeyChange: (value: string) => void;
  status: string | null;
  onStatus: (value: string | null) => void;
}) {
  const update = (patch: Partial<ModelConfig>) => onConfigChange({ ...config, ...patch });
  const save = async () => {
    try {
      await invoke('secure_store_set', { key: 'deepseek_api_key', value: apiKey });
      onStatus('Settings saved securely.');
    } catch {
      onStatus('Unable to save the API key securely.');
    }
  };
  const test = async () => {
    onStatus('Testing connection...');
    try {
      await invoke('ai:test_connection', {
        config: { base_url: config.baseUrl, model: config.model }
      });
      onStatus('Connection successful.');
    } catch (reason: unknown) {
      onStatus(reason instanceof Error ? reason.message : 'Connection test failed.');
    }
  };
  return (
    <div className="chat-config-page">
      <p className="setting-help">DeepSeek uses an OpenAI-compatible Chat Completions API.</p>
      <label className="setting-row" htmlFor="chat-api-key">
        <span>API key</span>
        <input
          id="chat-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="setting-row" htmlFor="chat-base-url">
        <span>Base URL</span>
        <input
          id="chat-base-url"
          value={config.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
        />
      </label>
      <label className="setting-row" htmlFor="chat-model">
        <span>Model</span>
        <input
          id="chat-model"
          value={config.model}
          onChange={(event) => update({ model: event.target.value })}
        />
      </label>
      <div className="config-actions">
        <button onClick={() => void save()}>Save</button>
        <button onClick={() => void test()}>Test connection</button>
      </div>
      {status && (
        <p className="setting-help" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
