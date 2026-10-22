import { invoke } from '@tauri-apps/api/core';

type LocalServer = { base: string; token: string };

let cache: LocalServer | null = null;

async function localServer(): Promise<LocalServer> {
  if (cache) return cache;
  cache = await invoke<LocalServer>('server:local_config');
  return cache;
}

/** Persists configuration changes on the standalone server (D:\IceAgent\config.json). */
export async function saveServerConfig(patch: Record<string, unknown>): Promise<void> {
  try {
    const server = await localServer();
    await fetch(`${server.base}/v1/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.token}`
      },
      body: JSON.stringify(patch)
    });
  } catch {
    /* server offline: the local copy stays authoritative until it returns */
  }
}

export async function loadServerConfig(): Promise<Record<string, unknown> | null> {
  try {
    const server = await localServer();
    const response = await fetch(`${server.base}/v1/config`, {
      headers: { Authorization: `Bearer ${server.token}` }
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { config?: Record<string, unknown> };
    return payload.config ?? null;
  } catch {
    return null;
  }
}
