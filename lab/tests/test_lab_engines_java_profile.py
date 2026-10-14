"""Static checks of ``compose.lab-engines-java.json``, without Docker.

The profile re-runs the JUnit suites of ``binding-core`` and of the four JVM engines (including their ``*CancelTest``
classes, which drive the asynchronous mode over real HTTP) inside the ``builder`` stage of the engines' own
Dockerfiles, that is, on the JDK those images are built with: JDK 8 for random-search, many-heuristic and
multi-heuristic, and JDK 21 for the evolutionary engine.

Why not one ``seed`` service for everything: ``lab_compose seed`` runs only the service named ``seed``, but the
``builder`` stage of every Dockerfile copies ``binding-core`` and **only its own engine** into ``/app``, and no
Dockerfile may be added.  So ``seed`` runs the random-search builder (``binding-core`` + ``random-search``, JDK 8) and
the other three engines run as services without a profile, which ``up`` starts and which are healthy only if their
suites passed (the pattern of ``engine-real-tests`` in ``compose.lab-engines.json``).  ``image-builder`` builds the
image ``seed`` reuses, as in ``compose.pgtest.json``.

Every service runs as a non-root user, writes only to a size-capped tmpfs, publishes no port, has a modest memory
limit and must pass the rules of ``compose.lab.json`` that apply to it.  Nothing here starts a container: executing
the profile is up to ``lab_compose`` (see ``docs/qa/ENGINE_CANCELLATION_JAVA.md``).

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
ENGINES = ROOT / "engines"
# service -> engine module whose suite it runs
MODULES = {
    "seed": "random-search",
    "engines-java-many-heuristic": "many-heuristic",
    "engines-java-multi-heuristic": "multi-heuristic",
    "engines-java-evolutionary": "evolutionary-heuristics",
}
RUNNERS = ["engines-java-many-heuristic", "engines-java-multi-heuristic", "engines-java-evolutionary"]
EXPECTED_SERVICES = ["image-builder", *RUNNERS, "seed"]
CANCEL_TESTS = {
    "random-search": "RandomSearchCancelTest",
    "many-heuristic": "ManyHeuristicCancelTest",
    "multi-heuristic": "MultiHeuristicCancelTest",
    "evolutionary-heuristics": "EvolutionaryCancelTest",
}
MAX_SERVICE_MIB = 1024


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(PROFILE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def services(manifest) -> dict:
    return manifest["services"]


def _script(service: dict) -> str:
    command = service["command"]
    assert command[:2] == ["sh", "-ec"] and len(command) == 3
    return command[2]


def _builder_stage(dockerfile: Path) -> str:
    text = dockerfile.read_text(encoding="utf-8")
    assert re.search(r"(?im)^FROM\s+\S+\s+AS\s+builder\s*$", text), dockerfile
    return re.split(r"(?im)^FROM\s", text)[1]  # from the first FROM to the second one


def test_shape_and_names_follow_the_validator_rules(manifest):
    assert set(manifest) <= rules.ALLOWED_TOP_LEVEL
    assert {"name", "services"} <= set(manifest)
    assert manifest["name"] == "openbinding-engines-java"
    assert rules.NAME_PATTERN.fullmatch(manifest["name"])
    assert list(manifest["services"]) == EXPECTED_SERVICES
    for name in manifest["services"]:
        assert rules.NAME_PATTERN.fullmatch(name), name
    for section in ("networks", "volumes"):
        for name, definition in (manifest.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"


def test_there_is_exactly_one_seed_service_and_it_is_the_only_profile_one(services):
    """``lab_compose seed`` runs only the service named ``seed``; ``up`` starts the others."""
    assert services["seed"]["profiles"] == ["seed"]
    assert [name for name, service in services.items() if "profiles" in service] == ["seed"]
    assert [name for name, service in services.items() if "profiles" not in service] == ["image-builder", *RUNNERS]
    assert not [name for name in services if name.startswith("engines-java-") and name.endswith("-random-search")]


def test_seed_reuses_the_image_that_up_builds_like_the_pgtest_profile(services):
    pgtest = json.loads((ROOT / "compose.pgtest.json").read_text(encoding="utf-8"))["services"]
    builder, seed = services["image-builder"], services["seed"]
    assert "build" not in seed and seed["image"] == builder["image"] == "openbinding-engines-java-builder:latest"
    assert builder["build"] == {"context": "engines", "dockerfile": "random-search/Dockerfile", "target": "builder"}
    for key in ("entrypoint", "command", "mem_limit", "healthcheck", "user"):
        assert builder[key] == pgtest["image-builder"][key], key
    assert seed["entrypoint"] == pgtest["seed"]["entrypoint"] == []


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
        total += mib
        if name == "image-builder":
            assert mib <= 64
            continue
        assert 256 <= mib <= MAX_SERVICE_MIB, name
        heap = re.search(r"-Xmx(\d+)m", rules._env(service)["MAVEN_OPTS"])
        assert heap, name
        tmpfs = service["volumes"][0]["tmpfs"]["size"] // (1024 * 1024)
        # The heap of Maven, its forked test JVM (default sizing) and the tmpfs all count against the limit.
        assert int(heap.group(1)) + tmpfs < mib, name
    assert total <= rules.MAX_MIB


def test_the_only_mount_is_a_size_capped_tmpfs_on_tmp(services):
    assert "volumes" not in services["image-builder"]
    for name in MODULES:
        service = services[name]
        assert len(service["volumes"]) == 1, name
        mount = service["volumes"][0]
        assert set(mount) <= rules.ALLOWED_MOUNT_KEYS, name
        assert mount["type"] == "tmpfs" and mount["target"] == "/tmp", name
        assert set(mount["tmpfs"]) == {"mode", "size"} and mount["tmpfs"]["size"] <= 512 * 1024 * 1024, name
        env = rules._env(service)
        assert service["working_dir"] == "/tmp" and env["HOME"] == "/tmp", name
        assert env["MAVEN_CONFIG"].startswith("/tmp/"), f"{name}: the maven image points it at /root/.m2"
        assert service["entrypoint"] == [], f"{name}: the maven entrypoint writes to /root/.m2, which a non-root user cannot"


def test_builds_use_the_builder_stage_of_the_engines_own_dockerfile(services):
    for name in ("image-builder", *RUNNERS):
        build = services[name]["build"]
        module = "random-search" if name == "image-builder" else MODULES[name]
        assert set(build) <= rules.ALLOWED_BUILD_KEYS, name
        assert build["context"] == "engines" and build["target"] == "builder", name
        assert build["dockerfile"] == f"{module}/Dockerfile", name
        assert (ROOT / build["context"] / build["dockerfile"]).is_file(), name
        _builder_stage(ROOT / build["context"] / build["dockerfile"])
        assert (ENGINES / module / "pom.xml").is_file() and (ENGINES / "binding-core" / "pom.xml").is_file(), name


def test_each_builder_holds_binding_core_and_only_its_own_engine():
    """The reason there is more than one service: no single ``/app`` has the whole reactor."""
    for module in ("random-search", "many-heuristic", "multi-heuristic", "evolutionary-heuristics"):
        stage = _builder_stage(ENGINES / module / "Dockerfile")
        copied = set(re.findall(r"(?m)^COPY\s+([\w-]+)[/\s]", stage))
        assert copied == {"binding-core", module}, (module, copied)
    # a different JDK for the evolutionary engine, so it can never share a builder with the others
    assert "openjdk-8" in (ENGINES / "random-search" / "Dockerfile").read_text(encoding="utf-8")
    assert "temurin-21" in (ENGINES / "evolutionary-heuristics" / "Dockerfile").read_text(encoding="utf-8")


def test_each_builder_makes_app_readable_before_the_first_maven_run():
    """The lab copies /app as a non-root user; the build context checkout leaves the sources root-only."""
    for module in ("random-search", "many-heuristic", "multi-heuristic", "evolutionary-heuristics"):
        stage = _builder_stage(ENGINES / module / "Dockerfile")
        chmod = stage.find("RUN chmod -R a+rX /app")
        maven = stage.find("mvn")
        assert chmod != -1, module
        assert maven != -1 and chmod < maven, module


def test_the_scripts_test_binding_core_and_every_engine_with_maven_inside_the_container(services):
    tested_core = []
    for name, module in MODULES.items():
        script = _script(services[name])
        assert "$" not in script.replace("$$", ""), f"{name}: every $ must be escaped as $$ for compose"
        assert script.startswith("cp -r /app /tmp/work; "), name
        assert "mvn -B -Dmaven.repo.local=/tmp/m2" in script and "-o " not in script, name
        assert "rm " not in script and "sudo" not in script and "skipTests test" not in script, name
        steps = [step.strip() for step in script.split("; ")]
        assert f"mz {module} test" in steps, name
        assert f"report {module}" in steps, f"{name}: prints the 'Tests run' lines"
        assert steps.index(f"mz {module} test") < steps.index(f"report {module}"), name
        if "mz binding-core install" in steps:
            tested_core.append(name)
            assert "report binding-core" in steps, name
        else:
            assert "mz binding-core -DskipTests install" in steps, f"{name}: the engine's tests need the installed core"
        install = [i for i, step in enumerate(steps) if step.startswith("mz binding-core")]
        assert install and install[0] < steps.index(f"mz {module} test"), name
        assert "grep \"Tests run:\" /tmp/$$1.log" in script, f"{name}: a summary line is required, so no silent zero tests"
        assert f"echo {'engines-java-random-search' if name == 'seed' else name}-ok" in steps, name
    # binding-core's own suite runs once per JDK: JDK 8 in the seed, JDK 21 in the evolutionary builder
    assert tested_core == ["seed", "engines-java-evolutionary"]


def test_the_runners_are_healthy_only_after_their_suites_passed(services):
    for name in RUNNERS:
        service = services[name]
        script = _script(service)
        steps = [step.strip() for step in script.split("; ")]
        assert steps[-2:] == ["touch /tmp/engines-java-ok", "exec sleep infinity"], name
        assert steps.index(f"report {MODULES[name]}") < steps.index("touch /tmp/engines-java-ok"), name
        assert service["healthcheck"]["test"] == ["CMD-SHELL", "test -f /tmp/engines-java-ok"], name
        assert service["restart"] == "no", name
    seed = services["seed"]
    assert seed["restart"] == "no" and "healthcheck" not in seed, "seed is one-shot"
    assert "sleep" not in _script(seed)


def test_every_suite_the_scripts_depend_on_exists_including_the_cancel_tests():
    for module, cancel in CANCEL_TESTS.items():
        assert list((ENGINES / module / "src" / "test").rglob(f"{cancel}.java")), module
        assert "maven-surefire-plugin" in (ENGINES / module / "pom.xml").read_text(encoding="utf-8"), module
    assert list((ENGINES / "binding-core" / "src" / "test").rglob("EngineJobsTest.java"))
    assert list((ENGINES / "binding-core" / "src" / "test").rglob("EngineHttpTest.java"))


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
