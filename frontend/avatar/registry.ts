import manifest from './manifest.json';
import type { AvatarAsset, PetState } from './types';

const assetUrls: Record<string, string> = {
  whale: new URL('../../assets/static/whale.png', import.meta.url).href,
  sigrika: new URL('../../assets/static/sigrika.png', import.meta.url).href,
  dania: new URL('../../assets/static/dania.png', import.meta.url).href
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
    fallbackSrc: new URL('../../assets/static/whale.png', import.meta.url).href,
    license: { author: 'PSD2Live export', license: 'Personal use', source: 'assets/live2d/mornye' },
    states: {},
    live2d: true,
    motions: ['Idle', 'Blink', 'Nod', 'Shake']
  },
  {
    id: 'sigrika-live2d',
    characterId: 'sigrika',
    name: 'Sigrika (Live2D)',
    resolution: 4096,
    sizeBytes: 0,
    src: new URL(
      '../../assets/live2d/sigrika/sigrika-psd2live/sigrika.model3.json',
      import.meta.url
    ).href,
    fallbackSrc: new URL('../../assets/static/sigrika.png', import.meta.url).href,
    license: { author: 'PSD2Live export', license: 'Personal use', source: 'assets/live2d/sigrika' },
    states: {},
    live2d: true,
    motions: ['Idle', 'Blink', 'Nod', 'Shake']
  }
];

let characters: AvatarAsset[] = [...staticCharacters, ...cubismCharacters];

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
      characters[0]
    );
  }
};
