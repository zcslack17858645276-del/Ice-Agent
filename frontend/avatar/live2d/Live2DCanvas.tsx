import { useEffect, useRef, useState } from 'react';
import { CubismPetModel } from './CubismPetModel';

type Props = {
  modelUrl: string;
  motion: string;
  onReady?: (motions: string[]) => void;
  onStage?: (stage: { play: (name: string) => void }) => void;
  onError?: (message: string) => void;
};

/**
 * Drives a Cubism model with the official framework renderer on a plain WebGL
 * canvas (no PixiJS). Clipping masks, physics and eye blink come from the SDK.
 */
export function Live2DCanvas({ modelUrl, motion, onReady, onStage, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<CubismPetModel | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true
    });
    if (!gl) {
      onError?.('WebGL is unavailable for the Live2D renderer.');
      return;
    }

    let disposed = false;
    let frame = 0;
    let last = performance.now();

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const model = new CubismPetModel();
    modelRef.current = model;

    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (model.isReady) {
        try {
          model.syncViewport();
          model.update(delta);
          model.draw(gl, canvas.width, canvas.height);
        } catch (error) {
          console.error('[live2d:frame]', error);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    model
      .load(modelUrl, gl)
      .then(() => {
        if (disposed) return;
        setReady(true);
        const idle = model.hasMotion('Idle') ? 'Idle' : (model.motionGroups[0] ?? '');
        if (idle) model.play(idle);
        onReady?.(model.motionGroups);
        onStage?.({
          play: (name: string) => {
            model.play(name);
          }
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        onError?.(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      modelRef.current = null;
    };
  }, [modelUrl]);

  useEffect(() => {
    if (ready && motion) modelRef.current?.play(motion);
  }, [motion, ready]);

  return <canvas ref={canvasRef} className="avatar-live2d" aria-hidden="true" />;
}
