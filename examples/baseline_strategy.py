#!/usr/bin/env python3
"""Baseline visible-state strategy for the Z_n anyon puzzle.

The public API intentionally hides relation groups, so this player only uses the
charge matrix. It is not an optimal decoder; it is a deterministic baseline that
tries to remove charges quickly without merging unrelated visible charges.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib import error, request

BASE_URL = "http://127.0.0.1:5173"
Coord = tuple[int, int]
Move = tuple[Coord, Coord]


@dataclass(frozen=True)
class Candidate:
    score: float
    move: Move


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a baseline player against the local game API."
    )
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--rows", type=int, default=7)
    parser.add_argument("--cols", type=int, default=7)
    parser.add_argument("--n", type=int, default=10)
    parser.add_argument("--t", type=int, default=5)
    parser.add_argument("--m", type=int, default=6)
    parser.add_argument("--seed", default="baseline")
    parser.add_argument("--max-turns", type=int, default=1000)
    parser.add_argument(
        "--delay", type=float, default=0.15, help="Seconds to pause after each move."
    )
    parser.add_argument("--continue-current", action="store_true")
    args = parser.parse_args()

    try:
        if args.continue_current:
            state = get_json(args.base_url, "/api/state")
        else:
            state = post_json(
                args.base_url,
                "/api/new-game",
                {
                    "rows": args.rows,
                    "cols": args.cols,
                    "n": args.n,
                    "t": args.t,
                    "m": args.m,
                    "seed": args.seed,
                },
            )

        while not state["gameOver"] and state["turn"] < args.max_turns:
            move = choose_move(state)
            if move is None:
                print("No legal move available.")
                break

            result = post_json(
                args.base_url, "/api/move", {"from": move[0], "to": move[1]}
            )
            if not result.get("ok"):
                print(f"Move rejected: {result.get('error')}", file=sys.stderr)
                return 1
            state = result["state"]
            if args.delay > 0:
                time.sleep(args.delay)

        print(
            json.dumps(
                {
                    "score": state["score"],
                    "turn": state["turn"],
                    "gameOver": state["gameOver"],
                    "winReason": state["winReason"],
                },
                indent=2,
            )
        )
        return 0
    except error.URLError as exc:
        print(f"Could not reach game server at {args.base_url}: {exc}", file=sys.stderr)
        print("Start it with `npm run dev` first.", file=sys.stderr)
        return 1


def choose_move(state: dict[str, Any]) -> Move | None:
    charges = state["charges"]
    n = state["config"]["n"]
    candidates: list[Candidate] = []

    for source in nonzero_cells(charges):
        for target in neighbors(source, len(charges), len(charges[0])):
            candidates.append(
                Candidate(score_move(charges, n, source, target), (source, target))
            )

    if not candidates:
        return None

    # Deterministic tie-breaking keeps runs reproducible.
    return max(
        candidates,
        key=lambda candidate: (candidate.score, reverse_lexicographic(candidate.move)),
    ).move


def score_move(charges: list[list[int]], n: int, source: Coord, target: Coord) -> float:
    rows = len(charges)
    cols = len(charges[0])
    source_charge = charges[source[0]][source[1]]
    target_charge = charges[target[0]][target[1]]
    next_charge = (source_charge + target_charge) % n
    score = 0.0

    if target_charge != 0 and next_charge == 0:
        score += 10_000.0
    elif target_charge != 0:
        score -= 1_000.0

    before_active = count_active(charges)
    after_active = before_active - 1
    if target_charge != 0:
        after_active -= 1
    if next_charge != 0:
        after_active += 1
    score += 250.0 * (before_active - after_active)

    source_complement = (-source_charge) % n
    before_distance = nearest_charge_distance(
        charges, source, source_complement, exclude=source
    )
    after_distance = nearest_charge_distance(
        charges, target, source_complement, exclude=source
    )
    if math.isfinite(before_distance) and math.isfinite(after_distance):
        score += 40.0 * (before_distance - after_distance)

    score += 8.0 * (
        boundary_clearance(target, rows, cols) - boundary_clearance(source, rows, cols)
    )
    score += 0.25 * center_pull(target, rows, cols)

    if target_charge == 0:
        score += 3.0

    return score


def nonzero_cells(charges: list[list[int]]) -> list[Coord]:
    cells: list[Coord] = []
    for row, values in enumerate(charges):
        for col, charge in enumerate(values):
            if charge != 0:
                cells.append((row, col))
    return cells


def neighbors(coord: Coord, rows: int, cols: int) -> list[Coord]:
    row, col = coord
    candidates = [(row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1)]
    return [(r, c) for r, c in candidates if 0 <= r < rows and 0 <= c < cols]


def nearest_charge_distance(
    charges: list[list[int]], coord: Coord, charge: int, exclude: Coord | None = None
) -> float:
    best = math.inf
    for other in nonzero_cells(charges):
        if other == exclude:
            continue
        if charges[other[0]][other[1]] == charge:
            best = min(best, manhattan(coord, other))
    return best


def count_active(charges: list[list[int]]) -> int:
    return len(nonzero_cells(charges))


def manhattan(a: Coord, b: Coord) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def boundary_clearance(coord: Coord, rows: int, cols: int) -> int:
    row, col = coord
    return min(row, rows - 1 - row, col, cols - 1 - col)


def center_pull(coord: Coord, rows: int, cols: int) -> float:
    row, col = coord
    return -abs(row - (rows - 1) / 2) - abs(col - (cols - 1) / 2)


def reverse_lexicographic(move: Move) -> tuple[int, int, int, int]:
    (source_row, source_col), (target_row, target_col) = move
    return (-source_row, -source_col, -target_row, -target_col)


def get_json(base_url: str, path: str) -> dict[str, Any]:
    with request.urlopen(f"{base_url}{path}", timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(base_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{base_url}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
