import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AnimationController } from './avatar/animationController';
import { AvatarRegistry } from './avatar/registry';
import { StaticAvatarRenderer } from './avatar/renderer';
import { Live2DCanvas } from './avatar/live2d/Live2DCanvas';
import { applyTheme, readTheme } from './theme';
import { loadImportedCharacters } from './avatar/imported';
import { AvatarStateMachine, type AvatarSnapshot } from './avatar/stateMachine';
import { PET_STATES, type PetState } from './avatar/types';
import { WindowService, type AppInfo } from './windowService';
import { PanelWindow } from './PanelWindow';
import { VoiceServices } from './voice/services';

type Preferences = {
  characterId: string;
  animationEnabled: boolean;
};
const defaultPreferences: Preferences = {
  characterId: 'whale',
  animationEnabled: true
};
const preferencesKey = 'ice-agent.avatar-preferences.v1';
const expressionKey = 'ice-agent.avatar-expression.v1';
const petScaleKey = 'ice-agent.pet-scale.v5';

/** Live2D models play motion groups instead of the PNG state set. */
const live2dMotionByState: Record<PetState, string> = {
  IDLE: 'Idle',
  THINKING: 'Idle',
  HAPPY: 'Nod',
  SAD: 'Shake',
  WORKING: 'Idle',
  SLEEPING: 'Idle'
};

function stateMotion(state: PetState) {
  return live2dMotionByState[state] ?? 'Idle';
}

function readPetScale(): number {
  const raw = Number(localStorage.getItem(petScaleKey));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1.6, Math.max(0.55, raw));
}

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
        (asset) => asset.id === stored.characterId || asset.characterId === stored.characterId
      )
        ? String(stored.characterId)
        : defaultPreferences.characterId;
      return {
        characterId,
        animationEnabled: stored.animationEnabled === true
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
  const [assetError, setAssetError] = useState<string | null>(null);
  const [petScale, setPetScale] = useState(readPetScale);
  const [petBox, setPetBox] = useState<{ width: number; height: number } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<number | null>(null);
  const [theme] = useState(readTheme);
  const menuGuardRef = useRef(0);
  const live2dStageRef = useRef<{ play: (name: string) => void } | null>(null);
  const asset = AvatarRegistry.find(preferences.characterId, avatar.state, avatar.expression);

  useEffect(() => {
    applyTheme(theme);
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'ice-agent.theme.v1') applyTheme(event.newValue === 'dark' ? 'dark' : 'light');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [theme]);

  useEffect(() => {
    WindowService.setPetScale(petScale).then(setPetBox).catch(console.error);
  }, [petScale]);

  useEffect(() => {
    // The context menu keeps its own size: the window grows around it instead of
    // shrinking the menu with the character.
    WindowService.setMenuOpen(menuOpen).then(setPetBox).catch(console.error);
  }, [menuOpen]);

  useEffect(() => {
    // The window resize that accompanies the menu can blur the webview; ignore
    // those synthetic blur/click events so the menu is not closed instantly.
    const close = () => {
      if (Date.now() - menuGuardRef.current < 700) return;
      setMenuOpen(false);
    };
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
    if (localStorage.getItem('ice-agent.voice-autostart.v1') === 'false') return;
    void VoiceServices.startAll().catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const syncPanelChanges = (event: StorageEvent) => {
      if (event.key === preferencesKey) {
        void loadImportedCharacters().then(() => setPreferences(readPreferences()));
      }
      if (event.key === expressionKey && event.newValue) {
        setAvatar(
          machine.transition({ type: 'avatar:set_expression', expression: event.newValue })
        );
      }
      if (event.key === 'ice-agent.pet-state.v1' && event.newValue) {
        const next = machine.transition({
          type: 'avatar:set_state',
          state: event.newValue,
          priority: 1
        });
        if (next !== avatar) setAvatar(next);
      }
    };
    window.addEventListener('storage', syncPanelChanges);
    return () => window.removeEventListener('storage', syncPanelChanges);
  }, [machine]);

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
      style={
        petBox
          ? ({
              '--pet-w': `${petBox.width}px`,
              '--pet-h': `${petBox.height}px`,
              '--menu-anchor': menuAnchor ? `${menuAnchor}px` : undefined
            } as CSSProperties)
          : undefined
      }
      onContextMenu={(event) => {
        event.preventDefault();
        // Right-click toggles the menu: a second right-click closes it again.
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        // Freeze the menu beside the character at the size it had when opened.
        setMenuAnchor(petBox?.width ?? null);
        menuGuardRef.current = Date.now();
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
          {assetFailed ? (
            <div
              className={`avatar-fallback state-${avatar.state.toLowerCase()}`}
              aria-hidden="true"
            >
              <span>✦</span>
              {assetError && <em className="avatar-error">{assetError}</em>}
            </div>
          ) : asset.live2d ? (
            <Live2DCanvas
              modelUrl={asset.src}
              motion={stateMotion(avatar.state)}
              onStage={(stage) => {
                live2dStageRef.current = stage;
              }}
              onError={(messageText) => {
                setAssetFailed(true);
                setAssetError(messageText);
                console.error('[avatar:live2d]', messageText);
              }}
            />
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

      {menuOpen && (
        <nav
          className="context-menu"
          aria-label="Pet menu"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="context-menu-title">
            <span aria-hidden="true">♡</span>
            {asset.name}
          </span>
          <button onClick={() => openPanel('chat')}>
            <span aria-hidden="true">✉</span> Chat
          </button>
          <div className="context-menu-item" tabIndex={0}>
            <span aria-hidden="true">◈</span>
            <span className="item-label">States</span>
            <span className="item-chevron" aria-hidden="true">
              ›
            </span>
            <div className="context-flyout states" role="group" aria-label="States">
              {asset.live2d && asset.motions?.length
                ? asset.motions.map((motionName) => (
                    <button
                      key={motionName}
                      className="flyout-state"
                      onClick={() => {
                        setMenuOpen(false);
                        live2dStageRef.current?.play(motionName);
                      }}
                    >
                      {motionName}
                    </button>
                  ))
                : PET_STATES.map((state) => (
                    <button
                      key={state}
                      className={avatar.state === state ? 'flyout-state active' : 'flyout-state'}
                      onClick={() => {
                        setMenuOpen(false);
                        transition(state);
                      }}
                    >
                      {state[0] + state.slice(1).toLowerCase()}
                    </button>
                  ))}
            </div>
          </div>
          <div className="context-menu-item" tabIndex={0}>
            <span aria-hidden="true">◐</span>
            <span className="item-label">Size</span>
            <span className="item-value">{Math.round(petScale * 100)}%</span>
            <div className="context-flyout size">
              <input
                className="vertical-range"
                type="range"
                min="0.55"
                max="1.6"
                step="0.05"
                value={petScale}
                aria-label="Pet size"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPetScale(next);
                  localStorage.setItem(petScaleKey, String(next));
                }}
              />
            </div>
          </div>
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
    (windowLabel === 'panel-chat'
      ? 'chat'
      : windowLabel === 'panel-settings'
        ? 'settings'
        : windowLabel === 'panel-chat-config'
          ? 'chat-config'
          : null);
  if (panel === 'chat' || panel === 'settings' || panel === 'chat-config')
    return <PanelWindow kind={panel} />;
  return <PetApp />;
}
