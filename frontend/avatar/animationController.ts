import type { AnimationClip } from './types';

export class AnimationController {
  private timer: number | undefined;
  private paused = false;
  private clip: AnimationClip | null = null;
  private startedAt = 0;
  private remainingMs = 0;

  play(clip: AnimationClip, onComplete: () => void): void {
    this.pause();
    this.clip = clip;
    this.paused = false;
    this.startedAt = Date.now();
    this.remainingMs = clip.durationMs;
    this.schedule(onComplete);
  }

  pause(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.paused && this.clip)
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
    this.paused = true;
  }

  resume(onComplete: () => void): void {
    if (!this.paused || !this.clip) return;
    this.paused = false;
    this.startedAt = Date.now();
    this.schedule(onComplete);
  }

  stop(): void {
    this.pause();
    this.clip = null;
  }

  preload(urls: string[]): Promise<void[]> {
    return Promise.all(
      urls.map(
        (url) =>
          new Promise<void>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => reject(new Error(`Unable to preload avatar asset: ${url}`));
            image.src = url;
          })
      )
    );
  }

  private schedule(onComplete: () => void): void {
    const clip = this.clip;
    if (!clip) return;
    this.timer = window.setTimeout(() => {
      if (clip.loop) {
        this.remainingMs = clip.durationMs;
        this.startedAt = Date.now();
        this.schedule(onComplete);
      } else {
        this.stop();
        onComplete();
      }
    }, this.remainingMs);
  }
}
