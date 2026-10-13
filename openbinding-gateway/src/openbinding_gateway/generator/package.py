"""The files of a package the generator produced, and the calls it makes to the BIM toolchain.

The generator writes documents; whether they form a valid BIM package, and everything that follows
from it (the IR, the digests), is the toolchain's to say (``integrations.bim``). A
``GeneratedPackage`` is only the virtual filesystem the generator works on.
"""

from __future__ import annotations

from typing import Any, Mapping

from bim_core import PackageError

from ..core.jsonio import strict_json_loads
from ..integrations import bim, packages

#: Bindings sent to the toolchain in one evaluation request (a service accepts at most 1000).
_EVALUATION_BATCH = 500


class GeneratedPackage:
    """An in-memory package: file name to bytes."""

    def __init__(self, files: Mapping[str, bytes]) -> None:
        self.files: dict[str, bytes] = dict(files)

    def json(self, path: str) -> dict[str, Any]:
        try:
            value = strict_json_loads(self.files[path])
        except KeyError as exc:
            raise PackageError(f"resource is not present: {path}") from exc
        if not isinstance(value, dict):
            raise PackageError(f"resource must be a JSON object: {path}")
        return value

    def instance(self) -> dict[str, Any]:
        return self.json("instance.json")

    def to_zip(self) -> bytes:
        return packages.zip_files(self.files)


def compile_generated(package: GeneratedPackage) -> dict[str, Any]:
    """Compile ``package`` with the toolchain (synchronously: the generator is synchronous code)."""
    return bim.get_bim().compile(package.to_zip())


def evaluate_features(ir: Mapping[str, Any], bindings: list[Mapping[str, Any]]) -> list[dict[str, float]]:
    """The value of every feature under each binding, in order."""
    values: list[dict[str, float]] = []
    for start in range(0, len(bindings), _EVALUATION_BATCH):
        outcomes = bim.get_bim().evaluate_many(ir, bindings[start:start + _EVALUATION_BATCH])
        values.extend(outcome["evaluation"]["features"] for outcome in outcomes)
    return values
