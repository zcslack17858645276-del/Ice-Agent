import { getMotionGroup, modelResourcesSummary } from './model.ts';
import { loadLive2DRuntime, loadLive2DResources } from './runtime.ts';
import type { Live2DModelHandle } from './types.ts';

export class Live2DCharacterController {
  constructor(
    private readonly modelPath: string,
    private readonly onRuntimeError: (message: string) => void = () => undefined
  ) {}

  private handle: Live2DModelHandle | null = null;
  private frameRequest: number | null = null;
  private lastFrame = 0;
  private loadGeneration = 0;
  private currentState = 'IDLE';
  private currentExpression = 'NEUTRAL';
  private motionGroups = new Set<string>();
  private runtimeFailed = false;

  async load(canvas: HTMLCanvasElement): Promise<void> {
    this.dispose();
    const generation = ++this.loadGeneration;
    const resources = await loadLive2DResources(this.modelPath);
    const provider = await loadLive2DRuntime();
    if (generation !== this.loadGeneration) return;
    await provider.initialize();
    if (generation !== this.loadGeneration) return;
    this.handle = await provider.createModel(canvas, resources);
    if (generation !== this.loadGeneration) {
      this.handle.dispose();
      this.handle = null;
      return;
    }
    this.motionGroups = new Set(Object.keys(resources.motions));
    this.playStateMotion(this.currentState);
    this.handle.setExpression(this.currentExpression);
    this.resize(canvas);
    console.info('[live2d:loaded]', modelResourcesSummary(resources));
    this.startFrameLoop(canvas);
  }

  setState(state: string): void {
    this.currentState = state;
    this.playStateMotion(state);
  }

  setExpression(expression: string): void {
    this.currentExpression = expression;
    this.handle?.setExpression(expression);
  }

  setParameter(id: string, value: number): void {
    this.handle?.setParameter(id, value);
  }

  playMotion(group: string, index = 0): void {
    this.handle?.playMotion(group, index);
  }

  stopMotion(): void {
    this.handle?.stopMotion();
  }

  resize(canvas: HTMLCanvasElement): void {
    const bounds = canvas.getBoundingClientRect();
    this.handle?.resize(bounds.width, bounds.height, window.devicePixelRatio || 1);
  }

  dispose(): void {
    this.loadGeneration += 1;
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.handle?.dispose();
    this.handle = null;
    this.motionGroups.clear();
  }

  private playStateMotion(state: string): void {
    const requested = getMotionGroup(state);
    const fallback = this.motionGroups.has(requested)
      ? requested
      : this.motionGroups.has('Idle')
        ? 'Idle'
        : null;
    if (fallback === null) {
      console.error(
        `[live2d:motion] Model has no '${requested}' or 'Idle' motion group; keeping the model static.`
      );
      return;
    }
    if (requested !== fallback) {
      console.error(
        `[live2d:motion] Missing motion group '${requested}', falling back to '${fallback}'.`
      );
    }
    try {
      this.handle?.playMotion(fallback);
    } catch (error) {
      console.error('[live2d:motion]', {
        modelPath: this.modelPath,
        state,
        group: fallback,
        error
      });
      if (fallback !== 'Idle' && this.motionGroups.has('Idle')) {
        try {
          this.handle?.playMotion('Idle');
          return;
        } catch (fallbackError) {
          this.reportRuntimeError('Idle motion fallback', fallbackError);
          return;
        }
      }
      this.reportRuntimeError('state motion', error);
    }
  }

  private startFrameLoop(canvas: HTMLCanvasElement): void {
    const render = (time: number) => {
      if (!this.handle) return;
      const deltaSeconds = this.lastFrame === 0 ? 0 : Math.min(0.1, (time - this.lastFrame) / 1000);
      this.lastFrame = time;
      try {
        this.resize(canvas);
        this.handle.update({
          deltaSeconds,
          width: canvas.clientWidth,
          height: canvas.clientHeight
        });
        this.handle.draw();
      } catch (error) {
        this.frameRequest = null;
        this.reportRuntimeError('frame update/draw', error);
        return;
      }
      this.frameRequest = requestAnimationFrame(render);
    };
    this.lastFrame = 0;
    this.frameRequest = requestAnimationFrame(render);
  }

  private reportRuntimeError(phase: string, error: unknown): void {
    if (this.runtimeFailed) return;
    this.runtimeFailed = true;
    const detail =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    const message = `Live2D ${phase} failed for state '${this.currentState}' (${this.modelPath}): ${detail}`;
    console.error('[live2d:runtime-failure]', {
      phase,
      modelPath: this.modelPath,
      state: this.currentState,
      error
    });
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    try {
      this.handle?.dispose();
    } catch (disposeError) {
      console.error('[live2d:dispose-after-failure]', disposeError);
    }
    this.handle = null;
    this.onRuntimeError(message);
  }
}
