import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Operator client for the OpenClaw Gateway protocol.
 *
 * The socket itself lives in Rust (`src-tauri/src/gateway.rs`): the Gateway only
 * grants operator scopes to connections without a browser `Origin` header, so a
 * WebView socket is admitted with an empty scope set and every RPC fails. Rust
 * owns the connection and forwards JSON frames through Tauri events; this module
 * keeps the protocol logic (handshake, request correlation, event fan-out).
 *
 * Wire contract: https://docs.openclaw.ai/gateway/protocol
 */

export type GatewayHello = {
  type?: string;
  protocol?: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  auth?: { role?: string; scopes?: string[]; deviceToken?: string };
  policy?: {
    maxPayload?: number;
    tickIntervalMs?: number;
    attachments?: { maxBytes?: number; maxImageBytes?: number };
  };
  snapshot?: Record<string, unknown>;
};

export class GatewayError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.details = details;
  }
}

export type GatewayOptions = {
  url: string;
  token: string;
  /** `gateway-client` + `backend` uses the loopback shared-token path. */
  clientId?: string;
  clientMode?: 'backend' | 'operator';
  version?: string;
  scopes?: string[];
  caps?: string[];
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
};

type Listener = (payload: unknown) => void;

const DEFAULT_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'];
const DEFAULT_CAPS = ['tool-events', 'approvals', 'exec-approvals'];

function platformName(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'windows';
}

function requestId(): string {
  const cryptoApi =
    typeof crypto === 'undefined'
      ? null
      : (crypto as Crypto & { randomUUID?: () => string });
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    const value = cryptoApi.randomUUID();
    if (typeof value === 'string' && value) return value;
  }
  return `ice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Tauri rejects with the serialized `CommandError` (`{ code, message }`). */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === 'object') {
    const value = reason as Record<string, unknown>;
    if (typeof value.message === 'string') return value.message;
  }
  return String(reason);
}

function toGatewayError(raw: unknown): GatewayError {
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const code = typeof value.code === 'string' ? value.code : 'GATEWAY_ERROR';
    let message = typeof value.message === 'string' ? value.message : '网关拒绝了这次请求。';
    const details =
      value.details && typeof value.details === 'object'
        ? (value.details as Record<string, unknown>)
        : undefined;
    if (code === 'PAIRING_REQUIRED' && details && typeof details.requestId === 'string') {
      message += ` 先在网关主机运行 “openclaw devices approve ${details.requestId}”，然后重新连接。`;
    } else if (details && typeof details.recommendedNextStep === 'string') {
      message += ` (${details.recommendedNextStep})`;
    }
    return new GatewayError(code, message, details);
  }
  return new GatewayError('GATEWAY_ERROR', typeof raw === 'string' ? raw : '网关拒绝了这次请求。');
}

export class OpenClawGateway {
  private readonly options: GatewayOptions;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private nextId = 1;
  private hello: GatewayHello | null = null;
  private connectPromise: Promise<GatewayHello> | null = null;
  private settleConnect: {
    resolve: (hello: GatewayHello) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private connectTimer: number | undefined;
  private challengeTimer: number | undefined;
  private connectSent = false;
  private transportOpen = false;
  private unlisten: UnlistenFn[] = [];
  private buffered: string[] = [];

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.transportOpen && this.hello !== null;
  }

  get helloPayload(): GatewayHello | null {
    return this.hello;
  }

  /** Subscribes to one event family; `*` receives `{ event, payload }` for all. */
  on(event: string, listener: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  connect(): Promise<GatewayHello> {
    if (this.isOpen) return Promise.resolve(this.hello as GatewayHello);
    if (this.connectPromise) return this.connectPromise;

    this.resetTransport();
    const promise = new Promise<GatewayHello>((resolve, reject) => {
      this.settleConnect = { resolve, reject };
      void this.openTransport();
    });
    this.connectPromise = promise;
    promise.catch(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    return promise;
  }

  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.transportOpen) {
      return Promise.reject(new GatewayError('OFFLINE', '尚未连接 OpenClaw 网关。'));
    }
    const id = `ice-${this.nextId++}`;
    const payload = JSON.stringify({ type: 'req', id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GatewayError(
            'TIMEOUT',
            `网关没有在 ${Math.round(timeoutMs / 1000)} 秒内响应 ${method}。`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.sendFrame(payload);
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.hello = null;
    this.transportOpen = false;
    this.rejectPending(new GatewayError('CLOSED', '网关连接已关闭。'));
    if (this.settleConnect) {
      const settle = this.settleConnect;
      this.settleConnect = null;
      settle.reject(new GatewayError('CLOSED', '网关连接已关闭。'));
    }
    this.connectPromise = null;
    this.clearTimers();
    this.cleanupListeners();
    void invoke('gateway:close').catch(() => undefined);
  }

  private async openTransport(): Promise<void> {
    try {
      const unlisteners = await Promise.all([
        listen<string>('gateway:frame', (event) => this.handleFrame(event.payload)),
        listen<{ code?: number; reason?: string }>('gateway:closed', (event) =>
          this.handleClosed(event.payload)
        )
      ]);
      this.unlisten = unlisteners;
      await invoke('gateway:connect', {
        url: this.options.url,
        token: this.options.token
      });
      this.transportOpen = true;
      this.connectTimer = window.setTimeout(() => {
        this.failConnect(
          new GatewayError('TIMEOUT', '连接 OpenClaw 网关超时，请确认 Gateway 正在运行。')
        );
      }, 20000);
      // Frames that arrived during the handshake (the challenge) are replayed.
      const buffered = this.buffered;
      this.buffered = [];
      for (const frame of buffered) this.handleFrame(frame);
      if (!this.connectSent) {
        this.challengeTimer = window.setTimeout(() => this.sendConnect(), 2500);
      }
    } catch (reason) {
      this.failConnect(
        new GatewayError('SOCKET', `无法连接 ${this.options.url}：${describe(reason)}`)
      );
    }
  }

  private sendConnect(): void {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.challengeTimer !== undefined) {
      window.clearTimeout(this.challengeTimer);
      this.challengeTimer = undefined;
    }
    const options = this.options;
    const version = options.version ?? '0.1.0';
    const params = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: options.clientId ?? 'gateway-client',
        version,
        platform: platformName(),
        mode: options.clientMode ?? 'backend'
      },
      role: 'operator',
      scopes: options.scopes ?? DEFAULT_SCOPES,
      caps: options.caps ?? DEFAULT_CAPS,
      commands: [],
      permissions: {},
      auth: { token: options.token },
      locale: typeof navigator === 'undefined' ? 'zh-CN' : navigator.language || 'zh-CN',
      userAgent: `ice-agent/${version}`
    };
    this.request<GatewayHello>('connect', params, 20000)
      .then((hello) => this.succeedConnect(hello))
      .catch((error: unknown) => this.failConnect(error));
  }

  private succeedConnect(hello: GatewayHello): void {
    this.hello = hello;
    this.connectPromise = null;
    if (this.connectTimer !== undefined) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.challengeTimer !== undefined) {
      window.clearTimeout(this.challengeTimer);
      this.challengeTimer = undefined;
    }
    const settle = this.settleConnect;
    this.settleConnect = null;
    settle?.resolve(hello);
  }

  private failConnect(error: unknown): void {
    const settle = this.settleConnect;
    this.settleConnect = null;
    this.hello = null;
    this.transportOpen = false;
    this.clearTimers();
    this.cleanupListeners();
    void invoke('gateway:close').catch(() => undefined);
    this.rejectPending(error);
    settle?.reject(error);
  }

  private sendFrame(payload: string): void {
    if (!this.transportOpen) {
      throw new GatewayError('OFFLINE', '尚未连接 OpenClaw 网关。');
    }
    void invoke('gateway:send', { frame: payload }).catch((reason: unknown) => {
      this.handleClosed({ code: 1006, reason: describe(reason) });
    });
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    if (!this.transportOpen) {
      // The Gateway pushes `connect.challenge` immediately after the upgrade.
      if (this.buffered.length < 32) this.buffered.push(raw);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const message = frame as Record<string, unknown>;
    if (message.type === 'res') {
      const id = String(message.id ?? '');
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      window.clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.payload);
      else pending.reject(toGatewayError(message.error));
      return;
    }
    if (message.type === 'event') {
      const name = typeof message.event === 'string' ? message.event : '';
      if (name === 'connect.challenge') {
        this.sendConnect();
        return;
      }
      if (name) this.emit(name, message.payload);
    }
  }

  private handleClosed(payload: { code?: number; reason?: string } | null): void {
    const wasOpen = this.transportOpen;
    this.transportOpen = false;
    this.hello = null;
    this.clearTimers();
    this.cleanupListeners();
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    const error = new GatewayError('CLOSED', reason || '网关连接已关闭。');
    this.rejectPending(error);
    if (this.settleConnect) {
      const settle = this.settleConnect;
      this.settleConnect = null;
      settle.reject(error);
    }
    this.emit('__close', { code: payload?.code ?? 1006, reason, wasOpen });
  }

  private emit(name: string, payload: unknown): void {
    const listeners = this.listeners.get(name);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(payload);
        } catch (error) {
          console.error('[gateway:listener]', error);
        }
      }
    }
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const listener of [...wildcard]) {
        try {
          listener({ event: name, payload });
        } catch (error) {
          console.error('[gateway:listener]', error);
        }
      }
    }
  }

  private rejectPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private clearTimers(): void {
    if (this.connectTimer !== undefined) window.clearTimeout(this.connectTimer);
    if (this.challengeTimer !== undefined) window.clearTimeout(this.challengeTimer);
    this.connectTimer = undefined;
    this.challengeTimer = undefined;
    this.connectSent = false;
  }

  private cleanupListeners(): void {
    for (const unlisten of this.unlisten) {
      try {
        unlisten();
      } catch {
        /* the window is going away */
      }
    }
    this.unlisten = [];
  }

  private resetTransport(): void {
    this.clearTimers();
    this.transportOpen = false;
    this.buffered = [];
    this.cleanupListeners();
    void invoke('gateway:close').catch(() => undefined);
  }
}

export { requestId };
