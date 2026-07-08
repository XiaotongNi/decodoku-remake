import requests
import numpy as np


BASE_URL = "http://127.0.0.1:5173"


def main():
    state = requests.post(
        f"{BASE_URL}/api/new-game",
        json={"rows": 8, "cols": 8, "n": 10, "t": 5, "m": 6, "seed": "python-demo"},
        timeout=5,
    ).json()

    charges = np.array(state["charges"], dtype=int)
    print(charges)

    nonzero = np.argwhere(charges != 0)
    if len(nonzero) == 0:
        return

    row, col = nonzero[0]
    candidates = [(row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1)]
    for target_row, target_col in candidates:
        if 0 <= target_row < charges.shape[0] and 0 <= target_col < charges.shape[1]:
            result = requests.post(
                f"{BASE_URL}/api/move",
                json={"from": [int(row), int(col)], "to": [int(target_row), int(target_col)]},
                timeout=5,
            ).json()
            print(np.array(result["state"]["charges"], dtype=int))
            break


if __name__ == "__main__":
    main()
