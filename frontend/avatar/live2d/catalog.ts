import { validateLive2DModel } from './runtime.ts';
import modelFiles from 'virtual:ice-live2d-models';

declare module 'virtual:ice-live2d-models' {
  const files: string[];
  export default files;
}

export type Live2DModelInfo = {
  id: string;
  name: string;
  modelPath: string;
};

export type Live2DModelStatus = Live2DModelInfo & { error: string | null };

const baseUrl = import.meta.env.BASE_URL;

export const LIVE2D_MODELS: Live2DModelInfo[] = modelFiles
  .map((id) => {
    const modelPath = new URL(`${baseUrl}${id}`, document.baseURI).href;
    const name = decodeURIComponent(id.split('/').at(-1) ?? id).replace(/\.model3\.json$/i, '');
    return { id, name, modelPath };
  })
  .sort((left, right) => left.id.localeCompare(right.id));

export const DEFAULT_LIVE2D_MODEL_ID =
  LIVE2D_MODELS.find((model) => model.id.startsWith('xglk/'))?.id ?? LIVE2D_MODELS[0]?.id ?? '';

export async function validateLive2DModels(
  models: Live2DModelInfo[] = LIVE2D_MODELS,
  fetcher: typeof fetch = fetch
): Promise<Live2DModelStatus[]> {
  return Promise.all(
    models.map(async (model) => {
      try {
        await validateLive2DModel(model.modelPath, fetcher);
        return { ...model, error: null };
      } catch (reason) {
        return {
          ...model,
          error: reason instanceof Error ? reason.message : String(reason)
        };
      }
    })
  );
}
