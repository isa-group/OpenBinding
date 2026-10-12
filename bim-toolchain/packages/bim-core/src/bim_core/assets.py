"""Access to the data files shipped inside the package.

Everything under ``bim_core/resources`` is reached through ``importlib.resources``;
no path is derived from ``__file__`` or from a repository layout.
"""

from __future__ import annotations

from contextlib import contextmanager
from importlib.resources import as_file, files
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Iterator

_PACKAGE = __package__ or "bim_core"
BPMN_SCHEMA_ENTRY = "BPMN20.xsd"


def package_root() -> Traversable:
    """The installed ``bim_core`` package."""
    return files(_PACKAGE)


def resource_root() -> Traversable:
    """The ``resources`` data directory of the package."""
    return package_root().joinpath("resources")


def schema_root() -> Traversable:
    """The directory with the BIM v1 JSON Schemas (``*.schema.json``)."""
    return resource_root().joinpath("schemas", "bim", "v1")


def read_schema(name: str) -> bytes:
    """The exact bytes of one BIM v1 schema, e.g. ``binding-problem.schema.json``."""
    return schema_root().joinpath(name).read_bytes()


def engine_contract_bytes() -> bytes:
    """The OpenAPI engine contract (``bim-engine/v1``)."""
    return resource_root().joinpath("schemas", "engine-contract.openapi.yaml").read_bytes()


def bpmn_vendor_root() -> Traversable:
    """The vendored OMG BPMN 2.0.2 XSD bundle."""
    return resource_root().joinpath("vendor", "omg", "bpmn", "2.0.2")


@contextmanager
def bpmn_schema_directory() -> Iterator[Path]:
    """The XSD bundle as a real directory, because ``xs:import`` needs sibling files."""
    with as_file(bpmn_vendor_root()) as directory:
        yield Path(directory)
