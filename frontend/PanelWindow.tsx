import { useEffect, useState } from 'react';
import { DEFAULT_LIVE2D_MODEL_ID, LIVE2D_MODELS } from './avatar/live2d/catalog';
import { AvatarRegistry } from './avatar/registry';
import { AVATAR_EXPRESSIONS, type AvatarExpression } from './avatar/types';
import { WindowService } from './windowService';

type PanelKind = 'chat' | 'settings';
type AvatarMode = 'live2d' | 'static';
type Preferences = {
  characterId: string;
  animationEnabled: boolean;
  avatarMode: AvatarMode;
  live2dModelId: string;
};

const preferencesKey = 'ice-agent.avatar-preferences.v1';
const expressionKey = 'ice-agent.avatar-expression.v1';
const defaults: Preferences = {
  characterId: 'xglk',
  animationEnabled: true,
  avatarMode: 'live2d',
  live2dModelId: DEFAULT_LIVE2D_MODEL_ID
};

function readPreferences(): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return defaults;
    const stored = raw as Record<string, unknown>;
    return {
      characterId: AvatarRegistry.list().some((asset) => asset.characterId === stored.characterId)
        ? String(stored.characterId)
        : defaults.characterId,
      animationEnabled: stored.animationEnabled === true,
      avatarMode: stored.avatarMode === 'static' ? 'static' : 'live2d',
      live2dModelId:
        typeof stored.live2dModelId === 'string' &&
        LIVE2D_MODELS.some((model) => model.id === stored.live2dModelId)
          ? stored.live2dModelId
          : defaults.live2dModelId
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
          <div className="empty-state">
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
        </>
      ) : (
        <div className="panel-window-settings">
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
          <label className="setting-row" htmlFor="live2d-model">
            <span>Live2D model</span>
            <select
              id="live2d-model"
              value={preferences.live2dModelId}
              onChange={(event) =>
                setPreferences((current) => ({ ...current, live2dModelId: event.target.value }))
              }
            >
              {LIVE2D_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
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
          <label className="setting-row" htmlFor="avatar-mode">
            <span>Avatar display</span>
            <select
              id="avatar-mode"
              value={preferences.avatarMode}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  avatarMode: event.target.value as AvatarMode
                }))
              }
            >
              <option value="live2d">Live2D</option>
              <option value="static">Static PNG</option>
            </select>
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
