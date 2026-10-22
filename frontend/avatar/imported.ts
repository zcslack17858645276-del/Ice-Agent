import { invoke } from '@tauri-apps/api/core';
import { voiceServer } from '../voice/serverVoice';
import { voiceServer } from '../voice/serverVoice';
import { AvatarRegistry } from './registry';
import type { AvatarAsset, PetState } from './types';

type ImportedEntry = {
  id: string;
  name: string;
  kind: string;
  entry: string;
  path: string;
};

const states: AvatarAsset['states'] = {
  IDLE: { durationMs: 2400, loop: true, className: 'idle' },
  THINKING: { durationMs: 1400, loop: false, className: 'thinking' },
  HAPPY: { durationMs: 1100, loop: false, className: 'happy' },
  SAD: { durationMs: 1500, loop: false, className: 'sad' },
  WORKING: { durationMs: 1800, loop: true, className: 'working' },
  SLEEPING: { durationMs: 3000, loop: true, className: 'sleeping' }
} as AvatarAsset['states'];

function toAsset(entry: ImportedEntry): AvatarAsset {
  // Served by the built-in localhost HTTP server (works without the asset protocol).
  const src = `http://127.0.0.1:8787/assets/${entry.id}/${entry.entry}`;
  return {
    id: entry.id,
    characterId: entry.id,
    name: entry.name,
    resolution: 2048,
    sizeBytes: 0,
    src,
    fallbackSrc: src,
    license: { author: 'Imported', license: 'Personal use', source: entry.path },
    states,
    live2d: entry.kind === 'live2d',
    motions: entry.kind === 'live2d' ? ['Idle', 'Blink'] : undefined
  } as AvatarAsset & { motions?: string[] };
}

export async function loadImportedCharacters(): Promise<number> {
  try {
    const server = await voiceServer();
    const response = await fetch(`${server.base}/v1/characters`, {
      headers: { Authorization: `Bearer ${server.token}` }
    });
    if (!response.ok) throw new Error(`characters ${response.status}`);
    const payload = (await response.json()) as { characters?: ImportedEntry[] };
    const list = payload.characters ?? [];
    const assets = list.map(toAsset);
    AvatarRegistry.registerImported(assets);
    return assets.length;
  } catch {
    return 0;
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export async function importFiles(
  name: string,
  kind: 'image' | 'live2d',
  files: FileList
): Promise<ImportedEntry> {
  const payload: { path: string; data: string }[] = [];
  for (const file of Array.from(files)) {
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    payload.push({ path: relative, data: await readAsBase64(file) });
  }
  const entry = await invoke<ImportedEntry>('character:import', {
    name: name.trim() || (kind === 'live2d' ? 'Imported Live2D' : 'Imported Image'),
    kind,
    files: payload
  });
  AvatarRegistry.registerImported([toAsset(entry)]);
  return entry;
}

export function isLive2DState(state: PetState): boolean {
  return state === 'IDLE';
}
