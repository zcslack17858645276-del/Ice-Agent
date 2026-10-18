import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AnimationController } from './avatar/animationController';
import { AvatarRegistry } from './avatar/registry';
import { StaticAvatarRenderer } from './avatar/renderer';
import { Live2DRenderer } from './avatar/live2d/renderer';
import {
  DEFAULT_LIVE2D_MODEL_ID,
  LIVE2D_MODELS,
  validateLive2DModels,
  type Live2DModelStatus
} from './avatar/live2d/catalog';
import { AvatarStateMachine, type AvatarSnapshot } from './avatar/stateMachine';
import { PET_STATES, type PetState } from './avatar/types';
import { WindowService, type AppInfo } from './windowService';
import { PanelWindow } from './PanelWindow';

type AvatarMode = 'live2d' | 'static';
type Preferences = {
  characterId: string;
  animationEnabled: boolean;
  avatarMode: AvatarMode;
  live2dModelId: string;
};
const defaultPreferences: Preferences = {
  characterId: 'xglk',
  animationEnabled: true,
  avatarMode: 'live2d',
  live2dModelId: DEFAULT_LIVE2D_MODEL_ID
};
const preferencesKey = 'ice-agent.avatar-preferences.v1';
const expressionKey = 'ice-agent.avatar-expression.v1';

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
      return {
        characterId,
        animationEnabled: stored.animationEnabled === true,
        avatarMode: stored.avatarMode === 'static' ? 'static' : 'live2d',
        live2dModelId:
          typeof stored.live2dModelId === 'string' &&
          LIVE2D_MODELS.some((model) => model.id === stored.live2dModelId)
            ? stored.live2dModelId
            : defaultPreferences.live2dModelId
      };
    }
  } catch {
    return defaultPreferences;
  }
  return defaultPreferences;
}

function PetApp() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState(readPreferences);
  const machine = useMemo(() => new AvatarStateMachine(), []);
  const controller = useMemo(() => new AnimationController(), []);
  const [avatar, setAvatar] = useState<AvatarSnapshot>(machine.getSnapshot());
  const [assetFailed, setAssetFailed] = useState(false);
  const [live2dReady, setLive2dReady] = useState(false);
  const [live2dModels, setLive2dModels] = useState<Live2DModelStatus[]>([]);
  const selectedLive2DModel =
    live2dModels.find((model) => model.id === preferences.live2dModelId) ??
    LIVE2D_MODELS.find((model) => model.id === preferences.live2dModelId);
  const selectedLive2DModelPath = selectedLive2DModel?.modelPath ?? '';
  const asset = AvatarRegistry.find(preferences.characterId, avatar.state, avatar.expression);

  const onLive2DReady = useCallback(() => {
    setLive2dReady(true);
  }, []);

  const onLive2DError = useCallback((messageText: string) => {
    setLive2dReady(false);
    console.error('[live2d:runtime]', messageText);
  }, []);

  useEffect(() => {
    if (preferences.avatarMode === 'live2d') return;
    setLive2dReady(false);
  }, [preferences.avatarMode]);

  useEffect(() => {
    setLive2dReady(false);
  }, [preferences.live2dModelId]);

  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, []);

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
    const syncPanelChanges = (event: StorageEvent) => {
      if (event.key === preferencesKey) setPreferences(readPreferences());
      if (event.key === expressionKey && event.newValue) {
        setAvatar(
          machine.transition({ type: 'avatar:set_expression', expression: event.newValue })
        );
      }
    };
    window.addEventListener('storage', syncPanelChanges);
    return () => window.removeEventListener('storage', syncPanelChanges);
  }, [machine]);

  useEffect(() => {
    let active = true;
    validateLive2DModels().then((models) => {
      if (active) setLive2dModels(models);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setAssetFailed(false);
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
    action().catch((reason: Error) => {
      setError(reason.message);
      console.error('[window:command]', reason);
    });
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

  const openPanel = (nextPanel: 'chat' | 'settings') => {
    setMenuOpen(false);
    run(() => WindowService.openPanel(nextPanel));
  };

  return (
    <main
      className="app-shell desktop-mode"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <section className="pet-stage">
        <div
          className="avatar-display"
          role="img"
          aria-label={`${asset.name} avatar, ${avatar.state.toLowerCase()}`}
          onPointerDown={(event) => {
            if (event.button === 0) run(WindowService.drag);
          }}
        >
          {preferences.avatarMode === 'live2d' && selectedLive2DModelPath && (
            <Live2DRenderer
              key={selectedLive2DModelPath || preferences.live2dModelId}
              modelPath={selectedLive2DModelPath}
              state={avatar.state}
              expression={avatar.expression}
              visible={live2dReady}
              onReady={onLive2DReady}
              onError={onLive2DError}
            />
          )}
          {(preferences.avatarMode === 'static' || !live2dReady) &&
            (assetFailed ? (
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
                  console.error('[avatar:asset]', messageText);
                }}
              />
            ))}
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

      {menuOpen && (
        <nav
          className="context-menu"
          aria-label="Pet menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => openPanel('chat')}>
            <span aria-hidden="true">💬</span> Chat
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              run(WindowService.drag);
            }}
          >
            <span aria-hidden="true">✥</span> Move
          </button>
          <div className="context-menu-group">
            <span>
              <span aria-hidden="true">◈</span> States
            </span>
            {PET_STATES.map((state) => (
              <button
                key={state}
                className="context-state"
                onClick={() => {
                  setMenuOpen(false);
                  transition(state);
                }}
              >
                {state[0] + state.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <button onClick={() => openPanel('settings')}>
            <span aria-hidden="true">⚙</span> Settings
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              run(WindowService.close);
            }}
          >
            <span aria-hidden="true">×</span> Exit
          </button>
        </nav>
      )}
    </main>
  );
}

export default function App() {
  const queryPanel = new URLSearchParams(window.location.search).get('panel');
  const windowLabel = getCurrentWindow().label;
  const panel =
    queryPanel ??
    (windowLabel === 'panel-chat' ? 'chat' : windowLabel === 'panel-settings' ? 'settings' : null);
  if (panel === 'chat' || panel === 'settings') return <PanelWindow kind={panel} />;
  return <PetApp />;
}
