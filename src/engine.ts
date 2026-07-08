import { SeededRng } from "./rng";
import type {
  Coord,
  DebugGameState,
  Edge,
  GameConfig,
  GameConfigInput,
  MoveAction,
  MoveResult,
  PublicGameState,
  WinReason
} from "./types";

const DEFAULT_CONFIG: GameConfig = {
  rows: 8,
  cols: 8,
  n: 10,
  t: 5,
  m: 6,
  seed: "decodoku",
  initialBurst: true
};

type ClusterReport = {
  ids: (number | null)[][];
  winReason: WinReason;
};

export function normalizeConfig(input: GameConfigInput = {}): GameConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  assertInteger(config.rows, "rows", 2, 40);
  assertInteger(config.cols, "cols", 2, 40);
  assertInteger(config.n, "n", 2, 99);
  assertInteger(config.t, "t", 1, 999);
  assertInteger(config.m, "m", 0, 999);
  config.seed = String(config.seed || DEFAULT_CONFIG.seed);
  config.initialBurst = Boolean(config.initialBurst);
  return config;
}

export function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

export class GameEngine {
  private config: GameConfig;
  private charges: number[][];
  private relatedGroups: (number | null)[][] = [];
  private relationParents = new Map<number, number>();
  private nextRelationId = 1;
  private rng: SeededRng;
  private edges = new Set<string>();
  private turn = 0;
  private score = 0;
  private gameOver = false;
  private winReason: WinReason = null;

  constructor(config: GameConfigInput = {}) {
    this.config = normalizeConfig(config);
    this.charges = createMatrix(this.config.rows, this.config.cols, 0);
    this.relatedGroups = createMatrix(this.config.rows, this.config.cols, null);
    this.rng = new SeededRng(this.config.seed);
    if (this.config.initialBurst && this.config.m > 0) {
      this.spawnErrors(this.config.m);
    }
    this.updateGameOver();
  }

  reset(config: GameConfigInput = {}): PublicGameState {
    const nextConfig = normalizeConfig({ ...this.config, ...config });
    this.config = nextConfig;
    this.charges = createMatrix(nextConfig.rows, nextConfig.cols, 0);
    this.relatedGroups = createMatrix(nextConfig.rows, nextConfig.cols, null);
    this.relationParents = new Map<number, number>();
    this.nextRelationId = 1;
    this.rng = new SeededRng(nextConfig.seed);
    this.edges = new Set<string>();
    this.turn = 0;
    this.score = 0;
    this.gameOver = false;
    this.winReason = null;
    if (nextConfig.initialBurst && nextConfig.m > 0) {
      this.spawnErrors(nextConfig.m);
    }
    this.updateGameOver();
    return this.getState();
  }

  getState(): PublicGameState {
    return {
      charges: cloneMatrix(this.charges),
      turn: this.turn,
      score: this.score,
      gameOver: this.gameOver,
      winReason: this.winReason,
      config: { ...this.config }
    };
  }

  getDebugState(): DebugGameState {
    const report = this.computeClusters();
    return {
      ...this.getState(),
      clusterIds: report.ids,
      edgeCount: this.edges.size
    };
  }

  move(action: MoveAction): MoveResult {
    const validationError = this.validateMove(action);
    if (validationError) {
      return { ok: false, error: validationError, state: this.getState() };
    }

    const [fromRow, fromCol] = action.from;
    const [toRow, toCol] = action.to;
    const carriedCharge = this.charges[fromRow][fromCol];
    const redirectedNeighbors = this.connectedNeighbors(action.from);
    const sourceGroup = this.ensureRelatedGroup(action.from);
    const targetGroup = this.charges[toRow][toCol] === 0 ? null : this.ensureRelatedGroup(action.to);
    const nextTargetGroup =
      targetGroup === null ? sourceGroup : this.unionRelatedGroups(sourceGroup, targetGroup);

    this.removeEdgesTouching(action.from);
    this.charges[fromRow][fromCol] = 0;
    this.clearRelatedGroup(action.from);
    this.charges[toRow][toCol] = mod(this.charges[toRow][toCol] + carriedCharge, this.config.n);

    if (this.charges[toRow][toCol] === 0) {
      this.clearRelatedGroup(action.to);
      this.removeEdgesTouching(action.to);
    } else {
      this.relatedGroups[toRow][toCol] = this.findRelatedGroup(nextTargetGroup);
      for (const neighbor of redirectedNeighbors) {
        if (!sameCoord(neighbor, action.to) && this.chargeAt(neighbor) !== 0) {
          this.edges.add(edgeKey(action.to, neighbor));
        }
      }
    }

    this.pruneInactiveEdges();
    this.turn += 1;
    this.score += 1;

    this.updateGameOver();
    if (!this.gameOver && this.turn % this.config.t === 0 && this.config.m > 0) {
      this.spawnErrors(this.config.m);
      this.updateGameOver();
    }

    return { ok: true, state: this.getState() };
  }

  applyError(edge: Edge): void {
    this.assertInside(edge.a, "edge.a");
    this.assertInside(edge.b, "edge.b");
    if (!areNeighbors(edge.a, edge.b)) {
      throw new Error("error edge endpoints must be neighboring plaquettes");
    }
    const value = mod(edge.value, this.config.n);
    if (value === 0) {
      return;
    }
    const [aRow, aCol] = edge.a;
    const [bRow, bCol] = edge.b;
    this.charges[aRow][aCol] = mod(this.charges[aRow][aCol] + value, this.config.n);
    this.charges[bRow][bCol] = mod(this.charges[bRow][bCol] - value, this.config.n);

    const aGroup = this.charges[aRow][aCol] === 0 ? null : this.ensureRelatedGroup(edge.a);
    const bGroup = this.charges[bRow][bCol] === 0 ? null : this.ensureRelatedGroup(edge.b);
    if (aGroup === null) {
      this.clearRelatedGroup(edge.a);
    }
    if (bGroup === null) {
      this.clearRelatedGroup(edge.b);
    }
    if (aGroup !== null && bGroup !== null) {
      this.unionRelatedGroups(aGroup, bGroup);
    }

    if (this.charges[aRow][aCol] !== 0 && this.charges[bRow][bCol] !== 0) {
      this.edges.add(edgeKey(edge.a, edge.b));
    }
    this.pruneInactiveEdges();
    this.updateGameOver();
  }

  spawnErrors(count = this.config.m): void {
    for (let i = 0; i < count; i += 1) {
      this.applyError(this.randomInteriorEdge());
    }
  }

  private validateMove(action: MoveAction): string | null {
    if (this.gameOver) {
      return "game is over";
    }
    if (!isCoord(action.from) || !isCoord(action.to)) {
      return "move requires from and to coordinates";
    }
    if (!this.isInside(action.from) || !this.isInside(action.to)) {
      return "move coordinates are outside the board";
    }
    if (!areNeighbors(action.from, action.to)) {
      return "move destination must be an orthogonal neighbor";
    }
    if (this.chargeAt(action.from) === 0) {
      return "source plaquette has zero charge";
    }
    return null;
  }

  private randomInteriorEdge(): Edge {
    const horizontalCount = this.config.rows * Math.max(0, this.config.cols - 1);
    const verticalCount = Math.max(0, this.config.rows - 1) * this.config.cols;
    const total = horizontalCount + verticalCount;
    const index = this.rng.int(total);
    const value = this.rng.range(1, this.config.n - 1);

    if (index < horizontalCount) {
      const row = Math.floor(index / (this.config.cols - 1));
      const col = index % (this.config.cols - 1);
      return { a: [row, col], b: [row, col + 1], value };
    }

    const verticalIndex = index - horizontalCount;
    const row = Math.floor(verticalIndex / this.config.cols);
    const col = verticalIndex % this.config.cols;
    return { a: [row, col], b: [row + 1, col], value };
  }

  private computeClusters(): ClusterReport {
    const ids = createMatrix<number | null>(this.config.rows, this.config.cols, null);
    const visited = createMatrix(this.config.rows, this.config.cols, false);
    let clusterId = 1;
    let winReason: WinReason = null;

    for (let row = 0; row < this.config.rows; row += 1) {
      for (let col = 0; col < this.config.cols; col += 1) {
        if (this.charges[row][col] === 0 || visited[row][col]) {
          continue;
        }

        const touches = {
          left: false,
          right: false,
          top: false,
          bottom: false
        };
        const queue: Coord[] = [[row, col]];
        visited[row][col] = true;

        for (let i = 0; i < queue.length; i += 1) {
          const current = queue[i];
          const [currentRow, currentCol] = current;
          ids[currentRow][currentCol] = clusterId;
          touches.left ||= currentCol === 0;
          touches.right ||= currentCol === this.config.cols - 1;
          touches.top ||= currentRow === 0;
          touches.bottom ||= currentRow === this.config.rows - 1;

          for (const neighbor of this.connectedNeighbors(current)) {
            const [neighborRow, neighborCol] = neighbor;
            if (this.charges[neighborRow][neighborCol] !== 0 && !visited[neighborRow][neighborCol]) {
              visited[neighborRow][neighborCol] = true;
              queue.push(neighbor);
            }
          }
        }

        if (!winReason && touches.left && touches.right) {
          winReason = "left-right";
        }
        if (!winReason && touches.top && touches.bottom) {
          winReason = "top-bottom";
        }
        clusterId += 1;
      }
    }

    return { ids, winReason };
  }

  private updateGameOver(): void {
    this.winReason = this.computeRelatedWinReason();
    this.gameOver = this.winReason !== null;
  }

  private computeRelatedWinReason(): WinReason {
    const touchesByGroup = new Map<
      number,
      { left: boolean; right: boolean; top: boolean; bottom: boolean }
    >();

    for (let row = 0; row < this.config.rows; row += 1) {
      for (let col = 0; col < this.config.cols; col += 1) {
        if (this.charges[row][col] === 0) {
          continue;
        }

        const group = this.ensureRelatedGroup([row, col]);
        let touches = touchesByGroup.get(group);
        if (!touches) {
          touches = { left: false, right: false, top: false, bottom: false };
          touchesByGroup.set(group, touches);
        }

        touches.left ||= col === 0;
        touches.right ||= col === this.config.cols - 1;
        touches.top ||= row === 0;
        touches.bottom ||= row === this.config.rows - 1;

        if (touches.left && touches.right) {
          return "left-right";
        }
        if (touches.top && touches.bottom) {
          return "top-bottom";
        }
      }
    }

    return null;
  }

  private ensureRelatedGroup(coord: Coord): number {
    const [row, col] = coord;
    const group = this.relatedGroups[row][col];
    if (group !== null) {
      const root = this.findRelatedGroup(group);
      this.relatedGroups[row][col] = root;
      return root;
    }

    const next = this.nextRelationId;
    this.nextRelationId += 1;
    this.relationParents.set(next, next);
    this.relatedGroups[row][col] = next;
    return next;
  }

  private clearRelatedGroup(coord: Coord): void {
    this.relatedGroups[coord[0]][coord[1]] = null;
  }

  private unionRelatedGroups(a: number, b: number): number {
    const aRoot = this.findRelatedGroup(a);
    const bRoot = this.findRelatedGroup(b);
    if (aRoot === bRoot) {
      return aRoot;
    }
    const root = Math.min(aRoot, bRoot);
    const child = root === aRoot ? bRoot : aRoot;
    this.relationParents.set(child, root);
    return root;
  }

  private findRelatedGroup(group: number): number {
    const parent = this.relationParents.get(group);
    if (parent === undefined || parent === group) {
      if (parent === undefined) {
        this.relationParents.set(group, group);
      }
      return group;
    }

    const root = this.findRelatedGroup(parent);
    this.relationParents.set(group, root);
    return root;
  }

  private connectedNeighbors(coord: Coord): Coord[] {
    const neighbors: Coord[] = [];
    for (const key of this.edges) {
      const [a, b] = coordsFromEdgeKey(key);
      if (sameCoord(a, coord)) {
        neighbors.push(b);
      } else if (sameCoord(b, coord)) {
        neighbors.push(a);
      }
    }
    return neighbors;
  }

  private pruneInactiveEdges(): void {
    const next = new Set<string>();
    for (const key of this.edges) {
      const [a, b] = coordsFromEdgeKey(key);
      if (!sameCoord(a, b) && this.chargeAt(a) !== 0 && this.chargeAt(b) !== 0) {
        next.add(edgeKey(a, b));
      }
    }
    this.edges = next;
  }

  private removeEdgesTouching(coord: Coord): void {
    const next = new Set<string>();
    for (const key of this.edges) {
      const [a, b] = coordsFromEdgeKey(key);
      if (!sameCoord(a, coord) && !sameCoord(b, coord)) {
        next.add(key);
      }
    }
    this.edges = next;
  }

  private chargeAt(coord: Coord): number {
    return this.charges[coord[0]][coord[1]];
  }

  private isInside(coord: Coord): boolean {
    return (
      coord[0] >= 0 &&
      coord[0] < this.config.rows &&
      coord[1] >= 0 &&
      coord[1] < this.config.cols
    );
  }

  private assertInside(coord: Coord, label: string): void {
    if (!this.isInside(coord)) {
      throw new Error(`${label} is outside the board`);
    }
  }
}

function assertInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
}

function createMatrix<T>(rows: number, cols: number, value: T): T[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => value));
}

function cloneMatrix<T>(matrix: T[][]): T[][] {
  return matrix.map((row) => [...row]);
}

function isCoord(value: unknown): value is Coord {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1])
  );
}

function areNeighbors(a: Coord, b: Coord): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

function sameCoord(a: Coord, b: Coord): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function edgeKey(a: Coord, b: Coord): string {
  const aKey = coordKey(a);
  const bKey = coordKey(b);
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function coordKey(coord: Coord): string {
  return `${coord[0]},${coord[1]}`;
}

function coordsFromEdgeKey(key: string): [Coord, Coord] {
  const [a, b] = key.split("|");
  return [coordFromKey(a), coordFromKey(b)];
}

function coordFromKey(key: string): Coord {
  const [row, col] = key.split(",").map(Number);
  return [row, col];
}
