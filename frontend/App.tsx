import { useEffect, useMemo, useState } from 'react';
import { AnimationController } from './avatar/animationController';
import { AvatarRegistry } from './avatar/registry';
import { StaticAvatarRenderer } from './avatar/renderer';
import { AvatarStateMachine, type AvatarSnapshot } from './avatar/stateMachine';
import {
  AVATAR_EXPRESSIONS,
  PET_STATES,
  type AvatarExpression,
  type PetState
} from './avatar/types';
import { WindowService, type AppInfo } from './windowService';

type Panel = 'chat' | 'settings' | null;
type Preferences = { characterId: string; animationEnabled: boolean };
const defaultPreferences: Preferences = { characterId: 'xglk', animationEnabled: true };
const preferencesKey = 'ice-agent.avatar-preferences.v1';

function readPreferences(): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'characterId' in raw &&
      'animationEnabled' in raw
    ) {
      const stored = raw as Record<string, unknown>;
      const characterId = AvatarRegistry.list().some(
        (asset) => asset.characterId === stored.characterId
      )
        ? String(stored.characterId)
        : defaultPreferences.characterId;
      return { characterId, animationEnabled: stored.animationEnabled === true };
    }
  } catch {
    return defaultPreferences;
  }
  return defaultPreferences;
}

export default function App() {
  const [panel, setPanel] = useState<Panel>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [preferences, setPreferences] = useState(readPreferences);
  const machine = useMemo(() => new AvatarStateMachine(), []);
  const controller = useMemo(() => new AnimationController(), []);
  const [avatar, setAvatar] = useState<AvatarSnapshot>(machine.getSnapshot());
  const [assetError, setAssetError] = useState<string | null>(null);
  const [assetFailed, setAssetFailed] = useState(false);
  const asset = AvatarRegistry.find(preferences.characterId, avatar.state, avatar.expression);

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

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    setAssetFailed(false);
    setAssetError(null);
    const startedAt = performance.now();
    controller
      .preload([asset.src])
      .then(() =>
        console.info('[avatar:preload]', {
          characterId: asset.characterId,
          durationMs: Math.round(performance.now() - startedAt)
        })
      )
      .catch((reason: Error) => {
        setAssetError(reason.message);
        console.error('[avatar:preload]', reason);
      });
  }, [asset.src, controller]);

  useEffect(() => {
    const clip = asset.states[avatar.state];
    if (!clip) {
      controller.stop();
      return;
    }
    if (!preferences.animationEnabled) {
      controller.stop();
      if (avatar.dwellMs !== null) {
        const timer = window.setTimeout(
          () => setAvatar(machine.finishTemporary(`${avatar.state} dwell completed`)),
          avatar.dwellMs
        );
        return () => window.clearTimeout(timer);
      }
      return;
    }
    controller.play(clip, () => {
      const next = machine.finishTemporary(`${avatar.state} animation completed`);
      if (next !== avatar) {
        console.info('[avatar:state]', {
          state: next.state,
          reason: next.reason,
          time: new Date(next.changedAt).toISOString()
        });
        setAvatar(next);
      }
    });
    return () => controller.stop();
  }, [avatar, asset, controller, machine, preferences.animationEnabled]);

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    action().catch((reason: Error) => setError(reason.message));
  };

  const transition = (state: PetState) => {
    const next = machine.transition({
      type: 'avatar:set_state',
      state,
      reason: state === 'SLEEPING' ? 'explicit-sleep-policy' : 'user state selection',
      priority: state === 'HAPPY' || state === 'SAD' ? 2 : 0,
      dwellMs: AvatarRegistry.find(preferences.characterId, state, avatar.expression).states[state]
        ?.durationMs
    });
    if (next !== avatar) {
      console.info('[avatar:state]', {
        state: next.state,
        reason: next.reason,
        time: new Date(next.changedAt).toISOString()
      });
      setAvatar(next);
    }
  };

  const chooseCharacter = (characterId: string) => {
    const nextAsset = AvatarRegistry.find(characterId, avatar.state, avatar.expression);
    const startedAt = performance.now();
    controller
      .preload([nextAsset.src])
      .then(() =>
        console.info('[avatar:preload]', {
          characterId: nextAsset.characterId,
          durationMs: Math.round(performance.now() - startedAt)
        })
      )
      .catch((reason: Error) => {
        setAssetError(reason.message);
        console.error('[avatar:preload]', reason);
      });
    setPreferences((current) => ({ ...current, characterId }));
    setAssetFailed(false);
    setAssetError(null);
  };

  const setExpression = (expression: AvatarExpression) => {
    const next = machine.transition({ type: 'avatar:set_expression', expression });
    console.info('[avatar:expression]', {
      expression: next.expression,
      time: new Date(next.changedAt).toISOString()
    });
    setAvatar(next);
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
        <div
          className="avatar-display"
          role="img"
          aria-label={`${asset.name} avatar, ${avatar.state.toLowerCase()}`}
        >
          {assetFailed ? (
            <div
              className={`avatar-fallback state-${avatar.state.toLowerCase()}`}
              aria-hidden="true"
            >
              <span>✦</span>
            </div>
          ) : (
            <StaticAvatarRenderer
              state={avatar.state}
              expression={avatar.expression}
              asset={asset}
              animationEnabled={preferences.animationEnabled}
              onAssetError={(messageText) => {
                setAssetFailed(true);
                setAssetError(messageText);
                console.error('[avatar:asset]', messageText);
              }}
            />
          )}
        </div>
        <h1>{asset.name}</h1>
        <p className="state-label">
          {avatar.state.toLowerCase()} · {avatar.expression.toLowerCase()}
        </p>
        {loading && <span className="status">Connecting…</span>}
        {!loading && info && (
          <span className="status">
            {info.environment} · v{info.version}
          </span>
        )}
        <div className="state-controls" aria-label="Pet state">
          {PET_STATES.map((state) => (
            <button
              key={state}
              className={avatar.state === state ? 'state-button active' : 'state-button'}
              aria-pressed={avatar.state === state}
              onClick={() => transition(state)}
            >
              {state[0] + state.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
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
            <span className="empty-icon">◌</span>
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
              ➤
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
          <label className="setting-row" htmlFor="character-select">
            <span>Character</span>
            <select
              id="character-select"
              value={preferences.characterId}
              onChange={(event) => chooseCharacter(event.target.value)}
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
          <div className="setting-row" aria-label="Expression">
            <span>Expression</span>
            <select
              value={avatar.expression}
              onChange={(event) => setExpression(event.target.value as AvatarExpression)}
            >
              {AVATAR_EXPRESSIONS.map((expression) => (
                <option key={expression} value={expression}>
                  {expression[0] + expression.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span>Current state</span>
            <span className="setting-value">{avatar.state}</span>
          </div>
          {assetError && (
            <div className="asset-error" role="alert">
              {assetError}
            </div>
          )}
          <div className="license-note">{asset.license.license}</div>
        </section>
      )}

      <footer className="toolbar">
        <button
          className={panel === 'chat' ? 'tool active' : 'tool'}
          onClick={() => setPanel(panel === 'chat' ? null : 'chat')}
        >
          <span>◌</span>Chat
        </button>
        <button className="tool" onClick={() => run(WindowService.drag)}>
          <span>✥</span>Move
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
