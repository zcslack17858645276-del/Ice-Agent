export const PET_STATES = ['IDLE', 'THINKING', 'HAPPY', 'SAD', 'WORKING', 'SLEEPING'] as const;
export type PetState = (typeof PET_STATES)[number];

export const AVATAR_EXPRESSIONS = ['NEUTRAL', 'CHEERFUL', 'CONCERNED', 'CALM'] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

export type AnimationClip = {
  id: string;
  durationMs: number;
  loop: boolean;
  className: string;
};

export type AvatarAsset = {
  id: string;
  characterId: string;
  name: string;
  resolution: number;
  sizeBytes: number;
  src: string;
  fallbackSrc: string;
  license: { author: string; license: string; source: string };
  states: Partial<Record<PetState, AnimationClip>>;
};

export type AvatarTransitionEvent =
  | {
      type: 'avatar:set_state';
      state: string;
      reason?: string;
      priority?: number;
      dwellMs?: number;
    }
  | { type: 'avatar:finish_temporary'; reason?: string }
  | { type: 'avatar:set_expression'; expression: string }
  | { type: 'avatar:preload'; characterId: string };
