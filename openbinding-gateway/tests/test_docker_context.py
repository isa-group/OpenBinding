"""The build context of the gateway image: what its Dockerfile copies is what the ignore file lets through.

The images are built with the repository root as context (``docker-compose.yml``), so the root ``.dockerignore``
is the one effective ignore file; a ``Dockerfile.dockerignore`` beside the Dockerfile would silently take its
place under BuildKit, so there must not be one. The gateway installs ``bim-core`` and ``bim-client`` from the
repository and must not receive ``bim-service``, the toolchain's tests or its corpus.

The matcher follows Docker's ``patternmatcher``: patterns are read in order; a pattern that matches the path
or one of its parent directories flips the path to ignored (a plain pattern) or back to kept (``!pattern``).
"""

from __future__ import annotations

import functools
import re
import shlex

import yaml

from _repo import REPO_ROOT

DOCKERFILE = REPO_ROOT / "openbinding-gateway" / "Dockerfile"
IGNORE = REPO_ROOT / ".dockerignore"


def _regex(pattern: str) -> re.Pattern[str]:
    out = "^"
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i + 1 : i + 2] == "*":
                while pattern[i + 1 : i + 2] == "*":
                    i += 1
                if pattern[i + 1 : i + 2] == "/":
                    i += 1
                out += ".*" if i + 1 == len(pattern) else "(.*/)?"
            else:
                out += "[^/]*"
        elif char == "?":
            out += "[^/]"
        elif char in ".$+()|{}[]^\\":
            out += "\\" + char
        else:
            out += char
        i += 1
    return re.compile(out + "$")


@functools.lru_cache(maxsize=1)
def _patterns() -> list[tuple[bool, re.Pattern[str]]]:
    found = []
    for raw in IGNORE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        keep = line.startswith("!")
        line = line[1:].strip() if keep else line
        found.append((keep, _regex(line.strip("/"))))
    return found


def ignored(path: str) -> bool:
    """Whether the build context leaves ``path`` (relative to the repository root, with ``/``) out."""
    patterns = _patterns()
    parents = path.split("/")[:-1]
    candidates = ["/".join(parents[: i + 1]) for i in range(len(parents))]
    matched = False
    for keep, regex in patterns:
        if keep != matched:
            continue
        if regex.match(path) or any(regex.match(parent) for parent in candidates):
            matched = not matched
    return matched


def copied_sources() -> list[str]:
    sources = []
    for line in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        if not line.startswith("COPY "):
            continue
        words = shlex.split(line)
        if any(word.startswith("--from") for word in words):
            continue
        sources.extend(word for word in words[1:-1] if not word.startswith("--"))
    return sources


def files_of(source: str) -> list[str]:
    path = REPO_ROOT / source
    if path.is_dir():
        return sorted(
            item.relative_to(REPO_ROOT).as_posix()
            for item in path.rglob("*")
            if item.is_file() and "__pycache__" not in item.parts and item.suffix != ".pyc"
        )
    return [source]


def test_the_matcher_follows_docker_semantics() -> None:
    assert ignored("README.md") is True
    assert ignored("openbinding-gateway/src/openbinding_gateway/main.py") is False
    assert ignored("openbinding-gateway/src/openbinding_gateway/__pycache__/main.cpython-311.pyc") is True
    assert ignored("bim-toolchain/packages/bim-core/pyproject.toml") is False
    assert ignored("bim-toolchain/packages/bim-core/src/bim_core/compiler.py") is False
    assert ignored("bim-toolchain/packages/bim-core/src/bim_core/__pycache__/compiler.cpython-311.pyc") is True


def test_there_is_one_effective_ignore_file_and_it_is_the_one_at_the_root() -> None:
    assert IGNORE.is_file()
    assert not (REPO_ROOT / "openbinding-gateway" / "Dockerfile.dockerignore").exists()
    assert not (REPO_ROOT / "Dockerfile.dockerignore").exists()

    compose = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    builds = [
        service["build"]
        for service in compose["services"].values()
        if isinstance(service.get("build"), dict) and service["build"].get("dockerfile") == "openbinding-gateway/Dockerfile"
    ]
    assert builds and all(build["context"] == "." for build in builds)


def test_every_path_the_dockerfile_copies_is_in_the_build_context() -> None:
    sources = copied_sources()
    assert any(source.startswith("bim-toolchain/packages/bim-core/") for source in sources)
    assert any(source.startswith("bim-toolchain/packages/bim-client/") for source in sources)

    missing = []
    for source in sources:
        files = files_of(source)
        if not files or not (REPO_ROOT / source).exists():
            missing.append(f"{source}: does not exist")
        missing.extend(f"{source}: {name} is ignored" for name in files if ignored(name))
    assert not missing, "the Dockerfile copies what the ignore file removes:\n" + "\n".join(missing)


def test_the_packages_the_dockerfile_installs_are_copied_with_their_metadata() -> None:
    text = DOCKERFILE.read_text(encoding="utf-8")
    installed = re.findall(r"/bim-toolchain/packages/(bim-[a-z]+)(?=\s|$)", text)
    assert sorted(set(installed)) == ["bim-client", "bim-core"]
    for package in installed:
        for name in ("pyproject.toml", "README.md", "NOTICE.md"):
            assert f"bim-toolchain/packages/{package}/{name}" in copied_sources()


def test_the_service_the_tests_and_the_corpus_stay_out_of_the_gateway_context() -> None:
    for name in (
        "bim-toolchain/packages/bim-service/pyproject.toml",
        "bim-toolchain/packages/bim-service/src/bim_service/app.py",
        "bim-toolchain/packages/bim-core/tests/test_compiler.py",
        "bim-toolchain/packages/bim-client/tests/test_equivalence.py",
        "bim-toolchain/corpus/example/instance.json",
        "bim-toolchain/golden/bim_baseline/corpus.json",
        "bim-toolchain/tools/baseline_core.py",
    ):
        assert ignored(name), name
    instructions = [
        line for line in DOCKERFILE.read_text(encoding="utf-8").splitlines() if line.startswith(("COPY ", "RUN "))
    ]
    assert not [line for line in instructions if "bim-service" in line]
