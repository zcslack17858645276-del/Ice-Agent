import { getMotionGroup, modelResourcesSummary } from './model.ts';
import { loadLive2DRuntime, loadLive2DResources } from './runtime.ts';
import type { Live2DModelHandle } from './types.ts';

export class Live2DCharacterController {
  constructor(private readonly modelPath: string) {}

  private handle: Live2DModelHandle | null = null;
  private frameRequest: number | null = null;
  private lastFrame = 0;
  private loadGeneration = 0;
  private currentState = 'IDLE';
  private currentExpression = 'NEUTRAL';

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
    this.handle.playMotion(getMotionGroup(this.currentState));
    this.handle.setExpression(this.currentExpression);
    this.resize(canvas);
    console.info('[live2d:loaded]', modelResourcesSummary(resources));
    this.startFrameLoop(canvas);
  }

  setState(state: string): void {
    this.currentState = state;
    this.handle?.playMotion(getMotionGroup(state));
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
  }

  private startFrameLoop(canvas: HTMLCanvasElement): void {
    const render = (time: number) => {
      if (!this.handle) return;
      const deltaSeconds = this.lastFrame === 0 ? 0 : Math.min(0.1, (time - this.lastFrame) / 1000);
      this.lastFrame = time;
      this.resize(canvas);
      this.handle.update({ deltaSeconds, width: canvas.clientWidth, height: canvas.clientHeight });
      this.handle.draw();
      this.frameRequest = requestAnimationFrame(render);
    };
    this.lastFrame = 0;
    this.frameRequest = requestAnimationFrame(render);
  }
}
