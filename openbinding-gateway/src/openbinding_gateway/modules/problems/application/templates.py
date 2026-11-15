"""Templates: the example packages under ``examples/`` that the Workbench starts a new problem from.

Read only and anonymous. A template is a directory holding a ``bim/v1`` Instance; it is served as a
``.bim.zip`` the toolchain has read, never a path outside ``examples/``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

from bim_core import PackageError

from ....integrations import bim, packages
from ....services.engines import MANIFEST_DIR


class TemplateProblem(Exception):
    """A refusal the HTTP layer renders as ``application/problem+json``."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


class TemplatePackage(NamedTuple):
    """A template directory as a ``.bim.zip`` the toolchain has read."""

    archive: bytes
    name: str


def examples_root() -> Path:
    """``examples/`` of the repository, or of the image (``openbinding-gateway/Dockerfile`` copies it)."""
    return MANIFEST_DIR.parents[3] / "examples"


def template_paths() -> list[str]:
    """The directories under ``examples/`` that hold a ``bim/v1`` Instance."""
    root = examples_root()
    paths = []
    for path in root.rglob("instance.json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(document, dict) and document.get("apiVersion") == "bim/v1" and document.get("kind") == "Instance":
            paths.append(path.parent.relative_to(root).as_posix())
    paths.sort()
    return paths


async def template_package(template_path: str) -> TemplatePackage:
    """One template as a package; never a path outside ``examples/`` (404)."""
    root = examples_root().resolve()
    requested = (root / template_path).resolve()
    try:
        requested.relative_to(root)
    except ValueError as exc:
        raise TemplateProblem(404, "not_found", "Template not found") from exc
    if requested.name == "instance.json":
        requested = requested.parent
    if not requested.is_dir() or not (requested / "instance.json").is_file():
        raise TemplateProblem(404, "not_found", "Template not found")
    archive = packages.zip_directory(requested)
    try:
        # The toolchain reads the archive (without keeping anything): a template it cannot load is refused.
        await bim.abim().validate(archive)
    except PackageError as exc:
        raise TemplateProblem(422, "invalid_template", str(exc)) from exc
    return TemplatePackage(archive, requested.name.replace('"', "") or "template")
