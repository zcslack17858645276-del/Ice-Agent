import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AvatarRegistry } from './avatar/registry';
import { Live2DCanvas } from './avatar/live2d/Live2DCanvas';
import { TaskPanel } from './TaskPanel';
import { importFiles, loadImportedCharacters } from './avatar/imported';
import { applyTheme, readTheme, saveTheme, type Theme } from './theme';
import { AVATAR_EXPRESSIONS, type AvatarExpression } from './avatar/types';
import { WindowService } from './windowService';
import { invoke } from '@tauri-apps/api/core';
import { ConversationService } from './ai/conversation';
import { TauriOpenAIProvider } from './ai/openaiProvider';
import { PersonaService } from './ai/persona';
import {
  readPersonaSettings,
  resetPersonaSettings,
  writePersonaSettings,
  personaSettingsKey
} from './ai/personaSettings';
import type { ChatMessage, ModelConfig, Persona } from './ai/types';
import { DurableMemoryRepository, extractAndQueue } from './memory/index.ts';
import {
  VoiceServices,
  voiceAutostartKey,
  type VoiceServiceName,
  type VoiceServiceStatus
} from './voice/services.ts';
import { completeSentenceLength } from './voice/speechQueue.ts';
import {
  MediaDevicesInputProvider,
  MockASRProvider,
  MockTTSProvider,
  WebAudioPlayer,
  GPTSoVITSTTSProvider,
  SpeechQueue,
  VoiceSession,
  WhisperASRProvider,
  readVoiceSettings,
  writeVoiceSettings,
  type VoiceEvent,
  type VoiceSettings
} from './voice/index.ts';

type PanelKind = 'chat' | 'settings' | 'chat-config';
type Preferences = {
  characterId: string;
  animationEnabled: boolean;
};

type BalanceInfo = {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
};

type BalanceResponse = { isAvailable: boolean; balanceInfos: BalanceInfo[] };

type UsageRecord = { ts: number; prompt: number; completion: number };
type UsageResponse = { inputRate: number; outputRate: number; records: UsageRecord[] };

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** DeepSeek account balance, queried through the Rust bridge with the saved key. */
function DeepSeekBalancePanel({ baseUrl }: { baseUrl: string }) {
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      invoke<UsageResponse>('ai:usage')
        .then(setUsage)
        .catch(() => setUsage(null));
      setBalance(await invoke<BalanceResponse>('ai:balance', { baseUrl }));
    } catch (requestError) {
      setBalance(null);
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);


  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (29 - index));
      return { key: localDayKey(date), date, cost: 0, requests: 0, tokens: 0 };
    });
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    const inputRate = usage?.inputRate ?? 2;
    const outputRate = usage?.outputRate ?? 8;
    for (const record of usage?.records ?? []) {
      const bucket = byKey.get(localDayKey(new Date(record.ts * 1000)));
      if (!bucket) continue;
      bucket.cost += (record.prompt * inputRate + record.completion * outputRate) / 1_000_000;
      bucket.requests += 1;
      bucket.tokens += record.prompt + record.completion;
    }
    return buckets;
  }, [usage]);

  const totals = useMemo(
    () =>
      days.reduce(
        (acc, day) => ({
          cost: acc.cost + day.cost,
          requests: acc.requests + day.requests,
          tokens: acc.tokens + day.tokens
        }),
        { cost: 0, requests: 0, tokens: 0 }
      ),
    [days]
  );
  const peak = Math.max(0.0001, ...days.map((day) => day.cost));

  const info = balance?.balanceInfos?.[0];
  const symbol = info?.currency === 'CNY' ? '¥' : `${info?.currency ?? ''} `;
  return (
    <section className="settings-card deepseek-card" aria-labelledby="deepseek-heading">
      <h2 id="deepseek-heading">DeepSeek API</h2>
      <div className="setting-row deepseek-row">
        <span
          className={balance?.isAvailable ? 'service-dot online' : 'service-dot'}
          aria-hidden="true"
        />
        <span className="deepseek-status">
          {loading
            ? 'Loading…'
            : balance
              ? balance.isAvailable
                ? 'Available'
                : 'Unavailable'
              : 'Not connected'}
        </span>
        <button
          type="button"
          className="deepseek-refresh"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      {info && (
        <div className="deepseek-balance">
          <span className="deepseek-total">
            {symbol}
            {info.totalBalance}
          </span>
          <span className="deepseek-detail">
            granted {info.grantedBalance} · topped up {info.toppedUpBalance}
          </span>
        </div>
      )}
      {info && (
        <div className="usage-block">
          <div className="usage-summary">
            <span className="usage-metric">
              <b>¥{totals.cost.toFixed(2)}</b>
              <em>30d spend (est.)</em>
            </span>
            <span className="usage-metric">
              <b>{totals.requests}</b>
              <em>requests</em>
            </span>
            <span className="usage-metric">
              <b>{formatTokens(totals.tokens)}</b>
              <em>tokens</em>
            </span>
          </div>
          <svg
            className="usage-chart"
            viewBox="0 0 300 72"
            role="img"
            aria-label="Daily API spend over the last 30 days"
          >
            {days.map((day, index) => {
              const height = Math.max(0.8, (day.cost / peak) * 56);
              return (
                <rect
                  key={day.key}
                  x={index * 10 + 1}
                  y={60 - height}
                  width={7}
                  height={height}
                  rx={2}
                  className={index === days.length - 1 ? 'usage-bar today' : 'usage-bar'}
                >
                  <title>
                    {`${day.date.toLocaleDateString()} · ¥${day.cost.toFixed(2)} · ${day.requests} req · ${day.tokens} tok`}
                  </title>
                </rect>
              );
            })}
            <line x1="0" y1="60.5" x2="300" y2="60.5" className="usage-axis" />
          </svg>
        </div>
      )}
      {error && <p className="deepseek-error">{error}</p>}
    </section>
  );
}

const preferencesKey = 'ice-agent.avatar-preferences.v1';
const expressionKey = 'ice-agent.avatar-expression.v1';
const defaults: Preferences = {
  characterId: 'whale',
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
const personaService = new PersonaService(readPersonaSettings());

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
  personaService,
  readModelConfig()
);

function readPreferences(): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return defaults;
    const stored = raw as Record<string, unknown>;
    return {
      characterId: AvatarRegistry.list().some((asset) => asset.id === stored.characterId || asset.characterId === stored.characterId)
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
  const companion = AvatarRegistry.find(preferences.characterId, 'IDLE', expression);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState('');
  const [serverInfo, setServerInfo] = useState<{ running: boolean; port: number; token: string }>({
    running: false,
    port: 8787,
    token: ''
  });

  useEffect(() => {
    void loadImportedCharacters();
    invoke<{ running: boolean; port: number; token: string }>('server:status')
      .then(setServerInfo)
      .catch(() => undefined);
  }, []);

  const runImport = async (files: FileList | null, kind: 'image' | 'live2d') => {
    if (!files || files.length === 0) return;
    setImportStatus('Importing…');
    try {
      const name = kind === 'image' ? files[0].name.replace(/\.[^.]+$/, '') : files[0].name;
      const entry = await importFiles(name, kind, files);
      setImportStatus(`Imported ${entry.name}`);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [chatMode, setChatMode] = useState<'chat' | 'task'>(
    () => (localStorage.getItem('ice-agent.chat-mode.v1') === 'task' ? 'task' : 'chat')
  );
  const [draftCharacterId, setDraftCharacterId] = useState(preferences.characterId);
  const draftAsset = AvatarRegistry.find(draftCharacterId, 'IDLE', expression);
  const [savedFlash, setSavedFlash] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const settingsScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // WebView2 may restore a previous scroll offset for the panel page.
    settingsScrollRef.current?.scrollTo(0, 0);
  }, []);
  const [message, setMessage] = useState('');
  const [activeConversationId, setActiveConversationId] = useState(() => {
    const shouldResume = kind === 'chat' && localStorage.getItem(resumeConversationKey) === 'true';
    return shouldResume
      ? localStorage.getItem(lastConversationKey) || conversationId
      : `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await invoke<{
          id: string;
          title: string;
          messages: { role: string; content: string; ts: number }[];
        } | null>('session:get', { id: activeConversationId });
        if (cancelled) return;
        const list = session?.messages ?? [];
        if (list.length > 0) {
          setMessages(
            list
              .filter((item) => item.role !== 'system')
              .map((item, index) => ({
                id: `${activeConversationId}-${index}`,
                role: item.role === 'assistant' ? 'assistant' : 'user',
                content: item.content,
                createdAt: item.ts,
                incomplete: false
              })) as unknown as ChatMessage[]
          );
          conversationService.restoreConversation(activeConversationId, list as never);
        }
      } catch {
        /* keep whatever is already in memory */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  const [pcSessions, setPcSessions] = useState<{ id: string; title: string }[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  const [headerHeight, setHeaderHeight] = useState(58);
  const headerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = headerRef.current;
    if (!element) return;
    const sync = () => setHeaderHeight(element.getBoundingClientRect().height);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const persistSessions = (next: { id: string; title: string }[]) => {
    setPcSessions(next);
  };

  const switchSession = (id: string) => {
    setActiveConversationId(id);
    localStorage.setItem(lastConversationKey, id);
    setShowSessions(false);
  };

  useEffect(() => {
    let cancelled = false;
    void invoke<{ id: string; title: string }[]>('session:list')
      .then((list) => {
        if (cancelled) return;
        const mapped = list.map((item) => ({ id: item.id, title: item.title }));
        setPcSessions(mapped);
        if (mapped.length > 0 && !mapped.some((item) => item.id === activeConversationId)) {
          setActiveConversationId(mapped[0].id);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState(readModelConfig);
  const [apiKey, setApiKey] = useState('');
  const [configStatus, setConfigStatus] = useState<string | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(readVoiceSettings);
  const voiceSettingsRef = useRef(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  const [persona, setPersona] = useState<Persona>(readPersonaSettings);
  const outputPlayer = useMemo(() => new WebAudioPlayer(), []);
  const ttsProvider = useMemo(
    () =>
      voiceSettings.ttsProviderId === 'gpt-sovits'
        ? new GPTSoVITSTTSProvider(() => voiceSettingsRef.current)
        : new MockTTSProvider(),
    [voiceSettings.ttsProviderId]
  );
  const speechQueue = useMemo(
    () => new SpeechQueue(ttsProvider, outputPlayer),
    [outputPlayer, ttsProvider]
  );
  const voiceSession = useMemo(
    () =>
      new VoiceSession(
        new MediaDevicesInputProvider(),
        voiceSettings.providerId === 'whisper'
          ? new WhisperASRProvider(() => voiceSettingsRef.current)
          : new MockASRProvider(),
        conversationService,
        ttsProvider,
        outputPlayer,
        voiceSettings,
        activeConversationId,
        async (audio) => {
          const bytes = Array.from(new Uint8Array(await audio.data.arrayBuffer()));
          return invoke<string>('audio:save_capture', { data: bytes });
        },
        speechQueue
      ),
    [activeConversationId, outputPlayer, speechQueue, ttsProvider, voiceSettings.providerId]
  );
  const [voiceEvent, setVoiceEvent] = useState<VoiceEvent | null>(null);
  const [voiceDevices, setVoiceDevices] = useState<{
    inputs: { id: string; label: string }[];
    outputs: { id: string; label: string }[];
  }>({ inputs: [], outputs: [] });

  useEffect(() => {
    voiceSession.updateSettings(voiceSettings);
    writeVoiceSettings(voiceSettings);
  }, [voiceSession, voiceSettings]);

  useEffect(() => {
    conversationService.setConfig(modelConfig);
  }, [modelConfig]);

  useEffect(() => {
    const syncPersona = (event: StorageEvent) => {
      if (event.key !== personaSettingsKey) return;
      const current = readPersonaSettings();
      setPersona(current);
      conversationService.setPersona(current);
    };
    window.addEventListener('storage', syncPersona);
    return () => window.removeEventListener('storage', syncPersona);
  }, []);

  useEffect(() => {
    if (kind !== 'settings') return;
    void voiceSession
      .listDevices()
      .then(setVoiceDevices)
      .catch(() => setVoiceDevices({ inputs: [], outputs: [] }));
  }, [kind, voiceSession]);

  useEffect(() => {
    const unsubscribe = voiceSession.subscribe(setVoiceEvent);
    return () => {
      unsubscribe();
      void voiceSession.cancel('chat panel closed');
    };
  }, [voiceSession]);

  useEffect(() => {
    if (!voiceEvent) return;
    if (voiceEvent.transcript?.text) setMessage(voiceEvent.transcript.text);
    if (voiceEvent.transcript || voiceEvent.state === 'playing' || voiceEvent.state === 'idle')
      setMessages(
        conversationService
          .getConversation(activeConversationId)
          .messages.filter((item) => item.role !== 'system')
      );
    if (['recording', 'recognizing', 'synthesizing'].includes(voiceEvent.state))
      localStorage.setItem('ice-agent.pet-state.v1', 'THINKING');
    if (voiceEvent.state === 'playing') localStorage.setItem('ice-agent.pet-state.v1', 'WORKING');
    if (voiceEvent.state === 'error' && voiceEvent.error) setError(voiceEvent.error.message);
    if (voiceEvent.capturePath) setError(`Microphone capture saved to: ${voiceEvent.capturePath}`);
  }, [activeConversationId, voiceEvent]);

  useEffect(() => {
    if (kind === 'chat') localStorage.removeItem(resumeConversationKey);
  }, [kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        WindowService.closeCurrent().catch(console.error);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
          incomplete: item.incomplete,
          personaVersion: item.personaVersion
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
    <main className={`panel-window${maximized ? ' is-maximized' : ''}${kind === 'chat' && chatMode === 'task' ? ' task-mode' : ''}${kind === 'chat' && chatMode === 'chat' && showSessions ? ' rail-open' : ''}`}>
      <header
        className="panel-window-header"
        onPointerDown={(event) => {
          const target = event.target;
          if (event.button !== 0 || (target instanceof Element && target.closest('button'))) return;
          WindowService.dragCurrent().catch(console.error);
        }}
        onDoubleClick={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('button')) return;
          WindowService.toggleMaximizeCurrent().then(setMaximized).catch(console.error);
        }}
      >
        <span className="panel-grip" aria-hidden="true" />
        {kind === 'chat' && (
          <button
            type="button"
            className="window-control panel-gear"
            aria-label="Settings"
            title="Settings"
            onClick={() => WindowService.openPanel('settings').catch(console.error)}
          >
            <span aria-hidden="true">⚙</span>
          </button>
        )}
        {kind === 'chat' && (
          <button
            type="button"
            className="window-control session-toggle"
            aria-label="Conversations"
            title="Conversations"
            onClick={() => setShowSessions((value) => !value)}
          >
            <span aria-hidden="true">&#9776;</span>
          </button>
        )}

        <div className="panel-brand">
          <span
            className={`panel-avatar${kind === 'chat' ? ' has-photo' : ''}`}
            aria-hidden="true"
            style={kind === 'chat' ? { backgroundImage: `url("${companion.src}")` } : undefined}
          >
            {kind === 'settings' ? '♡' : kind === 'chat-config' ? '✦' : null}
          </span>
          <div className="panel-brand-text">
            <h1>
              {kind === 'chat' ? 'Chat' : kind === 'settings' ? 'Settings' : 'Chat Configuration'}
            </h1>
            <p className="panel-subtitle">
              {kind === 'chat'
                ? `Chatting with ${companion.name}`
                : kind === 'settings'
                  ? 'Make your companion feel at home'
                  : 'Connect Ice Agent to your model'}
            </p>
          </div>
        </div>
        {kind === 'chat' && (
          <div className="chat-mode" role="group" aria-label="Chat mode">
            <button
              type="button"
              className={chatMode === 'chat' ? 'active' : ''}
              onClick={() => {
                setChatMode('chat');
                localStorage.setItem('ice-agent.chat-mode.v1', 'chat');
              }}
            >
              Chat
            </button>
            <button
              type="button"
              className={chatMode === 'task' ? 'active' : ''}
              onClick={() => {
                setChatMode('task');
                localStorage.setItem('ice-agent.chat-mode.v1', 'task');
              }}
            >
              Task
            </button>
          </div>
        )}
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => WindowService.minimizeCurrent().catch(console.error)}
          >
            <span aria-hidden="true">–</span>
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() =>
              WindowService.toggleMaximizeCurrent().then(setMaximized).catch(console.error)
            }
          >
            <span aria-hidden="true">{maximized ? '❐' : '□'}</span>
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label="Close"
            title="Close"
            onClick={() => WindowService.closeCurrent().catch(console.error)}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>
      {kind === 'chat' && chatMode === 'task' && <TaskPanel />}
      {kind === 'chat' && chatMode === 'chat' && showSessions && (
        <aside className={showSessions ? 'session-drawer open' : 'session-drawer'} style={{ top: headerHeight }} aria-label="Conversations">
          <button
            type="button"
            className="session-new"
            onClick={() => {
              void invoke<{ id: string; title: string }>('session:create', { title: '新的对话' })
                .then((created) => {
                  persistSessions([{ id: created.id, title: created.title }, ...pcSessions]);
                  setActiveConversationId(created.id);
                  setMessages([]);
                  conversationService.restoreConversation(created.id, []);
                  localStorage.setItem(lastConversationKey, created.id);
                })
                .catch(() => undefined);
              setShowSessions(false);
            }}
          >
            + 新对话
          </button>
          {pcSessions.map((session) => (
            <div
              key={session.id}
              className={session.id === activeConversationId ? 'session-item active' : 'session-item'}
              onClick={() => switchSession(session.id)}
              role="button"
              tabIndex={0}
            >
              <span className="session-title">{session.title}</span>
              <button
                type="button"
                className="session-remove"
                aria-label="删除会话"
                onClick={(event) => {
                  event.stopPropagation();
                  void invoke('session:delete', { id: session.id });
                  const next = pcSessions.filter((item) => item.id !== session.id);
                  if (next.length === 0) return;
                  persistSessions(next);
                  if (session.id === activeConversationId) switchSession(next[0].id);
                }}
              >
                &#215;
              </button>
            </div>
          ))}
        </aside>
      )}

      {kind === 'chat' ? (
        <>
          <div className="chat-messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="empty-state">
                <span className="empty-badge" aria-hidden="true">
                  ♡
                </span>
                <strong>Hi, I&apos;m {companion.name}</strong>
                <span>Say hello and I&apos;ll answer right here, one little line at a time.</span>
                <span className="empty-hint">{modelConfig.model}</span>
              </div>
            )}
            {messages.map((item) => (
              <div className={`chat-message ${item.role}`} key={item.id}>
                <div className="bubble">{item.content || (item.incomplete ? '…' : '')}</div>
                {item.incomplete && <small className="bubble-note">incomplete</small>}
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
              const currentPersona = readPersonaSettings();
              setPersona(currentPersona);
              conversationService.setPersona(currentPersona);
              await speechQueue.cancel();
              setMessages([
                ...conversationService
                  .getConversation(activeConversationId)
                  .messages.filter((item) => item.role !== 'system')
              ]);
              const speechSettings = voiceSettingsRef.current;
              let spokenUpTo = 0;
              let streamSpeech = false;
              // Speaks the first sentence immediately, then batches the rest into
              // ~60 character chunks so the GPU handles fewer, richer requests.
              let speechBuffer = '';
              let firstChunkSent = false;
              const flushSpeechBuffer = () => {
                if (!speechBuffer.trim()) return;
                speechQueue.push(speechBuffer);
                speechBuffer = '';
                firstChunkSent = true;
              };
              const pushStreamedSpeech = (content: string) => {
                if (!streamSpeech) return;
                const chunk = content.slice(spokenUpTo);
                if (!chunk) return;
                const readyLength = completeSentenceLength(chunk);
                if (!readyLength) return;
                speechBuffer += chunk.slice(0, readyLength);
                spokenUpTo += readyLength;
                if (!firstChunkSent || speechBuffer.length >= 60) flushSpeechBuffer();
              };
              try {
                streamSpeech = speechSettings.autoplay;
                if (streamSpeech) speechQueue.begin(speechSettings);
                const result = await conversationService.sendMessage(
                  activeConversationId,
                  text,
                  () => {
                    setMessages([
                      ...conversationService
                        .getConversation(activeConversationId)
                        .messages.filter((item) => item.role !== 'system')
                    ]);
                    const streamed = conversationService
                      .getConversation(activeConversationId)
                      .messages.filter((item) => item.role !== 'system')
                      .at(-1);
                    if (streamed?.role === 'assistant') pushStreamedSpeech(streamed.content);
                  }
                );
                for (const item of conversationService.getConversation(activeConversationId)
                  .messages)
                  void invoke('session:append', { id: activeConversationId, role: item.role, content: item.content });
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
                if (streamSpeech) {
                  const tail = result.content.slice(spokenUpTo);
                  if (tail.trim()) speechBuffer += tail;
                  flushSpeechBuffer();
                  void speechQueue.finish().catch((speechError: unknown) => {
                    if (
                      !(speechError instanceof Error) ||
                      !speechError.message.toLowerCase().includes('cancel')
                    )
                      setError(
                        speechError instanceof Error
                          ? speechError.message
                          : 'Speech playback failed.'
                      );
                  });
                }
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
            <span className="voice-status" aria-live="polite">
              {voiceEvent?.state && voiceEvent.state !== 'idle'
                ? voiceEvent.state.replaceAll('_', ' ')
                : ''}
            </span>
            <button
              className="send-button"
              aria-label="Send message"
              title="Send message"
              disabled={!message.trim() || sending}
            >
              ➤
            </button>
            <button
              type="button"
              className={`voice-button${voiceEvent?.state === 'recording' ? ' recording' : ''}`}
              aria-label={voiceEvent?.state === 'recording' ? 'Stop recording' : 'Start recording'}
              title={voiceEvent?.state === 'recording' ? 'Stop recording' : 'Start recording'}
              disabled={
                sending ||
                [
                  'preparing',
                  'stopping',
                  'recognizing',
                  'waiting_for_response',
                  'synthesizing',
                  'playing'
                ].includes(voiceEvent?.state ?? '')
              }
              onClick={() => {
                if (voiceEvent?.state === 'recording') void voiceSession.stop();
                else void voiceSession.start();
              }}
            >
              <span className="voice-dot" aria-hidden="true" />
              {voiceEvent?.state === 'recording' ? 'Stop' : 'Voice'}
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
        <div className="panel-window-settings" ref={settingsScrollRef}>
          <aside className="settings-preview-column">
            <section className="settings-card settings-preview-card" aria-labelledby="preview-heading">
              <h2 id="preview-heading">Preview</h2>
              <div className="character-stage">
                {draftAsset.live2d ? (
                  <Live2DCanvas modelUrl={draftAsset.src} motion="Idle" />
                ) : (
                  <img src={draftAsset.src} alt="" draggable={false} />
                )}
              </div>
              <div className="character-picker" role="group" aria-label="Character">
                {AvatarRegistry.list().map((character) => (
                  <button
                    type="button"
                    key={character.characterId}
                    className={
                      draftCharacterId === character.characterId
                        ? 'character-chip selected'
                        : 'character-chip'
                    }
                    onClick={() => {
                      setDraftCharacterId(character.id ?? character.characterId);
                      setSavedFlash(false);
                    }}
                  >
                    {character.name}
                    <span className="character-chip-kind">
                      {character.live2d ? 'Live2D' : 'PNG'}
                    </span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="character-save"
                disabled={draftCharacterId === preferences.characterId}
                onClick={() => {
                  setPreferences((current) => ({ ...current, characterId: draftCharacterId }));
                  setSavedFlash(true);
                }}
              >
                Save character
              </button>
              {savedFlash && <span className="character-saved">Saved ✓</span>}
            </section>
          </aside>
          <div className="settings-column">
            <section className="settings-card" aria-labelledby="companion-heading">
              <h2 id="companion-heading">Companion</h2>
              <button
                className="setting-row setting-link"
                onClick={() => WindowService.openPanel('chat-config')}
              >
                <span>Chat Configuration</span>
                <span className="setting-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
              <div className="import-card">
              <h3>Characters</h3>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(event) => {
                  void runImport(event.target.files, 'image');
                  event.target.value = '';
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                // @ts-expect-error non-standard but supported by Chromium/WebView2
                webkitdirectory=""
                onChange={(event) => {
                  void runImport(event.target.files, 'live2d');
                  event.target.value = '';
                }}
              />
              <div className="import-actions">
                <button type="button" onClick={() => imageInputRef.current?.click()}>
                  Import image
                </button>
                <button type="button" onClick={() => folderInputRef.current?.click()}>
                  Import Live2D folder
                </button>
              </div>
              <p className="import-hint">Stored in D:\IceAgent\characters{importStatus ? ` · ${importStatus}` : ''}</p>
              <div className="server-row">
                <span>
                  Server {serverInfo.running ? `on :${serverInfo.port}` : 'off'}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    if (serverInfo.running) {
                      await invoke('server:stop');
                      setServerInfo({ ...serverInfo, running: false });
                    } else {
                      const result = await invoke<{ running: boolean; port: number; token: string }>(
                        'server:start',
                        { port: 8787 }
                      );
                      setServerInfo({ running: true, port: result.port, token: result.token });
                    }
                  }}
                >
                  {serverInfo.running ? 'Stop' : 'Start'}
                </button>
              </div>
              {serverInfo.token && (
                <p className="import-hint">
                  Token: <code>{serverInfo.token.slice(0, 8)}…</code>
                </p>
              )}
            </div>
            <label className="setting-row" htmlFor="theme-toggle">
                <span>Dark theme</span>
                <input
                  id="theme-toggle"
                  type="checkbox"
                  checked={theme === 'dark'}
                  onChange={(event) => {
                    const next: Theme = event.target.checked ? 'dark' : 'light';
                    setTheme(next);
                    saveTheme(next);
                  }}
                />
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
            </section>
            <DeepSeekBalancePanel baseUrl={modelConfig.baseUrl} />
            <VoiceServicesPanel />
            <VoiceSettingsPanel
              settings={voiceSettings}
              devices={voiceDevices}
              onChange={setVoiceSettings}
              speechQueue={speechQueue}
            />
          </div>
          <div className="settings-column">
            <PersonaSettingsPanel
              persona={persona}
              onSave={(next) => {
                const versioned = { ...next, version: `user-${Date.now()}` };
                writePersonaSettings(versioned);
                setPersona(versioned);
                conversationService.setPersona(versioned);
              }}
              onReset={() => {
                const reset = resetPersonaSettings();
                setPersona(reset);
                conversationService.setPersona(reset);
              }}
            />
            <MemorySettings repository={memoryRepository} />
          </div>
        </div>
      )}
    </main>
  );
}

const voiceServiceRows: { id: VoiceServiceName; name: string; detail: string }[] = [
  { id: 'whisper', name: 'Whisper ASR', detail: '127.0.0.1:8000' },
  { id: 'sovits', name: 'GPT-SoVITS TTS', detail: '127.0.0.1:9880' }
];

function VoiceServicesPanel() {
  const [status, setStatus] = useState<VoiceServiceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autostart, setAutostart] = useState(
    () => localStorage.getItem(voiceAutostartKey) !== 'false'
  );

  useEffect(() => {
    let active = true;
    const refresh = () => {
      VoiceServices.status()
        .then((next) => active && setStatus(next))
        .catch(() => active && setStatus(null));
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const run = (service: VoiceServiceName, action: 'start' | 'stop') => {
    setBusy(`${action}-${service}`);
    setError(null);
    const call = action === 'start' ? VoiceServices.start(service) : VoiceServices.stop(service);
    void call
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason))
      )
      .finally(() => {
        setBusy(null);
        window.setTimeout(() => {
          void VoiceServices.status()
            .then(setStatus)
            .catch(() => undefined);
        }, 1600);
      });
  };

  return (
    <section className="settings-card voice-services" aria-labelledby="services-heading">
      <h2 id="services-heading">Local services</h2>
      {voiceServiceRows.map((service) => {
        const running = status?.[service.id] ?? false;
        return (
          <div className="service-row" key={service.id}>
            <span className={`service-dot${running ? ' running' : ''}`} aria-hidden="true" />
            <div className="service-text">
              <strong>{service.name}</strong>
              <small>
                {service.detail} · {running ? 'running' : 'stopped'}
              </small>
            </div>
            <div className="service-actions">
              <button
                type="button"
                disabled={running || busy !== null}
                onClick={() => run(service.id, 'start')}
              >
                Start
              </button>
              <button
                type="button"
                disabled={!running || busy !== null}
                onClick={() => run(service.id, 'stop')}
              >
                Stop
              </button>
            </div>
          </div>
        );
      })}
      <label className="setting-row" htmlFor="voice-autostart">
        <span>Start services with Ice Agent</span>
        <input
          id="voice-autostart"
          type="checkbox"
          checked={autostart}
          onChange={(event) => {
            setAutostart(event.target.checked);
            localStorage.setItem(voiceAutostartKey, String(event.target.checked));
          }}
        />
      </label>
      <p className="setting-help">
        Launches uvicorn server:app and api_v2.py in WSL with the GPTSoVits environment.
      </p>
      {error && <p className="setting-help service-error">{error}</p>}
    </section>
  );
}

function VoiceSettingsPanel({
  settings,
  devices,
  onChange,
  speechQueue
}: {
  settings: VoiceSettings;
  devices: { inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] };
  onChange: (settings: VoiceSettings) => void;
  speechQueue: SpeechQueue;
}) {
  const [testStatus, setTestStatus] = useState<string | null>(null);
  return (
    <section className="settings-card voice-settings" aria-labelledby="voice-heading">
      <h2 id="voice-heading">Voice</h2>
      <label className="setting-row" htmlFor="tts-provider">
        <span>Speech engine</span>
        <select
          id="tts-provider"
          value={settings.ttsProviderId}
          onChange={(event) =>
            onChange({
              ...settings,
              ttsProviderId: event.target.value as VoiceSettings['ttsProviderId']
            })
          }
        >
          <option value="gpt-sovits">GPT-SoVITS V2</option>
          <option value="mock">Offline mock</option>
        </select>
      </label>
      {settings.ttsProviderId === 'gpt-sovits' && (
        <>
          <label className="setting-row" htmlFor="gpt-sovits-url">
            <span>GPT-SoVITS URL</span>
            <input
              id="gpt-sovits-url"
              type="url"
              value={settings.gptSovitsBaseUrl}
              onChange={(event) => onChange({ ...settings, gptSovitsBaseUrl: event.target.value })}
            />
          </label>
          <div className="setting-row batch-row">
            <span>Inference batch size · {settings.gptSovitsBatchSize}</span>
            <div className="batch-stepper">
              <button
                type="button"
                className="batch-step"
                aria-label="Decrease batch size"
                disabled={settings.gptSovitsBatchSize <= 1}
                onClick={() =>
                  onChange({
                    ...settings,
                    gptSovitsBatchSize: Math.max(1, settings.gptSovitsBatchSize - 1)
                  })
                }
              >
                −
              </button>
              <input
                id="gpt-sovits-batch"
                type="range"
                min="1"
                max="256"
                step="1"
                value={settings.gptSovitsBatchSize}
                aria-label="Inference batch size"
                onChange={(event) =>
                  onChange({ ...settings, gptSovitsBatchSize: Number(event.target.value) })
                }
              />
              <button
                type="button"
                className="batch-step"
                aria-label="Increase batch size"
                disabled={settings.gptSovitsBatchSize >= 256}
                onClick={() =>
                  onChange({
                    ...settings,
                    gptSovitsBatchSize: Math.min(256, settings.gptSovitsBatchSize + 1)
                  })
                }
              >
                +
              </button>
            </div>
          </div>
          <label className="setting-row stacked" htmlFor="reference-audio">
            <span>WSL reference audio path</span>
            <input
              id="reference-audio"
              value={settings.referenceAudioPath}
              onChange={(event) =>
                onChange({ ...settings, referenceAudioPath: event.target.value })
              }
            />
          </label>
          <label className="setting-row stacked" htmlFor="reference-transcript">
            <span>Reference transcript</span>
            <textarea
              id="reference-transcript"
              value={settings.referenceTranscript}
              onChange={(event) =>
                onChange({ ...settings, referenceTranscript: event.target.value })
              }
              rows={2}
            />
          </label>
          <label className="setting-row" htmlFor="reference-language">
            <span>Reference language</span>
            <input
              id="reference-language"
              value={settings.referenceLanguage}
              onChange={(event) => onChange({ ...settings, referenceLanguage: event.target.value })}
            />
          </label>
          <label className="setting-row" htmlFor="response-language">
            <span>Response language</span>
            <input
              id="response-language"
              value={settings.responseLanguage}
              onChange={(event) => onChange({ ...settings, responseLanguage: event.target.value })}
            />
          </label>
          <div className="config-actions">
            <button
              type="button"
              onClick={async () => {
                setTestStatus('Synthesizing test audio…');
                try {
                  await speechQueue.speak('你好，这是语音连接测试。', settings);
                  setTestStatus('Test speech played.');
                } catch (reason) {
                  setTestStatus(
                    reason instanceof Error ? reason.message : 'Synthesis test failed.'
                  );
                }
              }}
            >
              Test synthesis
            </button>
            {testStatus && <span role="status">{testStatus}</span>}
          </div>
        </>
      )}
      <label className="setting-row" htmlFor="voice-provider">
        <span>Provider</span>
        <select
          id="voice-provider"
          value={settings.providerId}
          onChange={(event) =>
            onChange({ ...settings, providerId: event.target.value as VoiceSettings['providerId'] })
          }
        >
          <option value="mock">Offline mock</option>
          <option value="whisper">Local Whisper (WSL)</option>
        </select>
      </label>
      {settings.providerId === 'whisper' && (
        <>
          <label className="setting-row" htmlFor="whisper-base-url">
            <span>Whisper service</span>
            <input
              id="whisper-base-url"
              type="url"
              value={settings.whisperBaseUrl}
              onChange={(event) => onChange({ ...settings, whisperBaseUrl: event.target.value })}
            />
          </label>
          <label className="setting-row" htmlFor="whisper-model">
            <span>Whisper model</span>
            <input
              id="whisper-model"
              value={settings.whisperModel}
              onChange={(event) => onChange({ ...settings, whisperModel: event.target.value })}
            />
          </label>
        </>
      )}
      <label className="setting-row" htmlFor="voice-input-device">
        <span>Microphone</span>
        <select
          id="voice-input-device"
          value={settings.inputDeviceId}
          onChange={(event) => onChange({ ...settings, inputDeviceId: event.target.value })}
        >
          <option value="">System default</option>
          {devices.inputs.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label className="setting-row" htmlFor="voice-output-device">
        <span>Speaker</span>
        <select
          id="voice-output-device"
          value={settings.outputDeviceId}
          onChange={(event) => onChange({ ...settings, outputDeviceId: event.target.value })}
        >
          <option value="">System default</option>
          {devices.outputs.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label className="setting-row" htmlFor="voice-volume">
        <span>Volume</span>
        <input
          id="voice-volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.volume}
          onChange={(event) => onChange({ ...settings, volume: Number(event.target.value) })}
        />
      </label>
      <label className="setting-row" htmlFor="voice-autoplay">
        <span>Speak replies</span>
        <input
          id="voice-autoplay"
          type="checkbox"
          checked={settings.autoplay}
          onChange={(event) => onChange({ ...settings, autoplay: event.target.checked })}
        />
      </label>
      <label className="setting-row" htmlFor="voice-retain-recordings">
        <span>Keep recordings</span>
        <input
          id="voice-retain-recordings"
          type="checkbox"
          checked={settings.retainRecordings}
          onChange={(event) => onChange({ ...settings, retainRecordings: event.target.checked })}
        />
      </label>
      <p className="setting-help">Recordings stay temporary unless this setting is enabled.</p>
    </section>
  );
}

function PersonaSettingsPanel({
  persona,
  onSave,
  onReset
}: {
  persona: Persona;
  onSave: (persona: Persona) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(persona);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setDraft(persona), [persona]);
  const update = (patch: Partial<Persona>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <section className="settings-card persona-settings" aria-labelledby="persona-heading">
      <h2 id="persona-heading">Persona</h2>
      <label className="setting-row stacked" htmlFor="persona-name">
        <span>Name</span>
        <input
          id="persona-name"
          maxLength={80}
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      <label className="setting-row stacked" htmlFor="persona-personality">
        <span>Personality</span>
        <textarea
          id="persona-personality"
          maxLength={2000}
          rows={4}
          value={draft.personality}
          onChange={(event) => update({ personality: event.target.value })}
        />
      </label>
      <label className="setting-row stacked" htmlFor="persona-style">
        <span>Response style</span>
        <textarea
          id="persona-style"
          maxLength={2000}
          rows={4}
          value={draft.responseStyle}
          onChange={(event) => update({ responseStyle: event.target.value })}
        />
      </label>
      <label className="setting-row stacked" htmlFor="persona-rules">
        <span>Behavior rules (one per line)</span>
        <textarea
          id="persona-rules"
          maxLength={10000}
          rows={6}
          value={draft.behaviorRules.join('\n')}
          onChange={(event) =>
            update({
              behaviorRules: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
            })
          }
        />
      </label>
      <div className="config-actions">
        <button
          type="button"
          onClick={() => {
            try {
              onSave(draft);
              setStatus('Persona saved.');
            } catch (reason) {
              setStatus(reason instanceof Error ? reason.message : 'Persona could not be saved.');
            }
          }}
        >
          Save Persona
        </button>
        <button
          type="button"
          onClick={() => {
            onReset();
            setStatus('Trait defaults restored.');
          }}
        >
          Reset defaults
        </button>
        {status && <span role="status">{status}</span>}
      </div>
    </section>
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
      <section className="settings-card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
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
      </section>
      {status && (
        <p className="config-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
