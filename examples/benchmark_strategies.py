#!/usr/bin/env python3
"""Benchmark example strategies over a reproducible set of game seeds."""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib import error, request


BASE_URL = "http://127.0.0.1:5173"
EXAMPLES_DIR = Path(__file__).resolve().parent
Move = tuple[tuple[int, int], tuple[int, int]]
ChooseMove = Callable[[dict[str, Any]], Optional[Move]]


@dataclass(frozen=True)
class RunResult:
    seed: str
    score: int
    game_over: bool
    win_reason: str | None
    elapsed: float


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Python strategies against the same seeds and print statistics."
    )
    parser.add_argument(
        "strategies",
        nargs="*",
        help="Strategy files or names (default: every examples/*_strategy.py).",
    )
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument("--seed-prefix", default="benchmark")
    parser.add_argument("--rows", type=int, default=7)
    parser.add_argument("--cols", type=int, default=7)
    parser.add_argument("--n", type=int, default=10)
    parser.add_argument("--t", type=int, default=5)
    parser.add_argument("--m", type=int, default=6)
    parser.add_argument("--max-turns", type=int, default=2000)
    parser.add_argument(
        "--verbose", action="store_true", help="Print the result of every seed."
    )
    args = parser.parse_args()

    if args.seeds < 1:
        parser.error("--seeds must be at least 1")

    paths = resolve_strategy_paths(args.strategies)
    if not paths:
        parser.error("no *_strategy.py files found")

    seeds = [f"{args.seed_prefix}-{index:02d}" for index in range(args.seeds)]
    all_results: list[tuple[str, list[RunResult]]] = []

    try:
        for path in paths:
            choose_move = load_strategy(path)
            results: list[RunResult] = []
            print(f"Running {path.name} ({len(seeds)} seeds)...", flush=True)

            for seed in seeds:
                result = run_game(choose_move, seed, args)
                results.append(result)
                if args.verbose:
                    status = result.win_reason or (
                        "game-over" if result.game_over else "turn-limit"
                    )
                    print(
                        f"  {seed}: score={result.score} "
                        f"status={status} time={result.elapsed:.3f}s"
                    )

            all_results.append((path.stem, results))
    except (error.URLError, TimeoutError) as exc:
        print(f"Could not reach game server at {args.base_url}: {exc}", file=sys.stderr)
        print("Start it with `npm run dev` first.", file=sys.stderr)
        return 1
    except (ImportError, AttributeError, TypeError, ValueError) as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1

    print_summary(all_results)
    return 0


def resolve_strategy_paths(values: list[str]) -> list[Path]:
    if not values:
        return sorted(EXAMPLES_DIR.glob("*_strategy.py"))

    paths: list[Path] = []
    for value in values:
        given = Path(value)
        candidates = [given, EXAMPLES_DIR / value]
        if not value.endswith(".py"):
            candidates.append(EXAMPLES_DIR / f"{value}.py")
        path = next(
            (candidate.resolve() for candidate in candidates if candidate.is_file()),
            None,
        )
        if path is None:
            raise ValueError(f"strategy not found: {value}")
        paths.append(path)
    return paths


def load_strategy(path: Path) -> ChooseMove:
    # Keep examples/ importable for strategies that share helpers with each other.
    if str(EXAMPLES_DIR) not in sys.path:
        sys.path.insert(0, str(EXAMPLES_DIR))

    module_name = f"decodoku_benchmark_{path.stem}_{abs(hash(path))}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    choose_move = getattr(module, "choose_move", None)
    if not callable(choose_move):
        raise AttributeError(f"{path.name} must define choose_move(state)")
    return choose_move


def run_game(choose_move: ChooseMove, seed: str, args: argparse.Namespace) -> RunResult:
    state = post_json(
        args.base_url,
        "/api/new-game",
        {
            "rows": args.rows,
            "cols": args.cols,
            "n": args.n,
            "t": args.t,
            "m": args.m,
            "seed": seed,
        },
    )
    started = time.perf_counter()

    while not state["gameOver"] and state["turn"] < args.max_turns:
        move = choose_move(state)
        if move is None:
            break
        result = post_json(
            args.base_url,
            "/api/move",
            {"from": move[0], "to": move[1]},
        )
        if not result.get("ok"):
            raise ValueError(f"move rejected on seed {seed}: {result.get('error')}")
        state = result["state"]

    return RunResult(
        seed=seed,
        score=state["score"],
        game_over=state["gameOver"],
        win_reason=state["winReason"],
        elapsed=time.perf_counter() - started,
    )


def print_summary(all_results: list[tuple[str, list[RunResult]]]) -> None:
    print("\nSummary")
    header = (
        f"{'strategy':<24} {'mean':>9} {'median':>9} {'stdev':>9} "
        f"{'min':>7} {'max':>7} {'ended':>9} {'time':>9}"
    )
    print(header)
    print("-" * len(header))

    for name, results in all_results:
        scores = [result.score for result in results]
        ended = sum(result.game_over for result in results)
        deviation = statistics.stdev(scores) if len(scores) > 1 else 0.0
        total_time = sum(result.elapsed for result in results)
        print(
            f"{name:<24} {statistics.mean(scores):>9.2f} "
            f"{statistics.median(scores):>9.2f} {deviation:>9.2f} "
            f"{min(scores):>7d} {max(scores):>7d} "
            f"{ended:>4d}/{len(results):<4d} {total_time:>8.2f}s"
        )

        reasons = Counter(result.win_reason or "turn-limit" for result in results)
        reason_text = ", ".join(
            f"{reason}={count}" for reason, count in sorted(reasons.items())
        )
        print(f"  outcomes: {reason_text}")


def post_json(base_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
