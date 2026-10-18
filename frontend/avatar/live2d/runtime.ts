import { LIVE2D_RUNTIME_FILES, LIVE2D_RUNTIME_SCRIPT_PATH, resolveModelResource } from './model.ts';
import type { Live2DModelResources, Live2DRuntimeProvider } from './types.ts';

type ModelFileReferences = {
  Moc?: unknown;
  Textures?: unknown;
  Physics?: unknown;
  Motions?: unknown;
  Expressions?: unknown;
};

type ModelDefinition = { FileReferences?: ModelFileReferences } & Record<string, unknown>;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Live2D ${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Live2D ${name} is missing.`);
  return value;
}

async function fetchBytes(url: string, fetcher: typeof fetch): Promise<ArrayBuffer> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Live2D resource failed to load (${response.status}): ${url}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error(`Live2D resource is empty: ${url}`);
  return bytes;
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const bytes = await fetchBytes(url, fetcher);
  try {
    return objectValue(JSON.parse(new TextDecoder().decode(bytes)), url);
  } catch (reason) {
    throw new Error(`Live2D JSON is invalid: ${url} (${String(reason)})`);
  }
}

async function validateReferencedFile(path: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(path, { method: 'HEAD' });
  if (!response.ok) {
    throw new Error(`Live2D required resource failed validation (${response.status}): ${path}`);
  }
}

export async function validateLive2DModel(
  modelPath: string,
  fetcher: typeof fetch = fetch,
  resourceBaseUrl: string = modelPath
): Promise<void> {
  const model = (await fetchJson(modelPath, fetcher)) as ModelDefinition;
  const references = objectValue(model.FileReferences, 'FileReferences') as ModelFileReferences;
  const mocPath = resolveModelResource(
    resourceBaseUrl,
    nonEmptyString(references.Moc, 'FileReferences.Moc')
  );
  if (!Array.isArray(references.Textures) || references.Textures.length === 0) {
    throw new Error('Live2D FileReferences.Textures must contain at least one texture.');
  }
  const required = [
    mocPath,
    ...references.Textures.map((texture, index) =>
      resolveModelResource(
        resourceBaseUrl,
        nonEmptyString(texture, `FileReferences.Textures[${index}]`)
      )
    )
  ];
  const optionalFiles: string[] = [];
  if (typeof references.Physics === 'string' && references.Physics.length > 0) {
    optionalFiles.push(resolveModelResource(resourceBaseUrl, references.Physics));
  }
  if (references.Motions !== undefined) {
    const groups = objectValue(references.Motions, 'FileReferences.Motions');
    for (const [group, entries] of Object.entries(groups)) {
      if (!Array.isArray(entries)) throw new Error(`Live2D motion group '${group}' is invalid.`);
      entries.forEach((entry, index) => {
        const definition = objectValue(entry, `motion ${group}[${index}]`);
        optionalFiles.push(
          resolveModelResource(
            resourceBaseUrl,
            nonEmptyString(definition.File, `motion ${group}[${index}].File`)
          )
        );
      });
    }
  }
  if (references.Expressions !== undefined) {
    if (!Array.isArray(references.Expressions)) {
      throw new Error('Live2D FileReferences.Expressions must be an array.');
    }
    references.Expressions.forEach((entry, index) => {
      const definition = objectValue(entry, `expression[${index}]`);
      optionalFiles.push(
        resolveModelResource(
          resourceBaseUrl,
          nonEmptyString(definition.File, `expression[${index}].File`)
        )
      );
    });
  }
  await Promise.all(
    [...required, ...optionalFiles].map((path) => validateReferencedFile(path, fetcher))
  );
}

export async function loadLive2DResources(
  modelPath: string,
  fetcher: typeof fetch = fetch,
  resourceBaseUrl: string = modelPath
): Promise<Live2DModelResources> {
  const model = (await fetchJson(modelPath, fetcher)) as ModelDefinition;
  const references = objectValue(model.FileReferences, 'FileReferences') as ModelFileReferences;
  const mocName = nonEmptyString(references.Moc, 'FileReferences.Moc');
  const textureNames = references.Textures;
  if (!Array.isArray(textureNames) || textureNames.length === 0) {
    throw new Error('Live2D FileReferences.Textures must contain at least one texture.');
  }
  const texturePaths = textureNames.map((name, index) =>
    resolveModelResource(resourceBaseUrl, nonEmptyString(name, `FileReferences.Textures[${index}]`))
  );
  const mocPath = resolveModelResource(resourceBaseUrl, mocName);
  const textures = await Promise.all(
    texturePaths.map(
      async (path) => new Blob([await fetchBytes(path, fetcher)], { type: 'image/png' })
    )
  );
  const physicsName = references.Physics;
  const physicsPath =
    typeof physicsName === 'string' && physicsName.length > 0
      ? resolveModelResource(resourceBaseUrl, physicsName)
      : null;
  const physics = physicsPath === null ? null : await fetchJson(physicsPath, fetcher);
  const motionEntries =
    references.Motions === undefined
      ? {}
      : objectValue(references.Motions, 'FileReferences.Motions');
  const motions: Live2DModelResources['motions'] = {};
  for (const [group, entries] of Object.entries(motionEntries)) {
    if (!Array.isArray(entries)) throw new Error(`Live2D motion group '${group}' is invalid.`);
    motions[group] = await Promise.all(
      entries.map(async (entry, index) => {
        const definition = objectValue(entry, `motion ${group}[${index}]`);
        const path = resolveModelResource(
          resourceBaseUrl,
          nonEmptyString(definition.File, `motion ${group}[${index}].File`)
        );
        const bytes = await fetchBytes(path, fetcher);
        return {
          path,
          definition: objectValue(JSON.parse(new TextDecoder().decode(bytes)), path),
          bytes
        };
      })
    );
  }
  const expressionEntries = references.Expressions;
  const expressions: Live2DModelResources['expressions'] = {};
  if (expressionEntries !== undefined) {
    if (!Array.isArray(expressionEntries)) {
      throw new Error('Live2D FileReferences.Expressions must be an array.');
    }
    for (const [index, entry] of expressionEntries.entries()) {
      const definition = objectValue(entry, `expression[${index}]`);
      const path = resolveModelResource(
        resourceBaseUrl,
        nonEmptyString(definition.File, `expression[${index}].File`)
      );
      const bytes = await fetchBytes(path, fetcher);
      expressions[
        typeof definition.Name === 'string' ? definition.Name : `Expression ${index + 1}`
      ] = {
        path,
        bytes
      };
    }
  }
  return {
    modelPath,
    model,
    mocPath,
    moc: await fetchBytes(mocPath, fetcher),
    texturePaths,
    textures,
    physicsPath,
    physics,
    motions,
    expressions
  };
}

function getGlobalRuntime(): { createProvider?: () => Live2DRuntimeProvider } | undefined {
  return (
    globalThis as typeof globalThis & {
      IceLive2D?: { createProvider?: () => Live2DRuntimeProvider };
    }
  ).IceLive2D;
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ice-live2d="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    script.dataset.iceLive2d = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Live2D runtime file failed to load: ${url}`));
    document.head.appendChild(script);
  });
}

let runtimeLoading: Promise<void> | null = null;

export async function loadLive2DRuntime(): Promise<Live2DRuntimeProvider> {
  const existing = getGlobalRuntime();
  if (!existing?.createProvider) {
    if (typeof document !== 'object') {
      throw new Error(
        `Live2D runtime is unavailable. Expected Cubism Core and shader assets: ${LIVE2D_RUNTIME_FILES.join(', ')}.`
      );
    }
    runtimeLoading ??= loadScript(LIVE2D_RUNTIME_SCRIPT_PATH);
    await runtimeLoading;
  }
  if (getGlobalRuntime()?.createProvider) return getLive2DRuntimeProvider();
  const { createCubismProvider } = await import('./cubismAdapter.ts');
  return createCubismProvider();
}

export function getLive2DRuntimeProvider(): Live2DRuntimeProvider {
  const globalRuntime = getGlobalRuntime();
  if (!globalRuntime?.createProvider) {
    throw new Error(
      `Live2D runtime is unavailable. Expected Cubism Core and shader assets: ${LIVE2D_RUNTIME_FILES.join(', ')}.`
    );
  }
  return globalRuntime.createProvider();
}
