import { CubismFramework, LogLevel, Option } from './framework/live2dcubismframework';
import { CubismModelSettingJson } from './framework/cubismmodelsettingjson';
import type { ICubismModelSetting } from './framework/icubismmodelsetting';
import { CubismUserModel } from './framework/model/cubismusermodel';
import { CubismMatrix44 } from './framework/math/cubismmatrix44';
import type { CubismMotion } from './framework/motion/cubismmotion';
import { CubismEyeBlink } from './framework/effect/cubismeyeblink';

let frameworkStarted = false;
const cubismLogs: string[] = [];

function ensureFramework() {
  if (frameworkStarted) return;
  const option = new Option();
  option.loggingLevel = LogLevel.LogLevel_Verbose;
  option.logFunction = (message: string) => {
    cubismLogs.push(message);
    if (cubismLogs.length > 40) cubismLogs.shift();
  };
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  frameworkStarted = true;
}

export function cubismLogTail(count = 3): string {
  return cubismLogs.slice(-count).join(' | ');
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Live2D asset missing: ${url} (${response.status})`);
  return response.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Live2D texture missing: ${url}`));
    image.src = url;
  });
}

/**
 * Cubism model rendered with the official framework renderer. The pipeline and
 * matrix setup mirror the AAAAGENT reference renderer that is known to work in
 * a transparent desktop-pet window.
 */
export class CubismPetModel extends CubismUserModel {
  private settings: ICubismModelSetting | null = null;
  private motions = new Map<string, CubismMotion>();
  private groups: string[] = [];
  private idleGroup = '';
  private gl: WebGLRenderingContext | null = null;
  private textures: WebGLTexture[] = [];
  private projection: CubismMatrix44 | null = null;
  lastStep = '';
  private viewportKey = '';
  private loaded = false;
  lastError = '';

  get motionGroups(): string[] {
    return this.groups;
  }

  get diagnostics(): string {
    const model = this.getModel();
    return `drawables=${model?.getDrawableCount() ?? 0} proj=${this.projection ? 'y' : 'n'} step=${this.lastStep} err=${this.lastError}`;
  }

  get isReady(): boolean {
    return this.loaded;
  }

  async load(modelUrl: string, gl: WebGLRenderingContext) {
    ensureFramework();
    this.gl = gl;
    const home = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
    const settingBuffer = await fetchBuffer(modelUrl);
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    this.settings = setting;

    const mocBuffer = await fetchBuffer(home + setting.getModelFileName());
    this.loadModel(mocBuffer, true);

    const canvas = gl.canvas as HTMLCanvasElement;
    this.createRenderer(canvas.width, canvas.height);
    this.setRenderTargetSize(canvas.width, canvas.height);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    renderer.loadShaders('/live2d/shaders/');
    renderer.setIsPremultipliedAlpha(true);

    for (let i = 0; i < setting.getTextureCount(); i += 1) {
      const image = await loadImage(home + setting.getTextureFileName(i));
      const texture = gl.createTexture();
      if (!texture) throw new Error('Unable to allocate a Live2D texture.');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      renderer.bindTexture(i, texture);
      this.textures[i] = texture;
    }

    for (let g = 0; g < setting.getMotionGroupCount(); g += 1) {
      const group = setting.getMotionGroupName(g);
      this.groups.push(group);
      if (group.toLowerCase() === 'idle') this.idleGroup = group;
      const count = setting.getMotionCount(group);
      for (let i = 0; i < count; i += 1) {
        const buffer = await fetchBuffer(home + setting.getMotionFileName(group, i));
        const motion = this.loadMotion(buffer, buffer.byteLength, `${group}_${i}`);
        if (motion) {
          // Without effect ids the motion manager dereferences a null list.
          motion.setEffectIds([], []);
          if (group.toLowerCase() === 'idle') motion.setLoop(true);
          this.motions.set(`${group}_${i}`, motion);
        }
      }
    }
    if (!this.idleGroup) this.idleGroup = this.groups[0] ?? '';

    if (setting.getEyeBlinkParameterCount() > 0) {
      this._eyeBlink = CubismEyeBlink.create(setting);
    }
    if (setting.getPhysicsFileName()) {
      const buffer = await fetchBuffer(home + setting.getPhysicsFileName());
      this.loadPhysics(buffer, buffer.byteLength);
    }
    if (setting.getPoseFileName()) {
      const buffer = await fetchBuffer(home + setting.getPoseFileName());
      this.loadPose(buffer, buffer.byteLength);
    }

    // Framing: the model canvas is unit-sized, so give the model a fixed height.
    this.getModelMatrix().setHeight(1.9);
    this.getModelMatrix().setPosition(0, 0);

    this.update(0);
    this.syncViewport(true);
    this.loaded = true;
  }

  hasMotion(group: string): boolean {
    return this.motions.has(`${group}_0`);
  }

  play(group: string, index = 0): boolean {
    const motion = this.motions.get(`${group}_${index}`);
    if (!motion) return false;
    this._motionManager.startMotionPriority(motion, false, 3);
    return true;
  }

  update(deltaSeconds: number) {
    if (!this.settings) return;
    const model = this.getModel();
    model.loadParameters();

    try {
      if (this._motionManager.isFinished()) {
        const idle = this.motions.get(`${this.idleGroup}_0`);
        if (idle) this._motionManager.startMotionPriority(idle, false, 1);
      } else {
        this._motionManager.updateMotion(model, deltaSeconds);
      }
    } catch (error) {
      this.lastError = `motion: ${error instanceof Error ? error.message : String(error)}`;
    }
    model.saveParameters();

    const stage = (name: string, run: () => void) => {
      try {
        run();
      } catch (error) {
        this.lastError = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    if (this._pose) stage('pose', () => this._pose?.updateParameters(model, deltaSeconds));
    if (this._eyeBlink) stage('blink', () => this._eyeBlink?.updateParameters(model, deltaSeconds));
    if (this._physics) stage('physics', () => this._physics?.evaluate(model, deltaSeconds));
    stage('model', () => model.update());
  }

  /** Keeps the render target and projection in sync with the canvas size. */
  syncViewport(force = false) {
    if (!this.gl || !this.settings) return;
    this.lastStep = 'sync';
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const width = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);
    this.setRenderTargetSize(width, height);
    // A canvas resize invalidates the projection; without this the model keeps
    // the old framing and shows up tiny / displaced for the resize frame.
    const key = `${width}x${height}`;
    if (!force && this.projection && this.viewportKey === key) return;
    this.viewportKey = key;
    const modelMatrix = this.getModelMatrix();
    const model = this.getModel();
    if (!model) return;
    const modelAspect = model.getCanvasWidth() / Math.max(1e-4, model.getCanvasHeight());
    const viewWidth = 2 * (width / height);
    const modelHeight = 1.9;
    const modelWidth = modelHeight * modelAspect;
    const zoom = Math.min(2 / modelHeight, (viewWidth / modelWidth) * 1.22);
    const projection = new CubismMatrix44();
    projection.scale((height / width) * zoom, zoom);
    // Bottom-align the character inside the view.
    projection.translateY(-(1 - (modelHeight * zoom) / 2));
    projection.multiplyByMatrix(modelMatrix);
    this.projection = projection;
  }

  draw(gl: WebGLRenderingContext, width: number, height: number) {
    if (!this.settings) return;
    if (!this.projection) this.syncViewport(true);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const renderer = this.getRenderer();
    this.lastStep = 'mvp';
    renderer.setMvpMatrix(this.projection ?? new CubismMatrix44());
    this.lastStep = 'state';
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, width, height]);
    this.lastStep = 'draw';
    renderer.drawModel();
    this.lastStep = 'done';
  }
}
