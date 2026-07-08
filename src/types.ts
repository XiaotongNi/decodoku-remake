export type Coord = readonly [row: number, col: number];

export type WinReason = "left-right" | "top-bottom" | null;

export interface GameConfig {
  rows: number;
  cols: number;
  n: number;
  t: number;
  m: number;
  seed: string;
  initialBurst: boolean;
}

export type GameConfigInput = Partial<GameConfig>;

export interface MoveAction {
  from: Coord;
  to: Coord;
}

export interface PublicGameState {
  charges: number[][];
  turn: number;
  score: number;
  gameOver: boolean;
  winReason: WinReason;
  config: GameConfig;
}

export interface MoveResult {
  ok: boolean;
  state: PublicGameState;
  error?: string;
}

export interface Edge {
  a: Coord;
  b: Coord;
  value: number;
}

export interface DebugGameState extends PublicGameState {
  clusterIds: (number | null)[][];
  edgeCount: number;
}
