/**
 * Live2D first-frame thumbnail renderer for the admin console.
 *
 * Reuses the Cubism framework that already ships with the desktop pet
 * (frontend/avatar/live2d/framework) and is bundled into a browser-ready IIFE:
 *
 *   node_modules\.bin\esbuild server/admin/src/live2d-preview.ts ^
 *     --bundle --format=iife --minify --target=es2020 ^
 *     --outfile=server/admin/vendor/live2d-preview.js
 *
 * The global `IceLive2D.renderThumbnail({ modelUrl, shaderBase, size })` returns a
 * PNG data URL of the model's default pose (the first frame the pet would show).
 * `vendor/live2d/live2dcubismcore.min.js` + `vendor/live2d/shaders/` must be loaded
 * from the same origin first.
 */
import {
  CubismFramework,
  LogLevel,
  Option
} from '../../../frontend/avatar/live2d/framework/live2dcubismframework';
import { CubismModelSettingJson } from '../../../frontend/avatar/live2d/framework/cubismmodelsettingjson';
import { CubismUserModel } from '../../../frontend/avatar/live2d/framework/model/cubismusermodel';
import { CubismMatrix44 } from '../../../frontend/avatar/live2d/framework/math/cubismmatrix44';

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface RenderOptions {
  modelUrl: string;
  shaderBase?: string;
  size?: number;
  /** 'full' shows the whole model; 'portrait' keeps the top part (head + torso). */
  framing?: 'full' | 'portrait';
  /** Vertical fraction kept for portrait framing (0.2 – 1). */
  portraitRatio?: number;
}

let frameworkStarted = false;

function ensureFramework(): void {
  if (frameworkStarted) return;
  const option = new Option();
  option.loggingLevel = LogLevel.LogLevel_Warning;
  option.logFunction = (message: string) => {
    console.warn('[live2d-thumb]', message);
  };
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  frameworkStarted = true;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`加载失败：${url}（${response.status}）`);
  return response.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`贴图加载失败：${url}`));
    image.src = url;
  });
}

function computeBounds(model: any): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const count = model.getDrawableCount();
  for (let index = 0; index < count; index += 1) {
    if (!model.getDrawableDynamicFlagIsVisible(index)) continue;
    const positions = model.getDrawableVertexPositions(index);
    if (!positions || positions.length === 0) continue;
    for (let offset = 0; offset < positions.length; offset += 2) {
      const x = positions[offset];
      const y = positions[offset + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

function fitMatrix(bounds: Bounds, padding = 0.94): CubismMatrix44 {
  const width = Math.max(1e-4, bounds.maxX - bounds.minX);
  const height = Math.max(1e-4, bounds.maxY - bounds.minY);
  const scale = Math.min(2 / width, 2 / height) * padding;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const matrix = new CubismMatrix44();
  matrix.setMatrix(
    new Float32Array([
      scale,
      0,
      0,
      0,
      0,
      scale,
      0,
      0,
      0,
      0,
      1,
      0,
      -centerX * scale,
      -centerY * scale,
      0,
      1
    ])
  );
  return matrix;
}

function portraitBounds(bounds: Bounds, ratio: number): Bounds {
  const height = Math.max(1e-4, bounds.maxY - bounds.minY);
  const keep = Math.min(1, Math.max(0.2, ratio));
  const cropHeight = height * keep;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const half = cropHeight / 2;
  return {
    minX: centerX - half,
    maxX: centerX + half,
    minY: bounds.maxY - cropHeight,
    maxY: bounds.maxY
  };
}

let sharedCanvas: HTMLCanvasElement | null = null;
let sharedGl: WebGLRenderingContext | null = null;

function getContext(size: number): { canvas: HTMLCanvasElement; gl: WebGLRenderingContext } {
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas');
    sharedGl = sharedCanvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: true,
      depth: true
    }) as WebGLRenderingContext | null;
  }
  if (!sharedCanvas || !sharedGl) throw new Error('WebGL 不可用，无法生成 Live2D 预览');
  if (sharedCanvas.width !== size || sharedCanvas.height !== size) {
    sharedCanvas.width = size;
    sharedCanvas.height = size;
  }
  return { canvas: sharedCanvas, gl: sharedGl };
}

class ThumbnailModel extends CubismUserModel {
  private gl: WebGLRenderingContext | null = null;
  private textures: WebGLTexture[] = [];

  async load(
    modelUrl: string,
    gl: WebGLRenderingContext,
    shaderBase: string,
    size: number
  ): Promise<void> {
    ensureFramework();
    this.gl = gl;

    const home = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
    const settingBuffer = await fetchArrayBuffer(modelUrl);
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);

    const mocBuffer = await fetchArrayBuffer(home + setting.getModelFileName());
    this.loadModel(mocBuffer, true);
    if (!this.getModel()) throw new Error('moc3 解析失败');

    this.createRenderer(size, size);
    this.setRenderTargetSize(size, size);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    renderer.loadShaders(shaderBase);
    renderer.setIsPremultipliedAlpha(true);

    for (let index = 0; index < setting.getTextureCount(); index += 1) {
      const image = await loadImage(home + setting.getTextureFileName(index));
      const texture = gl.createTexture();
      if (!texture) throw new Error('无法创建 WebGL 纹理');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      renderer.bindTexture(index, texture);
      this.textures.push(texture);
    }

    const model = this.getModel();
    if (!model) throw new Error('模型未初始化');
    model.loadParameters();
    model.update();
  }

  draw(
    gl: WebGLRenderingContext,
    size: number,
    framing: 'full' | 'portrait' = 'full',
    portraitRatio = 0.5
  ): void {
    const model = this.getModel();
    if (!model) throw new Error('模型未初始化');
    const bounds = computeBounds(model);
    const target =
      bounds && framing === 'portrait' ? portraitBounds(bounds, portraitRatio) : bounds;
    const matrix = target ? fitMatrix(target) : new CubismMatrix44();

    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const renderer = this.getRenderer();
    renderer.setMvpMatrix(matrix);
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, size, size]);
    renderer.drawModel();
    gl.finish();
  }

  dispose(): void {
    for (const texture of this.textures) {
      if (this.gl) this.gl.deleteTexture(texture);
    }
    this.textures = [];
    this.deleteRenderer();
    this.gl = null;
  }
}

async function renderThumbnail(options: RenderOptions): Promise<string> {
  const modelUrl = String(options.modelUrl || '');
  if (!modelUrl) throw new Error('缺少 modelUrl');
  const size = Math.max(96, Math.min(1024, Number(options.size) || 384));
  const shaderBase = options.shaderBase || './vendor/live2d/shaders/';
  const framing = options.framing === 'portrait' ? 'portrait' : 'full';
  const portraitRatio = Math.min(1, Math.max(0.2, Number(options.portraitRatio) || 0.5));
  const { canvas, gl } = getContext(size);
  const model = new ThumbnailModel();
  try {
    await model.load(modelUrl, gl, shaderBase, size);
    model.draw(gl, size, framing, portraitRatio);
    return canvas.toDataURL('image/png');
  } finally {
    model.dispose();
  }
}

(globalThis as any).IceLive2D = { renderThumbnail };

export { renderThumbnail };
