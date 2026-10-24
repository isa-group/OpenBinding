"""SPHERE is remote; SPACE is remote too, except in the optional pricing lab profile.

Only compose.lab-pricing.json may define local SPACE services. Every other
manifest (docker-compose.yml, deploy/**, the other lab profiles) keeps no SPACE
service, network, volume or destructive key, and no manifest defines SPHERE.
"""

from __future__ import annotations

import re

import pytest
import yaml
from _repo import REPO_ROOT

ROOT = REPO_ROOT
COMPOSE = ROOT / "docker-compose.yml"
PRICING = ROOT / "compose.lab-pricing.json"
# GAP, no SPACE image digest is verified, owner request
# crp-openbinding-m41-space-image-and-16-1 is open. Never guess a digest or registry.
SPACE_API_GAP_IMAGE = "gap.invalid/space-api:1.7.1"
PRICING_SPACE_SERVICES = {"space-mongo", "space-redis", "space-api"}
PINNED_SPACE_API = re.compile(r"[^\s@]+:1\.7\.1@sha256:[0-9a-f]{64}")
# Assembled from parts so a repository-wide search for the retired key finds no
# literal here; the key itself must not come back anywhere in the stacks.
FORBIDDEN_KEY = "SPACE_" + "DESTRUCTIVE_API_KEY"


def _compose() -> dict:
    if not COMPOSE.is_file():
        pytest.skip(f"docker-compose.yml not found under repo root {ROOT}")
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def _env(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, dict):
        return {str(k): "" if v is None else str(v) for k, v in env.items()}
    return {
        str(item).split("=", 1)[0]: str(item).split("=", 1)[1] if "=" in str(item) else ""
        for item in env
    }


def _is_space_service(name: str, service: dict) -> bool:
    parts = name.lower().split("-")
    return (
        name.lower().startswith("space")
        or "space" in parts
        or "space-api" in str(service.get("image", "")).lower()
    )


def _is_sphere_service(name: str, service: dict) -> bool:
    return "sphere" in name.lower() or "sphere" in str(service.get("image", "")).lower()


def _space_service_names(manifest: dict) -> set[str]:
    services = manifest.get("services") or {}
    return {n for n, s in services.items() if _is_space_service(n, s or {})}


def _local_space_problems(manifest: dict, text: str) -> list[str]:
    """Everything a manifest other than the pricing profile must not contain."""
    problems = [f"service {n}" for n in sorted(_space_service_names(manifest))]
    for name, service in (manifest.get("services") or {}).items():
        service = service or {}
        if "space" in (service.get("profiles") or []):
            problems.append(f"profile of {name}")
        if "space" in (service.get("networks") or []):
            problems.append(f"network of {name}")
    if "space" in (manifest.get("networks") or {}):
        problems.append("network space")
    problems += [f"volume {v}" for v in (manifest.get("volumes") or {}) if v.startswith("space")]
    if FORBIDDEN_KEY in text:
        problems.append("destructive key")
    return problems


def _sphere_problems(manifest: dict) -> list[str]:
    services = manifest.get("services") or {}
    return [n for n, s in services.items() if _is_sphere_service(n, s or {})]


def _space_api_image_problems(manifest: dict) -> list[str]:
    image = str(((manifest.get("services") or {}).get("space-api") or {}).get("image", ""))
    if image == SPACE_API_GAP_IMAGE or PINNED_SPACE_API.fullmatch(image):
        return []
    return [f"space-api image {image!r}"]


def _manifests() -> list[tuple[str, dict, str]]:
    """(label, parsed, text) of every non-pricing manifest that exists."""
    paths = [COMPOSE, *sorted(ROOT.glob("compose.lab*.json")), ROOT / "compose.pgtest.json"]
    deploy = ROOT / "deploy"
    if deploy.is_dir():
        paths += sorted(p for p in deploy.rglob("*") if p.suffix in {".yml", ".yaml", ".json"})
    found = []
    for path in paths:
        if path == PRICING or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict) and isinstance(parsed.get("services"), dict):
            found.append((str(path.relative_to(ROOT)), parsed, text))
    return found


# [utest->req~lab-deployment-no-local-space~2]
def test_other_manifests_have_no_local_space() -> None:
    manifests = _manifests()
    assert manifests
    for label, parsed, text in manifests:
        assert not _local_space_problems(parsed, text), label


# [utest->req~lab-deployment-no-local-space~2]
def test_no_manifest_defines_sphere() -> None:
    for label, parsed, _ in _manifests():
        assert not _sphere_problems(parsed), label
    if PRICING.is_file():
        assert not _sphere_problems(yaml.safe_load(PRICING.read_text(encoding="utf-8")))


# [utest->req~lab-deployment-no-local-space~2]
def test_pricing_profile_defines_exactly_the_space_services() -> None:
    assert PRICING.is_file()
    manifest = yaml.safe_load(PRICING.read_text(encoding="utf-8"))
    assert _space_service_names(manifest) == PRICING_SPACE_SERVICES
    assert all(v.startswith("space-") for v in (manifest.get("volumes") or {}))
    assert not _sphere_problems(manifest)
    assert not _space_api_image_problems(manifest)
    assert FORBIDDEN_KEY not in PRICING.read_text(encoding="utf-8")


def _sample(**services: dict) -> dict:
    return {"services": services}


# [utest->req~lab-deployment-no-local-space~2]
@pytest.mark.parametrize(
    "manifest",
    [
        _sample(**{"space-mongo": {"image": "mongo:7"}}),
        _sample(api={"image": "registry.example/space-api:1.7.1"}),
        _sample(api={"image": "x", "profiles": ["space"]}),
        _sample(api={"image": "x", "networks": ["space"]}),
        {"services": {}, "networks": {"space": {}}},
        {"services": {}, "volumes": {"space-data": {}}},
    ],
)
def test_negative_control_local_space_is_detected(manifest: dict) -> None:
    assert _local_space_problems(manifest, "")


# [utest->req~lab-deployment-no-local-space~2]
def test_negative_control_extra_space_service_breaks_the_exact_set() -> None:
    names = [*PRICING_SPACE_SERVICES, "space-web"]
    assert _space_service_names(_sample(**{n: {} for n in names})) != PRICING_SPACE_SERVICES


# [utest->req~lab-deployment-no-local-space~2]
def test_negative_control_destructive_key_is_detected() -> None:
    assert _local_space_problems(_sample(), f"environment: {FORBIDDEN_KEY}")


# [utest->req~lab-deployment-no-local-space~2]
@pytest.mark.parametrize(
    "service", [("sphere-api", {}), ("api", {"image": "registry.example/SPHERE-ui:1"})]
)
def test_negative_control_sphere_is_detected(service: tuple[str, dict]) -> None:
    assert _sphere_problems(_sample(**{service[0]: service[1]}))


# [utest->req~lab-deployment-no-local-space~2]
@pytest.mark.parametrize(
    "image",
    [
        "registry.example/space-api:1.7.1",
        f"registry.example/space-api:1.8.0@sha256:{'a' * 64}",
        f"registry.example/space-api:1.7.1@sha256:{'a' * 63}",
    ],
)
def test_negative_control_space_api_image_is_detected(image: str) -> None:
    assert _space_api_image_problems(_sample(**{"space-api": {"image": image}}))


# [utest->req~lab-deployment-no-local-space~2]
def test_negative_control_space_api_image_accepts_marker_and_digest() -> None:
    digest = f"registry.example/space-api:1.7.1@sha256:{'a' * 64}"
    for image in (SPACE_API_GAP_IMAGE, digest):
        assert not _space_api_image_problems(_sample(**{"space-api": {"image": image}}))


# [utest->req~lab-deployment-no-local-space~2]
def test_no_space_services_or_profile() -> None:
    services = _compose()["services"]
    assert not [name for name in services if name.startswith("space")]
    for name, service in services.items():
        assert "space" not in (service.get("profiles") or []), name
        assert "space" not in (service.get("networks") or []), name


def test_no_space_network_or_volumes() -> None:
    compose = _compose()
    assert "space" not in (compose.get("networks") or {})
    assert not [v for v in (compose.get("volumes") or {}) if v.startswith("space")]


def test_local_space_paths_are_gone() -> None:
    assert not (ROOT / "space/prepare.sh").exists()


def test_destructive_key_is_not_referenced() -> None:
    assert FORBIDDEN_KEY not in COMPOSE.read_text(encoding="utf-8")
    for relative in (".env.example", "openbinding-gateway/.env.example"):
        path = ROOT / relative
        if path.is_file():
            assert FORBIDDEN_KEY not in path.read_text(encoding="utf-8"), relative


def test_remote_space_defaults_without_keys() -> None:
    services = _compose()["services"]
    # Production services default to the real SPACE (APP_ENV=prod refuses the
    # open gate); the development ones default to the stateless open gate.
    defaults = {"gateway": "true", "worker": "true", "gateway-dev": "false", "worker-dev": "false"}
    for name, enabled in defaults.items():
        env = _env(services[name])
        assert env["SPACE_URL"] == "${SPACE_URL:-https://space.score.us.es}", name
        assert env["SPACE_API_KEY"] == "${SPACE_API_KEY:-}", name
        assert env["SPACE_ENABLED"] == f"${{SPACE_ENABLED:-{enabled}}}", name
    for name, service in services.items():
        env = _env(service)
        for key in ("SPACE_API_KEY", "SPHERE_API_KEY"):
            if key in env:
                assert env[key] == f"${{{key}:-}}", f"{name}:{key}"


def test_openbinding_data_services_remain() -> None:
    services = _compose()["services"]
    assert services["postgres"]["image"].startswith("postgres:")
    assert services["redis"]["image"].startswith("redis:")
