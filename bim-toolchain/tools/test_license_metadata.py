"""The license of the code is CC-BY-4.0, declared once per distribution and once in ``licenses.json``, with an honest scope."""

from __future__ import annotations

import json
import re
import tomllib

import pytest

from packaging_support import PACKAGES, ROOT, package_dir, pyproject

NAMES = sorted(PACKAGES)
HOLDER = "javiercavlop (titular del repositorio OpenBinding)"
SPDX = "CC-BY-4.0"


@pytest.fixture(scope="module")
def licenses() -> dict:
    return json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_licenses_json_records_the_holder_the_spdx_identifier_and_the_scope(licenses: dict) -> None:
    assert licenses["schema"] == "bim-toolchain/licenses/1"
    assert licenses["holder"] == HOLDER
    assert "not recorded" in licenses["holder_note"] and "invented" in licenses["holder_note"]
    own = licenses["own_material"]
    assert own["spdx"] == SPDX and own["license_file"] == "LICENSE" and own["notice_file"] == "NOTICE.md"
    assert any(item.startswith("omg_bpmn_xsd") for item in own["does_not_cover"])
    assert any("third-party dependencies" in item for item in own["does_not_cover"])
    assert any(item.startswith("packages/*/src") for item in own["covers"])
    assert licenses["package_metadata"] == {
        "license_expression": SPDX, "license_files": ["NOTICE.md"], "classifier_kept": "Private :: Do Not Upload",
    }
    assert "not designed for software" in licenses["technical_note"] and "untouched" in licenses["technical_note"]
    names = [item["name"] for item in licenses["third_party"]]
    assert any("OMG BPMN" in name for name in names) and any("dependencies" in name for name in names)
    omg = next(item for item in licenses["third_party"] if "OMG BPMN" in item["name"])
    assert omg["license"] == "not demonstrated"


def test_the_spdx_identifier_is_declared_by_the_manifest_not_by_every_module(licenses: dict) -> None:
    """A comment in a module of bim_core would change compilerDigest (it covers every .py file) and the goldens."""
    assert "compilerDigest" in licenses["spdx_policy"]
    for name in NAMES:
        for path in (package_dir(name) / "src").rglob("*.py"):
            assert "SPDX-License-Identifier" not in path.read_text(encoding="utf-8"), path


@pytest.mark.parametrize("name", NAMES)
def test_every_distribution_declares_the_license_and_keeps_the_notice_and_the_private_classifier(name: str, licenses: dict) -> None:
    project = pyproject(name)["project"]
    assert project["license"] == SPDX == licenses["own_material"]["spdx"]
    assert project["license-files"] == ["NOTICE.md"]
    assert not any(item.startswith("License ::") for item in project["classifiers"])
    assert "Private :: Do Not Upload" in project["classifiers"]
    header = (package_dir(name) / "pyproject.toml").read_text(encoding="utf-8").split("[project]", 1)[0]
    assert "CC-BY-4.0" in header and HOLDER in header.replace("\n# ", " ")
    assert "pending" not in header


def test_the_root_pyproject_names_the_license() -> None:
    text = read("pyproject.toml")
    assert "CC-BY-4.0" in text and "pending" not in text.split("[tool.uv.workspace]", 1)[0]
    assert "project" not in tomllib.loads(text)


def test_the_notice_states_the_license_the_holder_the_scope_and_the_risk() -> None:
    notice = read("NOTICE.md")
    assert "## License of the code: CC-BY-4.0" in notice and "SPDX: `CC-BY-4.0`" in notice
    assert HOLDER in notice and "none has been inferred" in notice
    assert "same license as OpenBinding" in notice
    assert "https://creativecommons.org/licenses/by/4.0/" in notice
    assert "credit the holder, link the" in notice
    assert "does **not** cover" in notice and "not designed for software" in notice
    assert "rights not demonstrated" in notice and "No dataset is redistributed here" in notice
    assert "pending" not in notice.lower()
    for name in NAMES:
        assert (package_dir(name) / "NOTICE.md").read_bytes() == (ROOT / "NOTICE.md").read_bytes()


def test_the_license_file_is_the_text_of_cc_by_4_0() -> None:
    text = read("LICENSE")
    assert text.startswith("Attribution 4.0 International")
    assert "Creative Commons Attribution 4.0 International Public License" in text


def test_third_party_notices_keep_openbindings_text_and_add_the_scope_of_this_repository() -> None:
    text = read("THIRD_PARTY_NOTICES.md")
    assert text.startswith("# Third-party notices\n\n## Universidad de Sevilla mark")
    assert "OpenBinding source and documentation retain the license declared by this repository." in text
    head, _, additions = text.partition("## Additions of bim-toolchain")
    assert additions, "the additions of bim-toolchain are missing"
    assert "OMG BPMN 2.0.2 XML Schemas" in additions and "**not demonstrated**" in additions
    assert "Not vendored" in additions and "CC-BY-4.0" in additions
    assert head.rstrip().endswith("---")


def test_the_licensing_document_covers_attribution_scope_risk_and_the_decision() -> None:
    text = read("docs/LICENSING.md")
    flat = re.sub(r"\s+", " ", text)
    for needle in (
        "CC-BY-4.0", HOLDER, "Attribution", "Scope", "not designed for software", "patent", "OMG BPMN",
        "not demonstrated", "licenses.json", "decision of the holder", "THIRD_PARTY_NOTICES.md", "dependencies",
    ):
        assert needle in flat, needle


def test_the_documents_a_reader_starts_from_do_not_claim_that_the_license_is_pending() -> None:
    forbidden = ("license: pending", "license is pending", "licence is pending", "licence is undecided", "not been decided",
                 "license is undecided", "no `license` field", "licence pending", "license pending")
    for name in ("README.md", "NOTICE.md", "docs/PACKAGING.md", "docs/RELEASING.md", "docs/LICENSING.md"):
        text = read(name).lower()
        for phrase in forbidden:
            assert phrase not in text, f"{name} still says {phrase!r}"
    assert "CC-BY-4.0" in read("README.md") and "docs/LICENSING.md" in read("README.md")
