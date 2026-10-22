import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  chatViaServerOnce,
  serverSessionAppend,
  serverSessionCreate,
  serverSessionDelete,
  serverSessionDetail,
  serverSessionList,
  streamChat
} from './api';
import {
  androidStoragePath,
  clearSettings,
  defaultSettings,
  loadSessions,
  loadSettings,
  newSession,
  saveSessions,
  saveSettings,
  sessionTitle,
  type ChatMessage,
  type Session,
  type Settings
} from './storage';
import avatar from './avatar.png';

export default function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [draft, setDraft] = useState<Settings>(defaultSettings);
  const [action, setAction] = useState<{ index: number; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0] ?? null;
  const messages: ChatMessage[] = active?.messages ?? [];

  useEffect(() => {
    void (async () => {
      const [stored, loaded] = await Promise.all([loadSettings(), loadSessions()]);
      setSettings(stored);
      setDraft(stored);
      setSessions(loaded.sessions);
      setActiveId(loaded.activeId);
      if (!stored.apiKey) setShowSettings(true);
      const serverReady = stored.useServer && stored.serverUrl.trim().length > 0;
      if (serverReady) {
        try {
          const list = await serverSessionList(stored.serverUrl, stored.serverToken);
          if (list.length > 0) {
            const details = await Promise.all(
              list.slice(0, 20).map((item) => serverSessionDetail(stored.serverUrl, stored.serverToken, item.id))
            );
            const mapped: Session[] = details.map((detail) => ({
              id: detail.id,
              title: detail.title,
              createdAt: detail.createdAt,
              messages: (detail.messages ?? []).map((item) => ({ role: item.role, content: item.content }))
            }));
            setSessions(mapped);
            setActiveId(mapped[0].id);
          } else {
            const created = await serverSessionCreate(stored.serverUrl, stored.serverToken);
            const session: Session = { id: created.id, title: created.title, createdAt: created.createdAt, messages: [] };
            setSessions([session]);
            setActiveId(session.id);
          }
        } catch {
          /* offline: keep local sessions */
        }
      }
      if (stored.notify) {
        try {
          await LocalNotifications.requestPermissions();
        } catch {
          /* notifications unavailable */
        }
      }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let handle: { remove: () => void } | null = null;
    let disposed = false;
    void CapacitorApp.addListener('backButton', () => {
      if (action) {
        setAction(null);
        return;
      }
      if (showSettings) {
        setShowSettings(false);
        return;
      }
      if (showDrawer) {
        setShowDrawer(false);
        return;
      }
      void CapacitorApp.exitApp();
    }).then((listener) => {
      if (disposed) {
        void listener.remove();
        return;
      }
      handle = listener;
    });
    return () => {
      disposed = true;
      handle?.remove();
    };
  }, [action, showSettings, showDrawer]);

  const persist = (nextSessions: Session[], nextActiveId: string) => {
    setSessions(nextSessions);
    setActiveId(nextActiveId);
    void saveSessions(nextSessions, nextActiveId);
  };

  const updateActiveMessages = (updater: (list: ChatMessage[]) => ChatMessage[]) => {
    setSessions((current) => {
      const next = current.map((session) =>
        session.id === activeId
          ? { ...session, messages: updater(session.messages), title: sessionTitle(updater(session.messages)) }
          : session
      );
      void saveSessions(next, activeId);
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !active) return;
    const serverReady = settings.useServer && settings.serverUrl.trim().length > 0;
    if (!settings.apiKey.trim() && !serverReady) {
      setError('请先填写 API Key，或在设置里启用 PC 服务器');
      setShowSettings(true);
      return;
    }
    setError(null);
    setInput('');
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    updateActiveMessages(() => [...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    const serverMode = settings.useServer && settings.serverUrl.trim().length > 0;
    if (serverMode) {
      void serverSessionAppend(settings.serverUrl, settings.serverToken, activeId, 'user', text);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let answer = '';

    const onDelta = (delta: string) => {
      answer += delta;
      updateActiveMessages((list) => {
        const copy = [...list];
        copy[copy.length - 1] = { role: 'assistant', content: answer };
        return copy;
      });
    };
    const useServer = settings.useServer && settings.serverUrl.trim().length > 0;

    try {
      if (useServer) {
        try {
          const full = await chatViaServerOnce(
            settings.serverUrl,
            settings.serverToken,
            { model: settings.model, persona: settings.persona },
            history,
            controller.signal
          );
          onDelta(full);
        } catch (serverError) {
          if (!settings.apiKey.trim()) throw serverError;
          // Offline fallback: talk to DeepSeek directly with the local key.
          await streamChat(settings, history, onDelta, controller.signal);
        }
      } else {
        await streamChat(settings, history, onDelta, controller.signal);
      }
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      updateActiveMessages((list) => list.filter((item) => item.content.trim().length > 0));
      if (serverMode && answer.trim()) {
        void serverSessionAppend(settings.serverUrl, settings.serverToken, activeId, 'assistant', answer);
      }
      if (settings.notify && document.visibilityState !== 'visible' && answer.trim()) {
        try {
          await LocalNotifications.schedule({
            notifications: [
              {
                id: Math.floor(Date.now() / 1000) % 100000,
                title: 'Ice',
                body: answer.slice(0, 120)
              }
            ]
          });
        } catch {
          /* permission missing */
        }
      }
    }
  };

  const save = async () => {
    await saveSettings(draft);
    setSettings(draft);
    setShowSettings(false);
    setError(null);
  };

  const startLongPress = (index: number, text: string) => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      setAction({ index, text });
      pressTimer.current = null;
    }, 450);
  };

  const cancelLongPress = () => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="icon-button"
          aria-label="会话列表"
          onClick={() => setShowDrawer(true)}
        >
          ☰
        </button>
        <img className="avatar" src={avatar} alt="" />
        <div className="title">
          <strong>Ice Agent</strong>
          <small>{busy ? '正在输入…' : active ? active.title : '在线'}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="设置"
          onClick={() => {
            setDraft(settings);
            setShowSettings(true);
          }}
        >
          ⚙
        </button>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            <img src={avatar} alt="" />
            <strong>我是 Ice</strong>
            <span>直接说点什么吧，比如「今天有点累」。</span>
          </div>
        )}
        {messages.map((item, index) => (
          <div key={`${item.role}-${index}`} className={`row ${item.role}`}>
            {item.role === 'assistant' && <img className="mini" src={avatar} alt="" />}
            <div
              className="bubble"
              onPointerDown={() => startLongPress(index, item.content)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onContextMenu={(event) => {
                event.preventDefault();
                setAction({ index, text: item.content });
              }}
            >
              {item.content || (busy ? '…' : '')}
            </div>
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="说点什么…"
          rows={1}
        />
        {busy ? (
          <button type="button" className="send stop" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim()}>
            发送
          </button>
        )}
      </form>

      {showDrawer && (
        <div className="sheet" role="dialog" aria-label="会话列表">
          <div className="sheet-card drawer">
            <div className="drawer-head">
              <h2>会话</h2>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const session = newSession();
                  persist([session, ...sessions], session.id);
                  setShowDrawer(false);
                  if (settings.useServer && settings.serverUrl.trim()) {
                    void serverSessionCreate(settings.serverUrl, settings.serverToken).then((created) => {
                      setSessions((current) => current.map((item) => (item.id === session.id ? { ...item, id: created.id } : item)));
                      setActiveId(created.id);
                    }).catch(() => undefined);
                  }
                }}
              >
                + 新对话
              </button>
            </div>
            <div className="session-list">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={session.id === activeId ? 'session-row active' : 'session-row'}
                  onClick={() => {
                    persist(sessions, session.id);
                    setShowDrawer(false);
                  }}
                >
                  <div className="session-main">
                    <strong>{session.title}</strong>
                    <small>
                      {session.messages.length > 0 ? `${session.messages.length} 条消息` : '空会话'}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="session-delete"
                    aria-label="删除会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (settings.useServer && settings.serverUrl.trim()) {
                        void serverSessionDelete(settings.serverUrl, settings.serverToken, session.id);
                      }
                      const next = sessions.filter((item) => item.id !== session.id);
                      if (next.length === 0) {
                        const fresh = newSession();
                        persist([fresh], fresh.id);
                      } else {
                        persist(next, session.id === activeId ? next[0].id : activeId);
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {action && (
        <div className="sheet" role="dialog" aria-label="消息操作">
          <div className="sheet-card action-card">
            <p className="action-preview">{action.text.slice(0, 120)}</p>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(action.text);
                } catch {
                  /* clipboard unavailable */
                }
                setAction(null);
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                updateActiveMessages((list) => list.filter((_, index) => index !== action.index));
                setAction(null);
              }}
            >
              删除这条
            </button>
            <button type="button" className="ghost" onClick={() => setAction(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="sheet" role="dialog" aria-label="设置">
          <div className="sheet-card">
            <h2>设置</h2>
            <label>
              DeepSeek API Key
              <div className="key-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder="sk-..."
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
                <button type="button" onClick={() => setShowKey((value) => !value)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
            <p className="hint">
              模型 / 人格 / 主题等配置由 PC 服务器统一管理；这里只有连接信息与离线回退用的本地 Key。
            </p>
            <label>
              模型
              <input
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
            </label>
            <label>
              Base URL
              <input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
            <label>
              PC 服务器（可选）
              <input
                placeholder="http://192.168.1.10:8787"
                value={draft.serverUrl}
                onChange={(event) => setDraft({ ...draft, serverUrl: event.target.value })}
              />
            </label>
            <label>
              配对 Token
              <input
                value={draft.serverToken}
                onChange={(event) => setDraft({ ...draft, serverToken: event.target.value })}
              />
            </label>
            <div className="toggle-row">
              <span>走 PC 服务器（失败自动回退本地 Key）</span>
              <input
                type="checkbox"
                checked={draft.useServer}
                onChange={(event) => setDraft({ ...draft, useServer: event.target.checked })}
              />
            </div>
            <label>
              人格设定
              <textarea
                rows={4}
                value={draft.persona}
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              />
            </label>
            <div className="toggle-row">
              <span>深色主题</span>
              <input
                type="checkbox"
                checked={draft.theme === 'dark'}
                onChange={(event) =>
                  setDraft({ ...draft, theme: event.target.checked ? 'dark' : 'light' })
                }
              />
            </div>
            <div className="toggle-row">
              <span>后台 / 锁屏通知</span>
              <input
                type="checkbox"
                checked={draft.notify}
                onChange={(event) => setDraft({ ...draft, notify: event.target.checked })}
              />
            </div>
            <p className="hint">
              Key 与会话保存在本机应用私有目录：
              <br />
              <code>{androidStoragePath}</code>
              <br />
              可用{' '}
              <code>adb shell run-as com.iceagent.mobile cat shared_prefs/CapacitorStorage.xml</code>{' '}
              查看，删除该文件或点下方「清除」即可移除。
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  await clearSettings();
                  setDraft(defaultSettings);
                  setSettings(defaultSettings);
                  setShowSettings(false);
                }}
              >
                清除
              </button>
              <button type="button" className="ghost" onClick={() => setShowSettings(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
