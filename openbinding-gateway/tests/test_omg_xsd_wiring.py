"""The five OMG BPMN 2.0.2 XSDs are not versioned in Git, and every route that builds or runs the toolchain from a clean
checkout puts them in place first: the Dockerfiles that install ``bim-core``, the build contexts that must let the build
hook through, and the workflows.

The files are read as text and YAML; nothing here builds an image, runs a workflow or touches the network. The download
itself (``bim-toolchain/packages/bim-core/hatch_build.py``) is tested with an injected opener in
``bim-toolchain/tools/test_xsd_inventory.py``.
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path

import pytest
import yaml

import test_docker_context as docker_context
from _repo import REPO_ROOT

TOOLCHAIN = REPO_ROOT / "bim-toolchain"
HOOK = "bim-toolchain/packages/bim-core/hatch_build.py"
XSD_PATTERN = "packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/*.xsd"
ENSURE = re.compile(r"^RUN python3? \S*hatch_build\.py --ensure$")

#: Dockerfile -> (context directory relative to the repository, the install the ensure step must precede)
DOCKERFILES = {
    "openbinding-gateway/Dockerfile": (".", re.compile(r"uv pip install .*bim-core")),
    "experimentation/qacobench/Gateway.Dockerfile": (".", re.compile(r"uv pip install .*bim-core")),
    "experimentation/qacobench/Dockerfile": (".", re.compile(r"uv pip install .*requirements\.lock")),
    "bim-toolchain/packages/bim-service/Dockerfile": ("bim-toolchain", re.compile(r"pip install .*bim-core")),
}


def need(path: Path) -> Path:
    if not path.is_file():
        pytest.skip(f"{path.name} is not part of this checkout")
    return path


def instructions(path: Path) -> list[str]:
    """The Dockerfile instructions, continuation lines joined and comments dropped."""
    found: list[str] = []
    pending = ""
    for raw in need(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#") or (not line and not pending):
            continue
        if line.endswith("\\"):
            pending += line[:-1].strip() + " "
            continue
        found.append((pending + line).strip())
        pending = ""
    return found


def copy_sources(line: str) -> list[str]:
    words = shlex.split(line)
    return [word for word in words[1:-1] if not word.startswith("--")]


# --- the images ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("dockerfile", sorted(DOCKERFILES))
def test_the_image_downloads_and_verifies_the_xsds_after_copying_bim_core_and_before_installing_it(dockerfile: str) -> None:
    _, install = DOCKERFILES[dockerfile]
    lines = instructions(REPO_ROOT / dockerfile)
    ensure_at = [i for i, line in enumerate(lines) if ENSURE.match(line)]
    assert len(ensure_at) == 1, f"{dockerfile}: expected one `RUN python .../hatch_build.py --ensure`"
    at = ensure_at[0]
    copies = [(i, copy_sources(line)) for i, line in enumerate(lines) if line.startswith("COPY ") and "--from" not in line]
    hook_copied = [i for i, sources in copies if any(s.endswith("bim-core/hatch_build.py") or s.endswith("bim-core/") for s in sources)]
    source_copied = [i for i, sources in copies if any(s.rstrip("/").endswith("bim-core/src") or s.endswith("bim-core/") for s in sources)]
    assert hook_copied and min(hook_copied) < at, f"{dockerfile}: the hook is not copied before it runs"
    assert source_copied and min(source_copied) < at, f"{dockerfile}: the files are downloaded before the sources are copied"
    installs = [i for i, line in enumerate(lines) if install.search(line)]
    assert installs, f"{dockerfile}: no install matching {install.pattern!r}"
    assert at < min(installs), f"{dockerfile}: the XSDs are downloaded after the install"


def test_the_ensure_step_is_the_script_of_the_build_hook_and_checks_every_digest() -> None:
    script = need(TOOLCHAIN / "packages" / "bim-core" / "hatch_build.py").read_text(encoding="utf-8")
    licenses = (TOOLCHAIN / "licenses.json").read_text(encoding="utf-8")
    assert "https://www.omg.org/spec/BPMN/20100501/" in script and "--ensure" in script
    for digest in re.findall(r'"[A-Za-z0-9]+\.xsd": "([0-9a-f]{64})"', script):
        assert digest in licenses
    assert len(re.findall(r'"[A-Za-z0-9]+\.xsd": "[0-9a-f]{64}"', script)) == 5


# --- the build contexts ------------------------------------------------------------------------------------


def test_the_root_dockerignore_lets_the_hook_through_and_still_leaves_the_toolchain_tests_out() -> None:
    assert docker_context.ignored(HOOK) is False
    assert docker_context.ignored("bim-toolchain/packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/BPMN20.xsd") is False
    assert docker_context.ignored("bim-toolchain/packages/bim-core/tests/test_compiler.py") is True
    assert docker_context.ignored("bim-toolchain/packages/bim-service/pyproject.toml") is True


def test_the_root_context_carries_what_each_image_copies_of_bim_core() -> None:
    for dockerfile, (context, _) in DOCKERFILES.items():
        if context != ".":
            continue
        for line in instructions(REPO_ROOT / dockerfile):
            if not line.startswith("COPY ") or "--from" in line:
                continue
            for source in copy_sources(line):
                if source.endswith("bim-core/hatch_build.py"):
                    assert (REPO_ROOT / source).is_file(), f"{dockerfile}: {source} does not exist"
                    assert docker_context.ignored(source) is False, f"{dockerfile}: {source} is ignored by .dockerignore"


def test_the_service_context_does_not_ignore_the_hook() -> None:
    """The context of the bim-service image is bim-toolchain/ and its ignore file removes tests, tools and docs, not the hook."""
    patterns = [
        line.strip() for line in need(TOOLCHAIN / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert not any(pattern.startswith("!") for pattern in patterns)
    hook = "packages/bim-core/hatch_build.py"
    for pattern in patterns:
        regex = docker_context._regex(pattern.strip("/"))
        parents = ["/".join(hook.split("/")[: i + 1]) for i in range(len(hook.split("/")) - 1)]
        assert not regex.match(hook) and not any(regex.match(parent) for parent in parents), pattern


# --- Git and the workflows ---------------------------------------------------------------------------------


def test_both_gitignore_files_ignore_the_five_files() -> None:
    for gitignore, pattern in (
        (REPO_ROOT / ".gitignore", f"/bim-toolchain/{XSD_PATTERN}"),
        (TOOLCHAIN / ".gitignore", f"/{XSD_PATTERN}"),
    ):
        lines = [line.strip() for line in need(gitignore).read_text(encoding="utf-8").splitlines()]
        assert pattern in lines, f"{gitignore}: {pattern}"


def steps_of(workflow: Path) -> dict[str, list[dict]]:
    document = yaml.safe_load(need(workflow).read_text(encoding="utf-8"))
    return {name: job["steps"] for name, job in document["jobs"].items() if "steps" in job}


def test_every_checkout_of_the_toolchain_workflows_is_followed_by_the_verified_download() -> None:
    for name in ("ci.yml", "release.yml"):
        jobs = steps_of(TOOLCHAIN / ".github" / "workflows" / name)
        checkouts = 0
        for job, steps in jobs.items():
            for index, step in enumerate(steps):
                if str(step.get("uses", "")).startswith("actions/checkout@"):
                    checkouts += 1
                    assert steps[index + 1].get("run") == "python3 tools/xsd_inventory.py --ensure", f"{name}: {job}"
        assert checkouts >= 1, name


def test_the_lint_job_also_checks_that_git_does_not_version_the_files() -> None:
    steps = steps_of(TOOLCHAIN / ".github" / "workflows" / "ci.yml")["lint"]
    assert any(step.get("run") == "python3 tools/xsd_inventory.py --check" for step in steps)


def test_the_action_pins_stay_marked_as_pending_in_the_toolchain_workflows() -> None:
    for name in ("ci.yml", "release.yml"):
        text = need(TOOLCHAIN / ".github" / "workflows" / name).read_text(encoding="utf-8")
        uses = [line for line in text.splitlines() if re.match(r"\s*(?:-\s+)?uses:", line)]
        assert uses and all("PIN-PENDING" in line for line in uses), name


def test_the_root_ci_ensures_and_checks_the_files_before_the_locked_environment_builds_bim_core() -> None:
    steps = steps_of(REPO_ROOT / ".github" / "workflows" / "ci.yml")["bim-corpus"]
    runs = [step.get("run", "") for step in steps]
    ensure = next(i for i, run in enumerate(runs) if "bim-toolchain/tools/xsd_inventory.py --ensure" in run)
    assert "bim-toolchain/tools/xsd_inventory.py --check" in runs[ensure]
    sync = next(i for i, run in enumerate(runs) if "uv sync" in run)
    checkout = next(i for i, step in enumerate(steps) if str(step.get("uses", "")).startswith("actions/checkout@"))
    assert checkout < ensure < sync
