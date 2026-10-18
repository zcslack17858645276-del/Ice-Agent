export type Live2DModelResources = {
  modelPath: string;
  model: Record<string, unknown>;
  mocPath: string;
  moc: ArrayBuffer;
  texturePaths: string[];
  textures: Blob[];
  physicsPath: string | null;
  physics: Record<string, unknown> | null;
  expressions: Record<string, { path: string; bytes: ArrayBuffer }>;
  motions: Record<
    string,
    { path: string; definition: Record<string, unknown>; bytes: ArrayBuffer }[]
  >;
};

export type Live2DFrame = {
  deltaSeconds: number;
  width: number;
  height: number;
};

export type Live2DModelHandle = {
  resize(width: number, height: number, devicePixelRatio: number): void;
  update(frame: Live2DFrame): void;
  draw(): void;
  playMotion(group: string, index?: number): void;
  hasMotion?(group: string): boolean;
  stopMotion(): void;
  setExpression(expression: string): void;
  setParameter(id: string, value: number): void;
  dispose(): void;
};

export type Live2DRuntimeProvider = {
  initialize(): Promise<void>;
  createModel(
    canvas: HTMLCanvasElement,
    resources: Live2DModelResources
  ): Promise<Live2DModelHandle>;
};

export type Live2DGlobal = {
  createProvider(): Live2DRuntimeProvider;
};
