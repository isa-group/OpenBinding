#!/usr/bin/env python3
"""Read-only probe of the private SPACE and SPHERE organizations.

Prints exactly one JSON document on stdout and exits 0 once it could run (a call
that fails is reported inside the document). It never writes to SPACE or SPHERE,
never prints keys, headers or YAML bodies - only digests, names of limits, and
shapes of responses it does not understand.

Environment: SPACE_URL, SPACE_API_KEY, SPACE_ORGANIZATION_ID, SPHERE_URL,
SPHERE_API_KEY, SPHERE_ORGANIZATION_ID. Exit 2 (with a JSON error) if they are
missing or malformed.

Usage:
    python tools/remote_probe.py [--sphere-slug SLUG ...] [--max-versions N]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Any

import httpx

from _remote_common import (
    EXIT_GUARD,
    EXIT_INTERNAL,
    EXIT_OK,
    ConfigError,
    Redactor,
    RemoteEnv,
    SpaceRemote,
    SphereRemote,
    _first,
    _slug_names,
    emit_json,
    load_env,
    mask_id,
    normalize_space_services,
    normalize_sphere_versions,
    parse_created_at,
    scan_cu,
    sha256_digest,
    shape_of,
    utc_timestamp_z,
    version_key,
    yaml_meta,
)

KNOWN_SPHERE_SLUGS = ("openbinding",)
_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def _verdict(status: int | None) -> str:
    if status is None:
        return "unreachable"
    if 200 <= status < 300:
        return "allowed"
    return {401: "unauthorized", 403: "forbidden", 404: "not-found"}.get(status, "error")


class _Capabilities:
    """What the key could and could not do on the (read) calls that were made."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def record(self, service: str, call: str, status: int | None) -> None:
        self.calls.append({"service": service, "call": call, "status": status, "verdict": _verdict(status)})

    def report(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "denied": [item for item in self.calls if item["status"] in (401, 403)],
            "notes": [
                "Only read calls are made. Whether the keys can write (SPACE needs scope ALL or MANAGEMENT; "
                "SPHERE needs write access to the organization) cannot be observed without writing, so it is "
                "not inferred here."
            ],
        }


def _orgs_from(body: Any) -> list[dict[str, Any]]:
    items: list[Any]
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        nested = next((body[key] for key in ("items", "organizations", "data") if isinstance(body.get(key), list)), None)
        items = nested if nested is not None else [body]
    else:
        return []
    flat: list[dict[str, Any]] = []
    pending = [item for item in items if isinstance(item, dict)]
    while pending and len(flat) < 200:
        item = pending.pop(0)
        flat.append(item)
        for key in ("subOrganizations", "children"):
            if isinstance(item.get(key), list):
                pending.extend(child for child in item[key] if isinstance(child, dict))
    return flat


def _org_summary(item: dict[str, Any], configured: str) -> dict[str, Any]:
    identifier = _first(item, "id", "_id", "organizationId")
    return {
        "name": item.get("name") if isinstance(item.get("name"), str) else None,
        "displayName": item.get("displayName") if isinstance(item.get("displayName"), str) else None,
        "id": mask_id(str(identifier)) if identifier else None,
        "isConfiguredOrganization": (str(identifier) == configured) if identifier else None,
    }


def _pricing_list_versions(body: Any) -> list[dict[str, Any]]:
    items = body.get("pricings") if isinstance(body, dict) else body
    result = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and isinstance(item.get("version"), str):
            result.append(
                {
                    "version": item["version"],
                    "status": item.get("status") if isinstance(item.get("status"), str) else None,
                    "id": _first(item, "id", "_id"),
                    "createdAt": _first(item, "createdAt", "extractionDate"),
                }
            )
    return result


async def probe_space(env: RemoteEnv, caps: _Capabilities, transport: httpx.AsyncBaseTransport | None) -> dict[str, Any]:
    space = SpaceRemote(env, transport=transport)
    section: dict[str, Any] = {}
    try:
        health = await space.healthcheck()
        caps.record("space", "GET /healthcheck", health["status"])
        section["healthcheck"] = health

        result = await space.services()
        caps.record("space", "GET /services", result.status)
        services: list[dict[str, Any]] = []
        notes: list[str] = []
        if result.ok:
            services, notes = normalize_space_services(result.data)
        section["servicesCall"] = result.describe() if not result.ok else {"status": result.status}
        for service in services:
            if not service["versions"]:
                detail = await space.service_pricings(service["name"])
                caps.record("space", "GET /services/{name}/pricings", detail.status)
                if detail.ok:
                    service["versions"] = _pricing_list_versions(detail.data)
                    if not service["versions"]:
                        notes.append("service-without-recognizable-versions")
            org = service.get("organizationId")
            service["organizationMatchesConfigured"] = (str(org) == env.space_organization_id) if org else None
            service["organizationId"] = mask_id(str(org)) if org else None
            service["contracts"] = None
        section["services"] = services
        section["serviceNotes"] = notes
        section["contracts"] = {
            "available": False,
            "reason": "The official space-python-client has no contract listing/count operation (only per-user "
            "get/add/update/remove); counting would need an undocumented endpoint, so none is called.",
        }
    finally:
        await space.aclose()
    return section


async def _inspect_version(sphere: SphereRemote, slug: str, item: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "slug": slug,
        "version": item["version"],
        "private": item["private"],
        "privateReported": item["private"] is not None,
        "apiCreatedAt": item["apiCreatedAt"],
        "id": item["id"],
        "yamlUrlPresent": bool(item["yamlUrl"]),
    }
    download = await sphere.download_yaml(item["yamlUrl"])
    entry["download"] = {"ok": download.content is not None, "error": download.error, "status": download.status}
    if download.content is None:
        entry.update(digest=None, bytes=None, cu={"status": "unparsed", "parsed": False, "hasCu": None, "findings": [], "limitNames": [], "planLimitNames": []})
        return entry
    meta = yaml_meta(download.content)
    entry.update(
        digest=sha256_digest(download.content),
        bytes=len(download.content),
        yamlVersion=meta["version"],
        versionMatchesYaml=(meta["version"] == item["version"]) if meta["version"] else None,
        createdAt=meta["createdAt"],
        createdAtQuoted=meta["createdAtQuoted"],
        createdAtKind=meta["createdAtKind"],
        createdAtFormat=meta["createdAtFormat"],
        saasName=meta["saasName"],
        parseError=meta["parseError"],
        cu=scan_cu(download.content),
    )
    return entry


async def probe_sphere(
    env: RemoteEnv,
    caps: _Capabilities,
    transport: httpx.AsyncBaseTransport | None,
    extra_slugs: Sequence[str],
    max_versions: int,
) -> dict[str, Any]:
    sphere = SphereRemote(env, transport=transport)
    section: dict[str, Any] = {}
    try:
        mine = await sphere.my_orgs()
        caps.record("sphere", "GET /users/me/orgs", mine.status)
        section["visibleOrganizations"] = (
            [_org_summary(item, env.sphere_organization_id) for item in _orgs_from(mine.data)]
            if mine.ok
            else {"call": mine.describe()}
        )

        org = await sphere.org()
        caps.record("sphere", "GET /orgs/{orgId}", org.status)
        if org.ok and isinstance(org.data, dict):
            section["organization"] = _org_summary(org.data, env.sphere_organization_id)
        else:
            section["organization"] = {"call": org.describe(), "shape": shape_of(org.data)}

        listing = await sphere.list_pricings()
        caps.record("sphere", "GET /pricings/{orgId}?includePrivate=true", listing.status)
        discovered = _slug_names(listing.data) if listing.ok else None
        section["slugListing"] = {
            "available": discovered is not None,
            "status": listing.status,
            "slugs": discovered,
            "shape": None if discovered is not None or not listing.ok else shape_of(listing.data),
        }

        slugs = sorted(set(discovered or []) | set(extra_slugs) | set(KNOWN_SPHERE_SLUGS))
        pricings: list[dict[str, Any]] = []
        for slug in slugs:
            result = await sphere.pricing_versions(slug)
            caps.record("sphere", "GET /pricings/{orgId}/{slug}?includePrivate=true", result.status)
            record: dict[str, Any] = {"slug": slug, "status": result.status, "versions": [], "notes": []}
            if result.status == 404:
                record["exists"] = False
            elif not result.ok:
                record["exists"] = None
                record["call"] = result.describe()
            else:
                record["exists"] = True
                versions, notes = normalize_sphere_versions(result.data)
                record["notes"] = notes
                versions.sort(key=lambda item: version_key(item["version"]), reverse=True)
                record["versionCount"] = len(versions)
                if len(versions) > max_versions:
                    record["notes"].append(f"only the {max_versions} highest versions were inspected")
                for item in versions[:max_versions]:
                    record["versions"].append(await _inspect_version(sphere, slug, item))
            pricings.append(record)
        section["pricings"] = pricings
    finally:
        await sphere.aclose()
    return section


def compute_candidates(pricings: Sequence[dict[str, Any]], space_services: Sequence[dict[str, Any]] = ()) -> dict[str, Any]:
    """Most recent version without capacity units: by YAML createdAt, then by version order."""
    eligible: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for pricing in pricings:
        for entry in pricing.get("versions", []):
            status = (entry.get("cu") or {}).get("status")
            reason = None
            if not entry.get("download", {}).get("ok"):
                reason = "yaml-not-downloadable"
            elif status == "cu":
                reason = "has-cu"
            elif status != "clean":
                reason = "yaml-unparsed"
            if reason:
                excluded.append({"slug": entry["slug"], "version": entry["version"], "reason": reason})
            else:
                eligible.append(entry)

    def sort_key(entry: dict[str, Any]) -> tuple:
        return (parse_created_at(entry.get("createdAt")) or _EPOCH, version_key(entry["version"]))

    eligible.sort(key=sort_key, reverse=True)
    ranking = [
        {
            "slug": entry["slug"],
            "version": entry["version"],
            "createdAt": entry.get("createdAt"),
            "createdAtKind": entry.get("createdAtKind"),
            "private": entry.get("private"),
            "digest": entry["digest"],
        }
        for entry in eligible[:5]
    ]
    result: dict[str, Any] = {
        "criteria": "latest YAML createdAt among versions without CU; ties by version order (numeric dotted)",
        "eligibleCount": len(eligible),
        "excluded": excluded,
        "ranking": ranking,
        "mostRecentWithoutCu": None,
        "ambiguous": False,
        "why": "no version without CU could be downloaded and read",
    }
    if eligible:
        head = eligible[0]
        tied = [item for item in eligible[1:] if sort_key(item) == sort_key(head)]
        counts = {
            reason: sum(1 for item in excluded if item["reason"] == reason)
            for reason in ("has-cu", "yaml-unparsed", "yaml-not-downloadable")
        }
        exact = [service["name"] for service in space_services if service["name"] == head.get("saasName")]
        result["mostRecentWithoutCu"] = {
            "slug": head["slug"],
            "version": head["version"],
            "createdAt": head.get("createdAt"),
            "createdAtKind": head.get("createdAtKind"),
            "createdAtFormat": head.get("createdAtFormat"),
            "private": head.get("private"),
            "digest": head["digest"],
            "saasName": head.get("saasName"),
            "spaceServicesWithExactlyThatName": exact,
        }
        result["ambiguous"] = bool(tied)
        result["why"] = (
            f"{head['slug']}@{head['version']} has the latest createdAt ({head.get('createdAt')}, "
            f"{head.get('createdAtKind')}) of {len(eligible)} version(s) without CU; excluded: "
            f"{counts['has-cu']} with CU, {counts['yaml-unparsed']} unreadable, "
            f"{counts['yaml-not-downloadable']} not downloadable."
            + (" Another version ties on createdAt and version order." if tied else "")
            + (" createdAt is date-only, so same-day versions are ordered by version." if head.get("createdAtKind") == "date" else "")
        )
    return result


async def run_probe(
    env: RemoteEnv,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    sphere_slugs: Sequence[str] = (),
    max_versions: int = 100,
) -> dict[str, Any]:
    redactor = Redactor(env.secrets())
    caps = _Capabilities()
    report: dict[str, Any] = {
        "tool": "remote_probe",
        "readOnly": True,
        "generatedAt": utc_timestamp_z(),
        "config": env.describe(),
        "space": {},
        "sphere": {},
        "errors": [],
    }
    for name, factory in (
        ("space", lambda: probe_space(env, caps, transport)),
        ("sphere", lambda: probe_sphere(env, caps, transport, sphere_slugs, max_versions)),
    ):
        try:
            report[name] = await factory()
        except Exception as exc:  # noqa: BLE001 - the probe always reports; a failed section is data
            report["errors"].append({"section": name, "error": redactor.error(exc)})
    report["capabilities"] = caps.report()
    report["candidates"] = compute_candidates(
        report["sphere"].get("pricings", []), report["space"].get("services", [])
    )
    return report


def _short_digest(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return value.split("-", 1)[1][:12] if value.startswith("sha256-") else value[:12]


def _summary_version(entry: dict[str, Any], common_saas: str | None) -> list[Any]:
    cu = entry.get("cu") or {}
    findings = cu.get("findings") or []
    saas = entry.get("saasName")
    return [
        entry["version"],
        entry.get("private"),
        entry.get("createdAt"),
        entry.get("createdAtKind", "missing"),
        cu.get("hasCu"),
        len(findings) if cu.get("parsed") else None,
        _short_digest(entry.get("digest")),
        None if saas is not None and saas == common_saas else saas,
    ]


def _short_reason(candidates: dict[str, Any]) -> str | None:
    head = candidates.get("mostRecentWithoutCu")
    if not head:
        return candidates.get("why")
    counts: dict[str, int] = {}
    for item in candidates.get("excluded", []):
        counts[item["reason"]] = counts.get(item["reason"], 0) + 1
    excluded = ",".join(f"{n} {reason}" for reason, n in sorted(counts.items())) or "none"
    tie = "; tie on createdAt+version" if candidates.get("ambiguous") else ""
    return (
        f"latest createdAt ({head.get('createdAtKind')}) of {candidates.get('eligibleCount')} "
        f"without CU; excluded: {excluded}{tie}"
    )


def build_summary(report: dict[str, Any]) -> dict[str, Any]:
    """Compact digest of ``run_probe``'s report: names, shapes and short digests only, never bodies."""
    sphere = report.get("sphere") or {}
    space = report.get("space") or {}
    visible = sphere.get("visibleOrganizations")
    orgs = [
        [item.get("name") or item.get("displayName"), item.get("id"), item.get("isConfiguredOrganization")]
        for item in (visible if isinstance(visible, list) else [])
    ]

    cu_names: set[str] = set()
    pricings: dict[str, Any] = {}
    for pricing in sphere.get("pricings", []):
        ordered = sorted(
            pricing.get("versions", []),
            key=lambda e: (parse_created_at(e.get("createdAt")) or _EPOCH, version_key(e["version"])),
        )
        names = [entry.get("saasName") for entry in ordered if entry.get("saasName")]
        common = max(set(names), key=names.count) if names else None
        for entry in ordered:
            for finding in (entry.get("cu") or {}).get("findings", []):
                cu_names.add(str(finding.get("name")))
        record: dict[str, Any] = {"saasName": common, "versions": [_summary_version(e, common) for e in ordered]}
        if pricing.get("status") != 200:
            record["status"] = pricing.get("status")
        if pricing.get("versionCount", len(ordered)) != len(ordered):
            record["total"] = pricing["versionCount"]
        pricings[pricing["slug"]] = record

    health = space.get("healthcheck") or {}
    services = []
    for item in space.get("services", []):
        by_status: dict[str, list[str]] = {}
        for v in item.get("versions", []):
            by_status.setdefault(str(v.get("status")), []).append(v["version"])
        services.append(
            [
                item["name"],
                mask_id(str(item["id"])) if item.get("id") else None,
                len(item.get("versions", [])),
                by_status,
            ]
        )
    denied = [
        [item["service"], item["call"], item["status"]]
        for item in (report.get("capabilities") or {}).get("denied", [])
    ]
    candidate = (report.get("candidates") or {}).get("mostRecentWithoutCu")
    return {
        "summary": 1,
        "sphere": {"orgs": orgs, "pricings": pricings},
        "space": {
            "health": [health.get("ok"), health.get("status")],
            "services": services,
        },
        "denied": denied,
        "cuNames": sorted(cu_names),
        "errors": [item.get("section") for item in report.get("errors", [])],
        "candidates": {
            "latestWithoutCu": (
                [candidate["slug"], candidate["version"], candidate.get("createdAt"), _short_digest(candidate.get("digest"))]
                if candidate
                else None
            ),
            "reason": _short_reason(report.get("candidates") or {}),
        },
    }


def emit_summary(report: dict[str, Any], redactor: Redactor) -> None:
    document = json.dumps(redactor.obj(build_summary(report)), separators=(",", ":"), ensure_ascii=True, default=str)
    print(redactor.exact(document))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only probe of the private SPACE/SPHERE organizations.")
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a compact one-line JSON summary as the last thing on stdout; the full report goes to stderr.",
    )
    parser.add_argument("--sphere-slug", action="append", default=[], help="Extra SPHERE pricing slug to inspect (repeatable).")
    parser.add_argument("--max-versions", type=int, default=100, help="Versions inspected per slug (highest first).")
    return parser


def main(argv: Sequence[str] | None = None, environ: dict[str, str] | None = None, transport: httpx.AsyncBaseTransport | None = None) -> int:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    args = build_parser().parse_args(argv)
    try:
        env = load_env(environ)
    except ConfigError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return EXIT_GUARD
    redactor = Redactor(env.secrets())
    try:
        report = asyncio.run(
            run_probe(env, transport=transport, sphere_slugs=args.sphere_slug, max_versions=max(1, args.max_versions))
        )
    except Exception as exc:  # noqa: BLE001
        print(redactor.error(exc), file=sys.stderr)
        return EXIT_INTERNAL
    if args.summary:
        emit_json(report, redactor, stream=sys.stderr)
        emit_summary(report, redactor)
    else:
        emit_json(report, redactor)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
