"""Regression guard: production code must not become a second iPricing."""

import re
from pathlib import Path


def test_production_backend_contains_no_commercial_catalog_or_mapping() -> None:
    source_root = Path(__file__).resolve().parents[1] / "src"
    source = "\n".join(path.read_text() for path in source_root.rglob("*.py"))
    forbidden = (
        "custom.openbinding",
        "PLAN_CAPS",
        "PlanName",
        "ADD_ON_RULES",
        "COMPUTE_PACK",
        "COLLABORATION_PACK",
        "STORAGE_PACK",
        "FEDERATION_PACK",
        "CONCURRENCY_PACK",
        "REPRODUCIBILITY_ARCHIVE",
    )
    assert not [marker for marker in forbidden if marker in source]
    assert not re.search(r"['\"](?:BASIC|ADVANCED|PRO)['\"]", source)
