import "./style.css";
import { GameEngine, normalizeConfig } from "./engine";
import type { Coord, GameConfig, GameConfigInput, MoveResult, PublicGameState } from "./types";

declare global {
  interface Window {
    decodoku: {
      engine: GameEngine;
      getState: () => PublicGameState;
      move: (from: Coord, to: Coord) => MoveResult;
      reset: (config?: GameConfigInput) => PublicGameState;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("missing #app root");
}

type FieldName = "rows" | "cols" | "n" | "t" | "m" | "seed";

const highScoreKey = "decodoku.highScore";
let engine = new GameEngine();
let selected: Coord | null = null;
let state = engine.getState();
let highScore = Number(localStorage.getItem(highScoreKey) ?? "0") || 0;
let apiWatchEnabled = new URLSearchParams(window.location.search).get("watchApi") === "1";
let apiWatchTimer: number | null = null;

app.innerHTML = `
  <main class="shell">
    <section class="topbar" aria-label="Game status">
      <div class="metric">
        <span class="metric-label">Score</span>
        <strong id="score">0</strong>
      </div>
      <div class="metric">
        <span class="metric-label">Turn</span>
        <strong id="turn">0</strong>
      </div>
      <div class="metric">
        <span class="metric-label">High</span>
        <strong id="high-score">0</strong>
      </div>
    </section>

    <section class="game-panel" aria-label="Z n anyon board">
      <svg id="board" class="board" role="grid" aria-label="Charge board"></svg>
      <div id="overlay" class="overlay hidden" aria-live="polite">
        <div class="overlay-title">Game Over</div>
        <div id="overlay-reason" class="overlay-reason"></div>
      </div>
    </section>

    <section class="controls" aria-label="Game controls">
      <label>Rows <input id="rows" type="number" min="2" max="40" step="1" /></label>
      <label>Cols <input id="cols" type="number" min="2" max="40" step="1" /></label>
      <label>n <input id="n" type="number" min="2" max="99" step="1" /></label>
      <label>t <input id="t" type="number" min="1" max="999" step="1" /></label>
      <label>m <input id="m" type="number" min="0" max="999" step="1" /></label>
      <label class="seed-label">Seed <input id="seed" type="text" /></label>
      <button id="watch-api" type="button">Watch API</button>
      <button id="new-game" type="button">New Game</button>
    </section>

    <section class="api-note" aria-label="API note">
      <code>GET /api/state</code>
      <code>POST /api/move {"from":[r,c],"to":[r,c]}</code>
    </section>
  </main>
`;

const board = mustGet<SVGSVGElement>("board");
const overlay = mustGet<HTMLDivElement>("overlay");
const overlayReason = mustGet<HTMLDivElement>("overlay-reason");
const scoreText = mustGet<HTMLElement>("score");
const turnText = mustGet<HTMLElement>("turn");
const highScoreText = mustGet<HTMLElement>("high-score");
const watchApiButton = mustGet<HTMLButtonElement>("watch-api");
const newGameButton = mustGet<HTMLButtonElement>("new-game");
const fields: Record<FieldName, HTMLInputElement> = {
  rows: mustGet<HTMLInputElement>("rows"),
  cols: mustGet<HTMLInputElement>("cols"),
  n: mustGet<HTMLInputElement>("n"),
  t: mustGet<HTMLInputElement>("t"),
  m: mustGet<HTMLInputElement>("m"),
  seed: mustGet<HTMLInputElement>("seed")
};

newGameButton.addEventListener("click", () => {
  if (apiWatchEnabled) {
    void resetApiFromControls();
  } else {
    resetFromControls();
  }
});

watchApiButton.addEventListener("click", () => {
  setApiWatchEnabled(!apiWatchEnabled);
});

window.addEventListener("keydown", (event) => {
  if (apiWatchEnabled || !selected || state.gameOver) {
    return;
  }

  const directions: Record<string, Coord> = {
    ArrowUp: [selected[0] - 1, selected[1]],
    ArrowDown: [selected[0] + 1, selected[1]],
    ArrowLeft: [selected[0], selected[1] - 1],
    ArrowRight: [selected[0], selected[1] + 1]
  };

  const target = directions[event.key];
  if (target) {
    event.preventDefault();
    doMove(selected, target);
  }
});

window.decodoku = {
  engine,
  getState: () => engine.getState(),
  move: (from, to) => {
    const result = engine.move({ from, to });
    syncAfterEngineChange();
    return result;
  },
  reset: (config = {}) => {
    const nextState = engine.reset(config);
    syncAfterEngineChange();
    return nextState;
  }
};

syncControls(state.config);
render();
setApiWatchEnabled(apiWatchEnabled);

function render(nextState = engine.getState()): void {
  state = nextState;
  highScore = Math.max(highScore, state.score);
  localStorage.setItem(highScoreKey, String(highScore));

  watchApiButton.classList.toggle("active", apiWatchEnabled);
  watchApiButton.textContent = apiWatchEnabled ? "Watching API" : "Watch API";
  scoreText.textContent = String(state.score);
  turnText.textContent = String(state.turn);
  highScoreText.textContent = String(highScore);
  overlay.classList.toggle("hidden", !state.gameOver);
  overlayReason.textContent =
    state.winReason === "left-right"
      ? "A cluster touched both left and right boundaries."
      : state.winReason === "top-bottom"
        ? "A cluster touched both top and bottom boundaries."
        : "";

  drawBoard(state);
}

function drawBoard(current: PublicGameState): void {
  const cell = 62;
  const radius = 27;
  const margin = 42;
  const width = margin * 2 + (current.config.cols - 1) * cell + radius * 2;
  const height = margin * 2 + (current.config.rows - 1) * cell + radius * 2;

  board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  board.textContent = "";

  const fragment = document.createDocumentFragment();
  for (let row = 0; row < current.config.rows; row += 1) {
    for (let col = 0; col < current.config.cols; col += 1) {
      const cx = margin + radius + col * cell;
      const cy = margin + radius + row * cell;
      const charge = current.charges[row][col];
      const group = svg("g", {
        class: cellClass(row, col, charge),
        role: "gridcell",
        tabindex: "0",
        "data-row": String(row),
        "data-col": String(col),
        "aria-label": `row ${row}, column ${col}, charge ${charge}`
      });

      const diamond = svg("polygon", {
        points: `${cx},${cy - radius} ${cx + radius},${cy} ${cx},${cy + radius} ${cx - radius},${cy}`
      });
      const text = svg("text", {
        x: String(cx),
        y: String(cy + 1),
        "data-charge": String(charge)
      });
      text.textContent = charge === 0 ? "" : String(charge);

      group.append(diamond, text);
      group.addEventListener("click", () => handleCell(row, col));
      group.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          handleCell(row, col);
        }
      });
      fragment.append(group);
    }
  }

  board.append(fragment);
}

function handleCell(row: number, col: number): void {
  const coord: Coord = [row, col];
  const charge = state.charges[row][col];

  if (apiWatchEnabled || state.gameOver) {
    return;
  }

  if (!selected) {
    if (charge !== 0) {
      selected = coord;
      render();
    }
    return;
  }

  if (sameCoord(selected, coord)) {
    selected = null;
    render();
    return;
  }

  if (isNeighbor(selected, coord)) {
    doMove(selected, coord);
    return;
  }

  selected = charge !== 0 ? coord : null;
  render();
}

function doMove(from: Coord, to: Coord): void {
  const result = engine.move({ from, to });
  if (result.ok) {
    selected = result.state.charges[to[0]]?.[to[1]] ? to : null;
  }
  syncAfterEngineChange();
}

function resetFromControls(): void {
  const config = readControls();
  engine = new GameEngine(config);
  window.decodoku.engine = engine;
  selected = null;
  syncAfterEngineChange();
}

function syncAfterEngineChange(): void {
  const nextState = engine.getState();
  syncControls(nextState.config);
  render(nextState);
}

function setApiWatchEnabled(enabled: boolean): void {
  apiWatchEnabled = enabled;
  selected = null;
  updateWatchUrl();
  if (apiWatchTimer !== null) {
    window.clearInterval(apiWatchTimer);
    apiWatchTimer = null;
  }

  if (apiWatchEnabled) {
    void syncFromApi();
    apiWatchTimer = window.setInterval(() => {
      void syncFromApi();
    }, 200);
  } else {
    syncAfterEngineChange();
  }
}

async function syncFromApi(): Promise<void> {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) {
      return;
    }
    const nextState = (await response.json()) as PublicGameState;
    syncControls(nextState.config);
    render(nextState);
  } catch {
    // Keep the last visible board if the dev server restarts mid-poll.
  }
}

async function resetApiFromControls(): Promise<void> {
  const response = await fetch("/api/new-game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(readControls())
  });
  if (!response.ok) {
    return;
  }
  const nextState = (await response.json()) as PublicGameState;
  syncControls(nextState.config);
  render(nextState);
}

function updateWatchUrl(): void {
  const url = new URL(window.location.href);
  if (apiWatchEnabled) {
    url.searchParams.set("watchApi", "1");
  } else {
    url.searchParams.delete("watchApi");
  }
  window.history.replaceState(null, "", url);
}

function readControls(): GameConfig {
  return normalizeConfig({
    rows: Number(fields.rows.value),
    cols: Number(fields.cols.value),
    n: Number(fields.n.value),
    t: Number(fields.t.value),
    m: Number(fields.m.value),
    seed: fields.seed.value,
    initialBurst: true
  });
}

function syncControls(config: GameConfig): void {
  fields.rows.value = String(config.rows);
  fields.cols.value = String(config.cols);
  fields.n.value = String(config.n);
  fields.t.value = String(config.t);
  fields.m.value = String(config.m);
  fields.seed.value = config.seed;
}

function cellClass(row: number, col: number, charge: number): string {
  const classes = ["cell"];
  if (charge !== 0) {
    classes.push("charged");
  }
  if (selected && selected[0] === row && selected[1] === col) {
    classes.push("selected");
  }
  return classes.join(" ");
}

function chargeColor(charge: string): string {
  const palette = [
    "#1aa05b",
    "#1f8ef1",
    "#f224a7",
    "#f39b12",
    "#7c7d11",
    "#1b53dc",
    "#8b0505",
    "#6d6d6d",
    "#111111"
  ];
  const numeric = Number(charge);
  return palette[(numeric - 1 + palette.length) % palette.length];
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {}
): SVGElementTagNameMap[K] {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function mustGet<T extends HTMLElement | SVGSVGElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing #${id}`);
  }
  return element as T;
}

function sameCoord(a: Coord, b: Coord): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isNeighbor(a: Coord, b: Coord): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

const stylesheet = new CSSStyleSheet();
stylesheet.replaceSync(`
  .cell text {
    fill: attr(data-charge color, #111111);
  }
`);

if ("adoptedStyleSheets" in document) {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}

document.addEventListener("DOMContentLoaded", () => {
  for (const element of board.querySelectorAll<SVGTextElement>(".cell text")) {
    element.style.fill = chargeColor(element.dataset.charge ?? "0");
  }
});
