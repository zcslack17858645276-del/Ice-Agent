import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { applyTheme, readTheme } from '../theme';
import { WindowService } from '../windowService';
import { activateMode, readMode, type AppMode } from '../mode';
import { ModeSwitch } from './ModeSwitch';
import { GatewayError, OpenClawGateway, requestId, type GatewayHello } from './gateway';
import {
  abortTask,
  createTask,
  defaultWorkSettings,
  failTask,
  loadWorkState,
  readWorkSettings,
  reduceTask,
  runIdOf,
  saveWorkSettings,
  saveWorkState,
  sessionKeyOf,
  type WorkItem,
  type WorkSettings,
  type WorkState
} from './tasks';

type GatewayConfig = { url: string; token: string; source: string; configPath: string };
type GatewayStatus = 'idle' | 'connecting' | 'online' | 'offline';
type Skill = { name: string; description: string };

const gatewayTokenKey = 'openclaw_gateway_token';

/** Models this install exposes through the gateway (see `openclaw models status`). */
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash' }
];

function clock(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function errorMessage(reason: unknown): string {
  if (reason instanceof GatewayError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** Reads a skills or MCP catalog out of the shapes gateways have used so far. */
function parseCatalog(result: unknown): Skill[] {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const list = Array.isArray(result)
    ? result
    : Array.isArray(record?.skills)
      ? (record?.skills as unknown[])
      : Array.isArray(record?.servers)
        ? (record?.servers as unknown[])
        : Array.isArray(record?.items)
          ? (record?.items as unknown[])
          : [];
  return list
    .map((entry) => {
      const value: Record<string, unknown> =
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return {
        name: String(value.name ?? value.id ?? value.skill ?? '').trim(),
        description: String(value.description ?? value.summary ?? '').trim()
      };
    })
    .filter((entry) => entry.name.length > 0);
}

type ToolEntry = { name: string; source: string };

/** `tools.effective` / `tools.catalog` return flat or grouped tool lists. */
function parseTools(result: unknown): ToolEntry[] {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const direct = Array.isArray(result)
    ? result
    : Array.isArray(record?.tools)
      ? (record?.tools as unknown[])
      : [];
  const groups = Array.isArray(record?.groups) ? (record?.groups as unknown[]) : [];
  const grouped = groups.flatMap((group) => {
    const value: Record<string, unknown> =
      group && typeof group === 'object' ? (group as Record<string, unknown>) : {};
    return Array.isArray(value.tools) ? (value.tools as unknown[]) : [];
  });
  return [...direct, ...grouped]
    .map((entry) => {
      const value: Record<string, unknown> =
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return {
        name: String(value.name ?? value.id ?? '').trim(),
        source: String(value.source ?? value.kind ?? '').trim().toLowerCase()
      };
    })
    .filter((tool) => tool.name.length > 0);
}

/**
 * Builds the task text handed to the agent. The hints live next to the prompt so
 * the gateway's own skills, MCP servers and computer-use tools stay in charge of
 * *how* the work happens — we only state the workspace and the intent.
 */
export function composeMessage(
  prompt: string,
  options: { workspace: string; computerUse: boolean; skill: string }
): string {
  const hints: string[] = [];
  const workspace = options.workspace.trim();
  if (workspace) hints.push(`工作目录：${workspace}`);
  if (options.skill.trim()) hints.push(`优先调用「${options.skill.trim()}」技能。`);
  if (options.computerUse)
    hints.push('需要操作界面时可使用 computer-use / 浏览器 / 桌面工具，并在每一步后核对结果。');
  hints.push('分步执行，最后给出简明的结果摘要。');
  return `${prompt}\n\n---\n${hints.map((line) => `- ${line}`).join('\n')}`;
}

/**
 * Reasoning is noisy and long, so it collapses into a single summary row — the
 * same shape a desktop coding agent uses. Expanding shows the full trace.
 */
function ThinkingBlock({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false);
  const text = item.text.replace(/\n{3,}/g, '\n\n').trim();
  const firstLine = (text.split('\n').find((line) => line.trim()) ?? '').trim();
  const preview = firstLine
    ? `${firstLine.slice(0, 78)}${firstLine.length > 78 ? '…' : ''}`
    : '推理过程';
  return (
    <article className={open ? 'work-entry thinking open' : 'work-entry thinking'}>
      <button
        type="button"
        className="work-thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="work-thinking-arrow" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="work-entry-tag">思考</span>
        {!open && <span className="work-thinking-preview">{preview}</span>}
        <span className="work-thinking-meta">{open ? '收起' : `${text.length} 字`}</span>
      </button>
      {open && <pre className="work-thinking-body">{text || '（空）'}</pre>}
    </article>
  );
}

/** Collapsed tool calls show one readable summary line; expanding reveals the
 *  full arguments and result, matching how desktop coding agents present them. */
function toolSummary(item: WorkItem): string {
  const raw = item.detail ?? '';
  if (!raw) return '—';
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value && typeof value === 'object') {
      for (const key of ['command', 'title', 'path', 'url', 'query', 'code', 'name']) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          const line = candidate.replace(/\s+/g, ' ').trim();
          return `${line.slice(0, 96)}${line.length > 96 ? '…' : ''}`;
        }
      }
    }
  } catch {
    /* arguments were not JSON */
  }
  const line = raw.replace(/\s+/g, ' ').trim();
  return `${line.slice(0, 96)}${line.length > 96 ? '…' : ''}`;
}

function ToolCard({ item, live }: { item: WorkItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  // A finished task must not leave a card spinning forever.
  const status = item.status === 'running' && !live ? 'done' : (item.status ?? 'running');
  const label = status === 'done' ? '完成' : status === 'error' ? '失败' : '执行中';
  const hasBody = Boolean(item.detail || item.output);
  return (
    <article className={`work-entry tool ${status}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="work-tool-head"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <span className="work-tool-arrow" aria-hidden="true">
          {hasBody ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="work-tool-dot" aria-hidden="true" />
        <span className="work-tool-name">{item.title ?? 'tool'}</span>
        {!open && <span className="work-tool-summary">{toolSummary(item)}</span>}
        <span className="work-tool-state">{label}</span>
      </button>
      {open && (
        <div className="work-tool-body">
          {item.detail && (
            <div className="work-tool-section">
              <span className="work-tool-label">参数</span>
              <pre className="work-tool-block">{item.detail}</pre>
            </div>
          )}
          {item.output && (
            <div className="work-tool-section">
              <span className="work-tool-label">结果</span>
              <pre className="work-tool-block result">{item.output}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function WorkItemView({ item, live }: { item: WorkItem; live: boolean }) {
  if (item.kind === 'prompt') {
    return (
      <article className="work-entry prompt">
        <span className="work-entry-tag">任务</span>
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === 'assistant') {
    const streaming = item.status === 'running';
    const text = item.text.trim();
    // Older persisted tasks may hold whitespace-only streamed frames.
    if (!text && !streaming) return null;
    return (
      <article className={streaming ? 'work-entry assistant streaming' : 'work-entry assistant'}>
        <span className="work-entry-tag">Agent</span>
        <p>{text || '正在思考…'}</p>
      </article>
    );
  }
  if (item.kind === 'thinking') {
    return <ThinkingBlock item={item} />;
  }
  if (item.kind === 'tool') {
    return <ToolCard item={item} live={live} />;
  }
  if (!item.text.trim()) return null;
  return <p className={`work-entry notice ${item.level ?? 'info'}`}>{item.text}</p>;
}

export function WorkPanel() {
  const [state, setState] = useState<WorkState>(() => loadWorkState());
  const [mode, setMode] = useState<AppMode>(readMode);
  const [settings, setSettings] = useState<WorkSettings>(readWorkSettings);
  const [draftSettings, setDraftSettings] = useState<WorkSettings>(settings);
  const [status, setStatus] = useState<GatewayStatus>('idle');
  const [hello, setHello] = useState<GatewayHello | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [approvals, setApprovals] = useState<
    { id: string; command: string; request: Record<string, unknown> }[]
  >([]);
  const [showSettings, setShowSettings] = useState(false);
  const [discovered, setDiscovered] = useState<GatewayConfig | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [execMode, setExecMode] = useState<'full' | 'allowlist'>('full');
  const [allowList, setAllowList] = useState<string[]>([]);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [modelId, setModelId] = useState<string>('deepseek/deepseek-v4-pro');
  const [switchingModel, setSwitchingModel] = useState(false);

  const gatewayRef = useRef<OpenClawGateway | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const submittingRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const { tasks, activeId } = state;
  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeId) ?? null,
    [tasks, activeId]
  );
  const runningTask = useMemo(
    () => tasks.find((task) => task.status === 'running') ?? null,
    [tasks]
  );

  useEffect(() => {
    applyTheme(readTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'ice-agent.theme.v1') {
        applyTheme(event.newValue === 'dark' ? 'dark' : 'light');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    // Opening the work console is an explicit switch: the pet follows the mode.
    if (readMode() !== 'work') activateMode('work', { openPanel: false });
    setMode('work');
  }, []);

  // Persist with a short delay so streaming deltas do not hammer localStorage.
  useEffect(() => {
    const timer = window.setTimeout(() => saveWorkState(state), 600);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [activeTask?.items]);

  const isRunning = runningTask !== null;

  // The pet mirrors the console: thinking while a task runs, working at rest.
  useEffect(() => {
    localStorage.setItem('ice-agent.pet-state.v1', isRunning ? 'THINKING' : 'WORKING');
  }, [isRunning]);

  const pushEvent = useCallback((event: string, payload: unknown) => {
    if (event === 'exec.approval.requested') {
      const record = (payload && typeof payload === 'object' ? payload : {}) as Record<
        string,
        unknown
      >;
      const nested = record.request ?? record.approval;
      const request = (
        nested && typeof nested === 'object' ? nested : record
      ) as Record<string, unknown>;
      const id = String(record.id ?? request.id ?? request.requestId ?? '');
      if (!id) return;
      const command = String(
        request.command ?? request.rawCommand ?? request.summary ?? request.description ?? ''
      );
      setApprovals((previous) =>
        previous.some((entry) => entry.id === id) ? previous : [...previous, { id, command, request }]
      );
      return;
    }
    if (event === 'exec.approval.resolved') {
      const record = (payload && typeof payload === 'object' ? payload : {}) as Record<
        string,
        unknown
      >;
      const id = String(record.id ?? (record.request as Record<string, unknown> | undefined)?.id ?? '');
      if (id) setApprovals((previous) => previous.filter((entry) => entry.id !== id));
      return;
    }
    if (event !== 'chat' && event !== 'agent' && event !== 'session.tool') return;
    const runId = runIdOf(payload);
    setState((previous) => {
      let changed = false;
      const nextTasks = previous.tasks.map((task) => {
        if (task.status !== 'running') return task;
        if (runId && task.runId && task.runId !== runId) return task;
        // The first event of a run teaches us its id before chat.send replies.
        const adopted = !task.runId && runId ? { ...task, runId } : task;
        const next = reduceTask(adopted, event, payload);
        if (next !== task) changed = true;
        return next;
      });
      return changed ? { ...previous, tasks: nextTasks } : previous;
    });
  }, []);

  const loadTools = useCallback(async (gateway: OpenClawGateway, sessionKey: string) => {
    try {
      // `tools.effective` projects the session's tools, including discovered
      // MCP servers; fall back to the agent-wide catalog on older gateways.
      const result = await gateway.request<unknown>('tools.effective', { sessionKey }, 15000);
      setTools(parseTools(result));
    } catch {
      try {
        const result = await gateway.request<unknown>('tools.catalog', {}, 15000);
        setTools(parseTools(result));
      } catch {
        setTools([]);
      }
    }
  }, []);

  /** Reads `tools.exec.mode` plus the per-agent allowlist from the gateway. */
  const loadExecPolicy = useCallback(async (gateway: OpenClawGateway) => {
    try {
      const config = await gateway.request<{ raw?: string; hash?: string }>(
        'config.get',
        {},
        15000
      );
      const parsed = config?.raw ? (JSON.parse(config.raw) as Record<string, unknown>) : {};
      const tools = parsed.tools as Record<string, unknown> | undefined;
      const exec = tools?.exec as Record<string, unknown> | undefined;
      setExecMode(exec?.mode === 'allowlist' ? 'allowlist' : 'full');
      const agents = parsed.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const model = defaults?.model as Record<string, unknown> | undefined;
      if (typeof model?.primary === 'string' && model.primary) setModelId(model.primary);
    } catch (reason) {
      console.warn('[work:policy]', reason);
    }
    try {
      const approvals = await gateway.request<{
        file?: { agents?: Record<string, { allowlist?: { pattern?: string }[] }> };
      }>('exec.approvals.get', {}, 15000);
      const entries = approvals?.file?.agents?.main?.allowlist ?? [];
      setAllowList(entries.map((entry) => String(entry.pattern ?? '')).filter(Boolean));
    } catch {
      setAllowList([]);
    }
  }, []);

  const changeExecMode = async (next: 'full' | 'allowlist') => {
    const gateway = gatewayRef.current;
    if (!gateway || !gateway.isOpen || switchingMode) return;
    setSwitchingMode(true);
    try {
      // `config.patch` is a compare-and-swap: it needs the hash from config.get.
      const config = await gateway.request<{ raw?: string; hash?: string }>(
        'config.get',
        {},
        15000
      );
      const baseHash = config?.hash;
      await gateway.request(
        'config.patch',
        {
          raw: JSON.stringify({ tools: { exec: { mode: next } } }),
          ...(baseHash ? { baseHash } : {})
        },
        20000
      );
      setExecMode(next);
      await loadExecPolicy(gateway);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSwitchingMode(false);
    }
  };

  const changeModel = async (next: string) => {
    const gateway = gatewayRef.current;
    if (!gateway || !gateway.isOpen || switchingModel || next === modelId) return;
    setSwitchingModel(true);
    try {
      const config = await gateway.request<{ raw?: string; hash?: string }>(
        'config.get',
        {},
        15000
      );
      const baseHash = config?.hash;
      await gateway.request(
        'config.patch',
        {
          raw: JSON.stringify({ agents: { defaults: { model: { primary: next } } } }),
          ...(baseHash ? { baseHash } : {})
        },
        20000
      );
      setModelId(next);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSwitchingModel(false);
    }
  };

  const loadCapabilities = useCallback(
    async (gateway: OpenClawGateway, sessionKey: string) => {
      try {
        const result = await gateway.request<unknown>('skills.status', {}, 15000);
        setSkills(parseCatalog(result));
      } catch (reason) {
        console.warn('[work:skills]', reason);
        setSkills([]);
      }
      await loadTools(gateway, sessionKey);
    },
    [loadTools]
  );

  const connectGateway = useCallback(
    async (next: WorkSettings) => {
      const previous = gatewayRef.current;
      gatewayRef.current = null;
      previous?.close();
      setStatus('connecting');
      setError(null);
      setHello(null);
      setApprovals([]);
      const gateway = new OpenClawGateway({
        url: next.url,
        token: next.token,
        clientId: 'gateway-client',
        clientMode: 'backend'
      });
      gatewayRef.current = gateway;
      gateway.on('*', (frame) => {
        if (!frame || typeof frame !== 'object') return;
        const { event, payload } = frame as { event: string; payload: unknown };
        if (event === '__close') {
          if (gatewayRef.current === gateway) {
            setStatus('offline');
            setApprovals([]);
          }
          return;
        }
        if (event === 'tick') return;
        pushEvent(event, payload);
      });
      try {
        const payload = await gateway.connect();
        if (gatewayRef.current !== gateway) return;
        setHello(payload);
        setStatus('online');
        void loadCapabilities(gateway, next.sessionKey || defaultWorkSettings.sessionKey);
        void loadExecPolicy(gateway);
      } catch (reason) {
        if (gatewayRef.current !== gateway) return;
        setStatus('offline');
        setError(errorMessage(reason));
      }
    },
    [loadCapabilities, loadExecPolicy, pushEvent]
  );

  // Discover the gateway token from ~/.openclaw/openclaw.json, prefer the
  // keychain copy, then connect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = readWorkSettings();
      let resolved = saved;
      try {
        const config = await invoke<GatewayConfig>('work:gateway_config');
        if (cancelled) return;
        setDiscovered(config);
        let secureToken: string | null = null;
        try {
          secureToken = await invoke<string | null>('secure_store_get', { key: gatewayTokenKey });
        } catch {
          secureToken = null;
        }
        if (cancelled) return;
        const configuredUrl =
          saved.url && saved.url !== defaultWorkSettings.url ? saved.url : config.url || saved.url;
        resolved = {
          ...saved,
          url: configuredUrl || defaultWorkSettings.url,
          token: secureToken || saved.token || config.token
        };
      } catch (reason) {
        console.warn('[work:config]', reason);
      }
      if (cancelled) return;
      setSettings(resolved);
      setDraftSettings(resolved);
      void connectGateway(resolved);
    })();
    return () => {
      cancelled = true;
      gatewayRef.current?.close();
      gatewayRef.current = null;
    };
  }, [connectGateway]);

  const updateSettings = (patch: Partial<WorkSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setDraftSettings(next);
    saveWorkSettings(next);
  };

  const saveAndConnect = async (next: WorkSettings) => {
    setSettings(next);
    saveWorkSettings(next);
    if (next.token.trim()) {
      try {
        await invoke('secure_store_set', { key: gatewayTokenKey, value: next.token.trim() });
      } catch (reason) {
        console.warn('[work:token]', reason);
      }
    }
    await connectGateway(next);
  };

  const handleMode = (next: AppMode) => {
    if (next === mode) return;
    setMode(next);
    activateMode(next, { openPanel: false });
    if (next === 'chat') {
      WindowService.openPanel('chat')
        .then(() => {
          if (!runningTask) WindowService.closeCurrent().catch(console.error);
        })
        .catch((reason: unknown) => console.error('[work:panel]', reason));
    }
  };

  const createSession = async (
    gateway: OpenClawGateway,
    displayName: string,
    workspace: string,
    fallback: string
  ): Promise<string> => {
    try {
      // `sessions.create` rejects `title`; the presentation field is `displayName`.
      const created = await gateway.request<unknown>(
        'sessions.create',
        {
          displayName,
          ...(workspace.trim() ? { cwd: workspace.trim() } : {})
        },
        30000
      );
      const key = sessionKeyOf(created);
      if (key) return key;
    } catch (reason) {
      console.warn('[work:session]', reason);
    }
    return fallback;
  };

  const subscribeSession = async (gateway: OpenClawGateway, sessionKey: string) => {
    try {
      // Live `chat` / `agent` frames are delivered to session subscribers.
      await gateway.request('sessions.messages.subscribe', { key: sessionKey }, 15000);
    } catch (reason) {
      console.warn('[work:subscribe]', reason);
    }
  };

  const runTask = async () => {
    const prompt = draft.trim();
    if (!prompt || submittingRef.current) return;
    const gateway = gatewayRef.current;
    if (!gateway || !gateway.isOpen) {
      setError('尚未连接 OpenClaw 网关，请先在“网关设置”里配置并连接。');
      return;
    }
    if (runningTask) {
      setError('当前任务仍在执行，请先等待结束或点击 Stop。');
      return;
    }
    submittingRef.current = true;
    const current = settingsRef.current;
    const task = createTask(prompt, {
      sessionKey: current.sessionKey,
      workspace: current.workspace
    });
    setState((previous) => ({
      tasks: [task, ...previous.tasks].slice(0, 12),
      activeId: task.id
    }));
    setDraft('');
    setError(null);

    try {
      const sessionKey = current.isolate
        ? await createSession(
            gateway,
            task.title,
            current.workspace,
            current.sessionKey || defaultWorkSettings.sessionKey
          )
        : current.sessionKey;
      setState((previous) => ({
        ...previous,
        tasks: previous.tasks.map((item) =>
          item.id === task.id ? { ...item, sessionKey } : item
        )
      }));
      await subscribeSession(gateway, sessionKey);
      void loadTools(gateway, sessionKey);
      const accepted = await gateway.request<unknown>(
        'chat.send',
        {
          sessionKey,
          message: composeMessage(prompt, current),
          idempotencyKey: requestId()
        },
        120000
      );
      const runId = runIdOf(accepted);
      setState((previous) => ({
        ...previous,
        tasks: previous.tasks.map((item) =>
          item.id === task.id
            ? {
                ...item,
                runId: runId ?? item.runId,
                sessionKey: sessionKeyOf(accepted) ?? item.sessionKey
              }
            : item
        )
      }));
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      setState((previous) => ({
        ...previous,
        tasks: previous.tasks.map((item) =>
          item.id === task.id ? failTask(item, message) : item
        )
      }));
    } finally {
      submittingRef.current = false;
    }
  };

  const stopTask = async () => {
    const task = runningTask ?? activeTask;
    const gateway = gatewayRef.current;
    if (!task || !gateway) return;
    try {
      await gateway.request(
        'chat.abort',
        {
          sessionKey: task.sessionKey,
          ...(task.runId ? { runId: task.runId } : {})
        },
        15000
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
    setState((previous) => ({
      ...previous,
      tasks: previous.tasks.map((item) =>
        item.id === task.id && item.status === 'running' ? abortTask(item) : item
      )
    }));
  };

  const resolveApproval = async (
    id: string,
    decision: 'allow-once' | 'allow-always' | 'deny'
  ) => {
    const gateway = gatewayRef.current;
    if (!gateway) return;
    // Gateway contract: `{ id, decision }` with allow-once / allow-always / deny.
    try {
      await gateway.request('exec.approval.resolve', { id, decision }, 15000);
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    setApprovals((previous) => previous.filter((entry) => entry.id !== id));
  };

  const startNewTask = () => {
    setState((previous) => ({ ...previous, activeId: null }));
    setDraft('');
    setError(null);
  };

  const gatewayVersion = hello?.server?.version ?? '';
  const scopesText = hello?.auth?.scopes?.join(' · ') ?? '';
  const gatewayLabel =
    status === 'online'
      ? `Gateway ${gatewayVersion ? `v${gatewayVersion}` : '在线'}`
      : status === 'connecting'
        ? '连接中…'
        : '离线';

  const canRun = draft.trim().length > 0 && status === 'online' && !runningTask;

  const mcpTools = tools.filter((tool) => tool.source === 'mcp');
  const computerUseTool = tools.some((tool) =>
    /screen|computer|desktop|browser|mouse|keyboard/i.test(tool.name)
  );
  const capabilitiesText =
    status === 'online'
      ? `能力：${skills.length} 个技能 · ${tools.length} 个工具${mcpTools.length ? `（MCP ${mcpTools.length}）` : ''}${computerUseTool ? ' · computer use 可用' : ''}`
      : '能力：连接网关后读取';

  return (
    <main className={`panel-window work-window${maximized ? ' is-maximized' : ''}`}>
      <header
        className="panel-window-header work-header"
        onPointerDown={(event) => {
          const target = event.target;
          if (event.button !== 0 || (target instanceof Element && target.closest('button, input, select, textarea')))
            return;
          WindowService.dragCurrent().catch(console.error);
        }}
        onDoubleClick={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('button, input, select, textarea')) return;
          WindowService.toggleMaximizeCurrent().then(setMaximized).catch(console.error);
        }}
      >
        <span className="panel-grip" aria-hidden="true" />
        <div className="panel-brand">
          <span className="panel-avatar work-avatar" aria-hidden="true">
            ✧
          </span>
          <div className="panel-brand-text">
            <h1>Work</h1>
            <p className="panel-subtitle">Agent console · OpenClaw gateway</p>
          </div>
        </div>
        <ModeSwitch mode={mode} onChange={handleMode} />
        <span className={`gateway-pill ${status}`} title={scopesText || undefined}>
          <span className="gateway-dot" aria-hidden="true" />
          {gatewayLabel}
        </span>
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

      <div className="work-body">
        <aside className="work-rail" aria-label="任务列表">
          <button type="button" className="work-new" onClick={startNewTask}>
            <span aria-hidden="true">＋</span> 新建任务
          </button>
          <div className="work-task-list">
            {tasks.length === 0 && <p className="work-rail-empty">还没有任务</p>}
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={task.id === activeId ? 'work-task active' : 'work-task'}
                onClick={() => setState((previous) => ({ ...previous, activeId: task.id }))}
              >
                <span className={`work-task-dot ${task.status}`} aria-hidden="true" />
                <span className="work-task-title">{task.title}</span>
                <span className="work-task-time">{clock(task.startedAt)}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="work-rail-settings"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((value) => !value)}
          >
            <span aria-hidden="true">⚙</span> 网关设置
          </button>
        </aside>

        <section className="work-main">
          {showSettings && (
            <section className="work-settings" aria-label="OpenClaw 网关设置">
              <div className="work-settings-head">
                <strong>OpenClaw Gateway</strong>
                <span className={`gateway-pill ${status}`}>
                  <span className="gateway-dot" aria-hidden="true" />
                  {gatewayLabel}
                </span>
              </div>
              <div className="work-settings-grid">
                <label className="work-field">
                  <span>地址</span>
                  <input
                    value={draftSettings.url}
                    spellCheck={false}
                    placeholder="ws://127.0.0.1:18789"
                    onChange={(event) =>
                      setDraftSettings({ ...draftSettings, url: event.target.value })
                    }
                  />
                </label>
                <label className="work-field">
                  <span>Token</span>
                  <input
                    type="password"
                    value={draftSettings.token}
                    spellCheck={false}
                    placeholder="gateway.auth.token"
                    onChange={(event) =>
                      setDraftSettings({ ...draftSettings, token: event.target.value })
                    }
                  />
                </label>
                <label className="work-field">
                  <span>默认会话</span>
                  <input
                    value={draftSettings.sessionKey}
                    spellCheck={false}
                    placeholder="agent:main:main"
                    onChange={(event) =>
                      setDraftSettings({ ...draftSettings, sessionKey: event.target.value })
                    }
                  />
                </label>
                <label className="work-field">
                  <span>工作目录</span>
                  <input
                    value={draftSettings.workspace}
                    spellCheck={false}
                    placeholder="D:\codex\workspace"
                    onChange={(event) =>
                      setDraftSettings({ ...draftSettings, workspace: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="work-settings-actions">
                <button
                  type="button"
                  className="work-run"
                  onClick={() => void saveAndConnect(draftSettings)}
                >
                  保存并连接
                </button>
                <button
                  type="button"
                  className="work-ghost"
                  onClick={() => void connectGateway(settings)}
                >
                  重连
                </button>
                <button
                  type="button"
                  className="work-ghost"
                  onClick={() => setDraftSettings(settings)}
                >
                  还原
                </button>
              </div>
              <p className="work-hint">
                先运行 <code>openclaw gateway</code>。Token 默认读取{' '}
                <code>~/.openclaw/openclaw.json</code> 的 <code>gateway.auth.token</code>
                {discovered?.configPath ? `（当前：${discovered.configPath}）` : '（尚未找到配置文件）'}。
              </p>
              {scopesText && <p className="work-hint">权限：{scopesText}</p>}
              <p className="work-hint">{capabilitiesText}</p>
              <div className="work-policy">
                <span className="work-policy-label">模型</span>
                <select
                  className="work-policy-select"
                  value={modelId}
                  disabled={switchingModel || status !== 'online'}
                  aria-label="默认模型"
                  onChange={(event) => void changeModel(event.target.value)}
                >
                  {MODEL_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                  {!MODEL_OPTIONS.some((option) => option.id === modelId) && (
                    <option value={modelId}>{modelId}</option>
                  )}
                </select>
                <span className="work-policy-note">
                  {switchingModel ? '切换中…' : '新任务生效'}
                </span>
              </div>
              <div className="work-policy">
                <span className="work-policy-label">执行权限</span>
                <div className="work-policy-options" role="group" aria-label="执行权限模式">
                  <button
                    type="button"
                    className={execMode === 'full' ? 'work-policy-btn active' : 'work-policy-btn'}
                    aria-pressed={execMode === 'full'}
                    disabled={switchingMode || status !== 'online'}
                    onClick={() => void changeExecMode('full')}
                  >
                    完全执行
                  </button>
                  <button
                    type="button"
                    className={execMode === 'allowlist' ? 'work-policy-btn active' : 'work-policy-btn'}
                    aria-pressed={execMode === 'allowlist'}
                    disabled={switchingMode || status !== 'online'}
                    onClick={() => void changeExecMode('allowlist')}
                  >
                    仅白名单
                  </button>
                </div>
                <span className="work-policy-note">
                  {switchingMode
                    ? '切换中…'
                    : execMode === 'full'
                      ? '不询问，直接运行'
                      : `白名单 ${allowList.length} 条`}
                </span>
              </div>
              {execMode === 'allowlist' && (
                <p className="work-hint">
                  {allowList.length > 0
                    ? `已允许：${allowList.slice(0, 6).join('、')}${allowList.length > 6 ? '…' : ''}`
                    : '白名单为空：所有命令都会被拒绝。'}
                  {' '}
                  用 <code>openclaw approvals allowlist add "&lt;程序&gt;"</code> 添加。
                </p>
              )}
            </section>
          )}

          <div className="work-timeline" ref={timelineRef} aria-live="polite">
            {!activeTask && (
              <div className="work-empty">
                <span className="work-empty-badge" aria-hidden="true">
                  ✧
                </span>
                <strong>把任务交给 Agent</strong>
                <span>
                  工作模式通过 OpenClaw Gateway 运行 Agent，可调用 skills、MCP 和 computer-use 工具。
                </span>
                <span className="empty-hint">
                  {status === 'online' ? '在下面描述任务，按 Enter 开始' : '先连接网关'}
                </span>
              </div>
            )}
            {activeTask?.items.map((item) => (
              <WorkItemView key={item.id} item={item} live={activeTask.status === 'running'} />
            ))}
            {activeTask && activeTask.tokens !== undefined && (
              <p className="work-entry notice info">
                本次运行约 {activeTask.tokens.toLocaleString()} tokens
              </p>
            )}
            {error && (
              <div className="chat-error" role="alert">
                {error}
                <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
                  ×
                </button>
              </div>
            )}
          </div>

          {approvals.length > 0 && (
            <div className="work-approvals" role="group" aria-label="待审批的工具执行">
              {approvals.map((approval) => (
                <div key={approval.id} className="work-approval">
                  <div className="work-approval-body">
                    <strong>需要审批</strong>
                    <code>{approval.command || approval.id}</code>
                  </div>
                  <button
                    type="button"
                    className="work-approval-approve"
                    onClick={() => void resolveApproval(approval.id, 'allow-once')}
                  >
                    允许一次
                  </button>
                  <button
                    type="button"
                    className="work-approval-always"
                    onClick={() => void resolveApproval(approval.id, 'allow-always')}
                  >
                    始终允许
                  </button>
                  <button
                    type="button"
                    className="work-approval-deny"
                    onClick={() => void resolveApproval(approval.id, 'deny')}
                  >
                    拒绝
                  </button>
                </div>
              ))}
            </div>
          )}

          <form
            className="work-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void runTask();
            }}
          >
            <textarea
              className="work-input"
              rows={3}
              value={draft}
              placeholder="描述要让 Agent 完成的任务，例如：整理 D:\downloads 里的发票，输出一份 CSV 汇总。"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (canRun) void runTask();
                }
              }}
            />
            <div className="work-options">
              <label className="work-field inline">
                <span>目录</span>
                <input
                  value={settings.workspace}
                  spellCheck={false}
                  placeholder="工作目录"
                  onChange={(event) => updateSettings({ workspace: event.target.value })}
                />
              </label>
              <label className="work-check">
                <input
                  type="checkbox"
                  checked={settings.isolate}
                  onChange={(event) => updateSettings({ isolate: event.target.checked })}
                />
                <span>独立会话</span>
              </label>
              <label className="work-check">
                <input
                  type="checkbox"
                  checked={settings.computerUse}
                  onChange={(event) => updateSettings({ computerUse: event.target.checked })}
                />
                <span>Computer use</span>
              </label>
              <label className="work-field inline skill">
                <span>技能</span>
                <select
                  value={settings.skill}
                  onChange={(event) => updateSettings({ skill: event.target.value })}
                >
                  <option value="">自动</option>
                  {skills.map((skill) => (
                    <option key={skill.name} value={skill.name}>
                      {skill.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="work-actions">
              <span className="work-hint">
                {runningTask ? 'Agent 执行中…' : 'Enter 发送 · Shift+Enter 换行'}
              </span>
              {runningTask && (
                <button type="button" className="work-stop" onClick={() => void stopTask()}>
                  Stop
                </button>
              )}
              <button type="submit" className="work-run" disabled={!canRun}>
                运行
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

export default WorkPanel;
