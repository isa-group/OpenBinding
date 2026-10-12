"""remote_probe against simulated SPACE/SPHERE: read-only, one JSON document, tolerant of odd answers."""

from __future__ import annotations

import json

import httpx
import pytest

import remote_probe
from fakes import ENV, SPACE_KEY, SPHERE_KEY, FakeRemotes, production_world, pricing_yaml


def run(fake: FakeRemotes, capsys, *argv: str, environ=None):
    code = remote_probe.main(list(argv), environ=ENV if environ is None else environ, transport=fake.transport())
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def parse_single_document(out: str) -> dict:
    document = json.loads(out)  # raises if stdout holds anything but one JSON document
    assert isinstance(document, dict)
    return document


def assert_no_secrets(*texts: str) -> None:
    for text in texts:
        assert SPACE_KEY not in text and SPHERE_KEY not in text
        assert "syntaxVersion" not in text  # no YAML body is ever printed


def rich_world() -> FakeRemotes:
    fake = production_world()  # openbinding: 0.9.0 (CU), 1.0.0 (clean, 2026-09-01T10:00:00Z)
    fake.add_sphere("openbinding", "1.1.0", pricing_yaml(version="1.1.0", created="2026-09-15"), private=True)
    fake.add_sphere("other", "0.1.0", pricing_yaml(saas="other", version="0.1.0", created="2026-09-15T08:00:00Z"), private=True)
    return fake


def test_probe_reports_everything_read_only_and_picks_the_most_recent_version_without_cu(capsys):
    fake = rich_world()
    code, out, err = run(fake, capsys)
    assert code == 0 and err == ""
    report = parse_single_document(out)
    assert_no_secrets(out)
    assert fake.methods() == {"GET"} and not fake.uploads

    assert report["readOnly"] is True
    assert report["space"]["healthcheck"] == {"ok": True, "status": 200, "error": None}
    names = {item["name"]: item for item in report["space"]["services"]}
    assert names["openbinding"]["organizationMatchesConfigured"] is True
    assert [(v["version"], v["status"]) for v in names["openbinding"]["versions"]] == [("0.9.0", "active"), ("1.0.0", "active")]
    assert report["space"]["contracts"]["available"] is False

    assert report["sphere"]["organization"]["name"] == "OpenBinding"
    assert report["sphere"]["slugListing"]["slugs"] == ["openbinding", "other"]
    pricings = {item["slug"]: item for item in report["sphere"]["pricings"]}
    versions = {v["version"]: v for v in pricings["openbinding"]["versions"]}
    assert versions["0.9.0"]["cu"]["status"] == "cu" and "capacityUnits" in versions["0.9.0"]["cu"]["limitNames"]
    assert versions["1.0.0"]["cu"]["status"] == "clean"
    assert versions["1.0.0"]["digest"].startswith("sha256-") and versions["1.0.0"]["bytes"] > 0
    assert (versions["1.0.0"]["createdAtKind"], versions["1.0.0"]["createdAtFormat"]) == ("datetime", "YYYY-MM-DDTHH:mm:ssZ")
    assert versions["1.1.0"]["createdAtKind"] == "date" and versions["1.1.0"]["private"] is True
    assert versions["1.0.0"]["private"] is False and versions["1.0.0"]["versionMatchesYaml"] is True

    candidate = report["candidates"]["mostRecentWithoutCu"]
    assert (candidate["slug"], candidate["version"]) == ("other", "0.1.0")
    assert report["candidates"]["why"].startswith("other@0.1.0 has the latest createdAt")
    assert {(item["slug"], item["version"], item["reason"]) for item in report["candidates"]["excluded"]} == {
        ("openbinding", "0.9.0", "has-cu")
    }
    assert [(item["slug"], item["version"]) for item in report["candidates"]["ranking"]] == [
        ("other", "0.1.0"), ("openbinding", "1.1.0"), ("openbinding", "1.0.0")
    ]


def test_probe_lists_capabilities_with_the_status_of_every_call(capsys):
    fake = rich_world()
    code, out, _ = run(fake, capsys)
    calls = parse_single_document(out)["capabilities"]["calls"]
    assert code == 0
    assert {"service": "space", "call": "GET /services", "status": 200, "verdict": "allowed"} in calls
    assert all(item["verdict"] == "allowed" for item in calls)


def test_denied_calls_are_reported_as_401_403_and_the_probe_still_succeeds(capsys):
    fake = rich_world()
    fake.statuses[("space.test", "GET", "/api/v1/services")] = 403
    fake.statuses[("sphere.test", "GET", "/api/v1/users/me/orgs")] = 401
    fake.sphere_listing_status = 404
    code, out, err = run(fake, capsys)
    report = parse_single_document(out)
    assert code == 0
    assert_no_secrets(out, err)  # the simulated errors echo the credential; it must be scrubbed
    denied = {(item["service"], item["status"]) for item in report["capabilities"]["denied"]}
    assert denied == {("space", 403), ("sphere", 401)}
    assert report["space"]["servicesCall"]["status"] == 403 and report["space"]["services"] == []
    assert report["sphere"]["slugListing"]["available"] is False
    assert "openbinding" in {item["slug"] for item in report["sphere"]["pricings"]}  # the known slug is still inspected


def test_extra_slugs_are_inspected_and_missing_ones_reported_not_found(capsys):
    fake = production_world()
    fake.sphere_listing_status = 404
    code, out, _ = run(fake, capsys, "--sphere-slug", "ghost")
    report = parse_single_document(out)
    ghost = next(item for item in report["sphere"]["pricings"] if item["slug"] == "ghost")
    assert code == 0 and ghost["exists"] is False and ghost["versions"] == []


def test_malformed_answers_are_reported_without_raising(capsys):
    fake = production_world()
    fake.raw_bodies[("space.test", "GET", "/api/v1/services")] = "just a string"
    fake.raw_bodies[("sphere.test", "GET", "/api/v1/pricings/sphere-org-0002/openbinding")] = {"versions": "nope", "secretish": "VALUE"}
    fake.raw_bodies[("sphere.test", "GET", "/api/v1/users/me/orgs")] = 12
    code, out, _ = run(fake, capsys)
    report = parse_single_document(out)
    assert code == 0 and report["errors"] == []
    assert report["space"]["serviceNotes"][0].startswith("unrecognized-services-shape")
    assert report["sphere"]["pricings"][0]["notes"][0].startswith("unrecognized-versions-shape")
    assert "VALUE" not in out  # only shapes (key names) of unknown bodies are printed, never values
    assert report["candidates"]["mostRecentWithoutCu"] is None
    assert "no version without CU" in report["candidates"]["why"]


def test_unreadable_and_untrusted_yaml_are_excluded_from_candidates(capsys):
    fake = FakeRemotes()
    fake.add_sphere("openbinding", "1.0.0", b"a: [broken", created=None)
    fake.add_sphere("openbinding", "1.1.0", pricing_yaml(version="1.1.0"))
    fake.add_sphere("openbinding", "1.2.0", pricing_yaml(version="1.2.0"))
    fake.yaml_url_override[("openbinding", "1.1.0")] = "https://evil.test/static/pricings/x.yml"
    fake.yaml_url_override[("openbinding", "1.2.0")] = "/etc/passwd"
    code, out, _ = run(fake, capsys)
    report = parse_single_document(out)
    reasons = {(item["version"], item["reason"]) for item in report["candidates"]["excluded"]}
    assert code == 0
    assert reasons == {("1.0.0", "yaml-unparsed"), ("1.1.0", "yaml-not-downloadable"), ("1.2.0", "yaml-not-downloadable")}
    assert "evil.test" not in {item.host for item in fake.requests}


def test_unreachable_services_are_reported_inside_the_single_document(capsys):
    fake = production_world()
    for host in ("space.test", "sphere.test"):
        fake.raise_on[(host, "GET", "/api/v1/*")] = httpx.ConnectError(f"cannot connect with {SPACE_KEY} {SPHERE_KEY}")
    code, out, err = run(fake, capsys)
    report = parse_single_document(out)
    assert code == 0
    assert_no_secrets(out, err)
    assert {item["verdict"] for item in report["capabilities"]["calls"]} == {"unreachable"}


def test_an_unexpected_failure_in_a_section_is_data_not_a_crash(capsys):
    fake = production_world()
    fake.raise_on[("sphere.test", "GET", "/api/v1/orgs/*")] = RuntimeError(f"bug leaking {SPHERE_KEY}")
    code, out, err = run(fake, capsys)
    report = parse_single_document(out)
    assert code == 0 and report["errors"] and report["errors"][0]["section"] == "sphere"
    assert_no_secrets(out, err)


def test_missing_environment_exits_2_with_a_json_error_and_no_values(capsys):
    fake = production_world()
    code, out, _ = run(fake, capsys, environ={**ENV, "SPACE_URL": "http://space.test", "SPHERE_API_KEY": ""})
    assert code == 2 and fake.requests == []
    error = json.loads(out)["error"]
    assert "SPACE_URL must use the https scheme" in error and "SPHERE_API_KEY is not set" in error


def test_candidates_break_ties_by_version_order_and_flag_ambiguity():
    def entry(slug, version, created):
        return {"slug": slug, "version": version, "createdAt": created, "createdAtKind": "datetime", "digest": "sha256-x",
                "download": {"ok": True}, "cu": {"status": "clean"}, "private": True}

    same = "2026-10-01T00:00:00Z"
    pricings = [{"slug": "a", "versions": [entry("a", "1.2.0", same), entry("a", "1.10.0", same)]}]
    result = remote_probe.compute_candidates(pricings)
    assert result["mostRecentWithoutCu"]["version"] == "1.10.0" and result["ambiguous"] is False
    pricings.append({"slug": "b", "versions": [entry("b", "1.10.0", same)]})
    assert remote_probe.compute_candidates(pricings)["ambiguous"] is True


def test_candidates_prefer_the_latest_created_at_over_a_higher_version():
    def entry(version, created):
        return {"slug": "s", "version": version, "createdAt": created, "createdAtKind": "datetime", "digest": "sha256-x",
                "download": {"ok": True}, "cu": {"status": "clean"}}

    result = remote_probe.compute_candidates([{"slug": "s", "versions": [entry("9.0.0", "2026-01-01T00:00:00Z"), entry("1.0.0", "2026-06-01T00:00:00Z")]}])
    assert result["mostRecentWithoutCu"]["version"] == "1.0.0"


@pytest.mark.parametrize("status, verdict", [(200, "allowed"), (401, "unauthorized"), (403, "forbidden"), (404, "not-found"), (500, "error"), (None, "unreachable")])
def test_verdicts(status, verdict):
    assert remote_probe._verdict(status) == verdict
