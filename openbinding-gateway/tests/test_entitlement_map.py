"""The entitlement map: the one place the ids of pricing 0.2.0 are spelled, and the package copy of the pricing.

``modules/plans/domain/entitlement_map.py`` names every feature and limit the gateway
reads; the startup check refuses a pricing that lacks one. The pricing the image checks
without SPACE is a byte copy of ``docs/pricing/openbinding-0.2.0.yml`` shipped as package
data (the image copies only ``src/``).
"""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path

import pytest
import yaml

from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT
from openbinding_gateway.modules.plans.domain import entitlement_map, quotas
from openbinding_gateway.space_client import OpenCaps, PlanCaps
from openbinding_gateway.space_client.open import package_pricing_document

SOURCE = GATEWAY_ROOT / "src" / "openbinding_gateway"
DOCS_YAML = REPO_ROOT / "docs" / "pricing" / "openbinding-0.2.0.yml"
PACKAGE_YAML = SOURCE / "modules" / "plans" / "pricing" / "openbinding-0.2.0.yml"
PUBLISHED_SHA256 = "4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1"
MAP = SOURCE / "modules" / "plans" / "domain" / "entitlement_map.py"


def published() -> dict:
    return yaml.safe_load(DOCS_YAML.read_bytes())


def test_the_published_pricing_declares_every_id_the_gateway_reads():
    assert entitlement_map.missing_ids(published()) == []


def test_the_package_copy_is_the_published_pricing_byte_for_byte():
    assert hashlib.sha256(DOCS_YAML.read_bytes()).hexdigest() == PUBLISHED_SHA256
    assert PACKAGE_YAML.read_bytes() == DOCS_YAML.read_bytes()
    # Read as the installed package reads it (importlib.resources), not by path.
    assert package_pricing_document().encode("utf-8") == DOCS_YAML.read_bytes()


def test_the_package_copy_ships_in_the_wheel():
    # Hatchling puts every file of the package directory in the wheel unless told otherwise.
    pyproject = (GATEWAY_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "[tool.hatch.build" not in pyproject or "openbinding-0.2.0.yml" in pyproject


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda d: d["features"].pop("runs"), ["feature runs"]),
        (lambda d: d["usageLimits"].pop("maxRunMinutes"), ["usageLimit maxRunMinutes"]),
        (lambda d: d["usageLimits"]["maxApiKeys"].update(valueType="BOOLEAN"), ["usageLimit maxApiKeys (valueType NUMERIC)"]),
        (lambda d: d.pop("usageLimits"), [f"usageLimit {name}" for name in entitlement_map.REQUIRED_LIMITS]),
    ],
    ids=["feature", "limit", "not-numeric", "no-limits"],
)
def test_a_missing_or_mistyped_id_is_named(mutate, expected):
    document = published()
    mutate(document)

    assert entitlement_map.missing_ids(document) == expected


def test_ids_the_gateway_does_not_enforce_are_not_required():
    document = published()
    for name in ("solverHours", "generatedInstances", "maxInstancesPerGeneration", "maxCollections", "maxPrivateProjects"):
        document["usageLimits"].pop(name)
    for name in ("generator", "collaboration"):
        document["features"].pop(name)

    assert entitlement_map.missing_ids(document) == []
    assert entitlement_map.missing_ids(None) == [
        *(f"feature {name}" for name in entitlement_map.REQUIRED_FEATURES),
        *(f"usageLimit {name}" for name in entitlement_map.REQUIRED_LIMITS),
    ]


def test_the_units_are_written_in_the_map():
    assert entitlement_map.run_minutes_to_ms(5) == 300_000
    assert entitlement_map.run_minutes_to_seconds(30) == 1800
    # MB is decimal: 500 MB is 500 000 000 bytes, not 500 MiB.
    assert entitlement_map.storage_mb_to_bytes(500) == 500_000_000


def test_the_open_gate_is_generated_from_the_map():
    caps = OpenCaps()

    assert set(caps.features) == set(entitlement_map.REQUIRED_FEATURES) and all(caps.features.values())
    assert set(caps.limits) == set(entitlement_map.REQUIRED_LIMITS)
    assert all(caps.limit(name) is None for name in entitlement_map.REQUIRED_LIMITS)


# -- The quotas -------------------------------------------------------------------


def plan(**limits) -> PlanCaps:
    return PlanCaps(plan="T", features={}, limits={k: float(v) for k, v in limits.items()})


def test_the_storage_quota_counts_megabytes_of_a_million_bytes():
    caps = plan(maxRepositoryStorage=500)

    assert quotas.storage_quota(499_999_999, 1, caps) is None
    refusal = quotas.storage_quota(499_999_999, 2, caps)
    assert (refusal.status, refusal.code) == (402, "quota_exceeded")
    assert refusal.extra["quota"]["limit_id"] == "maxRepositoryStorage"
    assert refusal.extra["quota"]["limit"] == 500
    assert quotas.storage_quota(10**15, 1, plan(maxRepositoryStorage=float("inf"))) is None
    # Undeclared is zero (fail closed): nothing may be stored.
    assert quotas.storage_quota(0, 1, plan()) is not None


def test_the_problems_quota_counts_the_next_problem():
    caps = plan(maxProblems=25)

    assert quotas.problems_quota(24, caps) is None
    refusal = quotas.problems_quota(25, caps)
    assert (refusal.status, refusal.code) == (402, "quota_exceeded")
    assert refusal.extra["quota"] == {
        "limit_id": "maxProblems", "limit": 25.0, "used": 25, "unit": "problem", "source": "plan",
    }
    assert quotas.problems_quota(10**6, plan(maxProblems=float("inf"))) is None


# -- No id is spelled outside the map ------------------------------------------------


def _string_ids(path: Path, root: Path = SOURCE) -> list[str]:
    """``file:line`` of every string literal passed as an entitlement id."""
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        name = function.attr if isinstance(function, ast.Attribute) else getattr(function, "id", None)
        if name in {"limit", "allows"}:
            arguments = node.args[:1]
        elif name in {"feature_refusal", "require_feature"}:
            arguments = node.args[1:2]
        else:
            continue
        if any(isinstance(argument, ast.Constant) and isinstance(argument.value, str) for argument in arguments):
            found.append(f"{path.relative_to(root)}:{node.lineno}")
    return found


def test_no_entitlement_id_is_a_string_literal_outside_the_map():
    offenders = [hit for path in sorted(SOURCE.rglob("*.py")) if path != MAP for hit in _string_ids(path)]

    assert not offenders, offenders


def test_the_scan_sees_a_spelled_id(tmp_path):
    planted = tmp_path / "planted.py"
    planted.write_text(
        'caps.limit("maxApiKeys")\nservice.feature_refusal(caps, "runs")\nquery.limit(1)\ncaps.limit(ids.MAX_API_KEYS)\n',
        encoding="utf-8",
    )

    assert _string_ids(planted, tmp_path) == ["planted.py:1", "planted.py:2"]
