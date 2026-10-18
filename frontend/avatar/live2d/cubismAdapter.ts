/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * available at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismFramework } from '@cubism/live2dcubismframework';
import { CubismUserModel } from '@cubism/model/cubismusermodel';
import { CubismMotion } from '@cubism/motion/cubismmotion';
import { CubismExpressionMotion } from '@cubism/motion/cubismexpressionmotion';
import { CubismMatrix44 } from '@cubism/math/cubismmatrix44';
import type { Live2DModelHandle, Live2DModelResources, Live2DRuntimeProvider } from './types.ts';
import { LIVE2D_SHADER_PATH } from './model.ts';

let frameworkReady = false;

class IceCubismModel extends CubismUserModel {
  get cubismModel() {
    return this._model;
  }

  startMotion(motion: CubismMotion): void {
    this._motionManager.startMotionPriority(motion, true, 1);
  }

  updateFrame(deltaSeconds: number): void {
    const model = this._model;
    model.loadParameters();
    this._motionManager.updateMotion(model, deltaSeconds);
    if (this._physics) this._physics.evaluate(model, deltaSeconds);
    model.update();
    model.saveParameters();
  }

  stopMotion(): void {
    this._motionManager.stopAllMotions();
  }

  setModelParameter(id: string, value: number): void {
    const parameterId = CubismFramework.getIdManager().getId(id);
    this._model.setParameterValueById(parameterId, value);
  }
}

async function bindTexture(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  model: IceCubismModel,
  blob: Blob,
  index: number
): Promise<WebGLTexture> {
  const image = await createImageBitmap(blob);
  const texture = gl.createTexture();
  if (!texture) {
    image.close();
    throw new Error('WebGL could not allocate a Live2D texture.');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.bindTexture(gl.TEXTURE_2D, null);
  image.close();
  model.getRenderer().bindTexture(index, texture);
  return texture;
}

async function createModel(
  canvas: HTMLCanvasElement,
  resources: Live2DModelResources
): Promise<Live2DModelHandle> {
  const shaderPath = LIVE2D_SHADER_PATH;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
  if (!gl) throw new Error('Live2D requires WebGL 2, which is unavailable.');

  const model = new IceCubismModel();
  model.loadModel(resources.moc);
  if (!model.cubismModel)
    throw new Error('Cubism Core could not create the model from the moc3 file.');
  if (resources.physics) {
    const physicsBytes = new TextEncoder().encode(JSON.stringify(resources.physics));
    model.loadPhysics(physicsBytes.buffer, physicsBytes.byteLength);
  }
  model.createRenderer(canvas.width, canvas.height);
  model.getRenderer().startUp(gl);
  model.getRenderer().setIsPremultipliedAlpha(true);
  model.getRenderer().loadShaders(shaderPath);
  const textures: WebGLTexture[] = [];
  try {
    for (const [index, blob] of resources.textures.entries()) {
      textures.push(await bindTexture(gl, model, blob, index));
    }
  } catch (error) {
    model.release();
    for (const texture of textures) gl.deleteTexture(texture);
    throw error;
  }

  const parameterGroups = resources.model.Groups;
  const getParameterIds = (name: string): string[] => {
    if (!Array.isArray(parameterGroups)) return [];
    const group = parameterGroups.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'Name' in candidate &&
        candidate.Name === name
    );
    return typeof group === 'object' && group !== null && 'Ids' in group && Array.isArray(group.Ids)
      ? group.Ids.filter((id): id is string => typeof id === 'string')
      : [];
  };
  const eyeBlinkIds = getParameterIds('EyeBlink').map((id) =>
    CubismFramework.getIdManager().getId(id)
  );
  const lipSyncIds = getParameterIds('LipSync').map((id) =>
    CubismFramework.getIdManager().getId(id)
  );
  const motions = new Map<string, CubismMotion[]>();
  for (const [group, entries] of Object.entries(resources.motions)) {
    motions.set(
      group,
      entries.map(({ bytes, definition }) => {
        const motion = CubismMotion.create(bytes, bytes.byteLength);
        const meta = definition.Meta;
        if (motion && typeof meta === 'object' && meta !== null && 'Loop' in meta) {
          motion.setLoop(meta.Loop === true);
        }
        motion?.setEffectIds(eyeBlinkIds, lipSyncIds);
        return motion;
      })
    );
  }
  const expressions = new Map<string, CubismExpressionMotion>();
  for (const [name, expression] of Object.entries(resources.expressions)) {
    const motion = CubismExpressionMotion.create(expression.bytes, expression.bytes.byteLength);
    if (!motion)
      throw new Error(`Cubism could not parse expression '${name}' (${expression.path}).`);
    expressions.set(name, motion);
  }
  const projection = new CubismMatrix44();
  projection.loadIdentity();
  model.getModelMatrix().setHeight(1.8);
  let disposed = false;

  return {
    resize(width, height, devicePixelRatio) {
      const pixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
      const pixelHeight = Math.max(1, Math.round(height * devicePixelRatio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      model.setRenderTargetSize(pixelWidth, pixelHeight);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
    },
    update(frame) {
      model.updateFrame(frame.deltaSeconds);
    },
    draw() {
      if (disposed) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      model.getRenderer().setRenderState(null, [0, 0, canvas.width, canvas.height]);
      const matrix = new CubismMatrix44();
      matrix.multiplyByMatrix(projection);
      matrix.multiplyByMatrix(model.getModelMatrix());
      model.getRenderer().setMvpMatrix(matrix);
      model.getRenderer().drawModel(shaderPath);
    },
    playMotion(group, index = 0) {
      const motion = motions.get(group)?.[index];
      if (motion) model.startMotion(motion);
    },
    stopMotion() {
      model.stopMotion();
    },
    setExpression(name) {
      const expression = expressions.get(name);
      if (expression) model.setExpression(expression, 1);
    },
    setParameter(id, value) {
      model.setModelParameter(id, value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      model.release();
      for (const texture of textures) gl.deleteTexture(texture);
      const loseContext = gl.getExtension('WEBGL_lose_context');
      loseContext?.loseContext();
    }
  };
}

export function createCubismProvider(): Live2DRuntimeProvider {
  return {
    async initialize() {
      if (!frameworkReady) {
        CubismFramework.startUp();
        CubismFramework.initialize();
        frameworkReady = true;
      }
    },
    createModel
  };
}
