"""Locate repository fixtures in both a checkout and the gateway container."""

from __future__ import annotations

import os
from pathlib import Path


def repository_root() -> Path:
    configured = os.environ.get("OPENBINDING_REPO_ROOT")
    if configured:
        root = Path(configured).resolve()
        if (root / "schemas/bim/v1").is_dir():
            return root
        raise RuntimeError(f"OPENBINDING_REPO_ROOT is not an OpenBinding checkout: {root}")

    here = Path(__file__).resolve()
    for root in (here.parents[2], here.parents[1]):
        if (root / "schemas/bim/v1").is_dir() and (root / "examples").is_dir():
            return root
    raise RuntimeError("could not locate the OpenBinding repository fixtures")


REPO_ROOT = repository_root()
