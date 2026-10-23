/**
 * Work-mode task model.
 *
 * A task is one agent run handed to the OpenClaw gateway. The gateway streams
 * `chat` (display-projected assistant text) and `agent` (tool lifecycle) events;
 * `reduceTask` folds them into a linear timeline the panel can render.
 */

export type WorkTaskStatus = 'running' | 'done' | 'error' | 'aborted';

export type WorkItemKind = 'prompt' | 'assistant' | 'thinking' | 'tool' | 'notice';

export type WorkItem = {
  id: string;
  kind: WorkItemKind;
  /** Prompt, assistant, thinking and notice text. Unused for tools. */
  text: string;
  /** Tool name. */
  title?: string;
  /** Tool input preview. */
  detail?: string;
  /** Tool result preview. */
  output?: string;
  /** `info` notices are neutral status lines. */
  level?: 'info' | 'error';
  status?: 'running' | 'done' | 'error';
  at: number;
};

export type WorkTask = {
  id: string;
  title: string;
  prompt: string;
  sessionKey: string;
  workspace: string;
  status: WorkTaskStatus;
  items: WorkItem[];
  runId?: string;
  tokens?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type WorkState = {
  tasks: WorkTask[];
  activeId: string | null;
};

export const workStorageKey = 'ice-agent.work.tasks.v1';
export const workSettingsKey = 'ice-agent.work.settings.v1';

const MAX_TASKS = 12;
const MAX_ITEMS = 240;
const MAX_TEXT = 24000;
const MAX_PREVIEW = 4000;

let sequence = 0;

function uid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function taskTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled task';
  return line.length > 52 ? `${line.slice(0, 52)}…` : line;
}

export function createTask(
  prompt: string,
  options: { sessionKey: string; workspace: string; title?: string }
): WorkTask {
  return {
    id: uid('task'),
    title: options.title?.trim() || taskTitle(prompt),
    prompt,
    sessionKey: options.sessionKey,
    workspace: options.workspace,
    status: 'running',
    items: [{ id: uid('item'), kind: 'prompt', text: prompt, at: Date.now() }],
    startedAt: Date.now()
  };
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clip(value, MAX_PREVIEW);
  try {
    return clip(JSON.stringify(value, null, 2), MAX_PREVIEW);
  } catch {
    return clip(String(value), MAX_PREVIEW);
  }
}

/** Display text of an assistant message block (`{content: string | blocks[]}`). */
function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const value = message as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  const content = value.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const block = part as Record<string, unknown>;
          if (typeof block.text === 'string') return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function pushItem(task: WorkTask, item: WorkItem): WorkTask {
  const items = [...task.items, item];
  return {
    ...task,
    items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items
  };
}

function patchLast(task: WorkTask, patch: (item: WorkItem) => WorkItem): WorkTask {
  if (task.items.length === 0) return task;
  const items = [...task.items];
  const index = items.length - 1;
  items[index] = patch(items[index]);
  return { ...task, items };
}

function notice(task: WorkTask, text: string, level: 'info' | 'error'): WorkTask {
  return pushItem(task, { id: uid('item'), kind: 'notice', text, level, at: Date.now() });
}

function finish(task: WorkTask, status: WorkTaskStatus, error?: string): WorkTask {
  // Settle every running entry: a finished run must not leave spinners behind.
  const items = task.items.map((item) => {
    if (item.status !== 'running') return item;
    if (item.kind === 'assistant') return { ...item, status: 'done' as const };
    if (item.kind === 'tool') {
      return { ...item, status: (status === 'error' ? 'error' : 'done') as 'error' | 'done' };
    }
    return item;
  });
  return {
    ...task,
    items,
    status,
    error: error ?? task.error,
    finishedAt: Date.now()
  };
}

/** Terminal error state for a rejected request or a failed run. */
export function failTask(task: WorkTask, message: string): WorkTask {
  return finish(notice(task, message, 'error'), 'error', message);
}

/** Terminal state for a user-requested stop. */
export function abortTask(task: WorkTask): WorkTask {
  return finish(notice(task, '任务已停止。', 'info'), 'aborted');
}

function sameRun(task: WorkTask, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return true;
  if (!task.runId) return true;
  return task.runId === runId;
}

function reduceChat(task: WorkTask, payload: Record<string, unknown>): WorkTask {
  if (!sameRun(task, payload.runId)) return task;
  const state = typeof payload.state === 'string' ? payload.state : '';
  const deltaText = typeof payload.deltaText === 'string' ? payload.deltaText : '';
  const snapshot = messageText(payload.message);

  if (state === 'delta') {
    const last = task.items[task.items.length - 1];
    if (last && last.kind === 'assistant' && last.status === 'running') {
      if (payload.replace === true) {
        // A replace frame re-baselines the item; the snapshot is authoritative
        // and its deltaText is often empty (gateways send that at the end).
        if (snapshot) {
          return patchLast(task, (item) => ({ ...item, text: clip(snapshot, MAX_TEXT) }));
        }
        return patchLast(task, (item) => ({ ...item, text: clip(deltaText, MAX_TEXT) }));
      }
      if (snapshot) return patchLast(task, (item) => ({ ...item, text: clip(snapshot, MAX_TEXT) }));
      if (!deltaText) return task;
      return patchLast(task, (item) => ({ ...item, text: clip(item.text + deltaText, MAX_TEXT) }));
    }
    const text = snapshot || deltaText;
    // Streamed whitespace-only snapshots must not create an empty bubble.
    if (!text.trim()) return task;
    return pushItem(task, {
      id: uid('item'),
      kind: 'assistant',
      text: clip(text, MAX_TEXT),
      status: 'running',
      at: Date.now()
    });
  }

  if (state === 'final') {
    const text = snapshot;
    const next = text
      ? patchLast(task, (item) =>
          item.kind === 'assistant' && item.status === 'running'
            ? { ...item, text: clip(text, MAX_TEXT) }
            : item
        )
      : task;
    return finish(next, 'done');
  }

  if (state === 'error') {
    const message =
      typeof payload.errorMessage === 'string' && payload.errorMessage
        ? payload.errorMessage
        : 'Agent 运行失败。';
    return finish(notice(task, message, 'error'), 'error', message);
  }

  if (state === 'aborted') {
    return finish(notice(task, '任务已停止。', 'info'), 'aborted');
  }

  return task;
}

function toolStatus(phase: string): 'running' | 'done' | 'error' {
  if (/error|fail|denied|blocked/.test(phase)) return 'error';
  if (/end|done|complete|success|result|finish/.test(phase)) return 'done';
  return 'running';
}

/** Tool results arrive as `{content:[{type:'text',text}]}`; unwrap the text. */
function toolOutput(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return preview(raw);
  const value = raw as Record<string, unknown>;
  const content = value.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const block = part as Record<string, unknown>;
        return typeof block.text === 'string' ? block.text : '';
      })
      .join('\n')
      .trim();
    if (text) return clip(text, MAX_PREVIEW);
  }
  if (typeof value.text === 'string' && value.text.trim()) {
    return clip(value.text, MAX_PREVIEW);
  }
  return preview(raw);
}

function reduceTool(task: WorkTask, raw: unknown): WorkTask {
  if (!raw || typeof raw !== 'object') return task;
  const data = raw as Record<string, unknown>;
  const callId = String(
    data.toolCallId ?? data.callId ?? data.id ?? data.toolName ?? data.name ?? ''
  );
  if (!callId) return task;
  const itemId = `tool-${callId}`;
  const phase = String(data.phase ?? data.status ?? '').toLowerCase();
  // `isError` is authoritative: a failed call still ends with phase "result".
  const status: 'running' | 'done' | 'error' =
    data.isError === true ? 'error' : toolStatus(phase);
  const name = String(data.name ?? data.toolName ?? data.tool ?? 'tool');
  const label =
    typeof data.meta === 'string' && data.meta.trim() ? data.meta.trim() : name;
  const input = preview(data.args ?? data.input ?? data.arguments ?? data.parameters);
  const output = toolOutput(
    data.result ?? data.partialResult ?? data.output ?? data.preview ?? data.error
  );
  const index = task.items.findIndex((item) => item.id === itemId);

  if (index === -1) {
    return pushItem(task, {
      id: itemId,
      kind: 'tool',
      title: label,
      detail: input,
      output,
      status,
      text: '',
      at: Date.now()
    });
  }
  const items = [...task.items];
  const current = items[index];
  items[index] = {
    ...current,
    title: label || current.title,
    detail: input || current.detail,
    output: output || current.output,
    status: status === 'running' && current.status === 'done' ? 'done' : status
  };
  return { ...task, items };
}

function reduceAgent(task: WorkTask, payload: Record<string, unknown>): WorkTask {
  if (!sameRun(task, payload.runId)) return task;
  const stream = typeof payload.stream === 'string' ? payload.stream : '';
  const data = payload.data;

  if (stream === 'tool') return reduceTool(task, data);
  if (stream === 'item') {
    const item = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (item && (item.type === 'tool_call' || item.type === 'tool')) {
      return reduceTool(task, item);
    }
    if (item && item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
      // Consecutive reasoning chunks merge into one collapsible block.
      const last = task.items[task.items.length - 1];
      if (last && last.kind === 'thinking') {
        return patchLast(task, (entry) => ({
          ...entry,
          text: clip(`${entry.text}\n\n${item.text}`, MAX_PREVIEW)
        }));
      }
      return pushItem(task, {
        id: uid('item'),
        kind: 'thinking',
        text: clip(item.text, MAX_PREVIEW),
        at: Date.now()
      });
    }
    return task;
  }
  if (stream === 'lifecycle') {
    const value: Record<string, unknown> =
      data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const phase = String(value.phase ?? value.status ?? '').toLowerCase();
    if (/error|fail/.test(phase)) {
      // Live gateways put the failure text in `error` on lifecycle events.
      const raw = value.error ?? value.message;
      const message = typeof raw === 'string' && raw ? raw : 'Agent 运行失败。';
      return finish(notice(task, message, 'error'), 'error', message);
    }
    return task;
  }
  if (stream === 'usage') {
    const value: Record<string, unknown> =
      data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    // Gateways report `inputTokens` / `outputTokens` per streamed usage frame.
    const input = typeof value.inputTokens === 'number' ? value.inputTokens : 0;
    const output = typeof value.outputTokens === 'number' ? value.outputTokens : 0;
    const total =
      typeof value.totalTokens === 'number'
        ? value.totalTokens
        : typeof value.total === 'number'
          ? value.total
          : input + output > 0
            ? input + output
            : undefined;
    if (typeof total === 'number') return { ...task, tokens: Math.max(task.tokens ?? 0, total) };
    return task;
  }
  return task;
}

/** Folds one gateway event into a task. Unknown shapes are ignored. */
export function reduceTask(task: WorkTask, event: string, payload: unknown): WorkTask {
  if (task.status !== 'running') return task;
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!value) return task;
  if (event === 'chat') return reduceChat(task, value);
  if (event === 'agent') return reduceAgent(task, value);
  if (event === 'session.tool') {
    const data = value.data && typeof value.data === 'object' ? value.data : value;
    if (!sameRun(task, value.runId)) return task;
    return reduceTool(task, data);
  }
  return task;
}

export function runIdOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  for (const key of ['runId', 'run_id']) {
    if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  }
  const run = value.run;
  if (run && typeof run === 'object') {
    const id = (run as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

export function sessionKeyOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  for (const key of ['sessionKey', 'key', 'session']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = (candidate as Record<string, unknown>).key;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return undefined;
}

export function loadWorkState(): WorkState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(workStorageKey) ?? 'null');
    if (!raw || typeof raw !== 'object') return { tasks: [], activeId: null };
    const value = raw as { tasks?: unknown; activeId?: unknown };
    const tasks = Array.isArray(value.tasks)
      ? value.tasks.filter((task): task is WorkTask => Boolean(task) && typeof task === 'object')
      : [];
    const restored = tasks.slice(0, MAX_TASKS).map((task) => ({
      ...task,
      // A window cannot still be streaming a run it did not start.
      status: task.status === 'running' ? ('aborted' as WorkTaskStatus) : task.status
    }));
    const activeId =
      typeof value.activeId === 'string' && restored.some((task) => task.id === value.activeId)
        ? value.activeId
        : (restored[0]?.id ?? null);
    return { tasks: restored, activeId };
  } catch {
    return { tasks: [], activeId: null };
  }
}

export function saveWorkState(state: WorkState): void {
  try {
    let tasks = state.tasks.slice(0, MAX_TASKS);
    let serialized = JSON.stringify({ tasks, activeId: state.activeId });
    // Tool output can be large; drop the oldest tasks until the payload fits.
    while (serialized.length > 1_500_000 && tasks.length > 1) {
      tasks = tasks.slice(0, tasks.length - 1);
      serialized = JSON.stringify({ tasks, activeId: state.activeId });
    }
    localStorage.setItem(workStorageKey, serialized);
  } catch (error) {
    console.warn('[work:persist]', error);
  }
}

export type WorkSettings = {
  url: string;
  token: string;
  sessionKey: string;
  workspace: string;
  isolate: boolean;
  computerUse: boolean;
  skill: string;
};

export const defaultWorkSettings: WorkSettings = {
  url: 'ws://127.0.0.1:18789',
  token: '',
  sessionKey: 'agent:main:main',
  workspace: '',
  isolate: true,
  computerUse: true,
  skill: ''
};

export function readWorkSettings(): WorkSettings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(workSettingsKey) ?? 'null');
    if (!raw || typeof raw !== 'object') return { ...defaultWorkSettings };
    const value = raw as Partial<WorkSettings>;
    return {
      url: typeof value.url === 'string' && value.url ? value.url : defaultWorkSettings.url,
      token: typeof value.token === 'string' ? value.token : '',
      sessionKey:
        typeof value.sessionKey === 'string' && value.sessionKey
          ? value.sessionKey
          : defaultWorkSettings.sessionKey,
      workspace: typeof value.workspace === 'string' ? value.workspace : '',
      isolate: typeof value.isolate === 'boolean' ? value.isolate : defaultWorkSettings.isolate,
      computerUse:
        typeof value.computerUse === 'boolean' ? value.computerUse : defaultWorkSettings.computerUse,
      skill: typeof value.skill === 'string' ? value.skill : ''
    };
  } catch {
    return { ...defaultWorkSettings };
  }
}

/**
 * Persists the non-secret half of the settings. The gateway token lives in the
 * OS keychain (`secure_store_set`) and is never written to localStorage.
 */
export function saveWorkSettings(settings: WorkSettings): void {
  const { token, ...rest } = settings;
  void token;
  localStorage.setItem(workSettingsKey, JSON.stringify(rest));
}
