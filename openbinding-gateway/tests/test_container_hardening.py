"""Static hardening of the gateway image and of the lab compose file.

Nothing here builds or runs a container: the Dockerfile is read as text and ``compose.lab.json`` as JSON.
Root inside a rootless container is not root on the host, but an unprivileged user is still the practice, so the
image must end on a numeric non-root ``USER`` and everything that user writes must be a path it owns.
"""

from __future__ import annotations

import json
import re

import pytest

from _repo import REPO_ROOT

DOCKERFILE = REPO_ROOT / "openbinding-gateway" / "Dockerfile"
COMPOSE = REPO_ROOT / "compose.lab.json"

IMAGE_USER = 10001
ARTIFACT_DIR = "/var/lib/openbinding/artifacts"
SHARED_IMAGE = "openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}"
MAX_MIB = 4096
# The sum of every mem_limit of compose.lab.json, seed included (docs/DEMO.md states it): 3456 before e2e (576).
EXPECTED_MIB = 4032
S_IWOTH = 0o002

# A reference to a variable the supervisor supplies: nothing else may stand where a secret goes.
ALLOWED_REFERENCE = re.compile(r"\$\{(?:DEMO|SPACE|SPHERE)_[A-Z0-9_]+\}")
# The only references allowed a default: the public origin and the lab port fall back to the local port.
ALLOWED_DEFAULT_REFERENCE = {"DEMO_PUBLIC_ORIGIN:-http://localhost:18100", "DEMO_LAB_PORT:-18100"}
ANY_REFERENCE = re.compile(r"\$\{([^}]*)\}")
SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD", re.IGNORECASE)
SECRET_SHAPES = re.compile(
    r"BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.|\bAKIA[0-9A-Z]{12,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}"
)


@pytest.fixture(scope="module")
def dockerfile() -> str:
    # The test also runs inside the image, which carries neither the Dockerfile nor the compose file.
    if not DOCKERFILE.is_file():
        pytest.skip("the Dockerfile is not part of this checkout")
    return DOCKERFILE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def instructions(dockerfile: str) -> list[str]:
    """The Dockerfile instructions, continuation lines joined and comments dropped."""
    joined: list[str] = []
    pending = ""
    for raw in dockerfile.splitlines():
        line = raw.strip()
        if not pending and (not line or line.startswith("#")):
            continue
        pending += line.removesuffix("\\").strip() + " "
        if not line.endswith("\\"):
            joined.append(pending.strip())
            pending = ""
    return joined


@pytest.fixture(scope="module")
def services() -> dict:
    if not COMPOSE.is_file():
        pytest.skip("compose.lab.json is not part of this checkout")
    return json.loads(COMPOSE.read_text(encoding="utf-8"))["services"]


def _mib(value: str) -> int:
    match = re.fullmatch(r"(\d+)([mg])", str(value))
    assert match, f"mem_limit must be an integer with m or g, not {value!r}"
    return int(match.group(1)) * (1024 if match.group(2) == "g" else 1)


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from _strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _strings(item)


# -- the Dockerfile --------------------------------------------------------------------------------


def test_uv_is_pinned_to_a_release_and_nothing_uses_latest(instructions: list[str]) -> None:
    uv = [line for line in instructions if line.startswith(("FROM ", "COPY ")) and "astral-sh/uv" in line]
    assert uv, "the image no longer takes uv from ghcr.io/astral-sh/uv"
    for line in uv:
        assert re.search(r"astral-sh/uv:\d+\.\d+\.\d+(?=\s)", line), f"uv must name an explicit version: {line}"
    for line in instructions:
        if line.startswith("FROM ") or " --from=" in line:
            assert ":latest" not in line, line
    # An untagged FROM is :latest too.
    # A FROM naming an earlier stage (``FROM base AS test``) is not an image.
    stages: set[str] = set()
    for line in instructions:
        if line.startswith("FROM "):
            words = line.split()
            image = words[1]
            is_stage = image in stages
            if len(words) >= 4 and words[2].upper() == "AS":
                stages.add(words[3])
            if is_stage:
                continue
            assert ":" in image.rsplit("/", 1)[-1] or "@sha256:" in image, f"untagged base image: {line}"


def test_the_image_ends_on_a_numeric_non_root_user(instructions: list[str]) -> None:
    users = [line.split(None, 1)[1] for line in instructions if line.startswith("USER ")]
    assert users, "the image has no USER: it would run as root"
    final = users[-1]
    match = re.fullmatch(r"(\d+)(?::(\d+))?", final)
    assert match, f"USER must be numeric (a name cannot be checked against the base image): {final}"
    assert int(match.group(1)) == IMAGE_USER
    assert match.group(2) is not None and int(match.group(2)) == IMAGE_USER
    last_user = max(i for i, line in enumerate(instructions) if line.startswith("USER "))
    for line in instructions[last_user:]:
        assert not re.search(r"\b(?:su|sudo|gosu|chown)\b", line), line


def test_the_user_has_fixed_ids_and_no_login_shell(instructions: list[str]) -> None:
    text = "\n".join(instructions)
    assert re.search(rf"groupadd\b[^&]*--gid {IMAGE_USER}\b", text)
    useradd = re.search(r"useradd\b[^&]*", text)
    assert useradd, "no user is created"
    assert f"--uid {IMAGE_USER}" in useradd.group(0) and f"--gid {IMAGE_USER}" in useradd.group(0)
    assert re.search(r"--shell /(?:usr/)?sbin/nologin|--shell /bin/false", useradd.group(0))


def test_the_user_is_created_and_the_artifact_directory_owned_before_user_takes_effect(instructions: list[str]) -> None:
    user_at = max(i for i, line in enumerate(instructions) if line.startswith("USER "))
    created = [i for i, line in enumerate(instructions) if line.startswith("RUN ") and "useradd" in line]
    parent = ARTIFACT_DIR.rsplit("/", 1)[0]
    chown = rf"chown\b(?: -R)? {IMAGE_USER}:{IMAGE_USER} (?:{re.escape(ARTIFACT_DIR)}|{re.escape(parent)})(?:\s|$)"
    # A named volume inherits the owner of the image directory only if the directory exists in the image.
    owned = [
        i
        for i, line in enumerate(instructions)
        if line.startswith("RUN ") and f"mkdir -p {ARTIFACT_DIR}" in line and re.search(chown, line)
    ]
    assert created and owned, f"{ARTIFACT_DIR} must exist in the image owned by {IMAGE_USER}:{IMAGE_USER}"
    assert max(created) < user_at and max(owned) < user_at


def test_the_user_instruction_comes_after_the_dependencies_are_installed(instructions: list[str]) -> None:
    user_at = max(i for i, line in enumerate(instructions) if line.startswith("USER "))
    installs = [i for i, line in enumerate(instructions) if "uv pip install" in line or "pip install" in line]
    assert installs and max(installs) < user_at, "dependencies are installed system-wide and need root"
    copies = [i for i, line in enumerate(instructions) if line.startswith("COPY ")]
    assert max(copies) < user_at
    assert any(line.startswith("ENTRYPOINT ") for line in instructions[user_at:])


def test_the_local_bim_packages_install_in_the_same_command_as_the_gateway(instructions: list[str]) -> None:
    # uv 0.8.22 ignores an already installed bim-core when resolving the gateway, so one command must name all three.
    installs = [line for line in instructions if line.startswith("RUN ") and "uv pip install" in line]
    assert len(installs) == 1, installs
    command = installs[0]
    assert "--no-sources" in command
    assert "/bim-toolchain/packages/bim-core" in command
    assert "/bim-toolchain/packages/bim-client" in command
    assert '".[test]"' in command
    # Their sources are copied before the install, so the layers still cache.
    install_at = instructions.index(command)
    for source in ("bim-core/src/", "bim-client/src/", "openbinding-gateway/pyproject.toml", "openbinding-gateway/src/"):
        assert any(i < install_at and line.startswith("COPY ") and source in line for i, line in enumerate(instructions)), source


def test_code_stays_readable_and_curl_stays_for_the_healthcheck(instructions: list[str]) -> None:
    text = "\n".join(instructions)
    assert re.search(r"apt-get install[^&]*\bcurl\b", text)
    assert "chmod -R a+rX /app" in text
    for source in ("alembic/", "schemas/", "examples/", "openbinding-gateway/tools/"):
        assert any(line.startswith("COPY ") and source in line for line in instructions), source
    assert not re.search(r"chmod\b[^&]*\b(?:700|o-r|go-r|go-rwx|o-rwx)\b", text)


def test_the_entrypoint_needs_no_privileges() -> None:
    entrypoint = REPO_ROOT / "openbinding-gateway" / "docker-entrypoint.sh"
    if not entrypoint.is_file():
        pytest.skip("docker-entrypoint.sh is not part of this checkout")
    code = [
        line
        for line in entrypoint.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert not [line for line in code if re.search(r"\b(?:chown|chmod|su|sudo|gosu|setpriv)\b", line)], code
    assert code[-1] == 'exec "$@"'


# -- compose.lab.json ------------------------------------------------------------------------------


def _gateway_image_services(services: dict) -> dict:
    """The services that run the application: gateway, worker and seed."""
    found = {
        name: service
        for name, service in services.items()
        if service.get("image") == SHARED_IMAGE
        or service.get("build", {}).get("dockerfile") == "openbinding-gateway/Dockerfile"
    }
    assert set(found) == {"gateway", "worker", "seed"}, sorted(found)
    return found


def test_the_run_bim_tmpfs_is_writable_by_the_unprivileged_user(services: dict) -> None:
    for name, service in _gateway_image_services(services).items():
        mounts = [m for m in service["volumes"] if m["type"] == "tmpfs" and m["target"] == "/run/bim"]
        assert len(mounts) == 1, name
        mode = mounts[0].get("tmpfs", {}).get("mode")
        # JSON has no octal: 1023 is 0o1777.
        assert isinstance(mode, int) and mode & S_IWOTH, f"{name}: /run/bim must be world-writable (mode 1023)"
        # The token stays private to its writer.
        assert "umask 077" in " ".join(service["command"]), name


def test_the_artifact_volume_is_the_one_the_image_directory_seeds(services: dict) -> None:
    for name, service in _gateway_image_services(services).items():
        mounts = [m for m in service["volumes"] if m.get("target") == ARTIFACT_DIR]
        assert mounts and all(m["type"] == "volume" and m["source"] == "lab-artifacts-2" for m in mounts), name
        assert service["environment"]["ARTIFACT_ROOT"] == ARTIFACT_DIR, name
    volumes = json.loads(COMPOSE.read_text(encoding="utf-8"))["volumes"]
    assert "lab-artifacts-2" in volumes and "lab-pg-3" in volumes
    assert "lab-artifacts" not in volumes and "lab-pg" not in volumes


def test_no_service_asks_for_root_or_extra_privileges(services: dict) -> None:
    for name, service in services.items():
        user = str(service.get("user", ""))
        if user:
            assert user.split(":")[0] not in {"0", "root"}, name
        for key in ("privileged", "cap_add", "pid", "ipc", "devices"):
            assert key not in service, f"{name} uses {key}"


def test_no_service_runs_as_root_and_nothing_chowns_the_artifact_volume(services: dict) -> None:
    # The container has no CAP_CHOWN, so a chown one-shot cannot work: the fresh lab-artifacts-2 volume inherits the
    # owner (10001) of the image directory instead.
    roots = [name for name, service in services.items() if str(service.get("user", "")).split(":")[0] in {"0", "root"}]
    assert roots == []
    assert "artifacts-init" not in services
    for name, service in services.items():
        assert "artifacts-init" not in (service.get("depends_on") or {}), name


def test_the_memory_limits_stay_within_four_gib(services: dict) -> None:
    total = 0
    for name, service in services.items():
        assert "mem_limit" in service, f"{name} has no mem_limit"
        total += _mib(service["mem_limit"])
    assert total <= MAX_MIB, f"{total} MiB of mem_limit"
    assert total == EXPECTED_MIB, f"{total} MiB of mem_limit; update EXPECTED_MIB and docs/DEMO.md together"


def test_bim_service_limits_cpu_and_processes(services: dict) -> None:
    service = services["bim-service"]
    assert 0 < float(service["cpus"]) <= 4
    assert 0 < int(service["pids_limit"]) <= 1024


def test_compose_holds_no_literal_secret(services: dict) -> None:
    raw = COMPOSE.read_text(encoding="utf-8")
    document = json.loads(raw)
    for text in _strings(document):
        for reference in ANY_REFERENCE.findall(text):
            allowed = reference in ALLOWED_DEFAULT_REFERENCE or ALLOWED_REFERENCE.fullmatch("${" + reference + "}")
            assert allowed, f"unexpected variable ${{{reference}}}"
    assert not SECRET_SHAPES.search(raw)
    for name, service in services.items():
        for key, value in service.get("environment", {}).items():
            if SECRET_NAME.search(key) and not key.endswith(("_FILE", "_ENABLED")):
                assert ALLOWED_REFERENCE.fullmatch(str(value)), f"{name}.{key} must be a ${{DEMO_*}}/${{SPACE_*}}/${{SPHERE_*}} reference"
        # A password inside a URL is the one place a secret hides in a value that is not a reference.
        for key, value in service.get("environment", {}).items():
            for credentials in re.findall(r"://[^/@\s:]+:([^@\s]*)@", str(value)):
                assert ALLOWED_REFERENCE.fullmatch(credentials), f"{name}.{key} embeds a literal password"
