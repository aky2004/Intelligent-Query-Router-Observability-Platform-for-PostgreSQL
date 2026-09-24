import { io, type Socket } from "socket.io-client";
import { getSocketUrl } from "@/lib/api";
import { authStore } from "@/lib/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (data: any) => void;

class SocketService {
  private socket: Socket | null = null;
  private handlers = new Map<string, Set<Handler>>();

  connect() {
    if (this.socket) return this.socket;
    const url = getSocketUrl();
    if (!url) return null;
    this.socket = io(url, {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000, // exponential: 1s, 2s, 4s… capped
      reconnectionDelayMax: 16000,
      auth: (cb) => cb({ token: authStore.token }),
    });
    for (const [event, set] of this.handlers) set.forEach((h) => this.socket!.on(event, h));
    return this.socket;
  }
  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
  subscribe(event: string, cb: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
    this.socket?.on(event, cb);
    return () => this.unsubscribe(event, cb);
  }
  unsubscribe(event: string, cb?: Handler) {
    if (cb) this.handlers.get(event)?.delete(cb);
    else this.handlers.delete(event);
    this.socket?.off(event, cb);
  }
  emit(event: string, data: unknown) {
    this.socket?.emit(event, data);
  }
  get connected() {
    return !!this.socket?.connected;
  }
}

export const socketService = new SocketService();
