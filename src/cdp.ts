// Minimal Chrome DevTools Protocol client over a raw WebSocket.
// No domains, no typing of the protocol — just request/response correlation
// and event dispatch, with flat sessionId routing (Target.attachToTarget
// with flatten: true puts sessionId at the top level of each frame).

import WebSocket from "ws";

export type CdpEventHandler = (params: any, sessionId?: string) => void;

interface Pending {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// No CDP call this extension makes should take anywhere near this long. The
// cap exists so a wedged browser surfaces as an error the user can retry
// instead of a promise that never settles (which used to strand the view on
// "Starting browser…" with a dead Retry button).
const DEFAULT_TIMEOUT_MS = 15000;

export class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<CdpEventHandler>>();
  private closeHandlers = new Set<() => void>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.onClosed());
    ws.on("error", () => this.onClosed());
  }

  static connect(wsUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  send(
    method: string,
    params?: object,
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.seq;
    const msg: any = { id, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      // A late response for a timed-out id finds no pending entry and is
      // dropped by onMessage.
      if (timer && typeof (timer as any).unref === "function") (timer as any).unref();
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.settle(id);
          reject(err);
        }
      });
    });
  }

  // Remove a pending entry and cancel its timeout.
  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
    }
    return p;
  }

  on(event: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.settle(msg.id);
      if (!p) return; // already timed out or errored
      if (msg.error) {
        p.reject(new Error(`${p.method}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) {
        for (const h of set) {
          try {
            h(msg.params, msg.sessionId);
          } catch {
            /* handler errors must not kill the socket loop */
          }
        }
      }
    }
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("CDP connection closed");
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  }
}
