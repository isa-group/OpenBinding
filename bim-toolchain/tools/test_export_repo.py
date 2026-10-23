"""``tools/export_repo.py``, in temporary directories: one commit with the identity of whoever runs it, no history, remote,
tag or push; the checks that refuse an export (secrets, licenses, foreign files, references outside the repository); the
OMG XSD files, which the repository never carries (a tree that versions them is refused, the self-containment run downloads
them into its copy with the SHA-256 checked, the network replaced by an injected opener); and, once, the whole export of
this very tree with the suite run on the result."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path, PurePosixPath

import pytest

import export_repo
import xsd_inventory
from packaging_support import ROOT

VENDOR = "packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2"
XSD_FILES = ["BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "Semantic.xsd"]
NOTICE = "# Notice\n\nCC-BY-4.0\n"
WORKFLOW = """\
name: ci
on: [push]
jobs:
  one:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # PIN-PENDING
      - run: python3 tools/xsd_inventory.py --ensure
      - run: echo one
"""
IDENTITY = ("Export Tester", "export.tester@example.org")


LICENSE_TEXT = "Attribution 4.0 International\n\n(text)\n"
PACKAGE_PYPROJECT = (
    '[project]\nname = "{name}"\nlicense = "CC-BY-4.0"\nlicense-files = ["LICENSE", "NOTICE.md"]\n'
    'classifiers = ["Private :: Do Not Upload"]\n'
)


@pytest.fixture(autouse=True)
def tmp_trees_are_not_inside_a_checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The trees below are made in a temporary directory; Git must not find a repository above it."""
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))


def base_licenses() -> dict:
    """``licenses.json`` of a tree that does not carry the files and has not cleared them, whatever this repository's state is."""
    document = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))
    document["omg_bpmn_xsd"].update(
        present_in_tree=False, cleared=False, status="not-demonstrated", cleared_by=None, cleared_on=None, evidence=None
    )
    return document


def licenses_bytes(document: dict) -> bytes:
    return (json.dumps(document, indent=2) + "\n").encode("utf-8")


def rights_document() -> str:
    """The rights document of a tree that does not carry the files: only the generated table, which lists the digests."""
    block = xsd_inventory.current_block((ROOT / "docs" / "OMG_XSD_RIGHTS.md").read_text(encoding="utf-8"))
    assert block is not None
    return f"# Rights\n\n{block}\n"


def served_from_this_tree() -> dict[str, bytes]:
    """What omg.org serves, taken from the files of this tree (the tests of the download never use the network)."""
    return {f"https://www.omg.org/spec/BPMN/20100501/{name}": (ROOT / VENDOR / name).read_bytes() for name in XSD_FILES}


def git(cwd: Path, *arguments: str) -> str:
    result = subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout


def mini_files() -> dict[str, bytes]:
    files = {
        "README.md": "# mini bim-toolchain\nSee [the notice](NOTICE.md) and [a package](packages/pkg-a/README.md).\n",
        "LICENSE": LICENSE_TEXT,
        "NOTICE.md": NOTICE,
        "THIRD_PARTY_NOTICES.md": "# Third-party notices\n",
        "docs/LICENSING.md": "# Licensing\n",
        "docs/OMG_XSD_RIGHTS.md": rights_document(),
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/pkg-a"]\n',
        "tools/helper.py": "VALUE = 1\n",
        "packages/pkg-a/NOTICE.md": NOTICE,
        "packages/pkg-a/LICENSE": LICENSE_TEXT,
        "packages/pkg-a/README.md": "pkg a\n",
        "packages/pkg-a/pyproject.toml": PACKAGE_PYPROJECT.format(name="pkg-a"),
        "packages/pkg-a/src/pkg_a/__init__.py": "",
        # the OMG files go in packages/bim-core, which therefore is a package of the tree like pkg-a
        "packages/bim-core/NOTICE.md": NOTICE,
        "packages/bim-core/LICENSE": LICENSE_TEXT,
        "packages/bim-core/README.md": "core\n",
        "packages/bim-core/pyproject.toml": PACKAGE_PYPROJECT.format(name="bim-core"),
        ".github/workflows/ci.yml": WORKFLOW,
        ".gitignore": f"dist/\n/{VENDOR}/*.xsd\n",
        ".extraction-bootstrap": "marker\n",
        "licenses.json": licenses_bytes(base_licenses()),
        f"{VENDOR}/README.md": "# vendored\n",
    }
    return {name: data.encode("utf-8") if isinstance(data, str) else data for name, data in files.items()}


def write_files(base: Path, files: dict[str, bytes]) -> None:
    for name, data in files.items():
        path = base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def commit_all(clone: Path, message: str = "state") -> str:
    git(clone, "add", "-A", "--force")
    git(clone, "commit", "-q", "-m", message)
    return git(clone, "rev-parse", "HEAD").strip()


def make_clone(tmp_path: Path, extra: dict[str, bytes] | None = None, *, identity: bool = True) -> Path:
    """A stand-in for a clone of OpenBinding: the mini ``bim-toolchain/``, other directories that must not travel, one commit."""
    clone = tmp_path / "openbinding"
    clone.mkdir()
    git(clone, "init", "-q")
    if identity:
        git(clone, "config", "user.name", IDENTITY[0])
        git(clone, "config", "user.email", IDENTITY[1])
    write_files(clone / "bim-toolchain", {**mini_files(), **(extra or {})})
    write_files(clone, {"README.md": b"OPENBINDING ROOT\n", "openbinding-gateway/config.env": b"A=1\n", "frontend/x.txt": b"x\n"})
    git(clone, "add", "-A", "--force")
    git(clone, "-c", f"user.name={IDENTITY[0]}", "-c", f"user.email={IDENTITY[1]}", "commit", "-q", "-m", "state")
    return clone


def export(tmp_path: Path, clone: Path, *extra: str, capsys: pytest.CaptureFixture[str]) -> tuple[int, dict, str]:
    output = tmp_path / "exported"
    code = export_repo.main(
        ["--output", str(output), "--source", str(clone), "--skip-self-test", *extra], opener=served_from_this_tree().__getitem__
    )
    captured = capsys.readouterr()
    summary = json.loads(captured.out) if code == 0 else {}
    return code, summary, captured.err


def tracked(repository: Path) -> list[str]:
    return sorted(item for item in git(repository, "ls-files", "-z").split("\0") if item)


# --- one commit, the identity, nothing else ------------------------------------------------------------------


def test_the_export_is_one_commit_by_whoever_runs_it_with_a_neutral_message(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    head = git(clone, "rev-parse", "HEAD").strip()
    code, summary, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    out = tmp_path / "exported"
    assert git(out, "rev-list", "--count", "HEAD").strip() == "1"
    assert git(out, "log", "-1", "--format=%an|%ae|%cn|%ce").strip() == "|".join([*IDENTITY, *IDENTITY])
    message = git(out, "log", "-1", "--format=%B")
    assert message.splitlines()[0] == f"Import bim-toolchain from OpenBinding at {head}"
    assert head in message and summary["sourceCommit"] == head and summary["commit"] == git(out, "rev-parse", "HEAD").strip()
    assert not any(word in message.lower() for word in ("co-authored-by", "claude", "anthropic", "generated with", "assistant"))
    assert git(out, "remote", "-v").strip() == "" and git(out, "tag").strip() == ""
    assert git(out, "branch", "--show-current").strip() == "main"
    assert git(out, "status", "--porcelain").strip() == ""


def test_the_exported_repository_has_bim_toolchain_at_its_root_and_nothing_of_openbinding(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    code, summary, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    out = tmp_path / "exported"
    names = tracked(out)
    assert "pyproject.toml" in names and "packages/pkg-a/pyproject.toml" in names and "tools/helper.py" in names
    assert not any(name.startswith(("openbinding-gateway", "frontend", "bim-toolchain")) for name in names)
    assert ".extraction-bootstrap" not in names and ".extraction-bootstrap" in summary["leftOut"]
    assert (out / "README.md").read_text(encoding="utf-8").startswith("# mini bim-toolchain")
    assert summary["files"] == len(names)
    assert summary["selfTest"] == "skipped"


def test_only_the_committed_contents_are_exported(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    (clone / "bim-toolchain" / "tools" / "helper.py").write_text("VALUE = 2\n", encoding="utf-8")
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and "uncommitted changes" in errors and not (tmp_path / "exported").exists()
    code, _, errors = export(tmp_path, clone, "--allow-dirty", capsys=capsys)
    assert code == 0, errors
    assert (tmp_path / "exported" / "tools" / "helper.py").read_text(encoding="utf-8") == "VALUE = 1\n"


def test_an_untracked_file_does_not_travel(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    (clone / "bim-toolchain" / "notes.txt").write_text("private\n", encoding="utf-8")
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    assert not (tmp_path / "exported" / "notes.txt").exists()


def test_the_output_must_be_absent_or_empty(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    (tmp_path / "exported").mkdir()
    (tmp_path / "exported" / "keep.txt").write_text("mine\n", encoding="utf-8")
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and "not empty" in errors
    assert (tmp_path / "exported" / "keep.txt").read_text(encoding="utf-8") == "mine\n"


def test_without_a_configured_identity_nothing_is_made(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    clone = make_clone(tmp_path, identity=False)
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and "git user.name and user.email are not configured" in errors
    assert not (tmp_path / "exported").exists()


# --- what never travels ---------------------------------------------------------------------------------------


def test_configuration_credentials_logs_and_datasets_are_left_out(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    extra = {
        ".env": b"A=1\n", "logs/run.log": b"x\n", "datasets/a.csv": b"1,2\n", "deploy/server.pem": b"x\n",
        "packages/pkg-a/tests/fixtures/manifests/.copied": b"", "dist/x.txt": b"x\n", "notes/run.log": b"x\n",
    }
    clone = make_clone(tmp_path, extra)
    code, summary, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    names = tracked(tmp_path / "exported")
    for name in extra:
        assert name not in names, name
    assert set(extra) | {".extraction-bootstrap"} <= set(summary["leftOut"])


@pytest.mark.parametrize(
    ("kind", "content"),
    [
        ("private key block", "-----BEGIN " + "RSA PRIVATE KEY-----\n"),
        ("AWS access key id", "key = " + "AKIA" + "ABCDEFGHIJKLMNOP" + "\n"),
        ("GitHub token", "token " + "ghp_" + "a" * 36 + "\n"),
        ("Slack token", "xox" + "b-" + "1234567890-abcdefghij" + "\n"),
        ("JSON Web Token", "eyJ" + "a" * 12 + ".eyJ" + "b" * 12 + "." + "c" * 12 + "\n"),
        ("credentials in a URL", "https://user" + ":" + "hunter2" + "@example.org/path\n"),
        ("assigned secret", "api_key = " + '"' + "x" * 20 + '"' + "\n"),
    ],
)
def test_a_secret_stops_the_export_and_is_never_printed(kind: str, content: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path, {"docs/leak.md": content.encode()})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and f"docs/leak.md:1: {kind}" in errors
    assert content.strip() not in errors and not (tmp_path / "exported").exists()


def test_the_scan_finds_nothing_in_ordinary_text(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text(
        "password = None\ntoken: str\nsecret_key = settings.key\nsee https://example.org/a/b and http://localhost:8080/x\n"
        "BIM_SERVICE_TOKENS_FILE=/run/secrets/bim_tokens\n",
        encoding="utf-8",
    )
    (tmp_path / "b.bin").write_bytes(b"\xff\xfe\x00 not text")
    assert export_repo.scan_secrets(tmp_path) == []


def test_a_binary_or_an_undeclared_vendored_file_is_not_own_material(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path, {"data/blob.dat": b"\xff\xfe\x00\x01", "packages/pkg-a/src/pkg_a/vendor/other/lib.py": b"x = 1\n"})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1
    assert "data/blob.dat: not a text file" in errors
    assert "pkg_a/vendor/other/lib.py: vendored file that licenses.json does not declare" in errors


def test_a_link_that_leaves_the_repository_stops_the_export(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path, {"docs/a.md": b"[inside](../NOTICE.md) [outside](../../docs/qa/X.md) [web](https://example.org)\n"})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1
    assert "docs/a.md:1: link '../../docs/qa/X.md' leaves the repository" in errors
    assert "'../NOTICE.md'" not in errors and "example.org" not in errors


def test_the_license_inventory_stops_a_notice_that_is_not_a_copy_and_a_wrong_identifier(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path, {
        "packages/pkg-a/NOTICE.md": b"# another notice\n",
        "packages/pkg-a/pyproject.toml": b'[project]\nname = "pkg-a"\nlicense = "MIT"\nlicense-files = ["LICENSE", "NOTICE.md"]\n',
    })
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1
    assert "pkg-a/NOTICE.md is missing or not a copy of NOTICE.md" in errors
    assert 'pkg-a/pyproject.toml does not declare license = "CC-BY-4.0"' in errors
    assert "lost the classifier Private :: Do Not Upload" in errors


def test_the_license_inventory_stops_a_package_license_that_is_not_a_copy_and_missing_license_files(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    clone = make_clone(tmp_path, {
        "packages/pkg-a/LICENSE": b"Attribution 4.0 International\n\n(edited)\n",
        "packages/pkg-a/pyproject.toml": b'[project]\nname = "pkg-a"\nlicense = "CC-BY-4.0"\nlicense-files = ["NOTICE.md"]\n'
        b'classifiers = ["Private :: Do Not Upload"]\n',
    })
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1
    assert "pkg-a/LICENSE is missing or not a copy of LICENSE" in errors
    assert "bim-core/LICENSE is missing" not in errors
    assert 'pkg-a/pyproject.toml does not declare license-files = ["LICENSE", "NOTICE.md"]' in errors
    assert "bim-core/pyproject.toml does not declare license-files" not in errors


# --- the OMG XSD files: never versioned, never exported ---------------------------------------------------------


def cleared_licenses() -> bytes:
    document = base_licenses()
    document["omg_bpmn_xsd"].update(
        cleared=True, status="cleared", cleared_by="the holder", cleared_on="2026-10-14", evidence="written confirmation of OMG"
    )
    return licenses_bytes(document)


def test_the_xsd_files_are_not_in_the_export_which_ignores_them_and_says_how_they_arrive(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path)
    code, summary, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    out = tmp_path / "exported"
    names = tracked(out)
    assert not any(name.endswith(".xsd") for name in names)
    assert f"{VENDOR}/README.md" in names and ".gitignore" in names
    section = json.loads((out / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]
    assert section["present_in_tree"] is False and section["cleared"] is False
    assert summary["xsd"].startswith("not versioned")
    assert xsd_inventory.check(out) == []  # Git ignores the files and lists none, and the table lists every declared digest
    assert "not versioned" in git(out, "log", "-1", "--format=%B")
    workflow = (out / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert workflow == WORKFLOW, "the workflows travel as committed: they already carry the verified download"


def test_a_committed_tree_that_versions_an_xsd_file_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clone = make_clone(tmp_path, {f"{VENDOR}/DC.xsd": b"<xsd:schema/>\n", f"{VENDOR}/DI.xsd": b"<xsd:schema/>\n"})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and not (tmp_path / "exported").exists()
    assert "versions the OMG BPMN XSDs (DC.xsd, DI.xsd)" in errors and "git rm --cached" in errors


def test_a_licenses_json_that_says_the_files_are_in_the_tree_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    document = base_licenses()
    document["omg_bpmn_xsd"]["present_in_tree"] = True
    clone = make_clone(tmp_path, {"licenses.json": licenses_bytes(document)})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and "present_in_tree must be false" in errors and not (tmp_path / "exported").exists()


def test_the_stage_with_one_of_the_files_is_refused_by_the_license_inventory(tmp_path: Path) -> None:
    write_files(tmp_path, mini_files())
    assert export_repo.license_problems(tmp_path) == []
    (tmp_path / VENDOR / "DC.xsd").write_bytes(b"<xsd:schema/>\n")
    assert any("the OMG XSDs are in the tree (DC.xsd)" in item for item in export_repo.license_problems(tmp_path))


def test_the_xsd_switch_is_gone_and_a_clearance_does_not_make_the_files_travel(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        export_repo.main(["--output", str(tmp_path / "x"), "--xsd", "include"])
    capsys.readouterr()
    assert not hasattr(export_repo, "include_xsd") and not hasattr(export_repo, "drop_xsd") and not hasattr(export_repo, "patch_workflow")
    clone = make_clone(tmp_path, {"licenses.json": cleared_licenses()})
    code, summary, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 0, errors
    assert summary["xsd"].startswith("not versioned")
    assert not any(name.endswith(".xsd") for name in tracked(tmp_path / "exported"))


def test_a_clearance_without_its_record_is_an_incoherent_licenses_json_and_stops_the_export(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    document = json.loads(cleared_licenses())
    document["omg_bpmn_xsd"]["evidence"] = ""
    clone = make_clone(tmp_path, {"licenses.json": (json.dumps(document) + "\n").encode()})
    code, _, errors = export(tmp_path, clone, capsys=capsys)
    assert code == 1 and '"cleared" is true but "evidence" is empty' in errors
    assert not (tmp_path / "exported").exists()


# --- the self-containment run ---------------------------------------------------------------------------------


def tiny_stage(tmp_path: Path, extra_test: str = "") -> Path:
    stage = tmp_path / "stage"
    for number, suite in enumerate(export_repo.SUITES):
        (stage / suite).mkdir(parents=True)
        # distinct module names: the suites are collected in one session, without packages
        (stage / suite / f"test_ok_{number}.py").write_text(f"def test_ok_{number}():\n    assert True\n", encoding="utf-8")
    if extra_test:
        (stage / "tools" / "test_extra.py").write_text(extra_test, encoding="utf-8")
    return stage


def test_the_self_test_passes_a_tree_whose_tests_pass(tmp_path: Path) -> None:
    stage = tiny_stage(tmp_path)
    assert export_repo.self_test(stage) == []


def test_the_self_test_fails_on_a_skip_and_on_a_failure(tmp_path: Path) -> None:
    skipped = tiny_stage(tmp_path / "a", "import pytest\n\ndef test_needs_something():\n    pytest.skip('no corpus here')\n")
    (problem,) = export_repo.self_test(skipped)
    assert "skipped" in problem and "no corpus here" in problem
    failing = tiny_stage(tmp_path / "b", "def test_broken():\n    assert False\n")
    (problem,) = export_repo.self_test(failing)
    assert "failed" in problem and "test_broken" in problem


def test_the_self_test_runs_without_the_corpus_and_without_the_callers_bim_variables(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BIM_CORPUS_ROOT", str(ROOT.parent))
    monkeypatch.setenv("BIM_REQUIRE_CORPUS", "1")
    probe = (
        "import os\n\n"
        "def test_the_environment():\n"
        "    assert os.environ['BIM_NESTED_RUN'] == '1'\n"
        "    assert 'BIM_REQUIRE_CORPUS' not in os.environ\n"
        "    root = os.environ['BIM_CORPUS_ROOT']\n"
        "    assert os.path.isdir(root) and not os.listdir(root)\n"
    )
    stage = tiny_stage(tmp_path, probe)
    assert export_repo.self_test(stage) == []


def test_the_self_test_downloads_the_xsd_files_into_its_copy_only(tmp_path: Path) -> None:
    probe = (
        "from pathlib import Path\n\n"
        "def test_the_files_are_in_the_copy():\n"
        f"    directory = Path('{VENDOR}')\n"
        f"    assert sorted(path.name for path in directory.glob('*.xsd')) == {XSD_FILES!r}\n"
    )
    stage = tiny_stage(tmp_path, probe)
    shutil.copy2(ROOT / "licenses.json", stage / "licenses.json")
    served = served_from_this_tree()
    assert export_repo.self_test(stage, fetch_xsd=True, opener=served.__getitem__) == []
    assert not any(stage.rglob("*.xsd")), "the staged tree stays without the files"


def test_the_self_test_stops_when_a_download_is_not_the_declared_bytes(tmp_path: Path) -> None:
    stage = tiny_stage(tmp_path)
    shutil.copy2(ROOT / "licenses.json", stage / "licenses.json")
    served = served_from_this_tree()
    served["https://www.omg.org/spec/BPMN/20100501/Semantic.xsd"] += b" "
    (problem,) = export_repo.self_test(stage, fetch_xsd=True, opener=served.__getitem__)
    assert "could not be downloaded" in problem and "Semantic.xsd: SHA-256" in problem and "nothing was written" in problem


def test_without_network_the_self_test_says_so_and_runs_nothing(tmp_path: Path) -> None:
    stage = tiny_stage(tmp_path)
    shutil.copy2(ROOT / "licenses.json", stage / "licenses.json")

    def unreachable(url: str) -> bytes:
        raise xsd_inventory.hatch_build.NetworkError(f"{url}: no network")

    (problem,) = export_repo.self_test(stage, fetch_xsd=True, opener=unreachable)
    assert "could not be downloaded" in problem and "no network" in problem


# --- this very tree ----------------------------------------------------------------------------------------------


#: What is copied of this tree: the five XSDs are on disk (a build put them there) but are not part of the repository.
IGNORED = shutil.ignore_patterns(
    "dist", ".venv", ".verify-venv", ".pytest_cache", "__pycache__", ".ruff_cache", "*.pyc", "*.egg-info", "*.xsd"
)


def test_the_static_checks_pass_on_this_tree(tmp_path: Path) -> None:
    original = tmp_path / "original"
    shutil.copytree(ROOT, original, ignore=IGNORED)
    assert export_repo.committed_xsd_problems(original) == []
    stage = tmp_path / "stage"
    left_out = export_repo.stage_tree(original, stage)  # in an exported copy there is nothing left to leave out
    assert not any(not export_repo.excluded(PurePosixPath(name)) for name in left_out)
    assert not (stage / ".extraction-bootstrap").exists()
    assert not any(stage.rglob("*.xsd"))
    assert export_repo.scan_secrets(stage) == []
    assert export_repo.license_problems(stage) == []
    assert export_repo.foreign_files(stage) == []
    assert export_repo.outside_references(stage) == []
    assert xsd_inventory.check(stage) == []


@pytest.mark.spawns_suite
def test_this_tree_exports_and_the_export_passes_the_suite_without_the_corpus(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The whole thing, once: a clone with this tree, the export with the self-containment run (the OMG files are not
    versioned, so the suite runs on a copy in which they are downloaded with their SHA-256 checked; the network is replaced
    by the bytes of this tree)."""
    clone = tmp_path / "openbinding"
    clone.mkdir()
    git(clone, "init", "-q")
    git(clone, "config", "user.name", IDENTITY[0])
    git(clone, "config", "user.email", IDENTITY[1])
    shutil.copytree(ROOT, clone / "bim-toolchain", ignore=IGNORED)
    write_files(clone, {"README.md": b"OPENBINDING ROOT\n"})
    head = commit_all(clone)
    output = tmp_path / "exported"
    code = export_repo.main(["--output", str(output), "--source", str(clone)], opener=served_from_this_tree().__getitem__)
    captured = capsys.readouterr()
    assert code == 0, captured.err[-6000:]
    summary = json.loads(captured.out)
    assert summary["selfTest"] == "passed" and summary["xsd"].startswith("not versioned") and summary["sourceCommit"] == head
    names = tracked(output)
    assert not any(name.endswith(".xsd") for name in names)
    assert {"pyproject.toml", "licenses.json", "NOTICE.md", "tools/export_repo.py", "docs/DELIVERY.md", ".gitignore"} <= set(names)
    source = {path.relative_to(ROOT).as_posix() for path in ROOT.rglob("*") if path.is_file()}
    expected = {
        name for name in source if not export_repo.excluded(PurePosixPath(name)) and not name.endswith(".xsd")
    }
    assert set(names) == expected
    assert git(output, "rev-list", "--count", "HEAD").strip() == "1"
    assert xsd_inventory.check(output) == []
