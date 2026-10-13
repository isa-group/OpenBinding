#!/usr/bin/env python3
"""Provision ONE private development pricing 0.1.0 in SPHERE and SPACE, behind explicit guards.

The SPACE/SPHERE keys reach every resource of their organization, production
included, so nothing is inferred: production and base resources are named on the
command line, identified remotely, and the development target must be new.

    --plan   (default) prints the exact plan; reads remote state, writes nothing
    --apply  runs it only if every guard passes

Exit codes: 0 ok, 2 bad arguments/configuration or a guard refused, 3 development
target already exists (nothing written), 4 a remote rejected or did not confirm a
step (reported verbatim, redacted, never retried with another format), 5 tool bug.

A base with credits/CU (class A) is always refused. A base with usage counters (class B: taskStarts,
solverSeconds, ...) is refused with exit 2 unless --accept-usage-counters is given; the content is then kept
as is (only version/createdAt/saasName change).

Never done: deleting or updating a version, overwriting an existing 0.1.0,
publishing, touching a resource named as production, retrying a rejected upload.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from collections.abc import Sequence
from datetime import datetime
from typing import Any

import httpx
import yaml

from _remote_common import (
    CLASS_COUNTER,
    CLASS_CU,
    EXIT_COLLISION,
    EXIT_GUARD,
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_REJECTED,
    ApiResult,
    ConfigError,
    Redactor,
    RemoteEnv,
    SpaceRemote,
    SphereRemote,
    emit_json,
    finding_names,
    load_env,
    mask_id,
    normalize_digest,
    normalize_space_services,
    normalize_sphere_versions,
    scan_cu,
    sha256_digest,
    shape_of,
    top_level_line,
    utc_timestamp_z,
    yaml_meta,
    _scalar,
)

DEV_VERSION = "0.1.0"
#: Names that are production by decision of the project, on top of what --prod-* names.
KNOWN_PRODUCTION_NAMES = ("openbinding",)
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


class YamlBuildError(ValueError):
    pass


# --------------------------------------------------------------------------
# The development YAML
# --------------------------------------------------------------------------


def created_at_line(value: str, quote_char: str) -> str:
    return f"createdAt: {quote_char}{value}{quote_char}"


def created_at_round_trips(line: str, expected: str, quote_char: str) -> bool:
    """parse -> serialize gives back the same text, and the parsed value is the string ``expected``."""
    parsed = yaml.safe_load(line)
    value = parsed.get("createdAt") if isinstance(parsed, dict) else None
    return isinstance(value, str) and value == expected and created_at_line(value, quote_char) == line


def build_dev_yaml(base: bytes, *, saas_name: str, created_at: str, version: str = DEV_VERSION) -> tuple[bytes, dict[str, Any]]:
    """The base document with only ``version``, ``createdAt`` and ``saasName`` replaced.

    Done as targeted line edits so every other byte keeps its format; quoting of each
    replaced value follows the base (``createdAt`` is always quoted, single quotes if the base
    had none). ``saasName`` becomes the development service name because SPACE names a service
    after the document's ``saasName`` - without this the upload would add a version to the
    base's own service.
    """
    try:
        text = base.decode("utf-8-sig")
        base_data = yaml.safe_load(text)
    except (UnicodeDecodeError, yaml.YAMLError) as exc:
        raise YamlBuildError(f"the base document cannot be read ({type(exc).__name__})") from None
    if not isinstance(base_data, dict):
        raise YamlBuildError("the base document is not a mapping")
    try:
        version_line = top_level_line(text, "version")
        saas_line = top_level_line(text, "saasName")
        created_line = top_level_line(text, "createdAt")
    except ValueError as exc:
        raise YamlBuildError(str(exc)) from None
    if version_line is None or saas_line is None:
        raise YamlBuildError("the base document lacks a top-level 'version' or 'saasName' line")
    newline = "\r\n" if "\r\n" in text else "\n"

    old_version, version_quote = _scalar(version_line.group(1))
    old_saas, saas_quote = _scalar(saas_line.group(1))
    old_created, created_quote = _scalar(created_line.group(1)) if created_line else (None, None)
    created_quote = created_quote or "'"
    new_created_line = created_at_line(created_at, created_quote)
    if not created_at_round_trips(new_created_line, created_at, created_quote):
        raise YamlBuildError("createdAt does not survive parse -> serialize unchanged")

    edits: list[tuple[int, int, str]] = [
        (version_line.start(), version_line.end(), f"version: {version_quote or ''}{version}{version_quote or ''}"),
        (saas_line.start(), saas_line.end(), f"saasName: {saas_quote or ''}{saas_name}{saas_quote or ''}"),
    ]
    if created_line is not None:
        edits.append((created_line.start(), created_line.end(), new_created_line))
    else:
        edits.append((version_line.end(), version_line.end(), newline + new_created_line))
    for start, end, replacement in sorted(edits, key=lambda item: item[0], reverse=True):
        text = text[:start] + replacement + text[end:]

    try:
        new_data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise YamlBuildError(f"the edited document does not parse ({type(exc).__name__})") from None
    expected = dict(base_data)
    expected.update(version=version, createdAt=created_at, saasName=saas_name)
    if new_data != expected:
        raise YamlBuildError("the edited document differs from the base in more than version/createdAt/saasName")
    changes = {
        "version": {"from": old_version, "to": version},
        "saasName": {"from": old_saas, "to": saas_name},
        "createdAt": {"from": old_created, "to": created_at, "inserted": created_line is None, "quoted": True},
    }
    return text.encode("utf-8"), changes


# --------------------------------------------------------------------------
# Guards
# --------------------------------------------------------------------------


class Guards:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.items.append({"name": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    @property
    def failed(self) -> list[dict[str, Any]]:
        return [item for item in self.items if not item["ok"]]


def protected_names(args: argparse.Namespace) -> set[str]:
    return {name.casefold() for name in (args.prod_slug, args.prod_service_name, *KNOWN_PRODUCTION_NAMES)}


def static_guards(args: argparse.Namespace, guards: Guards) -> bool:
    protected = protected_names(args)
    guards.check("dev-names-valid", bool(NAME_RE.match(args.dev_slug)) and bool(NAME_RE.match(args.dev_service_name)),
                 "dev slug/service name must match [a-z0-9][a-z0-9_-]{1,62}")
    guards.check("dev-slug-is-not-production", args.dev_slug.casefold() not in protected,
                 "the development slug must differ from --prod-slug, --prod-service-name and the reserved production names")
    guards.check("dev-service-is-not-production", args.dev_service_name.casefold() not in protected,
                 "the development service name must differ from --prod-slug, --prod-service-name and the reserved production names")
    guards.check("dev-slug-is-not-base", args.dev_slug.casefold() != args.base_pricing_slug.casefold(),
                 "the development slug must differ from the base slug")
    guards.check("base-digest-format", normalize_digest(args.base_digest) is not None, "--base-digest must be a SHA-256 (hex)")
    guards.check("base-version-format", bool(VERSION_RE.match(args.base_version)), "--base-version is not a plausible version string")
    return not guards.failed


def _versions_of(result: ApiResult) -> tuple[list[dict[str, Any]] | None, list[str]]:
    """Versions of a SPHERE pricing; ``None`` if absence/presence cannot be established."""
    if result.status == 404:
        return [], []
    if not result.ok:
        return None, [f"status {result.status}" + (f": {result.error}" if result.error else "")]
    versions, notes = normalize_sphere_versions(result.data)
    if any(note.startswith("unrecognized") for note in notes):
        return None, notes
    return versions, notes


async def _space_service(space: SpaceRemote, name: str, listed: dict[str, dict[str, Any]]) -> tuple[str, dict[str, Any], list[str]]:
    """``("absent"|"present"|"unknown", identity, notes)`` for an exact service name."""
    result = await space.service(name)
    notes: list[str] = []
    if result.status == 404:
        return ("present", listed[name], notes) if name in listed else ("absent", {}, notes)
    if not result.ok:
        return "unknown", {"status": result.status}, [f"status {result.status}"]
    services, notes = normalize_space_services(result.data)
    match = next((item for item in services if item["name"] == name), None)
    if match is None:
        return "unknown", {"shape": shape_of(result.data)}, notes + ["service body does not carry the requested name"]
    if not match["versions"]:
        pricings = await space.service_pricings(name)
        if pricings.ok:
            items = pricings.data.get("pricings") if isinstance(pricings.data, dict) else pricings.data
            match["versions"] = [
                {"version": item["version"], "status": item.get("status"), "id": item.get("id") or item.get("_id"), "createdAt": None}
                for item in (items if isinstance(items, list) else [])
                if isinstance(item, dict) and isinstance(item.get("version"), str)
            ]
    return "present", match, notes


def _version_ids(versions: Sequence[dict[str, Any]]) -> list[str]:
    return sorted(f"{item['version']}" for item in versions)


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------


class Outcome:
    def __init__(self) -> None:
        self.code = EXIT_OK
        self.reason = ""

    def fail(self, code: int, reason: str) -> None:
        if self.code == EXIT_OK:
            self.code, self.reason = code, reason


async def run(
    env: RemoteEnv,
    args: argparse.Namespace,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    now: datetime | None = None,
) -> tuple[dict[str, Any], int]:
    apply = bool(args.apply)
    guards = Guards()
    outcome = Outcome()
    report: dict[str, Any] = {
        "tool": "remote_provision",
        "mode": "apply" if apply else "plan",
        "config": env.describe(),
        "guards": guards.items,
        "arguments": {
            "baseSlug": args.base_pricing_slug,
            "baseVersion": args.base_version,
            "baseDigest": args.base_digest,
            "devSlug": args.dev_slug,
            "devServiceName": args.dev_service_name,
            "prodSlug": args.prod_slug,
            "prodServiceName": args.prod_service_name,
            "sphereEndpoint": args.sphere_endpoint,
            "acceptUsageCounters": bool(args.accept_usage_counters),
        },
        "base": {},
        "production": {},
        "collisions": [],
        "plan": {},
        "steps": [],
        "outcome": {},
    }

    def finish() -> tuple[dict[str, Any], int]:
        report["outcome"] = {"exitCode": outcome.code, "reason": outcome.reason or ("ok" if outcome.code == EXIT_OK else "")}
        return report, outcome.code

    if not static_guards(args, guards):
        outcome.fail(EXIT_GUARD, "argument guards failed; no remote call was made")
        return finish()

    sphere = SphereRemote(env, transport=transport)
    space = SpaceRemote(env, transport=transport)
    try:
        # -- identify the organizations ---------------------------------------------------
        org = await sphere.org()
        org_ok = org.ok and isinstance(org.data, dict)
        org_name = org.data.get("displayName") or org.data.get("name") if org_ok else None
        org_id = (org.data.get("id") or org.data.get("_id")) if org_ok else None
        guards.check("sphere-organization-identified", org_ok and (org_id is None or str(org_id) == env.sphere_organization_id),
                     f"SPHERE organization name={org_name!r} id={mask_id(str(org_id)) if org_id else 'not reported'}" if org_ok
                     else f"GET /orgs/{{orgId}} returned status {org.status}")
        report["production"]["sphereOrganization"] = {"name": org_name, "id": mask_id(str(org_id)) if org_id else None}

        health = await space.healthcheck()
        listing = await space.services()
        services, service_notes = normalize_space_services(listing.data) if listing.ok else ([], [])
        listed = {item["name"]: item for item in services}
        foreign = [item["name"] for item in services if item.get("organizationId") not in (None, env.space_organization_id)]
        guards.check("space-organization-identified", bool(health["ok"]) and listing.ok and not foreign,
                     "healthcheck and GET /services must work and every service must belong to SPACE_ORGANIZATION_ID"
                     + (f" (services of another organization: {foreign})" if foreign else "")
                     + (f" (services listing status {listing.status})" if not listing.ok else ""))
        report["production"]["spaceServicesSeen"] = sorted(listed)
        report["production"]["spaceServiceNotes"] = service_notes

        # -- identify production ----------------------------------------------------------
        prod_slug_result = await sphere.pricing_versions(args.prod_slug)
        prod_versions, prod_notes = _versions_of(prod_slug_result)
        guards.check("production-slug-identified", bool(prod_versions),
                     f"SPHERE slug {args.prod_slug!r} must exist with versions (found: {len(prod_versions) if prod_versions is not None else 'unknown'}) {prod_notes or ''}")
        prod_state, prod_service, prod_service_notes = await _space_service(space, args.prod_service_name, listed)
        guards.check("production-service-identified", prod_state == "present",
                     f"SPACE service {args.prod_service_name!r} must exist ({prod_state}) {prod_service_notes or ''}")
        production_before = {
            "sphereVersions": _version_ids(prod_versions or []),
            "spaceVersions": _version_ids(prod_service.get("versions", [])) if prod_state == "present" else None,
        }
        report["production"].update(slug=args.prod_slug, service=args.prod_service_name, before=production_before)

        # -- re-download and verify the base ---------------------------------------------
        base_content: bytes | None = None
        usage_counters: dict[str, Any] = {"status": "unknown", "names": []}
        base_result = await sphere.pricing_versions(args.base_pricing_slug)
        base_versions, base_notes = _versions_of(base_result)
        match = [item for item in (base_versions or []) if item["version"] == args.base_version]
        base: dict[str, Any] = {"slug": args.base_pricing_slug, "version": args.base_version, "found": len(match) == 1}
        if len(match) == 1:
            download = await sphere.download_yaml(match[0]["yamlUrl"])
            base_content = download.content
            base["private"] = match[0]["private"]
            base["downloadError"] = download.error
        guards.check("base-version-found", len(match) == 1,
                     f"{args.base_pricing_slug}@{args.base_version} must exist exactly once ({len(match)} found) {base_notes or ''}")
        if base_content is not None:
            digest = sha256_digest(base_content)
            base.update(digest=digest, bytes=len(base_content), meta=yaml_meta(base_content))
            base["cu"] = scan_cu(base_content)
            guards.check("base-digest-matches", normalize_digest(digest) == normalize_digest(args.base_digest),
                         f"downloaded digest {digest} vs --base-digest {args.base_digest}")
            scan = base["cu"]
            guards.check("base-has-no-cu", scan["parsed"] and not scan["hasCu"],
                         f"credit/CU (class A) scan status: {scan['status']} ({scan['cuCount']} class A finding(s)"
                         + (f": {', '.join(finding_names(scan, CLASS_CU))}" if scan["cuCount"] else "") + ")")
            counter_names = finding_names(scan, CLASS_COUNTER)
            usage_counters["names"] = counter_names
            if scan["parsed"] and scan["hasUsageCounters"]:
                usage_counters["status"] = "accepted" if args.accept_usage_counters else "refused"
            elif scan["parsed"]:
                usage_counters["status"] = "none"
            guards.check("base-usage-counters", usage_counters["status"] != "refused",
                         f"the base declares {scan['counterCount']} usage-counter finding(s) (class B: {', '.join(counter_names)}); "
                         "pass --accept-usage-counters to keep them unchanged in the development pricing, or choose another base"
                         if usage_counters["status"] == "refused"
                         else f"usage counters (class B): {usage_counters['status']}")
        elif len(match) == 1:
            guards.check("base-downloaded", False, f"the base YAML could not be downloaded: {base.get('downloadError')}")
        report["base"] = base
        report["plan"]["usageCounters"] = usage_counters

        # -- the development target must be new ------------------------------------------
        dev_versions, dev_notes = _versions_of(await sphere.pricing_versions(args.dev_slug))
        guards.check("dev-slug-state-known", dev_versions is not None, f"cannot tell whether SPHERE slug exists {dev_notes or ''}")
        collisions: list[dict[str, Any]] = []
        if dev_versions:
            identity: dict[str, Any] = {"service": "sphere", "slug": args.dev_slug, "versions": _version_ids(dev_versions)}
            existing = [item for item in dev_versions if item["version"] == DEV_VERSION]
            identity["has010"] = bool(existing)
            if existing:
                found = existing[0]
                download = await sphere.download_yaml(found["yamlUrl"])
                identity.update(private=found["private"], id=found["id"],
                                digest=sha256_digest(download.content) if download.content is not None else None,
                                digestError=download.error)
            collisions.append(identity)
        dev_state, dev_service, dev_service_notes = await _space_service(space, args.dev_service_name, listed)
        guards.check("dev-service-state-known", dev_state != "unknown", f"cannot tell whether the SPACE service exists: {dev_service} {dev_service_notes or ''}")
        if dev_state == "present":
            collisions.append({"service": "space", "name": args.dev_service_name, "id": dev_service.get("id"),
                               "versions": dev_service.get("versions", []),
                               "has010": any(item["version"] == DEV_VERSION for item in dev_service.get("versions", [])),
                               "digest": None, "digestNote": "SPACE exposes no original YAML to compare"})
        report["collisions"] = collisions

        # -- build the YAML ---------------------------------------------------------------
        built: bytes | None = None
        if base_content is not None:
            created_at = utc_timestamp_z(now)
            try:
                built, changes = build_dev_yaml(base_content, saas_name=args.dev_service_name, created_at=created_at)
                result_scan = scan_cu(built)
                clean = result_scan["parsed"] and not result_scan["hasCu"] and result_scan["counterCount"] == base["cu"]["counterCount"]
                guards.check("dev-yaml-built", clean,
                             "only version/createdAt/saasName changed; the result has no credit/CU (class A) finding and "
                             "exactly the base's usage-counter findings (class B)")
                if not clean:
                    built = None
                else:
                    meta = yaml_meta(built)
                    report["plan"]["yaml"] = {
                        "version": meta["version"], "createdAt": meta["createdAt"], "createdAtFormat": meta["createdAtFormat"],
                        "createdAtQuoted": meta["createdAtQuoted"], "saasName": meta["saasName"],
                        "digest": sha256_digest(built), "bytes": len(built), "changes": changes,
                        "note": "createdAt is 'now' (UTC) at this run; --apply computes it again, so its digest differs from a --plan run",
                    }
            except YamlBuildError as exc:
                guards.check("dev-yaml-built", False, str(exc))

        report["plan"].update(
            sphere={
                "call": "POST /api/v1/pricings/{orgId}" + ("" if args.sphere_endpoint == "create" else f"/{args.dev_slug}/{DEV_VERSION}"),
                "multipartFile": "yaml", "fields": {"private": "true", "saasName": args.dev_service_name, "name": args.dev_slug, "version": DEV_VERSION},
                "assumption": "UNVERIFIED: SPHERE accepts this endpoint/fields for a new pricing in an organization that already has others",
            },
            space={
                "call": "POST /api/v1/services", "multipartFile": "pricing", "serviceName": args.dev_service_name,
                "assumption": "UNVERIFIED: SPACE names the service after saasName and takes the file in the 'pricing' multipart field",
                "visibility": "SPACE has no private/public flag in the documented API; the upload is a native file upload, never the sphere permanentUrl link",
            },
            neverDone=["delete", "update an existing version", "overwrite an existing 0.1.0", "publish", "touch the production resources", "retry a rejected upload"],
        )

        non_collision = guards.failed
        if non_collision:
            reason = "guard(s) failed: " + ", ".join(item["name"] for item in non_collision)
            if any(item["name"] == "base-usage-counters" for item in non_collision):
                reason += (f"; the base declares usage counters ({', '.join(usage_counters['names'])}): rerun with "
                           "--accept-usage-counters to keep them unchanged, or choose another base")
            outcome.fail(EXIT_GUARD, reason)
        elif collisions:
            outcome.fail(EXIT_COLLISION, "the development target already exists; choose another development slug/service name (nothing was written, nothing deleted)")
        if outcome.code != EXIT_OK or not apply or built is None:
            if outcome.code == EXIT_OK and built is None:
                outcome.fail(EXIT_GUARD, "no development YAML could be built")
            return finish()

        # -- apply ------------------------------------------------------------------------
        await _apply(env, args, sphere, space, built, report, outcome, production_before, prod_service_name=args.prod_service_name)
        return finish()
    finally:
        await sphere.aclose()
        await space.aclose()


async def _apply(env: RemoteEnv, args: argparse.Namespace, sphere: SphereRemote, space: SpaceRemote, built: bytes,
                 report: dict[str, Any], outcome: Outcome, production_before: dict[str, Any], *, prod_service_name: str) -> None:
    steps: list[dict[str, Any]] = report["steps"]
    expected_digest = sha256_digest(built)
    protected = protected_names(args)

    # (d) SPHERE: private upload, then verify that it kept private=true and the version.
    upload = await sphere.upload_private(slug=args.dev_slug, version=DEV_VERSION, saas_name=args.dev_service_name, content=built,
                                         endpoint=args.sphere_endpoint, protected_slugs=protected)
    step: dict[str, Any] = {"step": "sphere-upload", "request": upload.describe(), "accepted": upload.ok}
    steps.append(step)
    if not upload.ok:
        step["rejected"] = True
        outcome.fail(EXIT_REJECTED, "SPHERE rejected the upload (reported literally, redacted; not retried with another format)")
        steps.append({"step": "space-upload", "skipped": "SPHERE step did not succeed"})
        return
    versions, notes = _versions_of(await sphere.pricing_versions(args.dev_slug))
    found = [item for item in (versions or []) if item["version"] == DEV_VERSION]
    verification: dict[str, Any] = {"versionPresent": len(found) == 1, "notes": notes, "versions": _version_ids(versions or [])}
    step["verification"] = verification
    if len(found) == 1:
        verification.update(private=found[0]["private"], id=found[0]["id"], apiCreatedAt=found[0]["apiCreatedAt"])
        download = await sphere.download_yaml(found[0]["yamlUrl"])
        if download.content is not None:
            verification["digest"] = sha256_digest(download.content)
            verification["digestMatchesUpload"] = verification["digest"] == expected_digest
        else:
            verification["digestError"] = download.error
    if len(found) != 1:
        outcome.fail(EXIT_REJECTED, "SPHERE accepted the upload but the development version 0.1.0 is not listed under the development slug "
                                    "(the slug may be derived differently by SPHERE; check the console - nothing was deleted)")
    elif found[0]["private"] is not True:
        verification["warning"] = "PUBLIC EXPOSURE" if found[0]["private"] is False else "visibility not reported"
        outcome.fail(EXIT_REJECTED, f"SPHERE did not confirm private=true ({verification['warning']}); handle it in the SPHERE console, nothing was changed by this tool")
    if outcome.code != EXIT_OK:
        steps.append({"step": "space-upload", "skipped": "SPHERE step was not confirmed"})
        return

    # (e) SPACE: native private upload of the very same bytes, then verify service and version.
    upload = await space.upload_service(content=built, filename=f"{args.dev_service_name}-{DEV_VERSION}.yaml", protected_service_names=protected)
    step = {"step": "space-upload", "request": upload.describe(), "accepted": upload.ok}
    steps.append(step)
    if not upload.ok:
        step["rejected"] = True
        outcome.fail(EXIT_REJECTED, "SPACE rejected the upload (reported literally, redacted; not retried with another format)")
        return
    listing = await space.services()
    services, notes = normalize_space_services(listing.data) if listing.ok else ([], [f"status {listing.status}"])
    listed = {item["name"]: item for item in services}
    state, service, service_notes = await _space_service(space, args.dev_service_name, listed)
    versions = service.get("versions", []) if state == "present" else []
    present = [item for item in versions if item["version"] == DEV_VERSION]
    step["verification"] = {
        "servicePresent": state == "present", "id": service.get("id") if state == "present" else None,
        "disabled": service.get("disabled") if state == "present" else None,
        "versions": versions, "version010Present": bool(present), "notes": notes + service_notes,
        "visibility": "SPACE exposes no public/private flag; the pricing was uploaded natively as a file and left as SPACE created it",
    }
    if state != "present" or not present:
        outcome.fail(EXIT_REJECTED, "SPACE accepted the upload but the service/version could not be confirmed")

    # Production must be exactly as before.
    prod_sphere, _ = _versions_of(await sphere.pricing_versions(args.prod_slug))
    prod_state, prod_service, _ = await _space_service(space, prod_service_name, listed)
    after = {"sphereVersions": _version_ids(prod_sphere or []),
             "spaceVersions": _version_ids(prod_service.get("versions", [])) if prod_state == "present" else None}
    report["production"]["after"] = after
    report["production"]["unchanged"] = after == production_before
    if after != production_before:
        outcome.fail(EXIT_REJECTED, "the production version lists differ from before the run; verify manually")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", action="store_true", help="Print the plan only (default).")
    mode.add_argument("--apply", action="store_true", help="Execute the plan if every guard passes.")
    for name in ("base-pricing-slug", "base-version", "base-digest", "dev-slug", "dev-service-name", "prod-slug", "prod-service-name"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--accept-usage-counters", action="store_true",
                        help="Accept a base that declares usage counters (taskStarts, solverSeconds, ...); they are kept unchanged.")
    parser.add_argument("--sphere-endpoint", choices=("create", "version"), default="create",
                        help="create: POST /pricings/{org}; version: POST /pricings/{org}/{slug}/0.1.0 (default: create).")
    return parser


def main(argv: Sequence[str] | None = None, environ: dict[str, str] | None = None,
         transport: httpx.AsyncBaseTransport | None = None, now: datetime | None = None) -> int:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    args = build_parser().parse_args(argv)
    try:
        env = load_env(environ)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return EXIT_GUARD
    redactor = Redactor(env.secrets())
    try:
        report, code = asyncio.run(run(env, args, transport=transport, now=now))
    except Exception as exc:  # noqa: BLE001 - reported redacted, never with the traceback of a remote error
        print(redactor.error(exc), file=sys.stderr)
        return EXIT_INTERNAL
    emit_json(report, redactor)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
