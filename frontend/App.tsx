import { useEffect, useState } from 'react';
import { WindowService, type AppInfo } from './windowService';

type Panel = 'chat' | 'settings' | null;

export default function App() {
  const [panel, setPanel] = useState<Panel>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    WindowService.getInfo()
      .then((value) => active && setInfo(value))
      .catch((reason: Error) => active && setError(reason.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    action().catch((reason: Error) => setError(reason.message));
  };

  return (
    <main className="app-shell">
      <header
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={() => run(WindowService.minimize)}
      >
        <span className="brand-mark" aria-hidden="true">
          ✦
        </span>
        <span className="title">Ice Agent</span>
        <div className="title-actions">
          <button
            className="icon-button"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => run(WindowService.minimize)}
          >
            −
          </button>
          <button
            className="icon-button close"
            aria-label="Close"
            title="Close"
            onClick={() => run(WindowService.close)}
          >
            ×
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <section className="pet-stage" data-tauri-drag-region>
        <div className="halo" aria-hidden="true" />
        <div className="pet-orb" role="img" aria-label="Desktop pet placeholder">
          <span>✦</span>
        </div>
        <h1>Ready when you are</h1>
        <p>Ice Agent desktop companion</p>
        {loading && <span className="status">Connecting…</span>}
        {!loading && info && (
          <span className="status">
            {info.environment} · v{info.version}
          </span>
        )}
      </section>

      {panel === 'chat' && (
        <section className="panel chat-panel" aria-label="Chat panel">
          <div className="panel-heading">
            <h2>Chat</h2>
            <button className="text-button" onClick={() => setPanel(null)}>
              Close
            </button>
          </div>
          <div className="empty-state">
            <span className="empty-icon">○</span>
            <strong>No messages yet</strong>
            <span>Conversation will be available in a future phase.</span>
          </div>
          <form
            className="chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              setMessage('');
            }}
          >
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write a message"
              aria-label="Message"
            />
            <button aria-label="Send message" title="Send message" disabled={!message.trim()}>
              ↑
            </button>
          </form>
        </section>
      )}

      {panel === 'settings' && (
        <section className="panel settings-panel" aria-label="Settings panel">
          <div className="panel-heading">
            <h2>Settings</h2>
            <button className="text-button" onClick={() => setPanel(null)}>
              Close
            </button>
          </div>
          <div className="setting-row">
            <span>Always on top</span>
            <span className="setting-value">Enabled</span>
          </div>
          <div className="setting-row">
            <span>Window size</span>
            <span className="setting-value">420 × 620</span>
          </div>
          <div className="setting-row">
            <span>Features</span>
            <span className="setting-value">Foundation</span>
          </div>
        </section>
      )}

      <footer className="toolbar">
        <button
          className={panel === 'chat' ? 'tool active' : 'tool'}
          onClick={() => setPanel(panel === 'chat' ? null : 'chat')}
        >
          <span>◇</span>Chat
        </button>
        <button className="tool" onClick={() => run(WindowService.drag)}>
          <span>✣</span>Move
        </button>
        <button
          className={panel === 'settings' ? 'tool active' : 'tool'}
          onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
        >
          <span>⚙</span>Settings
        </button>
      </footer>
    </main>
  );
}
