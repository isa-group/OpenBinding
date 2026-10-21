"""The schemas the platform serves to engines, docs and the frontend are the toolchain's, byte for byte.

``schemas/bim/v1/*.schema.json`` and ``schemas/engine-contract.openapi.yaml`` stay in the repository (the Java
engines, the documentation and the frontend read them), but the language they describe lives in
``bim-core``, whose copies are the ones that validate documents. Two copies of a contract drift unless
something compares them: this does. The Engine manifests under ``schemas/bim/v1/manifests`` are the
platform's own catalog and have no counterpart.
"""

from __future__ import annotations

from importlib import resources

import pytest

from _repo import REPO_ROOT

SCHEMAS = REPO_ROOT / "schemas"
SCHEMA_FILES = sorted(path.name for path in (SCHEMAS / "bim" / "v1").glob("*.schema.json"))
TOOLCHAIN = resources.files("bim_core").joinpath("resources", "schemas")


def toolchain_schemas() -> list[str]:
    return sorted(
        item.name for item in TOOLCHAIN.joinpath("bim", "v1").iterdir() if item.name.endswith(".schema.json")
    )


def test_both_sides_have_the_same_schemas() -> None:
    assert SCHEMA_FILES
    assert SCHEMA_FILES == toolchain_schemas()


@pytest.mark.parametrize("name", SCHEMA_FILES)
def test_a_platform_schema_is_byte_identical_to_the_toolchains(name: str) -> None:
    served = (SCHEMAS / "bim" / "v1" / name).read_bytes()

    assert served == TOOLCHAIN.joinpath("bim", "v1", name).read_bytes()


def test_the_engine_protocol_is_byte_identical_to_the_toolchains() -> None:
    served = (SCHEMAS / "engine-contract.openapi.yaml").read_bytes()

    assert served == TOOLCHAIN.joinpath("engine-contract.openapi.yaml").read_bytes()


def test_the_manifests_are_the_platforms_catalog_and_the_toolchain_has_none() -> None:
    assert list((SCHEMAS / "bim" / "v1" / "manifests").glob("*.json"))
    assert not TOOLCHAIN.joinpath("bim", "v1", "manifests").is_dir()
