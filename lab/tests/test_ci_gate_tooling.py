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
import shlex
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
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


def _active(run: str) -> str:
    """The lines of a ``run`` text that are not shell comments."""
    return "\n".join(line for line in run.splitlines() if not line.lstrip().startswith("#"))


def _step(job: dict, text: str) -> dict:
    hits = [s for s in job["steps"] if text in _active(str(s.get("run", "")))]
    assert len(hits) == 1, f"expected one step running {text!r}, found {len(hits)}"
    return hits[0]


def _fails_job(job: dict, step: dict, *, allow_if: bool = False) -> None:
    """Assert that a failure of ``step`` fails the job: nothing masks its exit status or skips it."""
    assert "continue-on-error" not in job and "if" not in job, "job-level continue-on-error or if"
    assert any(step is s for s in job["steps"]), "the step is not a step of the job"
    assert "continue-on-error" not in step, f"step-level continue-on-error: {step.get('name')}"
    assert "shell" not in step, f"step with its own shell: {step.get('name')}"
    if not allow_if:
        assert "if" not in step, f"step-level if: {step.get('name')}"
    run = _active(str(step.get("run", "")))
    assert run.strip(), f"step without a run text: {step.get('name')}"
    for pattern in (r"\|\|", r"\bset\s+\+e\b", r";\s*true\b"):
        assert not re.search(pattern, run), f"{step.get('name')}: {pattern} masks the exit status"


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


_JS_STRING = r"""'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`"""
_JS_TOKEN = re.compile(rf"({_JS_STRING})|//[^\n]*|/\*.*?\*/", re.DOTALL)


def _strip_js_comments(text: str) -> str:
    """Remove ``//`` and ``/* */`` comments, leaving string literals (``'http://...'``) untouched."""
    return _JS_TOKEN.sub(lambda m: m.group(1) if m.group(1) is not None else " ", text)


def _mask_js_strings(text: str) -> str:
    """Same length as ``text`` with string contents blanked, so braces inside strings do not count."""
    return re.sub(_JS_STRING, lambda m: "x" * len(m.group(0)), text)


def _block_end(masked: str, start: int) -> int:
    assert masked[start] == "{"
    depth = 0
    for i in range(start, len(masked)):
        depth += {"{": 1, "}": -1}.get(masked[i], 0)
        if depth == 0:
            return i
    raise AssertionError("unbalanced braces")


def _block_start(masked: str, index: int) -> int:
    depth = 0
    for i in range(index - 1, -1, -1):
        if masked[i] == "}":
            depth += 1
        elif masked[i] == "{":
            if depth == 0:
                return i
            depth -= 1
    raise AssertionError("no enclosing block")


# [utest->req~gate-tooling-openspec-job~1]
def test_openspec_job_installs_pinned_cli_and_validates_all():
    job = _job("openspec")
    assert "needs" not in job
    assert str(_setup(job, "actions/setup-node@v4").get("node-version")) == "22"
    steps = job["steps"]
    install = _step(job, "npm install --global @fission-ai/openspec@1.14.3")
    version = _step(job, "openspec --version")
    order = [steps.index(install), steps.index(version), steps.index(_step(job, "openspec validate --strict --all"))]
    assert order == sorted(order)
    _fails_job(job, install)
    _fails_job(job, version)


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
    expected = f'echo "{OFT_SHA256}  $RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" | sha256sum -c -'
    assert verify["run"].strip() == expected, verify["run"]
    steps = job["steps"]
    trace = _step(job, "trace -o plain")
    assert "if" not in trace
    _fails_job(job, download)
    _fails_job(job, verify)
    assert steps.index(download) < steps.index(verify) < steps.index(trace)


# [utest->req~gate-tooling-trace-paths~1]
def test_trace_step_covers_g6_paths_report_only():
    trace = _step(_job("trace"), "trace -o plain")
    assert trace.get("continue-on-error") is True
    run = _active(trace["run"])
    loop = re.search(r"for path in ([^;\n]+); do", run)
    assert loop, "no `for path in ...` loop in the trace step"
    assert loop.group(1).split() == G6_PATHS
    assert "skipped (absent)" in run
    assert 'java -jar "$RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" trace -o plain' in run
    for needle in ('trace -o plain "${paths[@]}"', 'paths+=("$path")', '[ -e "$path" ]'):
        assert needle in run, f"the trace step lacks {needle!r}"


# [utest->req~gate-tooling-tools-not-shipped~1]
def test_gate_tools_not_committed_or_in_images():
    forbidden = ["openfasttrace", "@fission-ai/openspec", "import-linter", "importlinter", "lint-imports"]
    jars, dirty = [], []
    listing = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True, check=True)
    for relative in filter(None, listing.stdout.split("\0")):
        path = ROOT / relative
        if fnmatch.fnmatch(path.name.lower(), "openfasttrace*.jar"):
            jars.append(relative)
        if path.name.startswith("Dockerfile") and path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace").lower()
            dirty += [f"{relative}: {word}" for word in forbidden if word in content]
    assert not jars, f"committed jar: {jars}"
    assert not dirty, f"gate tool in an image: {dirty}"


# [utest->req~gate-tooling-pinned-steps~1]
def test_gate_jobs_pin_versions_and_add_no_actions():
    runs = [_active(str(s.get("run", ""))) for name in ("openspec", "trace") for s in _job(name)["steps"]]
    npm = [line for run in runs for line in run.splitlines() if re.search(r"\bnpm\s+install\b", line)]
    urls = [url for run in runs for url in re.findall(r"https?://\S+", run)]
    assert npm and urls
    for line in npm:
        arguments = shlex.split(line)
        packages = [a for a in arguments[arguments.index("install") + 1:] if not a.startswith("-")]
        assert packages, line
        assert all(re.search(r"@\d+\.\d+\.\d+$", a) for a in packages), line
    assert all("4.11.0" in url for url in urls), urls
    for run in runs:
        for pattern in (r"\bnpm\s+i\b", r"\bnpx\b", r"\bpip3?\s+install\b", r"\bgo\s+install\b", r"\bgit\s+clone\b"):
            assert not re.search(pattern, run), f"{pattern} in a gate job:\n{run}"
    for name in ("openspec", "trace"):
        for step in _job(name)["steps"]:
            for key in ("node-version", "java-version"):
                value = (step.get("with") or {}).get(key)
                assert value is None or re.fullmatch(r"\d+", str(value)), f"{name}: {key} {value!r}"
    jobs = _ci()["jobs"].values()
    used = {s["uses"] for job in jobs for s in job.get("steps", []) if "uses" in s}
    used |= {job["uses"] for job in jobs if "uses" in job}
    assert used <= ALLOWED_ACTIONS, sorted(used - ALLOWED_ACTIONS)


# Not tied to a requirement: the hardening of the workflow and of the two gate jobs.
def test_workflow_is_hardened():
    ci = _ci()
    assert ci.get("permissions") == {"contents": "read"}, ci.get("permissions")
    for name in ("openspec", "trace"):
        job = _job(name)
        assert job.get("timeout-minutes") == 10, f"{name}: timeout-minutes {job.get('timeout-minutes')!r}"
        checkouts = [s for s in job["steps"] if s.get("uses") == "actions/checkout@v4"]
        assert len(checkouts) == 1, name
        assert (checkouts[0].get("with") or {}).get("persist-credentials") is False, f"{name}: credentials persist"
    download = _step(_job("trace"), OFT_URL)
    curl = " ".join(_active(download["run"]).replace("\\\n", " ").split())
    for flag in ("--fail", "--proto '=https'", "--proto-redir '=https'", "--retry 3"):
        assert flag in curl, f"the OpenFastTrace curl has no {flag}"
    lab = _job("lab")
    assert "if" not in _step(lab, "pytest lab/tests")
    for text in ("-m pytest -c acceptance/api/pytest.ini acceptance/api", "lint-imports"):
        assert _step(lab, text).get("if") == "${{ !cancelled() }}", text


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
    assert not re.search(r"--(all-|only-)?groups?\b", dockerfile), "the gateway image installs a dependency group"
    default_groups = pyproject.get("tool", {}).get("uv", {}).get("default-groups")
    assert default_groups is None or (isinstance(default_groups, list) and "lint" not in default_groups), (
        f"[tool.uv].default-groups installs the lint group by default: {default_groups!r}"
    )


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

    config = _strip_js_comments(_read(FRONTEND / "eslint.config.js"))
    masked = _mask_js_strings(config)
    assert re.search(rf"""from\s+['"]{PLUGIN}['"]""", config), f"eslint.config.js does not import {PLUGIN}"
    assert not re.search(r"""boundaries\.configs|plugin:boundaries|['"]boundaries/(recommended|strict)['"]""", config), (
        "a boundaries preset is extended"
    )

    # The block that registers the plugin is the one that holds the element types, the files and the policy.
    registered = list(re.finditer(r"\bplugins\s*:\s*\{\s*boundaries\s*\}", masked))
    assert len(registered) == 1, "expected one config block with `plugins: { boundaries }`"
    start = _block_start(masked, registered[0].start())
    block = config[start:_block_end(masked, start) + 1]
    assert re.search(r"""\bfiles\s*:\s*\[\s*['"]src/\*\*/\*\.\{ts,tsx\}['"]\s*\]""", block), "the boundaries block has no files ['src/**/*.{ts,tsx}']"
    assert not re.search(r"\bextends\b", block), "the boundaries block extends a config"
    assert re.search(r"""type:\s*['"]page['"]""", block), "no element type 'page'"
    assert re.search(r"""pattern:\s*['"]src/pages/\*['"]""", block), "no element pattern 'src/pages/*'"
    assert re.search(r"capture:\s*\[\s*['\"]name['\"]\s*\]", block), "the page element captures no name"
    assert re.search(r"policies:\s*\[", block) and "from.element.captured.name" in block, "no page-to-page policy"
    assert re.search(r"""\bdefault\s*:\s*['"]allow['"]""", block), "the default of the rule is not 'allow'"
    assert re.search(r"\bdisallow\s*:", block), "the policy does not use `disallow`"
    assert not re.search(r"""(?<![\w-])['"]?allow['"]?\s*:""", block), "the policy uses `allow:`"

    bodies = [config[m.end() - 1:_block_end(masked, m.end() - 1) + 1] for m in re.finditer(r"\brules\s*:\s*\{", masked)]
    assert bodies, "eslint.config.js has no rules block"
    assert len(re.findall(r"\brules\s*:", masked)) == len(bodies), "a rules entry is not a literal object"
    keys = [k for k in re.findall(r"""['"](boundaries/[\w-]+)['"]\s*:""", config) if k != "boundaries/elements"]
    rules = [
        match
        for body in bodies
        for match in re.findall(r"""['"](boundaries/[\w-]+)['"]\s*:\s*\[?\s*([^\s,\]]+)""", body)
    ]
    assert "boundaries/dependencies" in [name for name, _ in rules], "boundaries/dependencies is not configured"
    assert len(keys) == len(rules), f"a boundaries/ key outside the rules objects: {keys}"
    for name, severity in rules:
        assert severity in ("'warn'", '"warn"'), f"{name} has severity {severity}, not 'warn'"


TOOLCHAIN_PYTHON = "../openbinding-gateway/.venv/bin/python"
TOOLCHAIN_PYTHONPATH = "packages/bim-core/src:packages/bim-service/src:packages/bim-client/src"
TOOLCHAIN_TESTS = ["packages/bim-core/tests", "packages/bim-service/tests", "packages/bim-client/tests"]
TOOLCHAIN_DESELECTED = [
    (
        "packages/bim-service/tests/analysis/test_analysis_b8_evidence.py"
        "::test_the_throughput_cost_of_a_short_switch_interval"
    ),
    (
        "packages/bim-service/tests/analysis/test_analysis_b8_probe.py"
        "::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]"
    ),
]


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
    arguments = shlex.split(pytest_step["run"])
    deselects = [i for i, a in enumerate(arguments) if a == "--deselect" or a.startswith("--deselect=")]
    assert len(deselects) == len(TOOLCHAIN_DESELECTED), f"expected exactly the two --deselect options: {arguments}"
    assert all(arguments[i] == "--deselect" for i in deselects), arguments
    assert [arguments[i + 1] for i in deselects] == TOOLCHAIN_DESELECTED, arguments
    values = {i + 1 for i in deselects}
    directories = [a for i, a in enumerate(arguments) if a.startswith("packages/") and i not in values]
    assert directories == TOOLCHAIN_TESTS, arguments
    steps = job["steps"]
    assert steps.index(ensure) < steps.index(sync) < steps.index(pytest_step)
    for step in (ensure, sync, pytest_step):
        _fails_job(job, step)


# [utest->req~gate-tooling-bim-toolchain-goldens~1]
def test_bim_toolchain_job_checks_goldens():
    job = _job("bim-toolchain")
    goldens = _step(job, f"{TOOLCHAIN_PYTHON} tools/baseline_core.py --check")
    assert goldens.get("working-directory") == "bim-toolchain"
    assert (goldens.get("env") or {}).get("PYTHONPATH") == TOOLCHAIN_PYTHONPATH
    _fails_job(job, goldens)
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


def _copy(line: str) -> tuple[dict[str, str], list[str]]:
    """The flags (``--from=build`` -> ``{"from": "build"}``, in any order) and the sources of a ``COPY`` line."""
    tokens = shlex.split(line)[1:]
    flags = dict(t[2:].partition("=")[::2] for t in tokens if t.startswith("--"))
    arguments = [t for t in tokens if not t.startswith("--")]
    assert len(arguments) >= 2, line
    return flags, arguments[:-1]


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
            if line.upper().startswith("COPY "):
                flags, sources = _copy(line)
                if "from" in flags:
                    assert flags["from"] == "build" and sources == ["/app/dist"], f"{stage} copies {sources} from {flags['from']}: {line}"
                else:
                    assert stage == "lab" and sources == ["nginx.lab.conf"], f"{stage} copies {sources} from the context: {line}"
    for stage in ("prod-assets", "prod"):
        copies = [_copy(line) for line in stages[stage] if line.upper().startswith("COPY ")]
        assert [(f.get("from"), s) for f, s in copies] == [("build", ["/app/dist"])], f"{stage} copies {copies}"


API_RUNNER = "openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api"
UI_RUNNER = "pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests"


def _child_env() -> dict[str, str]:
    """The environment of a child pytest, without the settings of the pytest and coverage run that spawns it."""
    return {k: v for k, v in os.environ.items() if not k.startswith(("PYTEST_", "COV_", "COVERAGE_"))}


# [utest->req~gate-tooling-api-runner~1]
def test_api_runner_passes_empty_and_runs_in_lab():
    conftest = _read(ROOT / "acceptance" / "api" / "conftest.py")
    assert "pytest_sessionfinish" in conftest, "acceptance/api/conftest.py has no pytest_sessionfinish hook"
    done = subprocess.run(
        [sys.executable, "-m", "pytest", "-c", "acceptance/api/pytest.ini", "acceptance/api", "-q",
         "-p", "no:cacheprovider", "-k", "zz_selects_nothing"],
        cwd=ROOT, env=_child_env(), capture_output=True, text=True, check=False, timeout=120,
    )
    assert done.returncode == 0, f"exit {done.returncode}\n{done.stdout}\n{done.stderr}"

    job = _job("lab")
    runner = _step(job, "-m pytest -c acceptance/api/pytest.ini acceptance/api")
    assert runner["run"].strip() == API_RUNNER
    assert "continue-on-error" not in runner
    steps = job["steps"]
    assert steps.index(_step(job, "pytest lab/tests")) < steps.index(runner) < steps.index(_step(job, "lint-imports"))
    _fails_job(job, runner, allow_if=True)
    assert runner.get("if") == "${{ !cancelled() }}"


def _run_api_runner(tmp_path: Path, tests: dict[str, str], *extra: str) -> subprocess.CompletedProcess:
    """Run the runner of acceptance/api on a copy of its configuration, with the given test files."""
    api = tmp_path / "acceptance" / "api"
    api.mkdir(parents=True)
    for name in ("conftest.py", "pytest.ini"):
        shutil.copy(ROOT / "acceptance" / "api" / name, api / name)
    for name, body in tests.items():
        (api / name).write_text(body, encoding="utf-8")
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-c", "acceptance/api/pytest.ini", "acceptance/api", "-q", "-p", "no:cacheprovider", *extra],
        cwd=tmp_path, env=_child_env(), capture_output=True, text=True, check=False, timeout=120,
    )


# [utest->req~gate-tooling-api-runner~1]
@pytest.mark.parametrize(
    ("tests", "extra", "expected"),
    [
        ({}, (), 0),
        ({"test_ok.py": "def test_ok():\n    assert True\n"}, (), 0),
        ({"test_ok.py": "def test_ok():\n    assert True\n"}, ("-k", "zz_selects_nothing"), 0),
        ({"test_bad.py": "def test_bad():\n    assert False\n"}, (), 1),
        ({"test_ok.py": "def test_ok():\n    assert True\n", "test_bad.py": "def test_bad():\n    assert False\n"}, (), 1),
        ({"test_broken.py": "def test_broken(:\n    pass\n"}, (), 2),
        ({}, ("--no-such-option",), 4),
    ],
    ids=["empty", "passing", "k-selects-nothing", "failing", "passing-and-failing", "collection-error", "usage-error"],
)
def test_api_runner_keeps_every_exit_code_but_no_tests(tmp_path, tests, extra, expected):
    done = _run_api_runner(tmp_path, tests, *extra)
    assert done.returncode == expected, f"exit {done.returncode}, expected {expected}\n{done.stdout}\n{done.stderr}"


# [utest->req~gate-tooling-ui-runner~1]
def test_ui_runner_passes_empty_in_frontend_job():
    # The configuration is outside the frozen acceptance/** path, so its shape is pinned here: it must not
    # filter the tests that --pass-with-no-tests would then report as passing.
    config = _strip_js_comments(_read(FRONTEND / "playwright.acceptance.config.ts"))
    assert len(re.findall(r"\btestDir\s*:", config)) == 1 and "testDir: '../acceptance/ui'" in config, (
        "playwright.acceptance.config.ts has no single testDir '../acceptance/ui'"
    )
    assert not re.search(r"\b(testIgnore|testMatch|grepInvert|grep|only)\b", config), "the UI runner configuration filters tests"
    assert re.search(r"\bprojects\s*:\s*\[\s*\{\s*name\s*:\s*'acceptance'\s*\}\s*\]", config), "the projects entries are not just a name"
    assert (ROOT / "acceptance" / "ui" / ".gitkeep").is_file(), "acceptance/ui/.gitkeep is missing"

    job = _job("frontend")
    runner = _step(job, "--config playwright.acceptance.config.ts")
    assert runner["run"].strip() == UI_RUNNER
    assert runner.get("working-directory") == "frontend"
    _fails_job(job, runner)
    steps = job["steps"]
    assert steps.index(_step(job, "playwright install")) < steps.index(runner)
    assert steps[-1] is runner, "the acceptance runner is not the last step of job frontend"


# [utest->req~gate-tooling-acceptance-docs~1]
def test_acceptance_docs_name_runners_and_writer():
    testing = _read(ROOT / "TESTING.md")
    section = re.search(r"^## 2\..*?(?=^## |\Z)", testing, re.DOTALL | re.MULTILINE)
    assert section, "TESTING.md has no section 2"
    for where, text in (("TESTING.md section 2", section.group(0)), ("acceptance/README.md", _read(ROOT / "acceptance" / "README.md"))):
        for needle in ("--pass-with-no-tests", "pytest -c acceptance/api/pytest.ini", "playwright.acceptance.config.ts", "test-designer"):
            assert needle in text, f"{where} does not contain {needle!r}"
        assert re.search(r"\bexits? 0\b", text), f"{where} does not say that the runners exit 0"
        assert re.search(r"\bonly\b[^.\n]{0,80}test-designer|test-designer[^.\n]{0,80}\bonly\b", text, re.IGNORECASE), (
            f"{where} does not say that only the test-designer writes the tests"
        )
    for needle in ("acceptance/api/<capability>/", "bim-engine/v1"):
        assert needle in section.group(0), f"TESTING.md section 2 does not contain {needle!r}"
    assert re.search(r"\bRemove\b[^.]*\bfirst acceptance test\b", section.group(0)), "TESTING.md section 2 does not say when to remove --pass-with-no-tests"
    headings = [line for line in testing.splitlines() if line.startswith("## 2.")]
    assert len(headings) == 1, headings
    assert "to be created" not in headings[0], headings[0]
