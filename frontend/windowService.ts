import { invoke } from '@tauri-apps/api/core';

export type AppInfo = {
  version: string;
  environment: 'development' | 'production';
  features: string[];
};

export class WindowServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowServiceError';
  }
}

async function command<T>(name: string): Promise<T> {
  try {
    return await invoke<T>(name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WindowServiceError(message || 'The desktop window command failed.');
  }
}

export const WindowService = {
  show: () => command<void>('window:show'),
  hide: () => command<void>('window:hide'),
  toggle: () => command<boolean>('window:toggle'),
  close: () => command<void>('window:close'),
  minimize: () => command<void>('window:minimize'),
  drag: () => command<void>('window:drag'),
  getInfo: () => command<AppInfo>('app:get_info')
};
