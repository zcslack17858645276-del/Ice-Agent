import { invoke } from '@tauri-apps/api/core';

type LocalServer = { base: string; token: string };

let cached: LocalServer | null = null;

/** Base URL + token of the standalone server (D:\IceAgent\config.json). */
export async function voiceServer(): Promise<LocalServer> {
  if (!cached) cached = await invoke<LocalServer>('server:local_config');
  return cached;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type VoiceStatus = { asr: boolean; tts: boolean; whisperUrl: string; ttsUrl: string };

export async function voiceStatus(): Promise<VoiceStatus> {
  const server = await voiceServer();
  const response = await fetch(`${server.base}/v1/voice/status`, {
    headers: { Authorization: `Bearer ${server.token}` }
  });
  if (!response.ok) throw new Error(`voice status ${response.status}`);
  return (await response.json()) as VoiceStatus;
}
