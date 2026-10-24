"""Static checks of ``compose.lab-pricing.json``, the optional laboratory profile that runs a local SPACE
(``space-mongo``, ``space-redis``, ``space-api``), and of its runbook ``docs/qa/PRICING_PROFILE.md``, without Docker.

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
SERVICES = ["space-mongo", "space-redis", "space-api"]
VOLUMES = {"lab-pricing-mongo": "/data/db", "lab-pricing-redis": "/data"}
MAX_MIB = 1152
LIMITS = {"space-mongo": 512, "space-redis": 96, "space-api": 384}
# No SPACE image digest is verified yet (owner request crp-openbinding-m41-space-image-and-16-1 is open): until it is
# answered, space-api carries this marker, which is accepted only for space-api and only while the runbook has a GAP entry.
SPACE_API_GAP_IMAGE = "gap.invalid/space-api:1.7.1"
CRP = "crp-openbinding-m41-space-image-and-16-1"
DIGESTED = re.compile(r"[a-z0-9][a-z0-9./-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}")
SECRET_REFERENCES = {f"${{DEMO_SPACE_{n}}}" for n in ("JWT_SECRET", "JWT_SALT", "ADMIN_PASSWORD", "MONGO_PASSWORD")}
SPHERE = {
    "SPHERE_SYNC_ENABLED": "true",
    "SPHERE_PUBLIC_URL": "https://sphere.score.us.es",
    "SPHERE_API_URL": "https://sphere.score.us.es/api/v1",
    "SPHERE_ALLOW_LOCAL_HTTP": "false",
}
MONGO_IMAGE = "mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a"
REDIS_IMAGE = "redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9"
SYNTHETIC_API_IMAGE = "example.invalid/space-api:1.7.1@sha256:" + "ab" * 32  # only for the in-memory controls

SAMPLE = {
    "name": "openbinding-lab-pricing",
    "services": {
        "space-mongo": {
            "image": MONGO_IMAGE, "user": "999:999", "mem_limit": "512m",
            "command": ["mongod", "--wiredTigerCacheSizeGB", "0.25"],
            "environment": {"MONGO_INITDB_ROOT_PASSWORD": "${DEMO_SPACE_MONGO_PASSWORD}"},
            "volumes": [{"type": "volume", "source": "lab-pricing-mongo", "target": "/data/db"}],
            "healthcheck": {"test": ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1})'"]},
        },
        "space-redis": {
            "image": REDIS_IMAGE, "user": "999:999", "mem_limit": "96m",
            "command": ["redis-server", "--maxmemory", "64mb"],
            "volumes": [{"type": "volume", "source": "lab-pricing-redis", "target": "/data"}],
            "healthcheck": {"test": ["CMD", "redis-cli", "ping"]},
        },
        "space-api": {
            "image": SPACE_API_GAP_IMAGE, "user": "1000:1000", "mem_limit": "384m",
            "environment": {
                "NODE_OPTIONS": "--max-old-space-size=192",
                "MONGO_URI": "mongodb://root:${DEMO_SPACE_MONGO_PASSWORD}@space-mongo:27017/space",
                "JWT_SECRET": "${DEMO_SPACE_JWT_SECRET}", "JWT_SALT": "${DEMO_SPACE_JWT_SALT}",
                "ADMIN_PASSWORD": "${DEMO_SPACE_ADMIN_PASSWORD}", **SPHERE,
            },
            "depends_on": {"space-mongo": {"condition": "service_healthy"},
                           "space-redis": {"condition": "service_healthy"}},
            "healthcheck": {"test": ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health || exit 1"]},
        },
    },
    "volumes": {"lab-pricing-mongo": {"labels": {"profile": "pricing"}}, "lab-pricing-redis": {}},
}
SAMPLE_VERIFIED = [MONGO_IMAGE, REDIS_IMAGE]


def sample() -> dict:
    return copy.deepcopy(SAMPLE)


# -- the rules: manifest in, failure message or None out ------------------------------------------------------------


def rule_optional(manifest: dict) -> str | None:
    if manifest.get("name") != "openbinding-lab-pricing":
        return f"name is {manifest.get('name')!r}"
    if list(manifest.get("services", {})) != SERVICES:
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
        uid = str(service.get("user", "0")).split(":")[0]
        if not uid.isdigit() or int(uid) == 0:
            return f"{name} must run as a numeric non-root user"
        for mount in service.get("volumes", []):
            if mount.get("type") != "volume" or VOLUMES.get(mount.get("source")) != mount.get("target"):
                return f"{name}: mount {mount} is not one of the named volumes"
    if [n for n in (*manifest["services"], *declared) if not rules.NAME_PATTERN.fullmatch(n)]:
        return "a service or volume name does not match the validator pattern"
    return None


def rule_images(manifest: dict, verified: list[str], gap_open: bool) -> str | None:
    for name, service in manifest["services"].items():
        image = service.get("image", "")
        if name == "space-api" and image == SPACE_API_GAP_IMAGE:
            if not gap_open:
                return "the GAP marker needs a GAP entry naming space-api in the runbook"
            continue
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
    if total > MAX_MIB or total != documented:
        return f"memory sum {total} (ceiling {MAX_MIB}, runbook says {documented})"
    if limits != LIMITS:
        return f"mem_limit is {limits}, expected {LIMITS}"
    cache = re.search(r"--wiredTigerCacheSizeGB\s+([\d.]+)", rules._command_text(services["space-mongo"]))
    maxmemory = re.search(r"--maxmemory\s+(\d+)mb", rules._command_text(services["space-redis"]))
    heap = re.search(r"--max-old-space-size=(\d+)", rules._env(services["space-api"]).get("NODE_OPTIONS", ""))
    if not (cache and maxmemory and heap):
        return "cache size, maxmemory or heap cap is missing"
    if (cache.group(1), maxmemory.group(1), heap.group(1)) != ("0.25", "64", "192"):
        return "cache, maxmemory or heap value differs from 0.25 GB, 64 mb, 192"
    if float(cache.group(1)) * 1024 >= limits["space-mongo"] or int(maxmemory.group(1)) >= limits["space-redis"]:
        return "a cache is not below its container limit"
    return None if int(heap.group(1)) < limits["space-api"] else "heap is not below the container limit"


def rule_secrets(manifest: dict, documented: set[str]) -> str | None:
    for name, service in manifest["services"].items():
        for key, value in rules._env(service).items():
            if (rules.SECRET_NAME.search(key) or "SALT" in key) and value not in SECRET_REFERENCES:
                return f"{name}:{key} must be one bare reference of {sorted(SECRET_REFERENCES)}"
            if key in ("JWT_SECRET", "JWT_SALT") and value != f"${{DEMO_SPACE_{key}}}":
                return f"{name}:{key} holds the wrong reference"
            if re.search(r"://[^/@:]+:(?!\$\{DEMO_SPACE_)[^/@]+@", value):
                return f"{name}:{key} embeds a literal password"
    for text in rules._strings(manifest):
        for body in rules.REFERENCE.findall(text):
            if f"${{{body}}}" not in SECRET_REFERENCES:
                return f"reference ${{{body}}} is not one of the four, bare"
    missing = {r[2:-1] for r in SECRET_REFERENCES} - documented
    return f"runbook does not document {sorted(missing)}" if missing else None


def rule_start_order(manifest: dict) -> str | None:
    services = manifest["services"]
    for name in SERVICES:
        if not services[name].get("healthcheck", {}).get("test"):
            return f"{name} has no healthcheck"
    ready = {"condition": "service_healthy"}
    if services["space-api"].get("depends_on") != {"space-mongo": ready, "space-redis": ready}:
        return "space-api must wait for space-mongo and space-redis with service_healthy only"
    return None


def rule_remote_sphere(manifest: dict) -> str | None:
    env = rules._env(manifest["services"]["space-api"])
    wrong = {key: env.get(key) for key, value in SPHERE.items() if env.get(key) != value}
    if wrong:
        return f"SPHERE variables differ: {wrong}"
    for text in rules._strings(manifest):
        for host in re.findall(r"https?://([^/:\s@]+)", text.split("@")[-1] if "@" in text else text):
            if host not in (*SERVICES, "sphere.score.us.es", "127.0.0.1"):
                return f"external address {host}"
    return None


# -- the runbook -----------------------------------------------------------------------------------------------------


def section(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def verified_images(text: str) -> list[str]:
    body = section(text, "Verified image references")
    return re.findall(r"^- `([^`\s]+@sha256:[0-9a-f]{64})` - verified \d{4}-\d{2}-\d{2}$", body, re.MULTILINE)


def gap_is_open(text: str) -> bool:
    return any("space-api" in line and CRP in line for line in section(text, "GAP").splitlines() if line.startswith("- "))


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
    # [utest->req~lab-deployment-pricing-profile-optional~1]
    assert COMPOSE.is_file()
    assert rule_optional(_manifest()) is None


def test_compose_lab_keeps_no_space_service():
    # [utest->req~lab-deployment-pricing-profile-optional~1]
    names = json.loads((ROOT / "compose.lab.json").read_text(encoding="utf-8"))["services"]
    assert not [n for n in names if n.startswith("space") or "space" in n.split("-")]
    assert rules._total_mib(names) == rules.EXPECTED_MIB


def test_pinned_images_match_the_runbook():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~1]
    assert RUNBOOK.is_file()
    text = _runbook()
    assert verified_images(text), "the runbook lists no verified image"
    assert rule_images(_manifest(), verified_images(text), gap_is_open(text)) is None


def test_isolated_services():
    # [utest->req~lab-deployment-pricing-profile-isolated~1]
    assert COMPOSE.is_file()
    assert rule_isolated(_manifest()) is None


def test_memory_budget_matches_the_runbook():
    # [utest->req~lab-deployment-pricing-profile-memory-budget~1]
    assert RUNBOOK.is_file()
    assert rule_memory(_manifest(), documented_sum(_runbook())) is None


def test_secret_references_are_bare_and_documented():
    # [utest->req~lab-deployment-pricing-profile-secret-references~1]
    assert RUNBOOK.is_file()
    documented = {v for v in (r[2:-1] for r in SECRET_REFERENCES) if f"`{v}`" in _runbook()}
    assert rule_secrets(_manifest(), documented) is None


def test_start_order_waits_for_healthy_databases():
    # [utest->req~lab-deployment-pricing-profile-start-order~1]
    assert COMPOSE.is_file()
    assert rule_start_order(_manifest()) is None


def test_remote_sphere_is_the_only_sphere():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    assert COMPOSE.is_file()
    assert rule_remote_sphere(_manifest()) is None


def test_runbook_documents_the_gap_and_the_bring_up():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~1]
    assert RUNBOOK.is_file()
    text = _runbook()
    assert gap_is_open(text), f"## GAP must name space-api and {CRP}"
    assert "lab_compose up file=compose.lab-pricing.json" in text


# -- controls: the rules on the in-memory SAMPLE ---------------------------------------------------------------------


def _api(manifest: dict) -> dict:
    return manifest["services"]["space-api"]


def test_control_sample_conforms():
    # [utest->req~lab-deployment-pricing-profile-optional~1]
    names = {r[2:-1] for r in SECRET_REFERENCES}
    assert rule_optional(sample()) is None and rule_isolated(sample()) is None
    assert rule_images(sample(), SAMPLE_VERIFIED, True) is None
    assert rule_memory(sample(), 992) is None and rule_secrets(sample(), names) is None
    assert rule_start_order(sample()) is None and rule_remote_sphere(sample()) is None
    digested = sample()
    _api(digested)["image"] = SYNTHETIC_API_IMAGE
    assert rule_images(digested, [*SAMPLE_VERIFIED, SYNTHETIC_API_IMAGE], False) is None


def _profiles(m): m["services"]["space-api"]["profiles"] = ["pricing"]
def _renamed(m): m["name"] = "openbinding-lab"
def _port(m): _api(m)["ports"] = ["127.0.0.1:3000:3000"]
def _bind(m): _api(m)["volumes"] = [{"type": "bind", "source": "data", "target": "/data"}]
def _root(m): _api(m)["user"] = "0:0"
def _privileged(m): _api(m)["privileged"] = True
def _extra(m): m["services"]["space-web"] = {}
def _no_limit(m): del _api(m)["mem_limit"]
def _swapped(m): m["services"]["space-mongo"]["image"] = REDIS_IMAGE
def _external(m): _api(m)["environment"]["WEBHOOK_URL"] = "https://hooks.example.org/x"
def _wrong_ref(m): _api(m)["environment"]["JWT_SECRET"] = "${DEMO_SPACE_ADMIN_PASSWORD}"
def _uri_password(m): _api(m)["environment"]["MONGO_URI"] = "mongodb://root:hunter2@space-mongo:27017/space"


@pytest.mark.parametrize("mutate,rule", [
    (_profiles, rule_optional), (_renamed, rule_optional), (_extra, rule_optional),
    (_port, rule_isolated), (_bind, rule_isolated), (_root, rule_isolated), (_privileged, rule_isolated),
    (_no_limit, lambda m: rule_memory(m, 992)), (_wrong_ref, lambda m: rule_secrets(m, set())),
    (_uri_password, lambda m: rule_secrets(m, set())), (_external, rule_remote_sphere),
    (_swapped, lambda m: rule_images(m, SAMPLE_VERIFIED, True)),
], ids=lambda x: getattr(x, "__name__", ""))
def test_control_refuses_a_non_isolated_or_non_optional_profile(mutate, rule):
    # [utest->req~lab-deployment-pricing-profile-isolated~1]
    manifest = sample()
    mutate(manifest)
    assert rule(manifest)


def test_control_refuses_unpinned_images():
    # [utest->req~lab-deployment-pricing-profile-pinned-images~1]
    tag_only = sample()
    tag_only["services"]["space-redis"]["image"] = "redis:7.4.2"
    assert rule_images(tag_only, SAMPLE_VERIFIED, True)
    assert rule_images(sample(), [MONGO_IMAGE], True), "digest missing from the runbook"
    marker = sample()
    marker["services"]["space-mongo"]["image"] = SPACE_API_GAP_IMAGE
    assert rule_images(marker, SAMPLE_VERIFIED, True)
    assert rule_images(sample(), SAMPLE_VERIFIED, False), "marker without a GAP entry"
    unlisted = sample()
    _api(unlisted)["image"] = SYNTHETIC_API_IMAGE
    assert rule_images(unlisted, SAMPLE_VERIFIED, False), "space-api digest missing from the runbook"
    api_tag = sample()
    _api(api_tag)["image"] = "example.invalid/space-api:1.7.1"
    assert rule_images(api_tag, SAMPLE_VERIFIED, True)


def test_control_refuses_a_mongo_limit_over_budget():
    # [utest->req~lab-deployment-pricing-profile-memory-budget~1]
    manifest = sample()
    manifest["services"]["space-mongo"]["mem_limit"] = "640m"
    assert rule_memory(manifest, 992)
    assert rule_memory(sample(), 1000), "the runbook sum must equal the manifest sum"


def test_control_refuses_defaulted_or_literal_secrets():
    # [utest->req~lab-deployment-pricing-profile-secret-references~1]
    names = {r[2:-1] for r in SECRET_REFERENCES}
    for key, value in [("JWT_SECRET", "${DEMO_SPACE_JWT_SECRET:-dev}"), ("ADMIN_PASSWORD", "changeme"),
                       ("JWT_SALT", "pepper")]:
        manifest = sample()
        _api(manifest)["environment"][key] = value
        assert rule_secrets(manifest, names), key
    assert rule_secrets(sample(), names - {"DEMO_SPACE_JWT_SALT"}), "an undocumented variable"


def test_control_refuses_a_started_only_dependency():
    # [utest->req~lab-deployment-pricing-profile-start-order~1]
    manifest = sample()
    _api(manifest)["depends_on"]["space-mongo"] = {"condition": "service_started"}
    assert rule_start_order(manifest)


def test_control_refuses_a_local_sphere():
    # [utest->req~lab-deployment-pricing-profile-remote-sphere~1]
    manifest = sample()
    _api(manifest)["environment"]["SPHERE_API_URL"] = "http://sphere:8080/api/v1"
    assert rule_remote_sphere(manifest)
