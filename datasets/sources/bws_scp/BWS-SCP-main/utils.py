from __future__ import annotations
from typing import Dict, Any, Tuple
import numpy as np
import pandas as pd
import re


_SECTION_KEYS = {
    "TIME_SECTION",
    "RELIABILITY_SECTION",
    "COST_SECTION",
    "ALPHA_SECTION", 
    "BETA_SECTION",
    "CAPACITY_SECTION",
    "DEMAND_SECTION",
    "EOF",
}


def read_scp(path: str) -> Dict[str, Any]:
    """
    Parse a .scp benchmark file.

    Parameters
    ----------
    path : str
        Path to the .scp file.

    Returns
    -------
    dict
        {
          "meta"       : dict[str, str],
          "size"       : tuple[int, int],
          "time"       : pd.DataFrame   (Tasks × Servers, int),
          "reliability": pd.DataFrame   (Tasks × Servers, float),
          "cost"       : pd.DataFrame   (Tasks × Servers, float),
          "alpha"      : pd.DataFrame   (Servers, float),
          "beta"       : pd.DataFrame   (Servers, float),
          "capacity"   : pd.Series      (Servers, int),
          "demand"     : pd.Series      (Tasks, int),
        }
    """
    with open(path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f]

    meta = {}
    body_start = None
    for idx, ln in enumerate(lines):
        s = ln.strip()
        if s in _SECTION_KEYS:
            body_start = idx
            break
        if ":" in s:
            k, v = s.split(":", 1)
            meta[k.strip()] = v.strip()
    if body_start is None:
        raise ValueError("No section header found")

    T = int(meta["DIM_TASKS"])
    S = int(meta["DIM_SERVERS"])

    time_mat = np.zeros((T, S), int)
    rel_mat  = np.zeros((T, S), float)
    cost_mat = np.zeros((T, S), float)
    alpha_vec= np.zeros(S, float)
    beta_vec = np.zeros(S, float)
    cap_vec  = np.zeros(S, int)
    dem_vec  = np.zeros(T, int)

    section = None
    counters= {k: 0 for k in _SECTION_KEYS}

    for raw in lines[body_start:]:
        if not raw.strip(): 
            continue
        parts = raw.split()
        token = parts[0]

        if token in _SECTION_KEYS:
            if token == "EOF":
                break
            section = token
            continue

        if section == "TIME_SECTION":
            time_mat[counters[section], :] = [int(x) for x in parts]
        elif section == "RELIABILITY_SECTION":
            rel_mat[counters[section], :] = [float(x) for x in parts]
        elif section == "COST_SECTION":
            cost_mat[counters[section], :] = [float(x) for x in parts]
        elif section == "ALPHA_SECTION":
            alpha_vec[:] = [float(x) for x in parts]
        elif section == "BETA_SECTION":
            beta_vec[:] = [float(x) for x in parts]
        elif section == "CAPACITY_SECTION":
            cap_vec[counters[section]] = int(parts[0])
        elif section == "DEMAND_SECTION":
            dem_vec[counters[section]] = int(parts[0])
        else:
            raise ValueError(f"Data before any SECTION header: {raw!r}")
        counters[section] += 1

    task_idx = [f"Task_{i+1}" for i in range(T)]
    srv_idx  = [f"Server_{j+1}" for j in range(S)]
    result = {
        "meta": meta,
        "size": (T, S),
        "time": pd.DataFrame(time_mat, index=task_idx, columns=srv_idx),
        "reliability": pd.DataFrame(rel_mat, index=task_idx, columns=srv_idx),
        "capacity": pd.Series(cap_vec, index=srv_idx, name="Capacity"),
        "demand": pd.Series(dem_vec, index=task_idx, name="Demand"),
    }
    if counters["COST_SECTION"] > 0:
        result["cost"] = pd.DataFrame(cost_mat, index=task_idx, columns=srv_idx)
    else:
        result["alpha"] = pd.Series(alpha_vec, index=srv_idx, name="Alpha")
        result["beta"]  = pd.Series(beta_vec, index=srv_idx, name="Beta")
    return result

def _extract_assignment_indices(Xprime_val) -> Tuple[np.ndarray, np.ndarray]:
    mask = (Xprime_val.values[:, 2] >= 0.9)
    rows = Xprime_val.values[mask, 0].astype(int) - 1
    cols = Xprime_val.values[mask, 1].astype(int) - 1
    return rows, cols

def get_records_minlp(model) -> Dict[str, Any]:
    rows, cols = _extract_assignment_indices(model.Xprime_val)

    X_prime = np.zeros_like(model.rel, dtype=int)
    X_prime[rows, cols] = 1
    P   = np.prod(model.rel[rows, cols])

    reliability = model.W3 * P
    time = model.W1 * np.sum(model.time * X_prime)
    cost = model.W2 * np.sum(model.cost * X_prime)
    records = {
        "W3": model.W3,
        "P": P,
        "reliability": reliability,
        "time": time,
        "cost": cost,
        "assignment": [(r.item() + 1, c.item() + 1) for r, c in zip(rows, cols)],
        "objective": model.objective_value
    }
    return records

def get_records_milp(model, W3: float=None) -> Dict[str, Any]:
    rows, cols = _extract_assignment_indices(model.Xprime_val)

    X_prime = np.zeros_like(model.rel, dtype=int)
    X_prime[rows, cols] = 1
    P   = np.prod(model.rel[rows, cols])

    if W3 is None:
        W3 = model.W3

    reliability = W3 * P
    time = np.sum(model.time * X_prime)
    if not model.time_dependent_cost:
        cost = np.sum(model.cost * X_prime)
    else:
        cost =  (
            np.sum(model.alpha * model.time * X_prime) +
            np.sum(model.beta * X_prime.sum(axis=0)**2)
        )
    
    records = {
        "W1": model.W1.item(),
        "W2": model.W2.item(),
        "service time": time.item(),
        "service cost": cost.item(),
        "P": P,
        "MILP gap": model.rel_gap,
        "reliability": reliability,
        "time": model.W1 * time,
        "cost": model.W2 * cost,
        "assignment": [(r.item() + 1, c.item() + 1) for r, c in zip(rows, cols)],
        "MILP Objective": model.objective_value,
        "MINLP Objective": model.W1 * time + model.W2 * cost - reliability,
    }
    return records


def sanitize_name(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z_]", "_", s)

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Preview an .scp file")
    p.add_argument("file", help="path to .scp file")
    args = p.parse_args()

    data = read_scp(args.file)
    print("=== META ===")
    for k, v in data["meta"].items():
        print(f"{k:18}: {v}")
    print("\nShapes:")
    print("time       :", data['time'].shape)
    print("reliability:", data['reliability'].shape)
    if 'cost' in data:
        print("cost       :", data['cost'].shape)
    else:
        print("alpha      :", data['alpha'].shape)
        print("beta       :", data['beta'].shape)
    print("capacity   :", data['capacity'].shape)
    print("demand     :", data['demand'].shape)
