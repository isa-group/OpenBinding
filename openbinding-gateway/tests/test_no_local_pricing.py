"""Static guard: OpenBinding keeps no operative pricing of its own.

SPACE and SPHERE are the source of truth for pricings, versions, plans and
contracts, and are administered in their native consoles. This repository holds
no operative pricing, no control plane for one, and no renewal or deployment
machinery. The third-party FaaS pricings that BIM *analyses* (``pricings/aws``,
``pricings/azure``, ``pricings/gcloud``) are domain inputs and must stay.

The retired names below are assembled from parts on purpose: the retirement is
checked with a repository-wide search for them, and a literal in this file would
be the one hit that search finds.
"""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path

import pytest

from _repo import REPO_ROOT

GATEWAY = REPO_ROOT / "openbinding-gateway"
SRC = GATEWAY / "src"

RETIRED_NAMES = (
    "Pricing" + "Release",
    "Space" + "DeploymentClient",
    "pricing" + "_bootstrap",
    "reconcile" + "_pricing",
    "reconcile_contract" + "_renewal",
    "sweep_contract" + "_renewals",
    "archive_drained" + "_pricings",
    "SPACE_DESTRUCTIVE" + "_API_KEY",
    "space_destructive" + "_api_key",
    "LOCAL" + "_PRICING",
    "migrate_due" + "_contract",
    "space/pricing" + "/openbinding",
)

#: Files that configure or build the stacks (compose, images, environment, manifests).
INFRASTRUCTURE = (
    REPO_ROOT / "docker-compose.yml",
    REPO_ROOT / ".dockerignore",
    REPO_ROOT / ".env.example",
    GATEWAY / "Dockerfile",
    GATEWAY / ".env.example",
    REPO_ROOT / "tools" / "generate_changelog.py",
)

#: The third-party FaaS pricing inputs of the BIM analysis, which this change leaves alone.
FAAS_INPUTS = (
    "pricings/aws/aws_lambda_pricing.yml",
    "pricings/aws/generate_lambda_variables.py",
    "pricings/aws/lambda_variables.yml",
    "pricings/azure/azure_functions_pricing.yml",
    "pricings/azure/azure_functions_variables.yml",
    "pricings/azure/generate_azure_functions_variables.py",
    "pricings/gcloud/generate_google_cloud_functions_variables.py",
    "pricings/gcloud/google_cloud_functions_pricing.yml",
    "pricings/gcloud/google_cloud_functions_variables.yml",
)


def _files(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix in suffixes and "__pycache__" not in path.parts
    )


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def test_the_local_operative_pricing_is_gone():
    assert not (REPO_ROOT / "space" / "pricing" / "openbinding.yml").exists()
    space = REPO_ROOT / "space"
    assert not space.exists() or not [path for path in space.rglob("*") if path.is_file()]


def test_no_source_file_references_the_retired_pricing_directory():
    offenders = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in _files(SRC, (".py",))
        if "space/pricing" in _text(path)
    ]
    assert offenders == []


@pytest.mark.parametrize("name", RETIRED_NAMES)
def test_retired_names_do_not_appear_in_source(name):
    offenders = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in _files(SRC, (".py",))
        if name in _text(path)
    ]
    assert offenders == []


@pytest.mark.parametrize("name", RETIRED_NAMES)
def test_retired_names_do_not_appear_in_infrastructure(name):
    paths = [path for path in INFRASTRUCTURE if path.is_file()]
    paths += _files(REPO_ROOT / "experimentation" / "qacobench", (".py", ".yaml", ".yml", ".md", ".sh"))
    paths += [
        path for path in (REPO_ROOT / "deploy").rglob("*") if path.is_file()
    ] if (REPO_ROOT / "deploy").is_dir() else []
    offenders = [path.relative_to(REPO_ROOT).as_posix() for path in paths if name in _text(path)]
    assert offenders == []


def test_the_retired_modules_cannot_be_imported():
    for module in (
        "pricing" + "_bootstrap",
        "space_client." + "deployments",
    ):
        path = SRC / "openbinding_gateway" / (module.replace(".", "/") + ".py")
        assert not path.exists(), path


def test_the_fake_gate_exists_only_in_the_test_suite():
    defining = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in _files(SRC, (".py",))
        if "class Fake" + "PricingGate" in _text(path)
    ]
    assert defining == []
    assert "class Fake" + "PricingGate" in _text(Path(__file__).parent / "_fake_space.py")


def test_the_pricing_release_table_is_not_modelled_any_more():
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.db import models

    assert "pricing_releases" not in Base.metadata.tables
    assert not hasattr(models, "Pricing" + "Release")


def test_the_third_party_faas_pricings_are_still_present():
    present = sorted(
        path.relative_to(REPO_ROOT).as_posix()
        for provider in ("aws", "azure", "gcloud")
        for path in (REPO_ROOT / "pricings" / provider).rglob("*")
        if path.is_file()
    )
    # The hash of their existence: the exact set of files, not just "some".
    expected = sorted(FAAS_INPUTS)
    assert hashlib.sha256("\n".join(present).encode()).hexdigest() == hashlib.sha256(
        "\n".join(expected).encode()
    ).hexdigest(), present
    for relative in expected:
        assert (REPO_ROOT / relative).stat().st_size > 0, relative


def test_the_bootstrap_module_neither_reads_nor_writes_pricings():
    source = _text(SRC / "openbinding_gateway" / "db" / "bootstrap.py")
    tree = ast.parse(source)
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    } | {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert not [name for name in imported if "pricing" in name.lower() or "yaml" in name.lower()]
    calls = {
        node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
    }
    assert not calls & {"open", "write_text", "write_bytes", "read_text", "read_bytes", "safe_load"}
    assert "pricings" not in source.replace("Pricings", "")


def _tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


async def test_running_the_bootstrap_leaves_every_pricing_file_untouched(db_session):
    from openbinding_gateway.core.settings import Settings
    from openbinding_gateway.db.bootstrap import ensure_administrator, seed_default_administrator

    before = (_tree_hash(REPO_ROOT / "pricings"), _tree_hash(REPO_ROOT / "space") if (REPO_ROOT / "space").is_dir() else "")

    await seed_default_administrator(
        db_session,
        Settings(_env_file=None, seed_default_admin=True, bootstrap_admin_password="a-long-enough-one"),
    )
    await ensure_administrator(
        db_session,
        Settings(_env_file=None, bootstrap_admin_username="alice", bootstrap_admin_password="a-long-enough-one"),
    )

    after = (_tree_hash(REPO_ROOT / "pricings"), _tree_hash(REPO_ROOT / "space") if (REPO_ROOT / "space").is_dir() else "")
    assert after == before
