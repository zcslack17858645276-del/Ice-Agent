import { WindowService } from './windowService';

/**
 * Chat mode and work mode are two separate surfaces:
 *
 * - `chat` keeps the companion chatting through the model configuration.
 * - `work` hands tasks to an agent running behind the OpenClaw gateway.
 *
 * The mode is global (every window reads the same key) and drives the pet's
 * state, the menu entry point and which panel the pet opens.
 */
export type AppMode = 'chat' | 'work';

export const modeStorageKey = 'ice-agent.mode.v1';

export function readMode(): AppMode {
  return localStorage.getItem(modeStorageKey) === 'work' ? 'work' : 'chat';
}

export function writeMode(mode: AppMode): void {
  localStorage.setItem(modeStorageKey, mode);
  // Same-window listeners never receive a storage event, so fan it out by hand.
  window.dispatchEvent(new StorageEvent('storage', { key: modeStorageKey, newValue: mode }));
}

/** The panel that belongs to a mode; both are separate windows. */
export function panelForMode(mode: AppMode): 'chat' | 'work' {
  return mode === 'work' ? 'work' : 'chat';
}

export function openModePanel(mode: AppMode): void {
  WindowService.openPanel(panelForMode(mode)).catch((error: unknown) => {
    console.error('[mode:panel]', error);
  });
}

/**
 * Switches the whole app between chat and work. `openPanel` defaults to true so
 * the matching console becomes visible; the pet passes `false` when it only
 * needs the state to follow.
 */
export function activateMode(mode: AppMode, options: { openPanel?: boolean } = {}): void {
  const changed = readMode() !== mode;
  if (changed) writeMode(mode);
  if (options.openPanel !== false) openModePanel(mode);
}
