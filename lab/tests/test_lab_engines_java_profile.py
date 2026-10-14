"""Static checks of ``compose.lab-engines-java.json``, without Docker.

The profile re-runs the JUnit suites of the four JVM engines (including their ``*CancelTest`` classes, which
drive the asynchronous mode over real HTTP) inside the ``builder`` stage of each engine's own Dockerfile: the JDK 8
the production images run on for random-search, many-heuristic and multi-heuristic, and the JDK 21 of the
evolutionary engine.  Every service is one-shot behind the ``seed`` profile, runs as a non-root user, writes only
to a size-capped tmpfs, publishes no port and has a modest memory limit.  It must pass the rules of
``compose.lab.json`` that apply to a seed-profile service.

Nothing here starts a container: executing the profile is up to ``lab_compose`` (see
``docs/qa/ENGINE_CANCELLATION_JAVA.md``).

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

_spec = importlib.util.spec_from_file_location("lab_compose_rules", HERE / "test_lab_compose.py")
rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rules)

PROFILE = ROOT / "compose.lab-engines-java.json"
DOC = ROOT / "docs" / "qa" / "ENGINE_CANCELLATION_JAVA.md"
MODULES = {
    "engines-java-random-search": "random-search",
    "engines-java-many-heuristic": "many-heuristic",
    "engines-java-multi-heuristic": "multi-heuristic",
    "engines-java-evolutionary": "evolutionary-heuristics",
}
MAX_SERVICE_MIB = 1024


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(PROFILE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def services(manifest) -> dict:
    return manifest["services"]


def test_shape_and_names_follow_the_validator_rules(manifest):
    assert set(manifest) <= rules.ALLOWED_TOP_LEVEL
    assert {"name", "services"} <= set(manifest)
    assert manifest["name"] == "openbinding-engines-java"
    assert rules.NAME_PATTERN.fullmatch(manifest["name"])
    assert set(manifest["services"]) == set(MODULES)
    for name in manifest["services"]:
        assert rules.NAME_PATTERN.fullmatch(name), name
    for section in ("networks", "volumes"):
        for name, definition in (manifest.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"


def test_every_service_is_one_shot_behind_the_seed_profile(services):
    for name, service in services.items():
        assert service["profiles"] == ["seed"], name
        assert service["restart"] == "no", name
        assert "healthcheck" not in service, f"{name}: a one-shot service has nothing to keep healthy"


def test_no_forbidden_key_no_network_exposure_no_socket(manifest, services):
    for name, service in services.items():
        assert not (set(service) & rules.FORBIDDEN_SERVICE_KEYS), name
        assert service.get("network_mode", "none") == "none", name
        for key in ("networks", "ports", "expose", "depends_on", "tmpfs", "secrets", "env_file"):
            assert key not in service, f"{name}: {key}"
    assert not [text for text in rules._strings(manifest) if ".sock" in text]


def test_every_service_runs_as_a_non_root_numeric_user(services):
    for name, service in services.items():
        match = re.fullmatch(r"(\d+):(\d+)", service["user"])
        assert match and int(match.group(1)) > 0 and int(match.group(2)) > 0, name


def test_memory_is_modest_and_the_heap_fits_inside_it(services):
    total = 0
    for name, service in services.items():
        mib = rules._mib(service["mem_limit"])
        assert 256 <= mib <= MAX_SERVICE_MIB, name
        heap = re.search(r"-Xmx(\d+)m", rules._env(service)["MAVEN_OPTS"])
        assert heap, name
        tmpfs = service["volumes"][0]["tmpfs"]["size"] // (1024 * 1024)
        # The heap of Maven, its forked test JVM (default sizing) and the tmpfs all count against the limit.
        assert int(heap.group(1)) + tmpfs < mib, name
        total += mib
    assert total <= rules.MAX_MIB


def test_the_only_mount_is_a_size_capped_tmpfs_on_tmp(services):
    for name, service in services.items():
        assert len(service["volumes"]) == 1, name
        mount = service["volumes"][0]
        assert set(mount) <= rules.ALLOWED_MOUNT_KEYS, name
        assert mount["type"] == "tmpfs" and mount["target"] == "/tmp", name
        assert set(mount["tmpfs"]) == {"mode", "size"} and mount["tmpfs"]["size"] <= 512 * 1024 * 1024, name
        assert service["working_dir"] == "/tmp" and rules._env(service)["HOME"] == "/tmp", name


def test_builds_use_the_builder_stage_of_the_engines_own_dockerfile(services):
    for name, service in services.items():
        build = service["build"]
        assert set(build) <= rules.ALLOWED_BUILD_KEYS, name
        assert build["context"] == "engines" and build["target"] == "builder", name
        assert build["dockerfile"] == f"{MODULES[name]}/Dockerfile", name
        dockerfile = ROOT / build["context"] / build["dockerfile"]
        assert dockerfile.is_file(), name
        assert re.search(r"(?im)^FROM\s+\S+\s+AS\s+builder\s*$", dockerfile.read_text(encoding="utf-8")), name
        assert (ROOT / build["context"] / MODULES[name] / "pom.xml").is_file(), name
        assert (ROOT / build["context"] / "binding-core" / "pom.xml").is_file(), name


def test_the_command_tests_exactly_its_module_and_writes_only_under_tmp(services):
    for name, service in services.items():
        module = MODULES[name]
        command = service["command"]
        assert command[:2] == ["sh", "-ec"] and len(command) == 3, name
        script = command[2]
        assert "$" not in script, f"{name}: no variable expansion by compose or the shell"
        steps = script.split(" && ")
        assert steps[0] == "cp -r /app /tmp/work", name
        assert steps[1] == "cd /tmp/work/binding-core", name
        assert steps[2] == "mvn -B -q -Dmaven.repo.local=/tmp/m2 -DskipTests install", name
        assert steps[3] == f"cd /tmp/work/{module}", name
        assert steps[4] == "mvn -B -Dmaven.repo.local=/tmp/m2 test", name
        assert steps[5] == f"echo {name}-ok", name
        assert len(steps) == 6, name
        assert "-o " not in script and "rm " not in script and "sudo" not in script, name


def test_no_secret_no_reference_no_destructive_key(manifest, services):
    text = PROFILE.read_text(encoding="utf-8")
    assert not rules.SECRET_SHAPES.search(text)
    assert rules.DESTRUCTIVE_KEY not in text
    assert not rules.REFERENCE.findall(text)
    for name, service in services.items():
        for variable in rules._env(service):
            assert not rules.SECRET_NAME.search(variable), f"{name}: {variable}"


def test_the_engine_images_still_boot_without_the_async_variables():
    """The profile must not need ENGINE_JOB_MODE: the default mode of every image stays synchronous."""
    text = PROFILE.read_text(encoding="utf-8")
    assert "ENGINE_JOB_MODE" not in text and "ENGINE_AUTH_TOKENS" not in text


def test_the_documentation_names_the_profile_and_that_it_was_not_executed_by_the_worker():
    doc = DOC.read_text(encoding="utf-8")
    assert "compose.lab-engines-java.json" in doc
    assert "NO EJECUTADO" in doc
    for name in MODULES:
        assert name in doc, name
