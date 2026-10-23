import type { AppMode } from '../mode';

/**
 * The mode slider: chat on the left, work on the right. Both side labels are
 * buttons as well, so the control stays reachable from the keyboard.
 */
export function ModeSwitch({
  mode,
  onChange,
  compact = false,
  disabled = false
}: {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const work = mode === 'work';
  const select = (next: AppMode) => {
    if (disabled || next === mode) return;
    onChange(next);
  };
  return (
    <div
      className={`mode-switch${work ? ' is-work' : ''}${compact ? ' compact' : ''}${disabled ? ' is-disabled' : ''}`}
    >
      <button
        type="button"
        className={work ? 'mode-switch-side' : 'mode-switch-side active'}
        aria-pressed={!work}
        onClick={() => select('chat')}
        disabled={disabled}
      >
        Chat
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={work}
        aria-label={work ? 'Switch to chat mode' : 'Switch to work mode'}
        title={work ? 'Switch to chat mode' : 'Switch to work mode'}
        className="mode-switch-track"
        onClick={() => select(work ? 'chat' : 'work')}
        disabled={disabled}
      >
        <span className="mode-switch-knob" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={work ? 'mode-switch-side active' : 'mode-switch-side'}
        aria-pressed={work}
        onClick={() => select('work')}
        disabled={disabled}
      >
        Work
      </button>
    </div>
  );
}
