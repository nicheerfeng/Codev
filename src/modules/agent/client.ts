import type { Frame, HostSnapshot } from "./types";

type WireCommand = {
  requestId: string;
  operation: string;
  sessionId?: string;
  instanceId?: string | null;
  payload: unknown;
};
type Pending = {
  command: WireCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  serverId: string | null;
};
export type ConnectionOptions = { endpoint: string; token: string };
// crypto.randomUUID requires a secure context; LAN HTTP still provides getRandomValues.
const requestId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");

/** Transport only: it never interprets Pi or ACP events and never owns a running process. */
export class AgentHostClient {
  private socket: WebSocket | null = null;
  private options: ConnectionOptions | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private serverId: string | null = null;
  private ready = false;
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private resyncing = false;
  private frame: (frame: Frame) => void = () => {};
  private status: (state: string, error?: string) => void = () => {};
  private listeners = new Set<() => void>();

  private requestResync(socket: WebSocket) {
    if (this.resyncing || socket.readyState !== WebSocket.OPEN) {
      socket.close();
      return;
    }
    this.resyncing = true;
    this.status("reconnecting", "正在同步会话快照");
    void this.request<HostSnapshot>("host.resync")
      .then((snapshot) => {
        if (this.socket !== socket || !snapshot || snapshot.protocolVersion !== 1) return;
        this.sequence = snapshot.sequence;
        this.serverId = snapshot.serverId;
        this.frame({ type: "resync", snapshot });
        this.status("connected");
      })
      .catch(() => {
        if (this.socket === socket) socket.close();
      })
      .finally(() => {
        this.resyncing = false;
      });
  }

  connect(
    options: ConnectionOptions,
    frame: (frame: Frame) => void,
    status: (state: string, error?: string) => void,
  ) {
    this.options = options;
    this.frame = frame;
    this.status = status;
    this.stopped = false;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    this.open();
  }
  private open() {
    if (!this.options || this.stopped) return;
    this.status(this.attempts ? "reconnecting" : "connecting");
    const socket = new WebSocket(this.options.endpoint, [
      "codev-events",
      `codev-token.${this.options.token}`,
    ]);
    this.socket = socket;
    socket.onmessage = (message) => {
      if (socket !== this.socket) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data.type === "response") {
        const id = String(data.requestId);
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (data.ok) pending.resolve(data.data);
        else pending.reject(new Error(String(data.error ?? "主机请求失败")));
        return;
      }
      if (data.type === "snapshot" || data.type === "resync") {
        const typed = data as unknown as Extract<
          Frame,
          { type: "snapshot" | "resync" }
        >;
        if (typed.snapshot.protocolVersion !== 1) {
          this.status("failed", "主机协议版本不兼容，请同步更新客户端");
          this.disconnect();
          return;
        }
        const previous = this.serverId;
        this.serverId = typed.snapshot.serverId;
        this.sequence = typed.snapshot.sequence;
        this.ready = true;
        this.attempts = 0;
        this.frame(typed);
        this.status("connected");
        for (const [id, request] of this.pending) {
          if (
            request.serverId &&
            previous &&
            request.serverId !== this.serverId
          ) {
            clearTimeout(request.timer);
            this.pending.delete(id);
            request.reject(new Error("服务已经重启，请确认会话状态后重新操作"));
          } else {
            request.serverId = this.serverId;
            socket.send(JSON.stringify(request.command));
          }
        }
        for (const listener of this.listeners) listener();
        return;
      }
      if (data.type === "event") {
        const typed = data as unknown as Extract<Frame, { type: "event" }>;
        if (typed.event.sequence <= this.sequence) return;
        if (typed.event.sequence !== this.sequence + 1) {
          this.requestResync(socket);
          return;
        }
        this.sequence = typed.event.sequence;
        this.frame(typed);
      }
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.ready = false;
      this.socket = null;
      if (this.stopped) return;
      this.status("reconnecting", "与代理主机连接中断，正在重连");
      const delay = Math.min(15000, 600 * 2 ** Math.min(this.attempts++, 5));
      this.reconnect = setTimeout(() => this.open(), delay);
    };
    socket.onerror = () =>
      this.status("reconnecting", "无法连接主机，请检查服务、地址和设备授权");
  }
  onReady(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async request<T = unknown>(
    operation: string,
    payload: unknown = {},
    sessionId?: string,
    instanceId?: string | null,
  ): Promise<T> {
    if (!this.options || this.stopped) throw new Error("请先连接代理主机");
    if (!this.ready) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.listeners.delete(connected);
          reject(new Error("等待代理主机连接超时"));
        }, 30000);
        const connected = () => {
          clearTimeout(timer);
          this.listeners.delete(connected);
          resolve();
        };
        this.listeners.add(connected);
      });
    }
    const command: WireCommand = {
      requestId: requestId(),
      operation,
      sessionId,
      instanceId,
      payload,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(command.requestId);
          reject(new Error(`${operation} 响应超时，请检查会话状态`));
        },
        operation === "session.compact" ? 3600000 : 150000,
      );
      this.pending.set(command.requestId, {
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        serverId: this.serverId,
      });
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify(command));
    });
  }
  disconnect() {
    this.stopped = true;
    this.ready = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close();
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("客户端已断开"));
    }
    this.pending.clear();
  }
}
export const agentClient = new AgentHostClient();
