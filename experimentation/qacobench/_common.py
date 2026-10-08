from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any, Mapping


SUITES = {
    "01_icws": {"name": "ICWS", "count": 48},
    "02_quantum": {"name": "Quantum service composition", "count": 46},
    "03_hsc_llm": {"name": "HSC-LLM", "count": 10_000},
    "04_rprsr15": {"name": "RPRSR15", "count": 60},
    "05_iots": {"name": "IoTS", "count": 6},
    "06_bws_scp": {"name": "BWS-SCP", "count": 90},
    "07_qfbs": {"name": "QFBS", "count": 5_200},
}
ACTIVE_SUITES = tuple(SUITES)
EXPECTED_SUITE_COUNTS = {key: value["count"] for key, value in SUITES.items()}
EXPECTED_TOTAL = sum(EXPECTED_SUITE_COUNTS.values())

ENGINE_MODES = {
    "minizinc-csp": "exact-weighted",
    "random-search": "seeded",
    "evolutionary-heuristics": "elitist-genetic",
}
DEFAULT_ENGINES = tuple(ENGINE_MODES)
HEURISTIC_ENGINES = frozenset({"random-search", "evolutionary-heuristics"})


def discover_project_root(start: Path | None = None) -> Path:
    origins = [start.resolve()] if start else []
    origins.extend((Path(__file__).resolve(), Path.cwd().resolve()))
    for origin in origins:
        base = origin if origin.is_dir() else origin.parent
        for candidate in (base, *base.parents):
            if (candidate / "openbinding-gateway/src/openbinding_gateway").is_dir() and (candidate / "datasets").is_dir():
                return candidate
    raise RuntimeError("Cannot locate a checkout containing openbinding-gateway/ and datasets/")


def install_gateway_import(root: Path) -> None:
    source = str(root / "openbinding-gateway/src")
    if source not in sys.path:
        sys.path.insert(0, source)


def stable_instance_seed(base_seed: int, suite: str, instance_id: str, engine: str) -> int:
    value = f"{int(base_seed)}\0{suite}\0{instance_id}\0{engine}".encode()
    return int.from_bytes(hashlib.sha256(value).digest()[:4], "big") % 2_147_483_647


def package_json_file_hashes(package_dir: Path) -> dict[str, str]:
    return {
        item.name: hashlib.sha256(item.read_bytes()).hexdigest()
        for item in sorted(package_dir.iterdir())
        if item.is_file() and item.name != "benchmark-metadata.json"
    }


def package_digest_from_dir(package_dir: Path) -> str:
    digest = hashlib.sha256()
    for name, value in package_json_file_hashes(package_dir).items():
        digest.update(f"{name}\0{value}\n".encode())
    return digest.hexdigest()


def optimization_spec(package: Any) -> dict[str, Any]:
    try:
        return dict(package.json("optimization.json").get("spec", {}))
    except Exception:
        return {}


def criteria_from_optimization(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
    if isinstance(spec.get("criteria"), list):
        return [dict(item) for item in spec["criteria"] if isinstance(item, Mapping)]
    result = []
    for index, term in enumerate(spec.get("terms", [])):
        if not isinstance(term, Mapping):
            continue
        feature = term.get("feature")
        feature_id = feature.get("id") if isinstance(feature, Mapping) else None
        result.append({
            "id": term.get("id") or feature_id or f"criterion_{index + 1}",
            "feature": feature,
            "direction": term.get("direction", "minimize"),
            "weight": term.get("weight", 1.0),
        })
    return result


def package_execution_spec(package: Any) -> dict[str, Any]:
    spec = optimization_spec(package)
    criteria = criteria_from_optimization(spec)
    annotations = package.json("instance.json").get("metadata", {}).get("annotations", {})
    declared = annotations.get("objective_weights", {})
    raw = [max(0.0, float(declared.get(item["id"], 1.0))) for item in criteria]
    total = sum(raw) or float(len(raw) or 1)
    return {
        "type": "SINGLE",
        "scalarization": "weighted-sum",
        "weights": [{"criteria": item["id"], "value": weight / total} for item, weight in zip(criteria, raw)],
    }
