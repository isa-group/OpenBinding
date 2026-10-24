"""Static checks of the gate tooling in ``.github/workflows/ci.yml`` and ``.agentic/project.yaml`` (change
``m03-gate-tooling``), without running a workflow.

The helpers assert instead of raising ``KeyError``, so a missing job, step or file is an ``AssertionError``.  PyYAML
reads the workflow key ``on`` as ``True``; no test reads it.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_gate_tooling.py
"""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
PROJECT = ROOT / ".agentic" / "project.yaml"

OFT_SHA256 = "f094cd314f0fc4236f513f66fb39260a16f72e2320beb6b4fdeb7940b9b8cf87"
OFT_URL = "https://github.com/itsallcode/openfasttrace/releases/download/4.11.0/openfasttrace-4.11.0.jar"
G6_PATHS = ["openspec/specs", "openbinding-gateway/src", "openbinding-gateway/tests", "engines", "frontend/src", "acceptance"]
ALLOWED_ACTIONS = {
    "actions/checkout@v4",
    "actions/setup-python@v5",
    "astral-sh/setup-uv@v6",
    "actions/setup-java@v4",
    "actions/setup-node@v4",
}


def _read(path: Path) -> str:
    assert path.is_file(), f"missing file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def _ci() -> dict:
    data = yaml.safe_load(_read(CI))
    assert isinstance(data, dict) and isinstance(data.get("jobs"), dict), "ci.yml has no jobs"
    return data


def _job(name: str) -> dict:
    jobs = _ci()["jobs"]
    assert name in jobs, f"ci.yml has no job {name!r}"
    assert isinstance(jobs[name].get("steps"), list), f"job {name!r} has no steps"
    return jobs[name]


def _step(job: dict, text: str) -> dict:
    hits = [s for s in job["steps"] if text in str(s.get("run", ""))]
    assert len(hits) == 1, f"expected one step running {text!r}, found {len(hits)}"
    return hits[0]


def _setup(job: dict, action: str) -> dict:
    hits = [s for s in job["steps"] if s.get("uses") == action]
    assert len(hits) == 1, f"expected one step using {action}, found {len(hits)}"
    return hits[0].get("with") or {}


def _comments_after(text: str, marker: str) -> str:
    lines = text.splitlines()
    found = [i for i, line in enumerate(lines) if marker in line and not line.lstrip().startswith("#")]
    assert len(found) == 1, f"expected one project.yaml line with {marker!r}, found {len(found)}"
    block = []
    for line in lines[found[0] + 1:]:
        if not line.lstrip().startswith("#"):
            break
        block.append(line.strip())
    return "\n".join(block)


# [utest->req~gate-tooling-openspec-job~1]
def test_openspec_job_installs_pinned_cli_and_validates_all():
    job = _job("openspec")
    assert "needs" not in job
    assert str(_setup(job, "actions/setup-node@v4").get("node-version")) == "22"
    steps = job["steps"]
    order = [
        steps.index(_step(job, "npm install --global @fission-ai/openspec@1.14.3")),
        steps.index(_step(job, "openspec --version")),
        steps.index(_step(job, "openspec validate --strict --all")),
    ]
    assert order == sorted(order)


# [utest->req~gate-tooling-openspec-report-only~1]
def test_openspec_validate_is_report_only():
    job = _job("openspec")
    validate = _step(job, "openspec validate --strict --all")
    assert validate.get("continue-on-error") is True
    others = [s for s in job["steps"] if s is not validate]
    assert others and all("continue-on-error" not in s for s in others)


# [utest->req~gate-tooling-trace-download~1]
def test_trace_job_downloads_and_verifies_pinned_jar():
    job = _job("trace")
    java = _setup(job, "actions/setup-java@v4")
    assert java.get("distribution") == "temurin" and str(java.get("java-version")) == "21"
    download = _step(job, OFT_URL)
    assert "$RUNNER_TEMP/oft" in download["run"]
    verify = _step(job, "sha256sum -c")
    assert OFT_SHA256 in verify["run"]
    assert "continue-on-error" not in download and "continue-on-error" not in verify
    assert "if" not in verify and "if" not in _step(job, "trace -o plain")
    steps = job["steps"]
    trace = _step(job, "trace -o plain")
    assert steps.index(download) < steps.index(verify) < steps.index(trace)


# [utest->req~gate-tooling-trace-paths~1]
def test_trace_step_covers_g6_paths_report_only():
    trace = _step(_job("trace"), "trace -o plain")
    assert trace.get("continue-on-error") is True
    run = trace["run"]
    loop = re.search(r"for path in ([^;\n]+); do", run)
    assert loop, "no `for path in ...` loop in the trace step"
    assert loop.group(1).split() == G6_PATHS
    assert "skipped (absent)" in run
    assert 'java -jar "$RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" trace -o plain' in run


# [utest->req~gate-tooling-tools-not-shipped~1]
def test_gate_tools_not_committed_or_in_images():
    forbidden = ["openfasttrace", "@fission-ai/openspec", "import-linter", "importlinter", "lint-imports"]
    jars, dirty = [], []
    for folder, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv"}]
        for name in files:
            path = Path(folder) / name
            if fnmatch.fnmatch(name.lower(), "openfasttrace*.jar"):
                jars.append(str(path.relative_to(ROOT)))
            if name.startswith("Dockerfile"):
                content = path.read_text(encoding="utf-8", errors="replace").lower()
                dirty += [f"{path.relative_to(ROOT)}: {word}" for word in forbidden if word in content]
    assert not jars, f"committed jar: {jars}"
    assert not dirty, f"gate tool in an image: {dirty}"


# [utest->req~gate-tooling-pinned-steps~1]
def test_gate_jobs_pin_versions_and_add_no_actions():
    runs = [str(s.get("run", "")) for name in ("openspec", "trace") for s in _job(name)["steps"]]
    npm = [line for run in runs for line in run.splitlines() if "npm install" in line]
    urls = [url for run in runs for url in re.findall(r"https?://\S+", run)]
    assert npm and urls
    assert all(re.search(r"\S+@\d+\.\d+\.\d+(\s|$)", line) for line in npm), npm
    assert all("4.11.0" in url for url in urls), urls
    for name in ("openspec", "trace"):
        for step in _job(name)["steps"]:
            for key in ("node-version", "java-version"):
                value = (step.get("with") or {}).get(key)
                assert value is None or re.fullmatch(r"\d+", str(value)), f"{name}: {key} {value!r}"
    used = {s["uses"] for job in _ci()["jobs"].values() for s in job.get("steps", []) if "uses" in s}
    assert used <= ALLOWED_ACTIONS, sorted(used - ALLOWED_ACTIONS)


# [utest->req~gate-tooling-project-yaml-notes~1]
def test_project_yaml_g1_g6_stay_todo_with_notes():
    text = _read(PROJECT)
    gates = yaml.safe_load(text).get("gates", {})
    g1 = next((e for e in gates.get("G1_spec", []) if e.get("name") == "openspec-validate"), None)
    g6 = next((e for e in gates.get("G6_trace", []) if e.get("name") == "oft-trace"), None)
    assert g1 is not None and g6 is not None, "G1 openspec-validate or G6 oft-trace entry missing"
    assert g1["argv"] == ["openspec", "validate", "--strict"] and g1["todo"] is True
    assert g6["argv"] == ["oft", "trace", "-o", "plain", *G6_PATHS] and g6["todo"] is True
    g1_notes = _comments_after(text, "name: openspec-validate")
    g6_notes = _comments_after(text, "name: oft-trace")
    for notes in (g1_notes, g6_notes):
        assert "todo: true" in notes and "F1" in notes, notes
    assert "lacks --all" in g1_notes, g1_notes
