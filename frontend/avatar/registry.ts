import manifest from './manifest.json';
import type { AvatarAsset, PetState } from './types';

const assetUrls: Record<string, string> = {
  xglk: new URL('../../assets/static/xglk4.png', import.meta.url).href,
  dny: new URL('../../assets/static/dny.png', import.meta.url).href
};

type ManifestCharacter = {
  id: string;
  name: string;
  author: string;
  license: string;
  source: string;
  asset: string;
  resolution: number;
  sizeBytes: number;
  states: AvatarAsset['states'];
};

const staticCharacters = (manifest.characters as ManifestCharacter[]).map((character) => {
  const src = assetUrls[character.id];
  if (!src) throw new Error(`No bundled avatar asset registered for '${character.id}'.`);
  return {
    id: character.id,
    characterId: character.id,
    name: character.name,
    resolution: character.resolution,
    sizeBytes: character.sizeBytes,
    src,
    fallbackSrc: src,
    license: { author: character.author, license: character.license, source: character.source },
    states: character.states
  } satisfies AvatarAsset;
});

/** Cubism models exported by psd2live; their states are motion groups. */
const cubismCharacters: AvatarAsset[] = [
  {
    id: 'mornye',
    characterId: 'mornye',
    name: 'Mornye',
    resolution: 4096,
    sizeBytes: 0,
    src: new URL(
      '../../assets/live2d/mornye/mornye-psd2live/mornye.model3.json',
      import.meta.url
    ).href,
    fallbackSrc: new URL('../../assets/static/dny.png', import.meta.url).href,
    license: { author: 'PSD2Live export', license: 'Personal use', source: 'assets/live2d/mornye' },
    states: {},
    live2d: true,
    motions: ['Idle', 'Blink', 'Nod', 'Shake']
  }
];

const characters = [...staticCharacters, ...cubismCharacters];

export const AvatarRegistry = {
  list: (): AvatarAsset[] => characters,
  find: (characterId: string, state: PetState, _expression: string, minResolution = 0) =>
    characters.find(
      (asset) =>
        asset.characterId === characterId &&
        asset.states[state] &&
        asset.resolution >= minResolution
    ) ??
    characters.find((asset) => asset.characterId === characterId) ??
    characters[0]
};
