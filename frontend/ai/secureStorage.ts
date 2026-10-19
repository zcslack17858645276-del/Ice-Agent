export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Production storage is supplied by the Tauri keychain bridge. This adapter never logs values. */
export class TauriSecureStorage implements SecureStorage {
  constructor(private readonly invoke: <T>(command: string, args?: Record<string, string>) => Promise<T>) {}
  get(key: string) { return this.invoke<string | null>('secure_store_get', { key }); }
  set(key: string, value: string) { return this.invoke<void>('secure_store_set', { key, value }); }
  remove(key: string) { return this.invoke<void>('secure_store_remove', { key }); }
}
