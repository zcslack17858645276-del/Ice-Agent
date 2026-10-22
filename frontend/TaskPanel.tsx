import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type TaskEvent = {
  type: string;
  text?: string;
  tool?: string;
  input?: unknown;
  result?: string;
  status?: string;
  callId?: string;
  sessionId?: string;
  phase?: string;
  code?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; tool: string; input: string; result?: string; status?: string }
  | { kind: 'final'; text: string }
  | { kind: 'stream'; text: string }
  | { kind: 'error'; text: string };

const workspaceKey = 'ice-agent.task-workspace.v1';
const defaultWorkspace = 'D:\\codex\\workspace';

/**
 * Task mode: runs `dsh --profile headless --json` and renders its event stream
 * (thinking, tool calls, results, final answer) as chat cards.
 */
export function TaskPanel() {
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem(workspaceKey) || defaultWorkspace
  );
  const [prompt, setPrompt] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tokens, setTokens] = useState(0);
  const [phase, setPhase] = useState('');
  const [step, setStep] = useState(0);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [lastEventAt, setLastEventAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);
  const startedRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(workspaceKey, workspace);
  }, [workspace]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const handle = useCallback((event: TaskEvent) => {
    if (event.type !== 'exit') {
      setLastEventAt(Date.now());
    }
    switch (event.type) {
      case 'status':
        if (event.phase === 'step_start' || event.phase === 'turn_start' || event.phase === 'turn_end') {
          setPhase(event.phase);
          if (typeof event.step === 'number') setStep(event.step);
        }
        if (event.usage?.totalTokens) {
          setTokens((current) => current + (event.usage?.totalTokens ?? 0));
        }
        break;
      case 'delta':
      case 'message':
        if (event.text) {
          setEntries((current) => {
            const last = current[current.length - 1];
            if (last && last.kind === 'stream') {
              return [...current.slice(0, -1), { kind: 'stream', text: last.text + (event.text ?? '') }];
            }
            return [...current, { kind: 'stream', text: event.text ?? '' }];
          });
        }
        break;
      case 'session':
        if (event.sessionId) setSessionId(event.sessionId);
        break;
      case 'thinking':
        if (event.text) {
          setEntries((current) => [...current, { kind: 'thinking', text: event.text ?? '' }]);
        }
        break;
      case 'tool_call':
        setPendingTool(event.tool ?? 'tool');
        setEntries((current) => [
          ...current,
          {
            kind: 'tool',
            id: event.callId ?? `call-${Date.now()}-${current.length}`,
            tool: event.tool ?? 'tool',
            input: JSON.stringify(event.input ?? {}, null, 2)
          }
        ]);
        break;
      case 'tool_result':
        setPendingTool(null);
        setEntries((current) =>
          current.map((entry) =>
            entry.kind === 'tool' && entry.id === event.callId
              ? { ...entry, result: event.result ?? '', status: event.status }
              : entry
          )
        );
        break;
      case 'final':
        setEntries((current) => [...current, { kind: 'final', text: event.text ?? '' }]);
        break;
      case 'stderr':
        if (event.text && !event.text.startsWith('dsh:')) {
          setEntries((current) => [...current, { kind: 'error', text: event.text ?? '' }]);
        }
        break;
      case 'exit':
        setRunning(false);
        setPendingTool(null);
        setPhase('idle');
        if (typeof event.code === 'number' && event.code !== 0) {
          setEntries((current) => [
            ...current,
            { kind: 'error', text: `dsh exited with code ${event.code}` }
          ]);
        }
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await invoke<{ events: TaskEvent[]; running: boolean; cursor: number }>(
          'task:poll',
          { since: cursorRef.current }
        );
        if (cancelled) return;
        cursorRef.current = res.cursor;
        res.events.forEach((event) => handle(event));
        // The invoke that starts the task is queued behind this poll, so a
        // "not running" answer right after Run only means "not started yet".
        const graceElapsed = Date.now() - startedRef.current > 2500;
        if (!res.running && graceElapsed) setRunning(false);
      } catch (error) {
        console.error('[task:poll]', error);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 300);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [running, handle]);

  const run = async () => {
    if (!prompt.trim() || running) return;
    const nextPrompt = prompt;
    setEntries([{ kind: 'user', text: nextPrompt }]);
    setTokens(0);
    cursorRef.current = 0;
    startedRef.current = Date.now();
    setRunning(true);
    setStartedAt(Date.now());
    setLastEventAt(Date.now());
    setPhase('turn_start');
    setStep(0);
    setPendingTool(null);
    setPrompt('');
    try {
      await invoke('task:start', { prompt: nextPrompt, sessionId, workspace });
    } catch (error) {
      setEntries((current) => [
        ...current,
        { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      ]);
      setRunning(false);
    }
  };

  const stop = () => {
    void invoke('task:stop').catch(console.error);
  };

  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const silent = lastEventAt ? Math.max(0, Math.round((now - lastEventAt) / 1000)) : 0;
  const statusLabel = !running
    ? 'Idle'
    : pendingTool
      ? `Running ${pendingTool}…`
      : phase === 'step_start'
        ? `Thinking · step ${step || 1}`
        : phase === 'turn_start'
          ? 'Starting…'
          : phase === 'turn_end'
            ? 'Finishing…'
            : 'Working…';
  const waitingForAnswer =
    running && !entries.some((entry) => entry.kind === 'thinking' || entry.kind === 'stream' || entry.kind === 'final' || entry.kind === 'tool');
  const statusMeta = !running
    ? ''
    : [
        `${elapsed}s`,
        silent >= 3 ? `${silent}s without output` : '',
        silent >= 45 ? 'looks stalled — try Stop' : '',
        tokens > 0 ? `${tokens.toLocaleString()} tok` : ''
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <section className="task-panel" aria-label="Task mode">
      <div className="task-head">
        <label className="task-workspace">
          <span>Workspace</span>
          <input
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            spellCheck={false}
          />
        </label>
        <span className="task-usage">
          {tokens > 0 ? `${tokens.toLocaleString()} tok` : ''}
          {sessionId ? ` · ${sessionId.replace('session-', '').slice(0, 8)}` : ''}
        </span>
        {running && (
          <button type="button" className="task-stop" onClick={stop}>
            Stop
          </button>
        )}
      </div>

      <div className={running ? 'task-status live' : 'task-status'} aria-live="polite">
        <span className="task-pulse" aria-hidden="true" />
        <span className="task-status-label">{statusLabel}</span>
        <span className="task-status-meta">{statusMeta}</span>
      </div>

      <div className="task-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="empty-state">
            <span className="empty-badge" aria-hidden="true">
              ✦
            </span>
            <strong>Task mode</strong>
            <span>Ask for something that needs files, commands or the web.</span>
            <span className="empty-hint">runs dsh headless · {workspace}</span>
          </div>
        )}
        {waitingForAnswer && (
          <div className="chat-message assistant" key="task-waiting">
            <div className="bubble task-thinking" aria-label="thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {entries.map((entry, index) => {
          if (entry.kind === 'user') {
            return (
              <div className="chat-message user" key={`user-${index}`}>
                <div className="bubble">{entry.text}</div>
              </div>
            );
          }
          if (entry.kind === 'thinking') {
            return (
              <details className="task-entry thinking" key={`think-${index}`}>
                <summary>thinking</summary>
                <pre>{entry.text}</pre>
              </details>
            );
          }
          if (entry.kind === 'tool') {
            return (
              <div className="task-entry tool" key={entry.id}>
                <div className="task-tool-head">
                  <span className="task-tool-name">{entry.tool}</span>
                  <span className="task-tool-status">{entry.status ?? 'running'}</span>
                </div>
                <pre className="task-tool-input">{entry.input}</pre>
                {entry.result && (
                  <details className="task-tool-result">
                    <summary>result</summary>
                    <pre>{entry.result}</pre>
                  </details>
                )}
              </div>
            );
          }
          if (entry.kind === 'stream') {
            return (
              <div className="chat-message assistant" key={`stream-${index}`}>
                <div className="bubble">{entry.text}</div>
              </div>
            );
          }
          if (entry.kind === 'final') {
            return (
              <div className="chat-message assistant" key={`final-${index}`}>
                <div className="bubble">{entry.text || '(no answer)'}</div>
              </div>
            );
          }
          return (
            <p className="task-error" key={`error-${index}`}>
              {entry.text}
            </p>
          );
        })}
      </div>

      <form
        className="task-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述要完成的任务，例如：统计 frontend 下的 .tsx 文件并按大小排序"
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void run();
            }
          }}
        />
        <button type="submit" disabled={running || !prompt.trim()}>
          {running ? 'Running…' : 'Run'}
        </button>
      </form>
    </section>
  );
}
