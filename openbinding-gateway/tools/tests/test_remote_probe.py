"""remote_probe against simulated SPACE/SPHERE: read-only, one JSON document, tolerant of odd answers."""

from __future__ import annotations

import json
import re

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
    strict = report["candidates"]["withoutUsageCounters"]  # no counters anywhere in this world: same answer
    assert (strict["mostRecent"]["slug"], strict["mostRecent"]["version"]) == ("other", "0.1.0")
    assert versions["1.0.0"]["cu"]["hasUsageCounters"] is False and versions["0.9.0"]["cu"]["hasCu"] is True


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


def test_candidates_rank_both_lists_class_a_excludes_from_both_class_b_only_from_the_strict_one():
    def entry(version, created, status):
        return {"slug": "s", "version": version, "createdAt": created, "createdAtKind": "datetime", "digest": "sha256-x",
                "download": {"ok": True}, "cu": {"status": status}}

    versions = [
        entry("1.0.0", "2026-01-01T00:00:00Z", "clean"),
        entry("2.0.0", "2026-02-01T00:00:00Z", "counters"),
        entry("3.0.0", "2026-03-01T00:00:00Z", "counters"),
        entry("4.0.0", "2026-04-01T00:00:00Z", "cu"),
    ]
    result = remote_probe.compute_candidates([{"slug": "s", "versions": versions}])
    assert result["mostRecentWithoutCu"]["version"] == "3.0.0"
    assert [item["version"] for item in result["ranking"]] == ["3.0.0", "2.0.0", "1.0.0"]
    assert {(item["version"], item["reason"]) for item in result["excluded"]} == {("4.0.0", "has-cu")}
    assert "3 version(s) without CU;" in result["why"] and "1 with CU" in result["why"]
    strict = result["withoutUsageCounters"]
    assert strict["mostRecent"]["version"] == "1.0.0" and strict["eligibleCount"] == 1
    assert [item["version"] for item in strict["ranking"]] == ["1.0.0"]
    assert {(item["version"], item["reason"]) for item in strict["excluded"]} == {
        ("2.0.0", "has-usage-counters"), ("3.0.0", "has-usage-counters"), ("4.0.0", "has-cu")
    }
    assert "without CU or usage counters" in strict["why"]


def test_candidates_when_every_version_has_usage_counters_like_the_real_remote():
    def entry(version, created):
        return {"slug": "s", "version": version, "createdAt": created, "createdAtKind": "datetime", "digest": "sha256-x",
                "download": {"ok": True}, "cu": {"status": "counters"}}

    result = remote_probe.compute_candidates(
        [{"slug": "s", "versions": [entry("0.1.0", "2026-01-01T00:00:00Z"), entry("0.1.5", "2026-05-01T00:00:00Z")]}]
    )
    assert result["mostRecentWithoutCu"]["version"] == "0.1.5"
    assert result["withoutUsageCounters"]["mostRecent"] is None
    assert "no version without CU or usage counters" in result["withoutUsageCounters"]["why"]


def test_probe_scans_the_class_b_world_and_summary_lists_both_name_sets(capsys):
    fake = FakeRemotes()
    fake.add_sphere("openbinding", "0.1.0", pricing_yaml(version="0.1.0", created="2026-05-01T10:00:00Z", counters=True))
    fake.add_sphere("openbinding", "0.1.1", pricing_yaml(version="0.1.1", created="2026-06-01T10:00:00Z", counters=True), private=True)
    fake.add_sphere("openbinding", "0.1.2", pricing_yaml(version="0.1.2", created="2026-07-01T10:00:00Z", cu=True, counters=True))
    code, out, err = run(fake, capsys, "--summary")
    assert code == 0
    summary = summary_of(out)
    assert summary["cuNames"] == ["capacityUnits"]
    assert summary["counterNames"] == ["concurrentJobs", "solverSeconds", "taskStarts"]
    rows = {row[0]: row for row in summary["sphere"]["pricings"]["openbinding"]["versions"]}
    # [version, private, createdAt, kind, hasCu, nA, hasCounters, nB, digest12, saasName]
    assert rows["0.1.0"][4:8] == [False, 0, True, 3]
    assert rows["0.1.2"][4] is True and rows["0.1.2"][5] == 1 and rows["0.1.2"][6] is True
    candidates = summary["candidates"]
    assert candidates["latestWithoutCu"][:2] == ["openbinding", "0.1.1"]
    assert candidates["latestWithoutUsageCounters"] is None
    assert "without CU" in candidates["reason"] and "no version without CU or usage counters" in candidates["reasonCounters"]
    full = json.loads(err)
    assert full["candidates"]["withoutUsageCounters"]["mostRecent"] is None


def big_world(count: int = 32) -> FakeRemotes:
    fake = FakeRemotes()
    for index in range(count):
        # Inserted in scrambled order so the summary has to sort; createdAt grows with the version.
        position = (index * 7) % count
        version = f"1.{position}.0"
        created = f"2026-0{1 + position // 28}-{1 + position % 28:02d}T10:00:00Z"
        fake.add_sphere("openbinding", version, pricing_yaml(version=version, created=created, cu=position == count - 1),
                        private=position % 2 == 0)
    fake.add_space("openbinding", [f"1.{i}.0" for i in range(count)])
    return fake


def summary_of(out: str) -> dict:
    last = out.rstrip("\n").splitlines()[-1]
    return json.loads(last)


def test_summary_is_the_last_stdout_line_compact_ordered_and_secret_free(capsys):
    fake = big_world()
    code, out, err = run(fake, capsys, "--summary")
    assert code == 0
    assert_no_secrets(out, err)
    lines = out.rstrip("\n").splitlines()
    assert len(lines) == 1 and len(out) < 4000
    summary = summary_of(out)
    assert json.loads(err)["readOnly"] is True  # the full report moved to stderr

    rows = summary["sphere"]["pricings"]["openbinding"]["versions"]
    assert len(rows) == 32
    assert [row[0] for row in rows] == [f"1.{i}.0" for i in range(32)]
    assert [row[2] for row in rows] == sorted(row[2] for row in rows)
    version, private, created, kind, has_cu, n_cu, has_counters, n_counters, digest, saas = rows[0]
    assert (kind, has_cu, n_cu, has_counters, n_counters) == ("datetime", False, 0, False, 0)
    assert saas is None and summary["sphere"]["pricings"]["openbinding"]["saasName"] == "openbinding"  # null = the common name
    assert isinstance(private, bool) and re.fullmatch(r"[0-9a-f]{12}", digest)
    assert summary["sphere"]["orgs"] == [["OpenBinding", "sphe...0002", True]]
    assert summary["space"]["health"] == [True, 200]
    assert summary["space"]["services"][0][2] == 32 and summary["space"]["services"][0][1] == "svc-...ding"
    assert summary["denied"] == []
    assert "syntaxVersion" not in out and "currency" not in out


def test_summary_stays_under_4000_characters_when_every_version_has_both_classes(capsys):
    fake = FakeRemotes()
    for position in range(30):
        version = f"1.{position}.0"
        created = f"2026-0{1 + position // 28}-{1 + position % 28:02d}T10:00:00Z"
        fake.add_sphere("openbinding", version, pricing_yaml(version=version, created=created, cu=position % 5 == 0, counters=True),
                        private=position % 2 == 0)
    fake.add_space("openbinding", [f"1.{i}.0" for i in range(30)])
    code, out, err = run(fake, capsys, "--summary")
    assert code == 0 and len(out) < 4000 and len(out.rstrip("\n").splitlines()) == 1
    summary = summary_of(out)
    assert summary["cuNames"] == ["capacityUnits"] and len(summary["counterNames"]) == 3
    assert all(row[6] is True and row[7] == 3 for row in summary["sphere"]["pricings"]["openbinding"]["versions"])


def test_summary_candidate_is_the_latest_version_without_cu(capsys):
    fake = big_world()
    _, out, _ = run(fake, capsys, "--summary")
    summary = summary_of(out)
    rows = summary["sphere"]["pricings"]["openbinding"]["versions"]
    with_cu = [row for row in rows if row[4]]
    assert len(with_cu) == 1 and with_cu[0][2] == max(row[2] for row in rows)  # the newest one has CU
    assert summary["cuNames"] == ["capacityUnits"] and summary["counterNames"] == []
    clean = [row for row in rows if row[4] is False]
    slug, version, created, digest = summary["candidates"]["latestWithoutCu"]
    assert (slug, version, created) == ("openbinding", clean[-1][0], clean[-1][2])
    assert digest == clean[-1][8]
    assert summary["candidates"]["latestWithoutUsageCounters"] == summary["candidates"]["latestWithoutCu"]
    assert "latest createdAt" in summary["candidates"]["reason"]
    assert "latest createdAt" in summary["candidates"]["reasonCounters"]


def test_summary_without_candidate_and_with_denied_calls(capsys):
    fake = production_world()
    fake.statuses[("space.test", "GET", "/api/v1/services")] = 403
    fake.statuses[("sphere.test", "GET", "/api/v1/users/me/orgs")] = 401
    fake.raw_bodies[("sphere.test", "GET", "/api/v1/pricings/sphere-org-0002/openbinding")] = {"versions": "nope"}
    code, out, err = run(fake, capsys, "--summary")
    summary = summary_of(out)
    assert code == 0
    assert_no_secrets(out, err)
    assert {tuple(item) for item in summary["denied"]} == {
        ("space", "GET /services", 403),
        ("sphere", "GET /users/me/orgs", 401),
    }
    assert summary["candidates"]["latestWithoutCu"] is None and summary["sphere"]["orgs"] == []
    assert summary["candidates"]["latestWithoutUsageCounters"] is None
    assert "no version without CU" in summary["candidates"]["reason"]
    assert "no version without CU or usage counters" in summary["candidates"]["reasonCounters"]


def test_without_summary_stdout_is_still_the_single_full_document(capsys):
    code, out, err = run(rich_world(), capsys)
    assert code == 0 and err == "" and "summary" not in parse_single_document(out)


@pytest.mark.parametrize("status, verdict", [(200, "allowed"), (401, "unauthorized"), (403, "forbidden"), (404, "not-found"), (500, "error"), (None, "unreachable")])
def test_verdicts(status, verdict):
    assert remote_probe._verdict(status) == verdict
