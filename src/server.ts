import type { IncomingMessage, ServerResponse } from "node:http";
import { GameEngine } from "./engine";
import type { GameConfigInput, MoveAction } from "./types";

type NextFunction = (error?: unknown) => void;
type ApiHandler = (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void;

let engine = new GameEngine();

export function createApiMiddleware(): ApiHandler {
  return (req, res, next) => {
    if (!req.url?.startsWith("/api/")) {
      next();
      return;
    }

    void routeRequest(req, res).catch((error: unknown) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "internal server error"
      });
    });
  };
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    sendJson(res, 204, null);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, engine.getState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/new-game") {
    const body = await readJson<GameConfigInput>(req);
    engine = new GameEngine(body ?? {});
    sendJson(res, 200, engine.getState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJson<GameConfigInput>(req);
    sendJson(res, 200, engine.reset(body ?? {}));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const body = await readJson<MoveAction>(req);
    const result = engine.move(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {} as T;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}
