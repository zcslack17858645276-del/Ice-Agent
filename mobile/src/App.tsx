import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { streamChat } from './api';
import {
  androidStoragePath,
  clearSettings,
  defaultSettings,
  loadHistory,
  loadSettings,
  saveHistory,
  saveSettings,
  type ChatMessage,
  type Settings
} from './storage';

import avatar from './avatar.png';

export default function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [draft, setDraft] = useState<Settings>(defaultSettings);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const [stored, history] = await Promise.all([loadSettings(), loadHistory()]);
      setSettings(stored);
      setDraft(stored);
      setMessages(history);
      if (!stored.apiKey) setShowSettings(true);
    })();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let handle: { remove: () => void } | null = null;
    let disposed = false;
    void CapacitorApp.addListener('backButton', () => {
      if (showSettings) {
        setShowSettings(false);
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
  }, [showSettings]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!settings.apiKey.trim()) {
      setError('请先在设置里填写 DeepSeek API Key');
      setShowSettings(true);
      return;
    }
    setError(null);
    setInput('');
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let answer = '';
    setMessages((current) => [...current, { role: 'assistant', content: '' }]);

    try {
      await streamChat(
        settings,
        next,
        (delta) => {
          answer += delta;
          setMessages((current) => {
            const copy = [...current];
            copy[copy.length - 1] = { role: 'assistant', content: answer };
            return copy;
          });
        },
        controller.signal
      );
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      setMessages((current) => {
        const final = current.filter((item) => item.content.trim().length > 0 || item.role === 'user');
        void saveHistory(final);
        return final;
      });
    }
  };

  const save = async () => {
    await saveSettings(draft);
    setSettings(draft);
    setShowSettings(false);
    setError(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <img className="avatar" src={avatar} alt="" />
        <div className="title">
          <strong>Ice Agent</strong>
          <small>{busy ? '正在输入…' : '在线'}</small>
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
            <div className="bubble">{item.content || (busy ? '…' : '')}</div>
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
              人格设定
              <textarea
                rows={4}
                value={draft.persona}
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              />
            </label>
            <p className="hint">
              Key 保存在本机应用私有目录：
              <br />
              <code>{androidStoragePath}</code>
              <br />
              可用 <code>adb shell run-as com.iceagent.mobile cat shared_prefs/CapacitorStorage.xml</code>{' '}
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
