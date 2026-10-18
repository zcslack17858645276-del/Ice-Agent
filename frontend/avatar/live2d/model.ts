import type { Live2DModelResources } from './types.ts';

export const LIVE2D_RUNTIME_FILES = [
  'assets/xglk/runtime/live2dcubismcore.min.js',
  'assets/xglk/runtime/shaders/WebGL/'
] as const;

const assetBaseUrl =
  typeof import.meta.env === 'object' && import.meta.env !== undefined
    ? import.meta.env.BASE_URL
    : '/';
const documentBase = typeof document === 'object' ? document.baseURI : 'http://localhost/';

export const LIVE2D_RUNTIME_SCRIPT_PATH = new URL(
  `${assetBaseUrl}xglk/runtime/live2dcubismcore.min.js`,
  documentBase
).href;

export const LIVE2D_SHADER_PATH = new URL(
  `${assetBaseUrl}xglk/runtime/shaders/WebGL/`,
  documentBase
).href;

export const LIVE2D_MOTION_GROUPS: Record<string, string> = {
  IDLE: 'Idle',
  THINKING: 'Nod',
  HAPPY: 'Shake',
  SAD: 'Shake',
  WORKING: 'Idle',
  SLEEPING: 'Idle'
};

export function resolveModelResource(modelPath: string, resourcePath: string): string {
  return new URL(resourcePath, new URL(modelPath)).href;
}

export function getMotionGroup(state: string): string {
  return LIVE2D_MOTION_GROUPS[state] ?? 'Idle';
}

export function modelResourcesSummary(resources: Live2DModelResources): {
  modelPath: string;
  mocPath: string;
  textureCount: number;
  motionGroups: string[];
  physicsLoaded: boolean;
} {
  return {
    modelPath: resources.modelPath,
    mocPath: resources.mocPath,
    textureCount: resources.texturePaths.length,
    motionGroups: Object.keys(resources.motions),
    physicsLoaded: resources.physics !== null
  };
}
