"""compiler_bundle_digest() covers every .py file and all of resources/, in a stable order."""

import re
import shutil
from importlib.resources import files
from pathlib import Path

import pytest

import bim_core
from bim_core.toolchain import bundle_digest, bundle_members, compiler_bundle_digest


@pytest.fixture
def package_copy(tmp_path) -> Path:
    target = tmp_path / "bim_core"
    shutil.copytree(
        Path(str(files("bim_core"))), target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
    )
    return target


def installed_files(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def test_digest_has_the_sha256_form_and_is_stable() -> None:
    first = compiler_bundle_digest()
    assert re.fullmatch(r"sha256-[0-9a-f]{64}", first)
    assert first == compiler_bundle_digest() == bim_core.compiler_bundle_digest()


def test_members_are_every_python_file_and_all_resources(package_copy) -> None:
    members = bundle_members(package_copy)
    everything = installed_files(package_copy)
    expected = {name for name in everything if name.endswith(".py") or name.startswith("resources/")}
    assert set(members) == expected
    assert list(members) == sorted(members)
    for name in ("compiler.py", "package.py", "settings.py", "toolchain.py", "errors.py", "assets.py"):
        assert name in members
    assert "resources/vendor/omg/bpmn/2.0.2/BPMN20.xsd" in members
    assert "resources/schemas/bim/v1/binding-problem.schema.json" in members
    assert "resources/schemas/engine-contract.openapi.yaml" in members
    assert "py.typed" not in members


def test_a_copy_of_the_installed_package_has_the_same_digest(package_copy) -> None:
    assert bundle_digest(package_copy) == compiler_bundle_digest()
    assert bundle_digest(files("bim_core")) == compiler_bundle_digest()


def test_adding_a_python_file_changes_the_digest(package_copy) -> None:
    before = bundle_digest(package_copy)
    (package_copy / "extra.py").write_text("VALUE = 1\n", encoding="utf-8")
    after = bundle_digest(package_copy)
    assert after != before
    (package_copy / "extra.py").write_text("VALUE = 2\n", encoding="utf-8")
    assert bundle_digest(package_copy) != after


def test_adding_a_resource_file_changes_the_digest(package_copy) -> None:
    before = bundle_digest(package_copy)
    (package_copy / "resources" / "schemas" / "bim" / "v1" / "extra.schema.json").write_text("{}", encoding="utf-8")
    assert bundle_digest(package_copy) != before


def test_changing_one_byte_of_a_resource_changes_the_digest(package_copy) -> None:
    before = bundle_digest(package_copy)
    xsd = package_copy / "resources" / "vendor" / "omg" / "bpmn" / "2.0.2" / "DC.xsd"
    xsd.write_bytes(xsd.read_bytes() + b" ")
    assert bundle_digest(package_copy) != before


def test_renaming_a_file_changes_the_digest(package_copy) -> None:
    before = bundle_digest(package_copy)
    (package_copy / "settings.py").rename(package_copy / "settings2.py")
    assert bundle_digest(package_copy) != before


def test_bytecode_and_unrelated_files_do_not_change_the_digest(package_copy) -> None:
    before = bundle_digest(package_copy)
    (package_copy / "__pycache__").mkdir()
    (package_copy / "__pycache__" / "settings.cpython-312.pyc").write_bytes(b"\x00")
    (package_copy / "resources" / "__pycache__").mkdir()
    (package_copy / "resources" / "__pycache__" / "x.py").write_text("x = 1\n", encoding="utf-8")
    (package_copy / "notes.txt").write_text("not part of the toolchain\n", encoding="utf-8")
    assert bundle_digest(package_copy) == before
