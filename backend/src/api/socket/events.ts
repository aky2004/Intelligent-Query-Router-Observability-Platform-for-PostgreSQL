import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { appConfig } from "../../config/app";
import { bus } from "../../events";
import { getMetrics } from "../../monitors/metrics-collector";
import { executeQuery } from "../../router/query-router";
import { getPoolStats } from "../../router/pool-manager";
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from "../../types/socket";
import { logger } from "../../utils/logger";
import { uuid } from "../../utils/helpers";
import { verifyAccessToken } from "../../auth/tokens";
import { devAuthBypass, verifyFirebaseToken } from "../../auth/firebase";
import { runtimeSettings } from "../../config/runtime";
import { onAlert } from "../../monitors/alert-store";

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

let io: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData> | null = null;

/** Fully verifies signed, unexpired access tokens from the handshake. */
const verifyHandshake = async (token: unknown): Promise<{ userId: string | null; ok: boolean }> => {
  if (devAuthBypass()) return { userId: "dev-user", ok: true };
  if (typeof token !== "string" || !token.length) return { userId: null, ok: false };
  const hosted = await verifyFirebaseToken(token);
  if (hosted) return { userId: hosted.userId, ok: true };
  try {
    const decoded = verifyAccessToken(token);
    return { userId: typeof decoded.sub === "string" ? decoded.sub : null, ok: typeof decoded.sub === "string" };
  } catch {
    return { userId: null, ok: false };
  }
};

export const registerSocketEvents = (httpServer: HttpServer): Server => {
  io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, origin || true),
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  io.use(async (socket, next) => {
    const { userId, ok } = await verifyHandshake(socket.handshake.auth?.token);
    if (!ok) return next(new Error("Unauthorized socket handshake"));
    socket.data.userId = userId;
    socket.data.sessionId = `ws-${uuid()}`;
    next();
  });

  io.on("connection", (socket: AppSocket) => {
    logger.info("Socket connected", { id: socket.id, userId: socket.data.userId });
    let metricsTimer: ReturnType<typeof setInterval> | null = null;

    socket.on("subscribe:metrics", async ({ intervalMs } = {}) => {
      const interval = Math.max(1000, Math.min(intervalMs ?? 2000, 30_000));
      await socket.join("metrics");
      socket.emit("metrics:update", await getMetrics());
      metricsTimer = setInterval(async () => {
        socket.emit("metrics:update", await getMetrics());
      }, interval);
    });

    socket.on("unsubscribe:metrics", () => {
      if (metricsTimer) clearInterval(metricsTimer);
      metricsTimer = null;
      void socket.leave("metrics");
    });

    socket.on("subscribe:alerts", () => {
      void socket.join("alerts");
    });

    socket.on("execute:query", async (payload, ack) => {
      try {
        const { result } = await executeQuery(payload.sql, [], {
          sessionId: payload.sessionId ?? socket.data.sessionId,
        });
        ack?.({ success: true, data: result });
        io?.emit("query:executed", { sql: payload.sql, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ack?.({ success: false, error: message });
        socket.emit("query:executed", { sql: payload.sql, error: message });
      }
    });

    // Collaborative editor rooms: relay text, cursors and presence to room members.
    const rooms = new Map<string, string>(); // room -> userId
    socket.on("editor:join", ({ room, user }) => {
      if (typeof room !== "string" || !room.startsWith("query-editor-")) return;
      void socket.join(room);
      rooms.set(room, user?.id ?? socket.id);
      socket.to(room).emit("user:joined", { room, user });
    });
    socket.on("editor:leave", ({ room, userId }) => {
      void socket.leave(room);
      rooms.delete(room);
      socket.to(room).emit("user:left", { room, userId });
    });
    socket.on("editor:sync", (msg) => { if (socket.rooms.has(msg.room)) socket.to(msg.room).emit("editor:sync", msg); });
    socket.on("cursor:update", (msg) => { if (socket.rooms.has(msg.room)) socket.to(msg.room).emit("cursor:update", msg); });

    socket.on("disconnect", (reason) => {
      for (const [room, userId] of rooms) socket.to(room).emit("user:left", { room, userId });
      if (metricsTimer) clearInterval(metricsTimer);
      logger.info("Socket disconnected", { id: socket.id, reason });
    });
  });

  bus.onEvent("anomaly:detected", (alert) => io?.to("alerts").emit("alert:anomaly", alert));
  bus.onEvent("health:updated", (nodes) => {
    io?.emit("health:update", nodes);
    for (const n of nodes) io?.emit("node:status", { nodeId: n.nodeId, status: n.healthy ? "healthy" : "unhealthy", timestamp: n.lastCheckedAt });
  });
  // Dashboard events
  onAlert((a) => io?.emit("alert:new", a));
  bus.onEvent("replay:progress", (p) => io?.emit("replay:progress", p));
  bus.onEvent("replay:complete", (p) => io?.emit("replay:complete", p));
  setInterval(async () => {
    if (!io || !runtimeSettings.liveUpdates || io.engine.clientsCount === 0) return;
    const m = await getMetrics(10_000);
    const ts = new Date().toISOString();
    io.emit("metrics:update", { queriesPerSecond: Math.round((m.queriesPerMinute / 60) * 100) / 100, activeConnections: getPoolStats().reduce((a, p) => a + p.total - p.idle, 0), timestamp: ts });
    io.emit("metrics:timeseries", { metric: "latency", dataPoint: { timestamp: ts, value: m.avgDurationMs } });
  }, 2000).unref();

  logger.info("Socket.io handlers registered");
  return io;
};

export const getIo = (): Server | null => io;
