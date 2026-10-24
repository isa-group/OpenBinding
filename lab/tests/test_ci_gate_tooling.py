"""Static checks of the gate tooling in ``.github/workflows/ci.yml`` and ``.agentic/project.yaml`` (change
``m03-gate-tooling``), without running a workflow.

The helpers assert instead of raising ``KeyError``, so a missing job, step or file is an ``AssertionError``.  PyYAML
reads the workflow key ``on`` as ``True``; the trigger test reads it as ``_ci().get(True)``.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_gate_tooling.py
"""

from __future__ import annotations

import configparser
import fnmatch
import json
import os
import re
import tomllib
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
PROJECT = ROOT / ".agentic" / "project.yaml"
GATEWAY = ROOT / "openbinding-gateway"
IMPORTLINTER = GATEWAY / ".importlinter"
FRONTEND = ROOT / "frontend"
PLUGIN = "eslint-plugin-boundaries"

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


def _lines(value: str) -> list[str]:
    return [line.strip() for line in value.splitlines() if line.strip()]


def _toml(path: Path) -> dict:
    return tomllib.loads(_read(path))


# [utest->req~gate-tooling-import-linter-contract~1]
def test_importlinter_contract_mirrors_layers():
    config = configparser.ConfigParser()
    config.read_string(_read(IMPORTLINTER))
    assert config.has_section("importlinter"), "no [importlinter] section"
    assert config.get("importlinter", "root_package") == "openbinding_gateway"
    pkg = "openbinding_gateway"

    layers = "importlinter:contract:layers"
    assert config.has_section(layers), f"no [{layers}] section"
    assert config.get(layers, "type") == "layers"
    assert _lines(config.get(layers, "containers")) == [pkg]
    assert _lines(config.get(layers, "layers")) == ["routes", "services", "repositories | integrations", "db"]

    no_routes = "importlinter:contract:no-routes"
    assert config.has_section(no_routes), f"no [{no_routes}] section"
    assert config.get(no_routes, "type") == "forbidden"
    assert _lines(config.get(no_routes, "source_modules")) == [f"{pkg}.services", f"{pkg}.domain", f"{pkg}.jobs"]
    assert _lines(config.get(no_routes, "forbidden_modules")) == [f"{pkg}.routes"]

    integrations = "importlinter:contract:integrations"
    assert config.has_section(integrations), f"no [{integrations}] section"
    assert config.get(integrations, "type") == "forbidden"
    assert _lines(config.get(integrations, "source_modules")) == [f"{pkg}.integrations"]
    assert _lines(config.get(integrations, "forbidden_modules")) == [
        f"{pkg}.{name}" for name in ("routes", "services", "repositories", "db", "domain", "jobs")
    ]
    contracts = [s for s in config.sections() if s.startswith("importlinter:contract:")]
    assert sorted(contracts) == sorted([layers, no_routes, integrations]), contracts


# [utest->req~gate-tooling-import-linter-dev-only~1]
def test_import_linter_is_locked_dev_only():
    pyproject = _toml(GATEWAY / "pyproject.toml")
    group = pyproject.get("dependency-groups", {}).get("lint")
    assert isinstance(group, list), "pyproject.toml has no [dependency-groups].lint"
    assert "import-linter==2.15" in group, group
    project = pyproject.get("project", {})
    extras = project.get("optional-dependencies", {})
    assert "test" in extras, "pyproject.toml has no test extra"
    for where, entries in (("[project].dependencies", project.get("dependencies", [])), ("the test extra", extras["test"])):
        assert not [e for e in entries if "import-linter" in e.lower().replace("_", "-")], f"import-linter in {where}"
    locked = [p for p in _toml(GATEWAY / "uv.lock").get("package", []) if p.get("name") == "import-linter"]
    assert len(locked) == 1 and locked[0].get("version") == "2.15", locked
    dockerfile = _read(GATEWAY / "Dockerfile")
    assert '".[test]"' in dockerfile, "the gateway image no longer installs .[test]"
    assert "--group" not in dockerfile, "the gateway image installs a dependency group"


# [utest->req~gate-tooling-import-linter-report-only~1]
def test_import_linter_step_is_report_only():
    job = _job("lab")
    lint = _step(job, "lint-imports")
    assert lint["run"].strip() == "uv run --locked --extra test --group lint lint-imports --config .importlinter"
    assert lint.get("working-directory") == "openbinding-gateway"
    assert lint.get("continue-on-error") is True
    steps = job["steps"]
    assert steps.index(_step(job, "pytest lab/tests")) < steps.index(lint)
    assert steps[-1] is lint, "the import-linter step is not the last step of job lab"
    assert all("continue-on-error" not in s for s in steps if s is not lint)


# [utest->req~gate-tooling-eslint-boundaries~1]
def test_eslint_boundaries_warns_page_to_page():
    package = json.loads(_read(FRONTEND / "package.json"))
    dev = package.get("devDependencies", {})
    assert dev.get(PLUGIN) == "7.3.0", f"devDependencies {PLUGIN}: {dev.get(PLUGIN)!r}"
    assert PLUGIN not in package.get("dependencies", {}), f"{PLUGIN} is a runtime dependency"
    lint = package.get("scripts", {}).get("lint")
    assert isinstance(lint, str) and lint, "package.json has no lint script"
    assert "--max-warnings" not in lint, lint

    config = _read(FRONTEND / "eslint.config.js")
    assert re.search(rf"""from\s+['"]{PLUGIN}['"]""", config), f"eslint.config.js does not import {PLUGIN}"
    assert re.search(r"""type:\s*['"]page['"]""", config), "no element type 'page'"
    assert re.search(r"""pattern:\s*['"]src/pages/\*['"]""", config), "no element pattern 'src/pages/*'"
    assert "rules:" in config, "eslint.config.js has no rules block"
    rules = [
        match
        for part in config.split("rules:")[1:]
        for match in re.findall(r"""['"](boundaries/[\w-]+)['"]\s*:\s*\[?\s*([^\s,\]]+)""", part)
    ]
    assert rules, "eslint.config.js sets no boundaries/ rule"
    assert re.search(r"capture:\s*\[\s*['\"]name['\"]\s*\]", config), "the page element captures no name"
    assert re.search(r"policies:\s*\[", config) and "from.element.captured.name" in config, "no page-to-page policy"
    for name, severity in rules:
        assert severity in ("'warn'", '"warn"'), f"{name} has severity {severity}, not 'warn'"


TOOLCHAIN_PYTHON = "../openbinding-gateway/.venv/bin/python"
TOOLCHAIN_PYTHONPATH = "packages/bim-core/src:packages/bim-service/src:packages/bim-client/src"
TOOLCHAIN_TESTS = ["packages/bim-core/tests", "packages/bim-service/tests", "packages/bim-client/tests"]


# [utest->req~gate-tooling-bim-toolchain-tests~1]
def test_bim_toolchain_job_runs_package_tests():
    trigger = _ci().get(True)
    assert isinstance(trigger, dict) and "pull_request" in trigger, f"ci.yml does not trigger on pull_request: {trigger!r}"
    assert "paths" not in (trigger["pull_request"] or {}), "the pull_request trigger has a paths filter"
    job = _job("bim-toolchain")
    assert "if" not in job
    assert all("continue-on-error" not in s for s in job["steps"])
    ensure = _step(job, "xsd_inventory.py --ensure")
    sync = _step(job, "uv sync --locked --project openbinding-gateway --extra test")
    pytest_step = _step(job, f"{TOOLCHAIN_PYTHON} -m pytest")
    assert pytest_step.get("working-directory") == "bim-toolchain"
    assert (pytest_step.get("env") or {}).get("PYTHONPATH") == TOOLCHAIN_PYTHONPATH
    arguments = pytest_step["run"].split()
    assert [a for a in arguments if a.startswith("packages/")] == TOOLCHAIN_TESTS, arguments
    steps = job["steps"]
    assert steps.index(ensure) < steps.index(sync) < steps.index(pytest_step)


# [utest->req~gate-tooling-bim-toolchain-goldens~1]
def test_bim_toolchain_job_checks_goldens():
    job = _job("bim-toolchain")
    goldens = _step(job, f"{TOOLCHAIN_PYTHON} tools/baseline_core.py --check")
    assert goldens.get("working-directory") == "bim-toolchain"
    assert (goldens.get("env") or {}).get("PYTHONPATH") == TOOLCHAIN_PYTHONPATH
    assert "continue-on-error" not in goldens and "if" not in goldens
    assert all("continue-on-error" not in s for s in job["steps"])


def _lockfile_dev_dependencies() -> str:
    lock = _read(FRONTEND / "pnpm-lock.yaml")
    importer = re.search(r"^importers:\n\n  \.:\n(?P<body>(?:    .*\n|\n)*)", lock, re.MULTILINE)
    assert importer, "pnpm-lock.yaml has no importer '.'"
    body = importer.group("body")
    dev = re.search(r"^    devDependencies:\n(?P<entries>(?:      .*\n)*)", body, re.MULTILINE)
    assert dev, "the importer has no devDependencies"
    runtime = re.search(r"^    dependencies:\n(?P<entries>(?:      .*\n)*)", body, re.MULTILINE)
    assert runtime and PLUGIN not in runtime.group("entries"), f"{PLUGIN} is a runtime dependency in the lockfile"
    return dev.group("entries")


def _stages(dockerfile: str) -> dict[str, list[str]]:
    stages: dict[str, list[str]] = {}
    current = None
    for line in dockerfile.replace("\\\n", " ").splitlines():
        head = re.match(r"FROM\s+\S+\s+AS\s+(\w[\w-]*)\s*$", line.strip(), re.IGNORECASE)
        if head:
            current = head.group(1)
            stages[current] = []
        elif current is not None and line.strip() and not line.lstrip().startswith("#"):
            stages[current].append(line.strip())
    return stages


# [utest->req~gate-tooling-frontend-images~1]
def test_frontend_images_get_plugin_only_by_frozen_install():
    entries = _lockfile_dev_dependencies()
    locked = re.search(rf"^      '?{PLUGIN}'?:\n        specifier: 7\.3\.0\n        version: 7\.3\.0(?:\(|\s*$)", entries, re.MULTILINE)
    assert locked, f"pnpm-lock.yaml does not resolve {PLUGIN} 7.3.0 as a devDependency of the importer"

    for name in ("Dockerfile", "Dockerfile.e2e"):
        text = _read(FRONTEND / name)
        assert re.search(r"^RUN pnpm install --frozen-lockfile$", text, re.MULTILINE), f"{name}: no frozen pnpm install"
        assert PLUGIN not in text, f"{name} names {PLUGIN}"

    stages = _stages(_read(FRONTEND / "Dockerfile"))
    for stage in ("prod-assets", "prod", "lab"):
        assert stage in stages, f"frontend/Dockerfile has no stage {stage!r}"
        for line in stages[stage]:
            if line.upper().startswith("RUN "):
                assert not re.search(r"\b(install|add|pnpm|npm|yarn|apk|apt-get|corepack)\b", line), f"{stage} installs: {line}"
            copy = re.match(r"COPY\s+--from=build\s+(\S+)\s+", line, re.IGNORECASE)
            if copy:
                assert copy.group(1) == "/app/dist", f"{stage} copies {copy.group(1)} from build"
    for stage in ("prod-assets", "prod"):
        assert any(re.match(r"COPY\s+--from=build\s+/app/dist\s", line) for line in stages[stage]), f"{stage} does not copy /app/dist from build"


API_RUNNER = "openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api"
UI_RUNNER = "pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests"


# [utest->req~gate-tooling-api-runner~1]
def test_api_runner_passes_empty_and_runs_in_lab():
    import subprocess
    import sys

    conftest = _read(ROOT / "acceptance" / "api" / "conftest.py")
    assert "pytest_sessionfinish" in conftest, "acceptance/api/conftest.py has no pytest_sessionfinish hook"
    done = subprocess.run(
        [sys.executable, "-m", "pytest", "-c", "acceptance/api/pytest.ini", "acceptance/api", "-q",
         "-p", "no:cacheprovider", "-k", "zz_selects_nothing"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, f"exit {done.returncode}\n{done.stdout}\n{done.stderr}"

    job = _job("lab")
    runner = _step(job, "-m pytest -c acceptance/api/pytest.ini acceptance/api")
    assert runner["run"].strip() == API_RUNNER
    assert "continue-on-error" not in runner
    steps = job["steps"]
    assert steps.index(_step(job, "pytest lab/tests")) < steps.index(runner) < steps.index(_step(job, "lint-imports"))


# [utest->req~gate-tooling-ui-runner~1]
def test_ui_runner_passes_empty_in_frontend_job():
    config = _read(FRONTEND / "playwright.acceptance.config.ts")
    assert "testDir: '../acceptance/ui'" in config, "playwright.acceptance.config.ts has no testDir '../acceptance/ui'"
    assert (ROOT / "acceptance" / "ui" / ".gitkeep").is_file(), "acceptance/ui/.gitkeep is missing"

    job = _job("frontend")
    runner = _step(job, "--config playwright.acceptance.config.ts")
    assert runner["run"].strip() == UI_RUNNER
    assert runner.get("working-directory") == "frontend"
    assert "continue-on-error" not in runner
    steps = job["steps"]
    assert steps.index(_step(job, "playwright install")) < steps.index(runner)
    assert steps[-1] is runner, "the acceptance runner is not the last step of job frontend"


# [utest->req~gate-tooling-acceptance-docs~1]
def test_acceptance_docs_name_runners_and_writer():
    for path in (ROOT / "acceptance" / "README.md", ROOT / "TESTING.md"):
        text = _read(path)
        for needle in ("pytest -c acceptance/api/pytest.ini", "playwright.acceptance.config.ts", "test-designer"):
            assert needle in text, f"{path.relative_to(ROOT)} does not contain {needle!r}"
    headings = [line for line in _read(ROOT / "TESTING.md").splitlines() if line.startswith("## 2.")]
    assert len(headings) == 1, headings
    assert "to be created" not in headings[0], headings[0]
