"""Docker Compose is the only deployment target (ADR-0021): no Kubernetes files remain.

Guards four things: no deploy/kubernetes directory, no kustomization file, no
Kubernetes manifest (top-level apiVersion and kind) and no kubectl or kustomize
in the CI workflows. .agentic/project.yaml is not scanned (owner-owned).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {"node_modules", ".venv", ".git"}
# Not deployment manifests: specs and docs describe or quote manifests, GitHub
# templates and workflows use other schemas.
MANIFEST_SKIP_DIRS = SKIP_DIRS | {"openspec", "docs", "lab", ".github"}
API_VERSION = re.compile(r"^apiVersion:", re.MULTILINE)
KIND = re.compile(r"^kind:", re.MULTILINE)
WORKFLOW_TOOLS = re.compile(r"\b(kubectl|kustomize)\b", re.IGNORECASE)


def _files(skip: set[str], suffixes: set[str] | None = None) -> list[Path]:
    found = []
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if skip & set(relative.parts) or not path.is_file():
            continue
        if suffixes is None or path.suffix in suffixes:
            found.append(path)
    return sorted(found)


def _is_kubernetes_manifest(text: str) -> bool:
    return bool(API_VERSION.search(text) and KIND.search(text))


def _manifest_files() -> list[str]:
    return [
        str(p.relative_to(ROOT))
        for p in _files(MANIFEST_SKIP_DIRS, {".yaml", ".yml"})
        if _is_kubernetes_manifest(p.read_text(encoding="utf-8", errors="replace"))
    ]


# [utest->req~lab-deployment-compose-only~1]
def test_no_deploy_kubernetes_directory() -> None:
    assert not (ROOT / "deploy" / "kubernetes").exists()


# [utest->req~lab-deployment-compose-only~1]
def test_no_kustomization_file() -> None:
    names = {"kustomization.yaml", "kustomization.yml"}
    found = [str(p.relative_to(ROOT)) for p in _files(SKIP_DIRS) if p.name in names]
    assert not found


# [utest->req~lab-deployment-compose-only~1]
def test_no_kubernetes_manifest() -> None:
    assert not _manifest_files()


# [utest->req~lab-deployment-compose-only~1]
def test_workflows_do_not_use_kubectl_or_kustomize() -> None:
    workflows = ROOT / ".github" / "workflows"
    offenders = [
        p.name
        for p in sorted(workflows.glob("*.yml"))
        if WORKFLOW_TOOLS.search(p.read_text(encoding="utf-8"))
    ]
    assert not offenders


# [utest->req~lab-deployment-compose-only~1]
def test_negative_control_manifest_is_detected() -> None:
    manifest = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: gateway\n"
    assert _is_kubernetes_manifest(manifest)
    assert not _is_kubernetes_manifest("services:\n  gateway:\n    image: x\n")
    assert not _is_kubernetes_manifest("  apiVersion: v1\n  kind: Pod\n")


# [utest->req~lab-deployment-compose-only~1]
def test_negative_control_workflow_tools_are_detected() -> None:
    assert WORKFLOW_TOOLS.search("run: kubectl apply -f x")
    assert WORKFLOW_TOOLS.search("run: kustomize build deploy")
    assert not WORKFLOW_TOOLS.search("run: docker compose config")
