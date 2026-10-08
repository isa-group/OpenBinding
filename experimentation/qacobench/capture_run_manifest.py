#!/usr/bin/env python3
"""Record the source, image, input, parameter and host identities of a run."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    "experimentation/qacobench/design_matrix.json",
    "experimentation/qacobench/requirements.lock",
    "experimentation/qacobench/gateway.lock",
    "experimentation/qacobench/compose.yaml",
    "space/pricing/openbinding.yml",
    "datasets/07_qfbs/manifest.jsonl",
)
IMAGES = ("gateway", "runner", "minizinc", "random-search", "evolutionary-heuristics")
SOURCE_DIRS = ("openbinding-gateway/src", "schemas", "experimentation/qacobench")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_tree_sha256() -> str:
    digest = hashlib.sha256()
    for folder in SOURCE_DIRS:
        for path in sorted((ROOT / folder).rglob("*")):
            if (not path.is_file() or "__pycache__" in path.parts or "paper" in path.parts
                    or path.suffix == ".pyc"):
                continue
            relative = path.relative_to(ROOT).as_posix()
            digest.update(relative.encode("utf-8") + b"\0")
            digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts/qacobench/run_manifest.json")
    parser.add_argument("--images-json", type=Path, required=True)
    parser.add_argument("--host-text", type=Path, required=True)
    parser.add_argument("--revision-file", type=Path, required=True)
    args = parser.parse_args()
    inspected = json.loads(args.images_json.read_text(encoding="utf-8"))
    images = {}
    for name in IMAGES:
        details = next((item for item in inspected if item.get("RepoTags") and
                        any(tag.startswith(f"qacobench/{name}:") for tag in item["RepoTags"])), None)
        if details is None:
            raise RuntimeError(f"missing qacobench/{name} image inspection")
        images[name] = {"id": details["Id"], "repo_digests": details.get("RepoDigests", []),
                        "platform": details.get("Os") + "/" + details.get("Architecture")}
    memory_bytes = None
    try:
        memory_bytes = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, ValueError, OSError):
        pass
    revision = args.revision_file.read_text(encoding="utf-8").strip() or None
    payload = {
        "schema": "qacobench/run-manifest/v1",
        "source_revision": revision,
        "source_tree_sha256": source_tree_sha256(),
        "source_dirty": None,
        "files_sha256": {name: sha256(ROOT / name) for name in FILES if (ROOT / name).is_file()},
        "images": images,
        "host": {"host_report": args.host_text.read_text(encoding="utf-8"),
                 "container_platform": platform.platform(), "machine": platform.machine(),
                 "processor": platform.processor(), "cpu_count": os.cpu_count(), "memory_bytes": memory_bytes},
        "parameters": {"qfbs_design": "qacobench/qfbs-design/v2", "qfbs_packages": 5200,
                       "qfbs_groups": {"guaranteed": 2600, "non_guaranteed": 2600}, "corpus_packages": 15450,
                       "engine_runs": 46350, "timeout_ms": 5000, "campaign_seed": 20260921,
                       "qfbs_base_seed": 20261004,
                       "engines": ["minizinc-csp", "random-search", "evolutionary-heuristics"]},
        "reproducibility": {"exact": ["HTTP package bytes", "compiled semantics", "derived calculations"],
                            "time_sensitive": ["engine termination at the time budget", "runtime measurements"]},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
