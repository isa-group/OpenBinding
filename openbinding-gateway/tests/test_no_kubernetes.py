"""Docker Compose is the only deployment target (ADR-0021): no Kubernetes files remain.

Guards four things: no deploy/kubernetes directory, no kustomization file, no
Kubernetes manifest (top-level apiVersion and kind) and no kubectl or kustomize
in the CI workflows. The owner-owned project configuration is outside the workflow scan.

Every scan helper takes a root (default: the repository) so the tests can run
them against temporary trees and prove that each kind of offender is found.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from _repo import REPO_ROOT

ROOT = REPO_ROOT
SKIP_DIRS = {"node_modules", ".venv", ".git"}
# Not deployment manifests: specs and docs describe or quote manifests, GitHub
# templates and workflows use other schemas.
MANIFEST_SKIP_DIRS = SKIP_DIRS | {"openspec", "docs", "lab", ".github"}
KUSTOMIZATION_NAMES = {"kustomization.yaml", "kustomization.yml"}
WORKFLOW_SUFFIXES = {".yml", ".yaml"}
API_VERSION = re.compile(r"^apiVersion:", re.MULTILINE)
KIND = re.compile(r"^kind:", re.MULTILINE)
WORKFLOW_TOOLS = re.compile(r"\b(kubectl|kustomize)\b", re.IGNORECASE)


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _files(
    skip: set[str], suffixes: set[str] | None = None, root: Path = ROOT
) -> list[Path]:
    found = []
    # Unreadable directories are ignored (os.walk default) and skipped ones are not entered.
    for current, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip]
        for name in names:
            path = Path(current) / name
            if suffixes is not None and path.suffix not in suffixes:
                continue
            try:
                is_file = path.is_file()
            except OSError:
                continue
            if is_file:
                found.append(path)
    return sorted(found)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _is_kubernetes_manifest(text: str) -> bool:
    return bool(API_VERSION.search(text) and KIND.search(text))


def _kubernetes_directories(root: Path = ROOT) -> list[str]:
    path = root / "deploy" / "kubernetes"
    return [_rel(path, root)] if path.exists() else []


def _kustomization_files(root: Path = ROOT) -> list[str]:
    return [_rel(p, root) for p in _files(SKIP_DIRS, root=root) if p.name in KUSTOMIZATION_NAMES]


def _manifest_files(root: Path = ROOT) -> list[str]:
    return [
        _rel(p, root)
        for p in _files(MANIFEST_SKIP_DIRS, {".yaml", ".yml"}, root)
        if _is_kubernetes_manifest(_read(p))
    ]


def _workflow_files(root: Path = ROOT) -> list[Path]:
    workflows = root / ".github" / "workflows"
    return sorted(p for p in workflows.glob("*") if p.is_file() and p.suffix in WORKFLOW_SUFFIXES)


def _workflow_offenders(root: Path = ROOT) -> list[str]:
    return [
        _rel(p, root)
        for p in _workflow_files(root)
        if WORKFLOW_TOOLS.search(_read(p))
    ]


def _write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


DEPLOYMENT = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: gateway\n"


# [utest->req~lab-deployment-compose-only~1]
def test_no_deploy_kubernetes_directory() -> None:
    assert not _kubernetes_directories()


# [utest->req~lab-deployment-compose-only~1]
def test_no_kustomization_file() -> None:
    found = _kustomization_files()
    assert not found, f"kustomization files: {found}"


# [utest->req~lab-deployment-compose-only~1]
def test_no_kubernetes_manifest() -> None:
    found = _manifest_files()
    assert not found, f"Kubernetes manifests: {found}"


# [utest->req~lab-deployment-compose-only~1]
def test_workflows_do_not_use_kubectl_or_kustomize() -> None:
    assert (ROOT / ".github" / "workflows").is_dir()
    offenders = _workflow_offenders()
    assert not offenders, f"workflows using kubectl or kustomize: {offenders}"


# [utest->req~lab-deployment-compose-only~1]
def test_negative_control_manifest_is_detected() -> None:
    assert _is_kubernetes_manifest(DEPLOYMENT)
    assert not _is_kubernetes_manifest("services:\n  gateway:\n    image: x\n")
    assert not _is_kubernetes_manifest("  apiVersion: v1\n  kind: Pod\n")


# [utest->req~lab-deployment-compose-only~1]
def test_negative_control_workflow_tools_are_detected() -> None:
    assert WORKFLOW_TOOLS.search("run: kubectl apply -f x")
    assert WORKFLOW_TOOLS.search("run: kustomize build deploy")
    assert not WORKFLOW_TOOLS.search("run: docker compose config")


# [utest->req~lab-deployment-compose-only~1]
def test_real_scan_is_not_empty() -> None:
    scanned = {_rel(p, ROOT) for p in _files(MANIFEST_SKIP_DIRS, {".yaml", ".yml"})}
    assert "deploy/compose/production/compose.yaml" in scanned
    assert _workflow_files()


# [utest->req~lab-deployment-compose-only~1]
def test_scan_finds_deploy_kubernetes_directory(tmp_path: Path) -> None:
    assert _kubernetes_directories(tmp_path) == []
    _write(tmp_path, "deploy/kubernetes/base.txt", "x")
    assert _kubernetes_directories(tmp_path) == ["deploy/kubernetes"]


# [utest->req~lab-deployment-compose-only~1]
def test_scan_finds_kustomization_file(tmp_path: Path) -> None:
    assert _kustomization_files(tmp_path) == []
    _write(tmp_path, "deploy/kubernetes/kustomization.yaml", "resources: []\n")
    _write(tmp_path, "other/kustomization.yml", "resources: []\n")
    assert _kustomization_files(tmp_path) == [
        "deploy/kubernetes/kustomization.yaml",
        "other/kustomization.yml",
    ]


# [utest->req~lab-deployment-compose-only~1]
def test_scan_finds_manifest_under_ops_and_src(tmp_path: Path) -> None:
    _write(tmp_path, "ops/gateway.yaml", DEPLOYMENT)
    _write(tmp_path, "src/app/pod.yml", "apiVersion: v1\nkind: Pod\n")
    _write(tmp_path, "ops/compose.yaml", "services:\n  gateway:\n    image: x\n")
    assert _manifest_files(tmp_path) == ["ops/gateway.yaml", "src/app/pod.yml"]


# [utest->req~lab-deployment-compose-only~1]
def test_scan_skips_excluded_directories(tmp_path: Path) -> None:
    for skipped in ("node_modules", ".venv", "openspec", "docs", "lab", ".github"):
        _write(tmp_path, f"{skipped}/pkg/manifest.yaml", DEPLOYMENT)
    _write(tmp_path, "node_modules/kustomization.yaml", "resources: []\n")
    assert _manifest_files(tmp_path) == []
    assert _kustomization_files(tmp_path) == []
    # Only the manifest scan skips openspec, docs, lab and .github.
    _write(tmp_path, "docs/kustomization.yaml", "resources: []\n")
    assert _kustomization_files(tmp_path) == ["docs/kustomization.yaml"]


# [utest->req~lab-deployment-compose-only~1]
def test_scan_skips_unreadable_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path, "ops/ok.yaml", "services: {}\n")
    _write(tmp_path, "ops/stray.yaml", "services: {}\n")
    real_is_file = Path.is_file
    real_read_text = Path.read_text

    def is_file(self: Path) -> bool:
        if self.name == "stray.yaml":
            raise PermissionError(self.name)
        return real_is_file(self)

    monkeypatch.setattr(Path, "is_file", is_file)
    assert [p.name for p in _files(SKIP_DIRS, root=tmp_path)] == ["ok.yaml"]

    def read_text(self: Path, *args: object, **kwargs: object) -> str:
        if self.name == "ok.yaml":
            raise PermissionError(self.name)
        return real_read_text(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "read_text", read_text)
    assert _manifest_files(tmp_path) == []


# [utest->req~lab-deployment-compose-only~1]
def test_scan_finds_workflow_using_kubectl(tmp_path: Path) -> None:
    ok = "steps:\n  - run: docker compose config\n"
    bad = "steps:\n  - run: kubectl kustomize deploy/kubernetes\n"
    _write(tmp_path, ".github/workflows/ok.yml", ok)
    assert _workflow_offenders(tmp_path) == []
    _write(tmp_path, ".github/workflows/ci.yml", bad)
    _write(tmp_path, ".github/workflows/deploy.yaml", bad)
    assert _workflow_offenders(tmp_path) == [
        ".github/workflows/ci.yml",
        ".github/workflows/deploy.yaml",
    ]
