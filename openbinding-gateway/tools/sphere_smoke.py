#!/usr/bin/env python3
"""A read-only smoke check of the live SPHERE through the gateway's own ``SphereHttpSource`` (run by hand).

For each family (TomatoMeter and set-B Mailgun by default) it reads, anonymously and with GETs only, the
manifest, the latest version's YAML, the permalink and the owning organization, and checks:

- the YAML's bytes match its ``ETag`` (SHA-256) and its functional hash matches the manifest's ``contentHash``;
- a fresh conditional read of the manifest with its ``ETag`` answers 304;
- SPHERE sends its ``RateLimit-*`` headers;
- the permalink names an organization and a slug.

About ten requests in all. Exit 0 when everything holds, 1 on a mismatch, 2 when SPHERE cannot be read.

    python tools/sphere_smoke.py [--url https://sphere.score.us.es] [--family <pricingId> ...] [--json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import httpx  # noqa: E402

from openbinding_gateway.core import outbound  # noqa: E402
from openbinding_gateway.core.outbound import OutboundError, OutboundPolicy  # noqa: E402
from openbinding_gateway.core.settings import DEFAULT_SPHERE_URL, Settings  # noqa: E402
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource  # noqa: E402
from openbinding_gateway.modules.plans.application import (  # noqa: E402
    DEFAULT_ENDPOINT,
    NotModified,
    PricingError,
    is_sphere_id,
    read_version,
)

DEFAULT_FAMILIES = ("6ab0a323697330667ccce8cd", "6ade364540e55445692b0eda")


@dataclass
class Check:
    family: str
    name: str
    ok: bool
    detail: str = ""


async def run(url: str, families: list[str], transport: httpx.AsyncBaseTransport | None = None) -> list[Check]:
    # Only the SPHERE settings matter here, at their defaults: no deployment environment is needed.
    settings = Settings.model_construct(sphere_enabled=True, sphere_url=url.rstrip("/"))
    checks: list[Check] = []
    for family in families:
        source = SphereHttpSource(settings, transport=transport)
        try:
            manifest = await source.manifest(DEFAULT_ENDPOINT, family, None)
            assert not isinstance(manifest, NotModified)
            read = await read_version(source, DEFAULT_ENDPOINT, family, manifest.latest_version_id, None, manifest=manifest)
            checks.append(Check(family, "yaml_matches_etag", True, read.fetched.sha256[:16]))
            checks.append(Check(family, "functional_hash_matches_content_hash", read.content_hash_verified,
                                f"{read.parsed.content_hash[:16]} vs {read.entry.content_hash[:16]}"))
            identity = await source.family(DEFAULT_ENDPOINT, family)
            checks.append(Check(family, "permalink_and_organization", bool(identity.owner and identity.slug),
                                f"{identity.owner}/{identity.slug}"))
            fresh = SphereHttpSource(settings, transport=transport)
            again = await fresh.manifest(DEFAULT_ENDPOINT, family, None, if_none_match=manifest.etag)
            checks.append(Check(family, "revalidation_304", isinstance(again, NotModified), str(manifest.etag)[:20]))
            raw = await outbound.fetch(
                f"{settings.sphere_url}/api/v1/public/pricings/{family}",
                policy=OutboundPolicy(max_bytes=settings.sphere_max_bytes),
                headers={"accept": "application/json", "user-agent": "openbinding-gateway"},
                transport=transport,
            )
            limit = raw.headers.get("ratelimit-limit")
            checks.append(Check(family, "rate_limit_headers", limit is not None, f"limit={limit}"))
        except (PricingError, OutboundError) as exc:
            checks.append(Check(family, "readable", False, f"{type(exc).__name__}: {exc}"))
    return checks


def main(argv: list[str] | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_SPHERE_URL, help="the SPHERE to check (https)")
    parser.add_argument("--family", action="append", default=[], help="a pricingId (24 hex characters); repeatable")
    parser.add_argument("--json", action="store_true", help="print the checks as JSON")
    args = parser.parse_args(argv)
    families = args.family or list(DEFAULT_FAMILIES)
    if not args.url.startswith("https://") or not all(is_sphere_id(f) for f in families):
        print("--url must be https and every --family a SPHERE id (24 lower-case hexadecimal characters)", file=sys.stderr)
        return 2
    checks = asyncio.run(run(args.url, families, transport))
    if args.json:
        print(json.dumps([asdict(c) for c in checks], indent=2))
    else:
        for check in checks:
            print(f"{'ok  ' if check.ok else 'FAIL'} {check.family} {check.name} {check.detail}")
    if any(not c.ok and c.name == "readable" for c in checks):
        return 2
    return 0 if all(c.ok for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
