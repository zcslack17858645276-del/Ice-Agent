import manifest from './manifest.json';
import type { AvatarAsset, PetState } from './types';

const assetUrls: Record<string, string> = {
  xglk: new URL('../../assets/xglk4.png', import.meta.url).href,
  dny: new URL('../../assets/dny.png', import.meta.url).href
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

const characters = (manifest.characters as ManifestCharacter[]).map((character) => {
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
