import { useEffect, useRef } from 'react';
import { Live2DCharacterController } from './controller.ts';
import type { AvatarExpression, PetState } from '../types.ts';

type Live2DRendererProps = {
  modelPath: string;
  state: PetState;
  expression: AvatarExpression;
  visible: boolean;
  onReady: () => void;
  onError: (message: string) => void;
};

export function Live2DRenderer({
  modelPath,
  state,
  expression,
  visible,
  onReady,
  onError
}: Live2DRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<Live2DCharacterController | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new Live2DCharacterController(modelPath);
    controllerRef.current = controller;
    controller
      .load(canvas)
      .then(() => onReady())
      .catch((reason: unknown) =>
        onError(reason instanceof Error ? reason.message : String(reason))
      );
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [modelPath, onError, onReady]);

  useEffect(() => controllerRef.current?.setState(state), [state]);
  useEffect(() => controllerRef.current?.setExpression(expression), [expression]);

  return (
    <canvas
      ref={canvasRef}
      className={`live2d-canvas${visible ? ' live2d-canvas-visible' : ''}`}
      aria-hidden="true"
    />
  );
}
