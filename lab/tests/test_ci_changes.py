"""Tests of the CI change detection and the required-check aggregator (change ``ci-speed``).

``tools/ci_changes.py`` maps the files of a pull request to the areas whose jobs must run and
``tools/ci_required.py`` fails the one required check when a job failed or was skipped by mistake.
Both are loaded by file path, so a missing script is an ``AssertionError`` of the first test.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_changes.py
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
GATEWAY_TESTS = ROOT / "openbinding-gateway" / "tests"
AREAS = ("e2e", "bim", "engines", "gateway")
CHANGELOG = "frontend/src/content/changelog.generated.json"


def _load(name: str):
    path = TOOLS / f"{name}.py"
    assert path.is_file(), f"{path} does not exist"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def changes():
    return _load("ci_changes")


@pytest.fixture(scope="module")
def required():
    return _load("ci_required")


def _only(result: dict[str, bool], *true: str) -> bool:
    return result == {area: area in true for area in AREAS}


def _all(value: bool) -> dict[str, bool]:
    return {area: value for area in AREAS}


# [utest->req~ci-speed-change-detection~1]
def test_changelog_only_pull_request_runs_no_area(changes):
    assert changes.changed_paths([CHANGELOG]) == _all(False)


# [utest->req~ci-speed-change-detection~1]
def test_docs_only_pull_request_runs_no_area(changes):
    paths = ["docs/agent-work/ci-speed/handoff.md", "openspec/changes/x/proposal.md", "acceptance/ui/a.spec.ts"]
    assert changes.changed_paths(paths) == _all(False)
    assert changes.changed_paths(["CONTRIBUTING.md", "frontend/README.md"]) == _all(False)


# [utest->req~ci-speed-change-detection~1]
def test_changelog_does_not_hide_a_real_change(changes):
    assert _only(changes.changed_paths([CHANGELOG, "frontend/e2e/a.spec.ts"]), "e2e")


# [utest->req~ci-speed-change-detection~1]
def test_e2e_spec_only_runs_e2e(changes):
    assert _only(changes.changed_paths(["frontend/e2e/playground.spec.ts"]), "e2e")


# [utest->req~ci-speed-change-detection~1]
def test_frontend_source_runs_e2e_and_gateway(changes):
    # The gateway tests read frontend/src (routes, bim-package fixtures), so the gateway area follows.
    assert _only(changes.changed_paths(["frontend/src/routes/d1.tsx"]), "e2e", "gateway")


# [utest->req~ci-speed-change-detection~1]
def test_engines_and_bim_paths(changes):
    assert _only(changes.changed_paths(["engines/multi-heuristic/pom.xml"]), "engines", "bim", "gateway")
    assert _only(changes.changed_paths(["schemas/bim/v1/instance.schema.json"]), "engines", "bim", "gateway")
    assert _only(changes.changed_paths(["bim-toolchain/packages/bim-core/src/x.py"]), "bim", "gateway")
    assert _only(changes.changed_paths(["openbinding-gateway/uv.lock"]), "bim", "gateway")
    assert _only(changes.changed_paths(["openbinding-gateway/src/openbinding_gateway/app.py"]), "gateway")
    assert _only(changes.changed_paths(["tools/check_bim_guard.py"]), "engines", "bim", "gateway")


# [utest->req~ci-speed-change-detection~1]
def test_unknown_path_runs_everything(changes):
    assert changes.changed_paths(["weird/file.xyz"]) == _all(True)
    assert changes.changed_paths([CHANGELOG, "weird/file.xyz"]) == _all(True)
    assert changes.changed_paths(["WEIRD_ROOT_FILE"]) == _all(True)


# [utest->req~ci-speed-change-detection~1]
@pytest.mark.parametrize("path", [".github/workflows/ci.yml", "tools/ci_changes.py", "tools/ci_required.py", "tools/ci_shard.py"])
def test_ci_definition_change_runs_everything(changes, path):
    assert changes.changed_paths([path, CHANGELOG]) == _all(True)


# [utest->req~ci-speed-change-detection~1]
@pytest.mark.parametrize("event", ["push", "workflow_dispatch", "schedule", ""])
def test_other_events_run_everything(changes, event, capsys, monkeypatch):
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    assert changes.main(["--base", "a" * 40, "--head", "b" * 40, "--event", event]) == 0
    assert capsys.readouterr().out.split() == [f"{area}=true" for area in AREAS]


def _git(repo: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", *args],
        cwd=repo, check=True, capture_output=True, text=True,
    )
    return done.stdout.strip()


def _commit(repo: Path, files: dict[str, str]) -> str:
    for name, text in files.items():
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c")
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    _git(tmp_path, "init", "-q")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    return tmp_path


# [utest->req~ci-speed-change-detection~1]
def test_main_uses_git_diff_and_writes_github_output(changes, repo, capsys, monkeypatch):
    base = _commit(repo, {"README.md": "a", CHANGELOG: "1"})
    head = _commit(repo, {CHANGELOG: "2", "frontend/e2e/a.spec.ts": "x"})
    out = repo / "out.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    assert changes.main(["--base", base, "--head", head, "--event", "pull_request"]) == 0
    expected = "e2e=true\nbim=false\nengines=false\ngateway=false\n"
    assert capsys.readouterr().out == expected
    assert out.read_text(encoding="utf-8") == expected


# [utest->req~ci-speed-change-detection~1]
def test_main_changelog_only_pull_request(changes, repo, capsys):
    base = _commit(repo, {CHANGELOG: "1"})
    head = _commit(repo, {CHANGELOG: "2"})
    assert changes.main(["--base", base, "--head", head, "--event", "pull_request"]) == 0
    assert capsys.readouterr().out.split() == [f"{area}=false" for area in AREAS]


# [utest->req~ci-speed-change-detection~1]
@pytest.mark.parametrize("base", ["", "0" * 40, "not-a-sha", "--output=x"])
def test_git_error_or_bad_base_runs_everything(changes, repo, capsys, base):
    head = _commit(repo, {"README.md": "a"})
    assert changes.main([f"--base={base}", "--head", head, "--event", "pull_request"]) == 0
    captured = capsys.readouterr()
    assert captured.out.split() == [f"{area}=true" for area in AREAS]
    assert captured.err.strip()


# [utest->req~ci-speed-change-detection~1]
def test_outside_a_repository_runs_everything(changes, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))
    assert changes.main(["--base", "a" * 40, "--head", "b" * 40, "--event", "pull_request"]) == 0
    assert capsys.readouterr().out.split() == [f"{area}=true" for area in AREAS]


# [utest->req~ci-speed-change-detection~1]
def test_rename_out_of_a_tested_area_still_runs_it(changes, repo, capsys):
    base = _commit(repo, {"examples/demo/a.json": "{}" * 50})
    (repo / "docs/agent-work").mkdir(parents=True)
    _git(repo, "mv", "examples/demo/a.json", "docs/agent-work/a.json")
    _git(repo, "commit", "-m", "move")
    head = _git(repo, "rev-parse", "HEAD")
    assert changes.main(["--base", base, "--head", head, "--event", "pull_request"]) == 0
    assert capsys.readouterr().out.split() == ["e2e=false", "bim=true", "engines=false", "gateway=true"]


# [utest->req~ci-speed-change-detection~1]
def test_whole_repository_walks_see_ignored_paths(changes):
    # test_no_kubernetes walks the repository for kustomizations and manifests.
    assert changes.changed_paths(["docs/agent-work/x/kustomization.yaml"])["gateway"] is True
    assert changes.changed_paths(["frontend/e2e/deploy.yaml"])["gateway"] is True


_CHAIN = re.compile(r'(?:REPO_ROOT|parents\[\d+\])((?:\s*/\s*"[^"]+")+)')


def _gateway_reads() -> set[str]:
    reads: set[str] = set()
    for source in GATEWAY_TESTS.rglob("*.py"):
        for match in _CHAIN.finditer(source.read_text(encoding="utf-8")):
            parts = re.findall(r'"([^"]+)"', match.group(1))
            reads.add("/".join(part.strip("/") for part in parts))
    return reads


# [utest->req~ci-speed-change-detection~1]
def test_every_path_the_gateway_tests_read_is_in_the_gateway_area(changes):
    reads = _gateway_reads()
    assert len(reads) > 20, "the regex found too few REPO_ROOT / ... reads"
    assert "openspec/changes/m09-compose-only/tasks.md" in reads
    for read in sorted(reads):
        for probe in (read, f"{read}/probe.txt"):
            assert changes.changed_paths([probe])["gateway"] is True, probe


def _needs(**jobs: str) -> str:
    outputs = {area: "false" for area in AREAS}
    document = {"changes": {"result": "success", "outputs": outputs}}
    document.update({job: {"result": result, "outputs": {}} for job, result in jobs.items()})
    return json.dumps(document)


def _run(required, needs: str | None, monkeypatch, capsys):
    if needs is None:
        monkeypatch.delenv("NEEDS", raising=False)
    else:
        monkeypatch.setenv("NEEDS", needs)
    code = required.main()
    captured = capsys.readouterr()
    return code, captured.out + captured.err


# [utest->req~ci-speed-required-aggregate~1]
def test_required_passes_when_every_job_succeeded(required, monkeypatch, capsys):
    code, text = _run(required, _needs(test="success", lab="success"), monkeypatch, capsys)
    assert code == 0
    assert len(text.strip().splitlines()) == 1


# [utest->req~ci-speed-required-aggregate~1]
@pytest.mark.parametrize("result", ["failure", "cancelled"])
def test_required_fails_on_failure_or_cancelled(required, monkeypatch, capsys, result):
    code, text = _run(required, _needs(**{"gateway-unit": result, "openspec": "success"}), monkeypatch, capsys)
    assert code == 1
    assert "gateway-unit" in text and "openspec" not in text


# [utest->req~ci-speed-required-aggregate~1]
def test_required_fails_when_changes_did_not_succeed(required, monkeypatch, capsys):
    document = json.loads(_needs(test="skipped"))
    document["changes"]["result"] = "failure"
    code, text = _run(required, json.dumps(document), monkeypatch, capsys)
    assert code == 1 and "changes" in text
    del document["changes"]
    code, text = _run(required, json.dumps(document), monkeypatch, capsys)
    assert code == 1 and "changes" in text


# [utest->req~ci-speed-required-aggregate~1]
@pytest.mark.parametrize(
    ("job", "area"),
    [("bim-toolchain", "bim"), ("engines", "engines"), ("test", "gateway"), ("gateway-unit", "gateway"), ("frontend-e2e", "e2e")],
)
def test_required_fails_on_skipped_job_whose_area_is_true(required, monkeypatch, capsys, job, area):
    document = json.loads(_needs(**{job: "skipped"}))
    document["changes"]["outputs"][area] = "true"
    code, text = _run(required, json.dumps(document), monkeypatch, capsys)
    assert code == 1 and job in text


# [utest->req~ci-speed-required-aggregate~1]
def test_required_fails_on_unknown_result_or_missing_area_output(required, monkeypatch, capsys):
    document = json.loads(_needs(test="skipped"))
    del document["changes"]["outputs"]["gateway"]
    code, text = _run(required, json.dumps(document), monkeypatch, capsys)
    assert code == 1 and "test" in text
    code, text = _run(required, _needs(**{"gateway-unit": "weird"}), monkeypatch, capsys)
    assert code == 1 and "gateway-unit" in text


# [utest->req~ci-speed-required-aggregate~1]
def test_required_passes_on_skipped_job_whose_area_is_false(required, monkeypatch, capsys):
    jobs = dict.fromkeys(("bim-toolchain", "engines", "test", "gateway-unit", "frontend-e2e"), "skipped")
    code, _ = _run(required, _needs(**jobs, lab="success"), monkeypatch, capsys)
    assert code == 0


# [utest->req~ci-speed-required-aggregate~1]
@pytest.mark.parametrize("needs", [None, "", "not json", "[]", "null", '{"changes": 3}', '{"changes": {"outputs": {}}}'])
def test_required_fails_on_missing_or_invalid_needs(required, monkeypatch, capsys, needs):
    code, text = _run(required, needs, monkeypatch, capsys)
    assert code == 1 and text.strip()
