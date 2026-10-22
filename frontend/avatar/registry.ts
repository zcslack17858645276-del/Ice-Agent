import type { AvatarAsset, PetState } from './types';

/**
 * Characters live on the Ice Agent server (`D:\IceAgent\characters`) and are
 * published by `GET /v1/characters`; nothing is bundled into the client build.
 */
const transparentPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const placeholderStates: AvatarAsset['states'] = {
  IDLE: { durationMs: 2400, loop: true, className: 'idle' },
  THINKING: { durationMs: 1400, loop: false, className: 'thinking' },
  HAPPY: { durationMs: 1100, loop: false, className: 'happy' },
  SAD: { durationMs: 1500, loop: false, className: 'sad' },
  WORKING: { durationMs: 1800, loop: true, className: 'working' },
  SLEEPING: { durationMs: 3000, loop: true, className: 'sleeping' }
} as AvatarAsset['states'];

const placeholder: AvatarAsset = {
  id: 'placeholder',
  characterId: 'placeholder',
  name: 'No character',
  resolution: 1,
  sizeBytes: 0,
  src: transparentPng,
  fallbackSrc: transparentPng,
  license: { author: '-', license: '-', source: 'server offline' },
  states: placeholderStates
} as AvatarAsset;

let characters: AvatarAsset[] = [];

export const AvatarRegistry = {
  registerImported: (assets: AvatarAsset[]) => {
    for (const asset of assets) {
      if (!characters.some((item) => item.id === asset.id)) {
        characters = [...characters, asset];
      }
    }
  },
  list: (): AvatarAsset[] => characters,
  find: (characterId: string, state: PetState, _expression: string, minResolution = 0) => {
    const byExactId = characters.find((asset) => asset.id === characterId);
    const candidates = byExactId
      ? [byExactId]
      : characters.filter((asset) => asset.characterId === characterId);
    return (
      candidates.find((asset) => asset.states[state] && asset.resolution >= minResolution) ??
      candidates[0] ??
      characters[0] ??
      placeholder
    );
  }
};

export { placeholder };
