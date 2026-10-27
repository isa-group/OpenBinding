"""Static checks of ``compose.lab-pricing.json``, the optional laboratory profile with the one-shot
``pricing-bootstrap`` that talks to the remote SPACE (https://space.score.us.es), and of its runbook
``docs/qa/PRICING_PROFILE.md``, without Docker.

The rules are plain functions of a manifest dict (and the runbook text) that return a failure message or None.  The
``control`` tests call them on a conforming in-memory SAMPLE, mutated, so every rule is proven to refuse what it must;
the other tests apply them to the real files.

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
TOOLS_DOCKERFILE = ROOT / "lab" / "tools" / "Dockerfile"

SERVICE = "pricing-bootstrap"
IMAGE = "openbinding-lab/pricing-bootstrap:1"
BUILD = {"context": "lab/tools", "dockerfile": "Dockerfile"}
SPACE_HOST = "space.score.us.es"
KEY_VARIABLE = "DEMO_SPACE_MANAGEMENT_KEY"
KEY_REFERENCE = f"${{{KEY_VARIABLE}}}"
ENVIRONMENT = {"SPACE_URL": f"https://{SPACE_HOST}", "SPACE_API_KEY": KEY_REFERENCE}
SERVICE_KEYS = {"image", "build", "user", "restart", "environment", "mem_limit"}
LIMIT_MIB = 96
# Assembled so a repository-wide search does not find the retired key here.
DESTRUCTIVE_KEY = "SPACE_" + "DESTRUCTIVE_API_KEY"
RETIRED_WORDS = (
    "space-mongo", "space-redis", "space-api", "DEMO_SPACE_JWT_SECRET", "DEMO_SPACE_JWT_SALT",
    "DEMO_SPACE_ADMIN_PASSWORD", "DEMO_SPACE_MONGO_PASSWORD",
)
URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"`<>]*")
PROXY_NAME = re.compile(r"proxy", re.IGNORECASE)

# SAMPLE mirrors compose.lab-pricing.json: update it together with the manifest.
SAMPLE = {
    "name": "openbinding-lab-pricing",
    "services": {
        SERVICE: {
            "image": IMAGE, "build": dict(BUILD), "user": "1000:1000", "restart": "no",
            "environment": dict(ENVIRONMENT), "mem_limit": f"{LIMIT_MIB}m",
        },
    },
}


def sample() -> dict:
    return copy.deepcopy(SAMPLE)


# -- the rules: manifest in, failure message or None out ------------------------------------------------------------


def rule_shape(manifest: dict) -> str | None:
    if set(manifest) != {"name", "services"}:
        return f"top-level keys are {sorted(manifest)}, expected name and services only"
    if manifest["name"] != "openbinding-lab-pricing":
        return f"name is {manifest['name']!r}"
    if set(manifest["services"]) != {SERVICE}:
        return f"services are {list(manifest['services'])}, expected only {SERVICE}"
    service = manifest["services"][SERVICE]
    if set(service) != SERVICE_KEYS:
        return f"service keys differ from the pinned ones: {sorted(set(service) ^ SERVICE_KEYS)}"
    if service["image"] != IMAGE:
        return f"image is {service['image']!r}, expected {IMAGE}"
    if service["build"] != BUILD:
        return f"build must be exactly {BUILD}"
    ids = str(service["user"]).split(":")
    if len(ids) != 2 or not all(i.isdigit() and int(i) > 0 for i in ids):
        return "user must be a numeric non-root uid and a numeric non-zero gid"
    if service["user"] != "1000:1000":
        return f"user is {service['user']!r}, expected 1000:1000"
    if service["restart"] != "no":
        return 'restart must be "no"'
    if not rules.NAME_PATTERN.fullmatch(SERVICE):
        return "the service name does not match the validator pattern"
    return None


def rule_forbidden(manifest: dict) -> str | None:
    text = json.dumps(manifest)
    if DESTRUCTIVE_KEY in text:
        return "the destructive key is named"
    if any(".sock" in s for s in rules._strings(manifest)):
        return "a socket is mounted"
    if re.search(r"SPACE_ADMIN_|SPHERE", text):
        return "a SPACE admin or SPHERE variable is named"
    for service in manifest["services"].values():
        for key in ("ports", "expose", "networks", "network_mode", "volumes", "depends_on", "command",
                    "entrypoint", "healthcheck", *rules.FORBIDDEN_SERVICE_KEYS):
            if key in service:
                return f"a service uses {key}"
    if "volumes" in manifest or "networks" in manifest:
        return "a top-level volumes or networks key"
    return None


def rule_environment(manifest: dict) -> str | None:
    env = rules._env(manifest["services"][SERVICE])
    if env != ENVIRONMENT:
        return f"environment differs from the pinned one: {sorted(set(env.items()) ^ set(ENVIRONMENT.items()))}"
    text = json.dumps(manifest)
    if text.count("$") != 1 or text.count(KEY_REFERENCE) != 1:
        return f"the only '$' must be the one bare {KEY_REFERENCE}, with no default"
    if rules.SECRET_SHAPES.search(text):
        return "a secret-shaped literal"
    if any(PROXY_NAME.search(key) for key in env):
        return "a proxy variable"
    return None


def _hosts(url: str) -> list[str]:
    """Every host of the URL's authority: userinfo ends at the last '@', a comma separates hosts."""
    authority = re.split(r"[/?#\\]", url.split("://", 1)[1], maxsplit=1)[0].rpartition("@")[2]
    return [item.partition(":")[0].lower() for item in authority.split(",")]


def rule_hosts(manifest: dict) -> str | None:
    found = 0
    for text in rules._strings(manifest):
        for url in URL.findall(re.sub(r"[\t\r\n]", "", text)):
            found += 1
            if not url.lower().startswith("https://"):
                return f"{url} is not https"
            for host in _hosts(url):
                if host != SPACE_HOST:
                    return f"external address {host!r} in {url}"
    return None if found else "no URL: the remote SPACE address is missing"


def _mib(value) -> int | None:
    match = re.fullmatch(r"(\d+)([mg])", str(value))
    return int(match.group(1)) * (1024 if match.group(2) == "g" else 1) if match else None


def rule_memory(manifest: dict, documented: int | None) -> str | None:
    limit = _mib(manifest["services"][SERVICE].get("mem_limit"))
    if limit is None:
        return "mem_limit must be whole m or g units"
    if limit != LIMIT_MIB:
        return f"mem_limit is {limit} MiB, expected {LIMIT_MIB}"
    if limit != documented:
        return f"memory sum {limit} differs from the runbook's {documented}"
    if 2 * rules.EXPECTED_MIB + limit > 9216:
        return "two lab stacks and the profile do not fit the 9216 MiB host"
    return None


RULES = (rule_shape, rule_forbidden, rule_environment, rule_hosts)


def first_failure(manifest: dict) -> str | None:
    for rule in RULES:
        try:
            message = rule(manifest)
        except (KeyError, TypeError, AttributeError) as error:
            message = f"{rule.__name__} could not read the manifest: {error!r}"
        if message:
            return message
    return None


# -- the runbook -----------------------------------------------------------------------------------------------------


def section(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def verified_images(text: str) -> list[str]:
    body = section(text, "Verified image references")
    return re.findall(r"^- `([^`\s]+@sha256:[0-9a-f]{64})` - verified \d{4}-\d{2}-\d{2}$", body, re.MULTILINE)


def base_digests() -> set[str]:
    """The base-image digests of the tool Dockerfile, read from it."""
    return set(re.findall(r"^FROM\s+\S+@sha256:([0-9a-f]{64})", TOOLS_DOCKERFILE.read_text(encoding="utf-8"),
                          re.MULTILINE))


def documented_sum(text: str) -> int | None:
    match = re.search(r"^Memory sum: (\d+) MiB$", text, re.MULTILINE)
    return int(match.group(1)) if match else None


def rule_runbook(text: str, digests: set[str]) -> str | None:
    if re.search(r"^## GAP\b", text, re.MULTILINE):
        return "the runbook still has a ## GAP section"
    if verified_images(text) or re.search(r"^## Verified image references", text, re.MULTILINE):
        return "the runbook keeps a verified mongo/redis image list"
    if re.search(r"\b(mongo|redis):\S*@sha256:", text):
        return "the runbook names a mongo or redis image digest"
    if documented_sum(text) != LIMIT_MIB:
        return f"the runbook must state 'Memory sum: {LIMIT_MIB} MiB'"
    if f"`{KEY_VARIABLE}`" not in text:
        return f"the runbook must document `{KEY_VARIABLE}` in backticks"
    context = re.compile(rf"(?<![\w-]){re.escape(BUILD['context'])}(?![\w-])")
    if not any(IMAGE in line and context.search(line) for line in text.splitlines()):
        return f"the runbook must name {IMAGE} with {BUILD['context']}"
    for digest in sorted(digests):
        if not any(digest in line and "UNVERIFIED" in line for line in text.splitlines()):
            return f"base digest {digest} must be on a line marked UNVERIFIED"
    for word in RETIRED_WORDS:
        if word in text:
            return f"the runbook still mentions {word}"
    if re.search(r"(?<![\w-])lab/space(?![\w])", text):
        return "the runbook still mentions lab/space"
    return None


def _manifest() -> dict:
    assert COMPOSE.is_file()
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


def _runbook() -> str:
    assert RUNBOOK.is_file()
    return RUNBOOK.read_text(encoding="utf-8")


# -- the real files ------------------------------------------------------------------------------------------------


def test_profile_is_the_single_bootstrap_service():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_shape(_manifest()) is None


def test_profile_has_nothing_forbidden():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_forbidden(_manifest()) is None


def test_profile_environment_is_the_remote_space_and_one_bare_key_reference():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_environment(_manifest()) is None


def test_profile_only_address_is_the_remote_space_over_https():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_hosts(_manifest()) is None


def test_profile_file_has_exactly_one_dollar():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    text = COMPOSE.read_text(encoding="utf-8")
    assert text.count("$") == 1 and KEY_REFERENCE in text


def test_memory_budget_matches_the_runbook():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    text = _runbook()
    assert documented_sum(text) == 96, "the runbook must state the sum of 96 MiB"
    assert rule_memory(_manifest(), documented_sum(text)) is None
    assert 2 * rules.EXPECTED_MIB + 96 <= 9216


def test_runbook_documents_the_remote_design():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    digests = base_digests()
    assert len(digests) == 1, "lab/tools/Dockerfile holds one base-image digest"
    assert rule_runbook(_runbook(), digests) is None


def test_runbook_key_variable_and_tool_variables():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    text = _runbook()
    for name in (KEY_VARIABLE, "SPACE_URL", "SPACE_API_KEY", "SPACE_BOOTSTRAP_PLAN"):
        assert f"`{name}`" in text, name


def test_compose_lab_keeps_no_space_service():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    names = json.loads((ROOT / "compose.lab.json").read_text(encoding="utf-8"))["services"]
    assert not [n for n in names if n.startswith("space") or "space" in n.split("-")]
    assert rules._total_mib(names) == rules.EXPECTED_MIB


# -- controls: the rules on the in-memory SAMPLE ---------------------------------------------------------------------


def _boot(manifest: dict) -> dict:
    return manifest["services"][SERVICE]


def _env_of(manifest: dict) -> dict:
    return _boot(manifest)["environment"]


def _good_runbook() -> str:
    return (
        "# Runbook\n\n## Purpose\n\nOptional one-shot against the remote SPACE.\n\n"
        f"## Variables\n\n- `{KEY_VARIABLE}` is set by the supervisor.\n"
        "- `SPACE_URL`, `SPACE_API_KEY`, `SPACE_BOOTSTRAP_PLAN` are read by the tool.\n\n"
        f"## Build\n\n- `{IMAGE}` is built from `lab/tools`\n"
        + "".join(f"- base `sha256:{d}` UNVERIFIED until the first lab build\n" for d in DIGESTS)
        + "\n## Memory\n\nMemory sum: 96 MiB\n"
    )


DIGESTS = ["11" * 32]  # stand-in for the base-image digest of the tool Dockerfile


def test_control_sample_conforms():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert first_failure(sample()) is None
    assert rule_memory(sample(), 96) is None
    assert rule_runbook(_good_runbook(), set(DIGESTS)) is None


def _extra_service(m): m["services"]["pricing-extra"] = copy.deepcopy(_boot(m))
def _local_space_api(m): m["services"]["space-api"] = {"image": "openbinding-lab/space-api:1.7.1"}
def _http_url(m): _env_of(m)["SPACE_URL"] = f"http://{SPACE_HOST}"
def _defaulted_key(m): _env_of(m)["SPACE_API_KEY"] = "${DEMO_SPACE_MANAGEMENT_KEY:-x}"
def _literal_key(m): _env_of(m)["SPACE_API_KEY"] = "changeme"
def _port(m): _boot(m)["ports"] = ["127.0.0.1:3000:3000"]
def _bind_volume(m): _boot(m)["volumes"] = [{"type": "bind", "source": "data", "target": "/data"}]
def _root_user(m): _boot(m)["user"] = "0:0"
def _proxy_variable(m): _env_of(m)["HTTPS_PROXY"] = "http://proxy.example:3128"
def _sphere_variable(m): _env_of(m)["SPHERE_API_KEY"] = "${DEMO_SPHERE_API_KEY}"
def _foreign_host(m): _env_of(m)["SPACE_URL"] = "https://space.example.org"
def _userinfo_host(m): _env_of(m)["SPACE_URL"] = f"https://{SPACE_HOST}@evil.example"
def _admin_variable(m): _env_of(m)["SPACE_ADMIN_USER"] = "admin"
def _destructive_key(m): _env_of(m)["EXTRA"] = DESTRUCTIVE_KEY
def _socket(m): _env_of(m)["DOCKER_HOST"] = "unix:///var/run/docker.sock"
def _top_volumes(m): m["volumes"] = {"lab-pricing-mongo": {}}
def _renamed(m): m["name"] = "openbinding-lab"
def _restart(m): _boot(m)["restart"] = "unless-stopped"
def _depends(m): _boot(m)["depends_on"] = {"space-api": {"condition": "service_healthy"}}
def _command(m): _boot(m)["command"] = ["sh", "-c", "true"]
def _healthcheck(m): _boot(m)["healthcheck"] = {"test": ["CMD", "true"]}
def _privileged(m): _boot(m)["privileged"] = True
def _wrong_build(m): _boot(m)["build"] = {"context": "lab/space", "dockerfile": "Dockerfile"}
def _wrong_image(m): _boot(m)["image"] = "openbinding-lab/pricing-bootstrap:2"
def _gid_zero(m): _boot(m)["user"] = "1000:0"
def _user_name(m): _boot(m)["user"] = "node"
def _other_user(m): _boot(m)["user"] = "1234:1234"
def _two_keys(m): _env_of(m)["OTHER"] = KEY_REFERENCE


@pytest.mark.parametrize(
    "mutate",
    [_extra_service, _local_space_api, _http_url, _defaulted_key, _literal_key, _port, _bind_volume, _root_user,
     _proxy_variable, _sphere_variable, _foreign_host, _userinfo_host, _admin_variable, _destructive_key, _socket,
     _top_volumes, _renamed, _restart, _depends, _command, _healthcheck, _privileged, _wrong_build, _wrong_image,
     _gid_zero, _user_name, _other_user, _two_keys],
    ids=lambda f: f.__name__,
)
def test_control_refuses_what_the_profile_must_not_hold(mutate):
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    manifest = sample()
    mutate(manifest)
    assert first_failure(manifest)


@pytest.mark.parametrize(
    "mutate, rule",
    [
        (_extra_service, rule_shape), (_local_space_api, rule_shape), (_renamed, rule_shape),
        (_restart, rule_shape), (_wrong_build, rule_shape), (_wrong_image, rule_shape), (_root_user, rule_shape),
        (_gid_zero, rule_shape), (_user_name, rule_shape), (_other_user, rule_shape),
(_port, rule_shape), (_bind_volume, rule_shape),
        (_top_volumes, rule_shape),
        (_port, rule_forbidden), (_bind_volume, rule_forbidden), (_depends, rule_forbidden),
        (_command, rule_forbidden), (_healthcheck, rule_forbidden), (_privileged, rule_forbidden),
        (_sphere_variable, rule_forbidden), (_admin_variable, rule_forbidden),
        (_destructive_key, rule_forbidden), (_socket, rule_forbidden),
        (_http_url, rule_environment), (_defaulted_key, rule_environment), (_literal_key, rule_environment),
        (_proxy_variable, rule_environment), (_sphere_variable, rule_environment), (_two_keys, rule_environment),
        (_http_url, rule_hosts), (_foreign_host, rule_hosts), (_userinfo_host, rule_hosts),
    ],
    ids=lambda x: getattr(x, "__name__", str(x)),
)
def test_control_each_rule_refuses_its_own_mutation(mutate, rule):
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    manifest = sample()
    mutate(manifest)
    assert rule(manifest)


def test_control_hosts_rule_needs_the_remote_address():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    manifest = sample()
    _env_of(manifest)["SPACE_URL"] = "space.score.us.es"
    assert "no URL" in rule_hosts(manifest)


def test_control_refuses_a_missing_key_reference():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    manifest = sample()
    del _env_of(manifest)["SPACE_API_KEY"]
    assert "pinned" in rule_environment(manifest)


def test_control_refuses_a_changed_memory_limit_or_runbook_sum():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    bigger = sample()
    _boot(bigger)["mem_limit"] = "128m"
    assert "expected" in rule_memory(bigger, 128)
    assert "runbook" in rule_memory(sample(), 1088), "a runbook that still documents 1088 MiB"
    unit = sample()
    _boot(unit)["mem_limit"] = "96"
    assert "whole m or g" in rule_memory(unit, 96)
    gigabyte = sample()
    _boot(gigabyte)["mem_limit"] = "1g"
    assert "expected" in rule_memory(gigabyte, 1024)


def test_control_runbook_parsers_refuse_malformed_text():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    good = _good_runbook()
    assert documented_sum(good) == 96 and verified_images(good) == []
    assert documented_sum(good.replace("Memory sum:", "Total:")) is None
    listed = f"## Verified image references\n\n- `mongo:7@sha256:{'22' * 32}` - verified 2026-10-24\n"
    assert verified_images(listed) == [f"mongo:7@sha256:{'22' * 32}"]
    assert verified_images(listed.replace(" - verified 2026-10-24", " - pending")) == []


def test_control_runbook_rule_refuses_each_defect():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    digests = set(DIGESTS)
    good = _good_runbook()
    assert rule_runbook(good, digests) is None
    assert "GAP" in rule_runbook(good + "\n## GAP\n\n- x\n", digests)
    assert "GAP" in rule_runbook(good + "\n## GAP (closed)\n\n- x\n", digests)
    listed = good + f"\n## Verified image references\n\n- `mongo:7@sha256:{'22' * 32}` - verified 2026-10-24\n"
    assert "verified" in rule_runbook(listed, digests)
    empty_list = good + "\n## Verified image references\n\nNone.\n"
    assert "verified" in rule_runbook(empty_list, digests)
    assert "digest" in rule_runbook(good + f"\n- `redis:7.4.2@sha256:{'33' * 32}`\n", digests)
    assert "Memory sum" in rule_runbook(good.replace("96 MiB", "1088 MiB"), digests)
    assert "Memory sum" in rule_runbook(good.replace("Memory sum:", "Total:"), digests)
    assert KEY_VARIABLE in rule_runbook(good.replace(f"`{KEY_VARIABLE}`", KEY_VARIABLE), digests)
    assert IMAGE in rule_runbook(good.replace(IMAGE, "pricing-bootstrap"), digests)
    assert "lab/tools" in rule_runbook(good.replace("`lab/tools`", "`lab/other`"), digests)
    assert "UNVERIFIED" in rule_runbook(good.replace(" UNVERIFIED", ""), digests)
    assert "UNVERIFIED" in rule_runbook(good, {*digests, "55" * 32}), "a base digest the runbook lacks"
    for word in RETIRED_WORDS:
        assert word in rule_runbook(good + f"\nSee {word}.\n", digests), word
    assert "lab/space" in rule_runbook(good + "\nBuilt from lab/space.\n", digests)
    assert rule_runbook(good + "\nTool: lab/tools/space_lab_bootstrap.py\n", digests) is None
