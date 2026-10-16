import {
  AVATAR_EXPRESSIONS,
  PET_STATES,
  type AvatarExpression,
  type AvatarTransitionEvent,
  type PetState
} from './types.ts';

const stableStates = new Set<PetState>(['IDLE', 'SLEEPING']);
const temporaryStates = new Set<PetState>(['THINKING', 'HAPPY', 'SAD', 'WORKING']);

export type AvatarSnapshot = {
  state: PetState;
  expression: AvatarExpression;
  stableState: PetState;
  reason: string;
  changedAt: number;
  priority: number;
  dwellMs: number | null;
  interruptedState: PetState | null;
  interruptedPriority: number;
};

export class AvatarStateMachine {
  private snapshot: AvatarSnapshot = {
    state: 'IDLE',
    expression: 'NEUTRAL',
    stableState: 'IDLE',
    reason: 'initial',
    changedAt: Date.now(),
    priority: 0,
    dwellMs: null,
    interruptedState: null,
    interruptedPriority: 0
  };

  getSnapshot = (): AvatarSnapshot => this.snapshot;

  transition(event: AvatarTransitionEvent): AvatarSnapshot {
    const current = this.snapshot;
    if (event.type === 'avatar:set_expression') {
      const expression = AVATAR_EXPRESSIONS.find((value) => value === event.expression);
      if (expression)
        this.snapshot = {
          ...current,
          expression,
          reason: 'expression changed',
          changedAt: Date.now()
        };
      return this.snapshot;
    }
    if (event.type !== 'avatar:set_state') return current;

    const state = PET_STATES.find((value) => value === event.state) ?? 'IDLE';
    const reason =
      state === event.state
        ? (event.reason ?? 'state event')
        : `unknown state '${event.state}', fallback to IDLE`;
    const priority = Math.max(0, event.priority ?? 0);
    if (
      state === current.state ||
      (state === 'SLEEPING' && event.reason !== 'explicit-sleep-policy') ||
      priority < current.priority
    ) {
      return current;
    }
    const stableState = stableStates.has(state) ? state : current.stableState;
    const interruptedState =
      current.interruptedState ??
      (priority > current.priority && current.state !== 'IDLE' ? current.state : null);
    this.snapshot = {
      ...current,
      state,
      stableState,
      reason,
      priority,
      interruptedState,
      interruptedPriority: current.interruptedState
        ? current.interruptedPriority
        : current.priority,
      changedAt: Date.now(),
      dwellMs: temporaryStates.has(state)
        ? Math.max(0, event.dwellMs ?? (state === 'HAPPY' ? 1100 : state === 'SAD' ? 1500 : 1800))
        : null
    };
    return this.snapshot;
  }

  finishTemporary(reason = 'temporary state finished'): AvatarSnapshot {
    if (!temporaryStates.has(this.snapshot.state)) return this.snapshot;
    const recoveredState = this.snapshot.interruptedState ?? this.snapshot.stableState;
    this.snapshot = {
      ...this.snapshot,
      state: recoveredState,
      reason,
      priority: this.snapshot.interruptedState ? this.snapshot.interruptedPriority : 0,
      interruptedState: null,
      interruptedPriority: 0,
      dwellMs: temporaryStates.has(recoveredState) ? 1800 : null,
      changedAt: Date.now()
    };
    return this.snapshot;
  }
}
