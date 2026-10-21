"""Shared paths, names and constants for the QACOBench secondary analyses.

The checkout root is taken from $QACOBENCH_ROOT or discovered by walking up from this file
until a directory containing both ``datasets/`` and ``openbinding-gateway/`` is found.
"""
from __future__ import annotations

import os
from pathlib import Path


def discover_root() -> Path:
    env = os.environ.get("QACOBENCH_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for candidate in (here.parent, *here.parents):
        if (candidate / "datasets").is_dir() and (candidate / "openbinding-gateway").is_dir():
            return candidate
    raise RuntimeError("set QACOBENCH_ROOT or run from inside the OpenBinding checkout")


ROOT = discover_root()
RESULTS = Path(os.environ.get("QACOBENCH_RESULTS", ROOT / ".artifacts/qacobench/results.jsonl"))
DATASETS = Path(os.environ.get("QACOBENCH_DATASETS", ROOT / "datasets"))
QFBS_DIR = DATASETS / "07_qfbs"
QFBS_MANIFEST = QFBS_DIR / "manifest.jsonl"
HSC_DIR = DATASETS / "03_hsc_llm"
HSC_SOURCE = DATASETS / "sources/hsc"
MZN_MODEL = ROOT / "engines/minizinc-csp/model/binding_problem.mzn"
OUT = Path(os.environ.get("QACOBENCH_SECONDARY_OUT", ROOT / ".artifacts/qacobench/secondary"))
OUT.mkdir(parents=True, exist_ok=True)

# Engine short names and the paper's suite names (kept in sync with experimentation/qacobench/_common.py).
ENGINES = {"minizinc-csp": "MZN", "evolutionary-heuristics": "GA", "random-search": "RS"}
ENGINE_LABELS = {"MZN": "MiniZinc CSP", "GA": "Elitist GA", "RS": "Random search"}
SUITE_NAMES = {
    "01_icws": "OpenBinding scenarios",
    "02_quantum": "Quantum",
    "03_hsc_llm": "HSC",
    "04_rprsr15": "RPRSR15",
    "05_iots": "IoTS",
    "06_bws_scp": "BWS-SCP",
    "07_qfbs": "QFBS",
}
SUITE_ORDER = list(SUITE_NAMES)
# Score tolerance: two bindings with scores closer than this are considered equal.
TOL = 1e-9
# QFBS design factors (design_matrix.json column order) and their level names.
FACTORS = ["structure", "candidate_distribution", "qos_distribution", "constraint_count_mode",
           "aggregation", "size", "constraint_setting", "constraint_count", "objective_count"]
LEVELS = {
    "structure": ["sequence", "parallel", "xor", "repeat", "parallel_xor", "parallel_repeat", "xor_repeat", "mixed"],
    "candidate_distribution": ["fixed_5", "uniform_3_8", "normal_3_8"],
    "qos_distribution": ["uniform", "normal", "mixed"],
    "constraint_count_mode": ["exact", "expected"],
    "aggregation": ["default", "cost_max", "latency_max"],
    "size": ["12", "24", "48"],
    "constraint_setting": ["0", "1"],
    "constraint_count": ["1", "3", "5"],
    "objective_count": ["1", "3", "5"],
}
FACTOR_LABELS = {
    "structure": "Workflow structure", "candidate_distribution": "Candidates per task", "qos_distribution": "QoS value distribution",
    "constraint_count_mode": "Constraint count mode", "aggregation": "Aggregation policy", "size": "Tasks",
    "constraint_setting": "Constraint setting", "constraint_count": "Constraints", "objective_count": "Objectives",
}
