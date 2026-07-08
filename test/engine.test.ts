import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { GameEngine, mod } from "../src/engine";
import { createApiMiddleware } from "../src/server";

describe("mod arithmetic", () => {
  it("wraps values into Z_n", () => {
    expect(mod(12, 10)).toBe(2);
    expect(mod(-3, 10)).toBe(7);
    expect(mod(0, 10)).toBe(0);
  });
});

describe("GameEngine", () => {
  it("generates deterministic seeded errors", () => {
    const a = new GameEngine({ seed: "same", initialBurst: true, m: 6 });
    const b = new GameEngine({ seed: "same", initialBurst: true, m: 6 });
    const c = new GameEngine({ seed: "different", initialBurst: true, m: 6 });

    expect(a.getState().charges).toEqual(b.getState().charges);
    expect(a.getState().charges).not.toEqual(c.getState().charges);
  });

  it("slides a full charge into a neighbor", () => {
    const game = new GameEngine({ rows: 3, cols: 3, initialBurst: false });
    game.applyError({ a: [1, 0], b: [1, 1], value: 3 });

    const result = game.move({ from: [1, 0], to: [0, 0] });

    expect(result.ok).toBe(true);
    expect(result.state.charges[1][0]).toBe(0);
    expect(result.state.charges[0][0]).toBe(3);
    expect(result.state.turn).toBe(1);
    expect(result.state.score).toBe(1);
  });

  it("cancels charges to zero", () => {
    const game = new GameEngine({ rows: 3, cols: 3, initialBurst: false });
    game.applyError({ a: [1, 0], b: [1, 1], value: 3 });

    const result = game.move({ from: [1, 0], to: [1, 1] });

    expect(result.ok).toBe(true);
    expect(result.state.charges[1][0]).toBe(0);
    expect(result.state.charges[1][1]).toBe(0);
    expect(game.getDebugState().edgeCount).toBe(0);
  });

  it("does not advance turn on illegal moves", () => {
    const game = new GameEngine({ initialBurst: false });
    const result = game.move({ from: [0, 0], to: [0, 1] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("zero charge");
    expect(result.state.turn).toBe(0);
  });

  it("recomputes active clusters after cancellation", () => {
    const game = new GameEngine({ rows: 3, cols: 3, initialBurst: false });
    game.applyError({ a: [0, 0], b: [0, 1], value: 4 });
    expect(game.getDebugState().clusterIds[0][0]).toBe(game.getDebugState().clusterIds[0][1]);

    game.move({ from: [0, 0], to: [0, 1] });
    const debug = game.getDebugState();

    expect(debug.charges[0][0]).toBe(0);
    expect(debug.charges[0][1]).toBe(0);
    expect(debug.clusterIds[0][0]).toBeNull();
    expect(debug.clusterIds[0][1]).toBeNull();
    expect(debug.edgeCount).toBe(0);
  });

  it("merges clusters through a spawned error edge", () => {
    const game = new GameEngine({ rows: 3, cols: 3, initialBurst: false });
    game.applyError({ a: [0, 0], b: [0, 1], value: 2 });
    game.applyError({ a: [0, 1], b: [0, 2], value: 3 });

    const debug = game.getDebugState();

    expect(debug.clusterIds[0][0]).toBe(debug.clusterIds[0][1]);
    expect(debug.clusterIds[0][1]).toBe(debug.clusterIds[0][2]);
  });

  it("moves cluster connections with a sliding charge", () => {
    const game = new GameEngine({ rows: 3, cols: 4, initialBurst: false });
    game.applyError({ a: [1, 0], b: [1, 1], value: 2 });
    game.applyError({ a: [1, 2], b: [1, 3], value: 4 });

    game.move({ from: [1, 1], to: [1, 2] });
    const debug = game.getDebugState();

    expect(debug.clusterIds[1][0]).toBe(debug.clusterIds[1][2]);
    expect(debug.clusterIds[1][2]).toBe(debug.clusterIds[1][3]);
  });

  it("detects game over for anyons related by historical moves after active edges vanish", () => {
    const game = new GameEngine({ rows: 3, cols: 4, t: 99, m: 0, initialBurst: false });
    game.applyError({ a: [1, 0], b: [1, 1], value: 2 });
    game.applyError({ a: [1, 2], b: [1, 3], value: 2 });

    const result = game.move({ from: [1, 1], to: [1, 2] });
    const debug = game.getDebugState();

    expect(result.ok).toBe(true);
    expect(debug.charges[1]).toEqual([2, 0, 0, 8]);
    expect(debug.edgeCount).toBe(0);
    expect(debug.clusterIds[1][0]).not.toBe(debug.clusterIds[1][3]);
    expect(result.state.gameOver).toBe(true);
    expect(result.state.winReason).toBe("left-right");
  });

  it("detects left-right game over", () => {
    const game = new GameEngine({ rows: 2, cols: 3, initialBurst: false });
    game.applyError({ a: [0, 0], b: [0, 1], value: 2 });
    game.applyError({ a: [0, 1], b: [0, 2], value: 3 });

    const state = game.getState();

    expect(state.gameOver).toBe(true);
    expect(state.winReason).toBe("left-right");
  });

  it("detects top-bottom game over", () => {
    const game = new GameEngine({ rows: 3, cols: 2, initialBurst: false });
    game.applyError({ a: [0, 0], b: [1, 0], value: 2 });
    game.applyError({ a: [1, 0], b: [2, 0], value: 3 });

    const state = game.getState();

    expect(state.gameOver).toBe(true);
    expect(state.winReason).toBe("top-bottom");
  });
});

describe("local HTTP API", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it("returns a rectangular numeric charge matrix and accepts a legal move", async () => {
    const middleware = createApiMiddleware();
    server = createServer((req, res) => {
      middleware(req, res, (error) => {
        res.statusCode = error ? 500 : 404;
        res.end(error ? String(error) : "not found");
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind to a TCP port");
    }
    const base = `http://127.0.0.1:${address.port}`;

    const state = await postJson(`${base}/api/new-game`, {
      rows: 4,
      cols: 4,
      n: 10,
      t: 5,
      m: 3,
      seed: "api-smoke"
    });

    expect(isNumericRectangle(state.charges)).toBe(true);
    expect(state).not.toHaveProperty("clusterIds");

    const [from, to] = findLegalMove(state.charges);
    const move = await postJson(`${base}/api/move`, { from, to });

    expect(move.ok).toBe(true);
    expect(isNumericRectangle(move.state.charges)).toBe(true);
  });
});

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

function isNumericRectangle(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === value[0].length &&
        row.every((cell) => Number.isInteger(cell))
    )
  );
}

function findLegalMove(charges: number[][]): [[number, number], [number, number]] {
  for (let row = 0; row < charges.length; row += 1) {
    for (let col = 0; col < charges[row].length; col += 1) {
      if (charges[row][col] === 0) {
        continue;
      }
      const candidates: [number, number][] = [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1]
      ];
      for (const [targetRow, targetCol] of candidates) {
        if (
          targetRow >= 0 &&
          targetRow < charges.length &&
          targetCol >= 0 &&
          targetCol < charges[row].length
        ) {
          return [
            [row, col],
            [targetRow, targetCol]
          ];
        }
      }
    }
  }
  throw new Error("no legal move found");
}
