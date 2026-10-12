"""remote_provision: the plan, every guard with a negative case, and the apply path (simulated remotes)."""

from __future__ import annotations

import json
import re

import pytest
import yaml

import _remote_common as common
import remote_provision
from fakes import BASE_YAML, ENV, NOW, NOW_TEXT, SPACE_KEY, SPHERE_KEY, FakeRemotes, pricing_yaml, production_world

DEV_SLUG = "lab-dev-pricing"
DEV_SERVICE = "lab-dev-service"
BASE_DIGEST = common.sha256_digest(BASE_YAML)
SPHERE_CREATE = "/api/v1/pricings/sphere-org-0002"
DEFAULTS = {
    "base-pricing-slug": "openbinding",
    "base-version": "1.0.0",
    "base-digest": BASE_DIGEST,
    "dev-slug": DEV_SLUG,
    "dev-service-name": DEV_SERVICE,
    "prod-slug": "openbinding",
    "prod-service-name": "openbinding",
}


def provision(fake: FakeRemotes, capsys, *flags: str, environ=None, **overrides: str):
    values = {**DEFAULTS, **{key.replace("_", "-"): value for key, value in overrides.items()}}
    argv = list(flags) + [item for key, value in values.items() for item in (f"--{key}", value)]
    code = remote_provision.main(argv, environ=ENV if environ is None else environ, transport=fake.transport(), now=NOW)
    captured = capsys.readouterr()
    assert fake.methods() <= {"GET", "POST"}, "the tool must never delete or update anything"
    assert SPACE_KEY not in captured.out + captured.err and SPHERE_KEY not in captured.out + captured.err
    report = json.loads(captured.out) if captured.out.strip() else None
    return code, report, captured


def failed_guards(report) -> set[str]:
    return {item["name"] for item in report["guards"] if not item["ok"]}


def lines_changed(before: bytes, after: bytes) -> list[tuple[str, str]]:
    old, new = before.decode().splitlines(), after.decode().splitlines()
    assert len(old) == len(new)
    return [(a, b) for a, b in zip(old, new, strict=True) if a != b]


# -- plan ---------------------------------------------------------------------------


def test_plan_is_the_default_and_writes_nothing(capsys):
    fake = production_world()
    code, report, _ = provision(fake, capsys)
    assert code == 0 and report["mode"] == "plan" and report["outcome"]["reason"] == "ok"
    assert fake.posts() == [] and fake.uploads == [] and not failed_guards(report)
    plan = report["plan"]["yaml"]
    assert (plan["version"], plan["createdAt"], plan["saasName"]) == ("0.1.0", NOW_TEXT, DEV_SERVICE)
    assert plan["createdAtFormat"] == "YYYY-MM-DDTHH:mm:ssZ" and plan["createdAtQuoted"] is True
    assert report["plan"]["sphere"]["fields"]["private"] == "true"
    assert "delete" in report["plan"]["neverDone"] and "publish" in report["plan"]["neverDone"]
    assert report["base"]["digest"] == BASE_DIGEST and report["base"]["cu"]["status"] == "clean"
    assert {item["name"] for item in report["guards"]} >= {
        "dev-names-valid", "dev-slug-is-not-production", "dev-service-is-not-production", "sphere-organization-identified",
        "space-organization-identified", "production-slug-identified", "production-service-identified", "base-version-found",
        "base-digest-matches", "base-has-no-cu", "dev-slug-state-known", "dev-service-state-known", "dev-yaml-built",
    }


def test_explicit_plan_flag_equals_the_default_and_never_posts(capsys):
    fake = production_world()
    code, report, _ = provision(fake, capsys, "--plan")
    assert code == 0 and report["mode"] == "plan" and fake.posts() == []


# -- apply ---------------------------------------------------------------------------


def test_apply_uploads_the_same_private_yaml_to_sphere_and_space_and_leaves_production_alone(capsys):
    fake = production_world()
    before_sphere = {slug: [dict(item) for item in versions] for slug, versions in fake.sphere.items() if slug == "openbinding"}
    code, report, captured = provision(fake, capsys, "--apply")
    assert code == 0, captured.out
    assert [item["service"] for item in fake.uploads] == ["sphere", "space"]
    sphere_upload, space_upload = fake.uploads
    assert sphere_upload["path"] == SPHERE_CREATE
    assert sphere_upload["fields"] == {"private": "true", "saasName": DEV_SERVICE, "name": DEV_SLUG, "version": "0.1.0"}
    assert sphere_upload["file"] == space_upload["file"]

    built = sphere_upload["file"]
    expected = {**yaml.safe_load(BASE_YAML), "version": "0.1.0", "createdAt": NOW_TEXT, "saasName": DEV_SERVICE}
    assert yaml.safe_load(built) == expected
    assert lines_changed(BASE_YAML, built) == [
        ("saasName: openbinding", f"saasName: {DEV_SERVICE}"),
        ("version: 1.0.0", "version: 0.1.0"),
        ("createdAt: '2026-09-01T10:00:00Z'", f"createdAt: '{NOW_TEXT}'"),
    ]
    assert common.yaml_meta(built)["createdAtFormat"] == "YYYY-MM-DDTHH:mm:ssZ"

    sphere_step, space_step = report["steps"]
    assert sphere_step["verification"]["private"] is True and sphere_step["verification"]["versionPresent"] is True
    assert sphere_step["verification"]["digest"] == common.sha256_digest(built)
    assert sphere_step["verification"]["digestMatchesUpload"] is True
    assert space_step["verification"]["servicePresent"] is True and space_step["verification"]["version010Present"] is True
    assert space_step["verification"]["id"] == f"svc-{DEV_SERVICE}"
    assert "no public/private flag" in space_step["verification"]["visibility"]

    assert fake.sphere[DEV_SLUG][0]["private"] is True
    assert [item["version"] for item in fake.sphere["openbinding"]] == ["0.9.0", "1.0.0"]
    assert [dict(item) for item in fake.sphere["openbinding"]] == before_sphere["openbinding"]
    assert sorted(fake.space["openbinding"]["versions"]) == ["0.9.0", "1.0.0"]
    assert report["production"]["unchanged"] is True
    assert {item.path for item in fake.posts()} == {SPHERE_CREATE, "/api/v1/services"}


def test_apply_can_use_the_per_version_sphere_endpoint(capsys):
    fake = production_world()
    code, _, _ = provision(fake, capsys, "--apply", "--sphere-endpoint", "version")
    assert code == 0
    assert fake.uploads[0]["path"] == f"{SPHERE_CREATE}/{DEV_SLUG}/0.1.0"


# -- guards: each has a negative case --------------------------------------------------


@pytest.mark.parametrize(
    "overrides, failing",
    [
        ({"dev_slug": "openbinding"}, "dev-slug-is-not-production"),
        ({"dev_service_name": "openbinding"}, "dev-service-is-not-production"),
        ({"dev_slug": "real-prod", "prod_slug": "real-prod"}, "dev-slug-is-not-production"),
        ({"dev_service_name": "real-svc", "prod_service_name": "real-svc"}, "dev-service-is-not-production"),
        ({"prod_slug": "real-prod", "prod_service_name": "real-svc", "dev_slug": "openbinding"}, "dev-slug-is-not-production"),
        ({"dev_slug": "Openbinding"}, "dev-names-valid"),
        ({"dev_slug": "x"}, "dev-names-valid"),
        ({"dev_service_name": "has space"}, "dev-names-valid"),
        ({"dev_slug": "openbinding", "base_pricing_slug": "openbinding", "prod_slug": "other"}, "dev-slug-is-not-base"),
        ({"base_digest": "not-a-digest"}, "base-digest-format"),
        ({"base_version": "../x"}, "base-version-format"),
    ],
)
def test_argument_guards_refuse_before_any_remote_call(capsys, overrides, failing):
    fake = production_world()
    code, report, _ = provision(fake, capsys, "--apply", **overrides)
    assert code == 2 and failing in failed_guards(report)
    assert fake.requests == []  # not even a read


def test_a_different_dev_name_with_the_prod_names_passes_static_guards(capsys):
    code, report, _ = provision(production_world(), capsys, dev_slug="a-new-one")
    assert code == 0 and not failed_guards(report)


def test_collision_in_sphere_with_an_existing_0_1_0_exits_3_and_prints_identity_and_digest(capsys):
    fake = production_world()
    existing = pricing_yaml(saas=DEV_SERVICE, version="0.1.0", created="2026-10-01T00:00:00Z")
    fake.add_sphere(DEV_SLUG, "0.1.0", existing, private=True)
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 3 and fake.posts() == []
    (collision,) = report["collisions"]
    assert collision["service"] == "sphere" and collision["slug"] == DEV_SLUG and collision["has010"] is True
    assert collision["digest"] == common.sha256_digest(existing) and collision["private"] is True
    assert report["outcome"]["exitCode"] == 3 and "nothing was written" in report["outcome"]["reason"]
    assert [item["version"] for item in fake.sphere[DEV_SLUG]] == ["0.1.0"]  # untouched, not deleted


def test_collision_with_an_existing_dev_slug_without_0_1_0_is_still_a_collision(capsys):
    fake = production_world()
    fake.add_sphere(DEV_SLUG, "0.2.0", pricing_yaml(saas=DEV_SERVICE, version="0.2.0"), private=True)
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 3 and fake.posts() == [] and report["collisions"][0]["has010"] is False


def test_collision_in_space_exits_3_without_touching_anything(capsys):
    fake = production_world()
    fake.add_space(DEV_SERVICE, ["0.1.0"])
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 3 and fake.posts() == []
    (collision,) = report["collisions"]
    assert collision["service"] == "space" and collision["name"] == DEV_SERVICE and collision["has010"] is True
    assert collision["id"] == f"svc-{DEV_SERVICE}"


def test_collision_is_reported_by_the_plan_too(capsys):
    fake = production_world()
    fake.add_space(DEV_SERVICE, ["0.1.0"])
    code, report, _ = provision(fake, capsys)
    assert code == 3 and report["mode"] == "plan" and fake.posts() == []


def test_a_different_digest_aborts(capsys):
    fake = production_world()
    code, report, _ = provision(fake, capsys, "--apply", base_digest=common.sha256_digest(b"something else"))
    assert code == 2 and fake.posts() == [] and failed_guards(report) == {"base-digest-matches"}


def test_a_base_with_capacity_units_aborts_even_when_the_digest_matches(capsys):
    fake = production_world()
    bad = fake.sphere["openbinding"][0]["content"]  # 0.9.0 declares capacityUnits
    code, report, _ = provision(fake, capsys, "--apply", base_version="0.9.0", base_digest=common.sha256_digest(bad))
    assert code == 2 and fake.posts() == []
    assert "base-has-no-cu" in failed_guards(report) and "base-digest-matches" not in failed_guards(report)
    assert report["base"]["cu"]["findings"][0]["name"] == "capacityUnits"


def test_an_unreadable_base_aborts(capsys):
    fake = production_world()
    fake.add_sphere("openbinding", "2.0.0", b"a: [broken")
    code, report, _ = provision(fake, capsys, "--apply", base_version="2.0.0", base_digest=common.sha256_digest(b"a: [broken"))
    assert code == 2 and fake.posts() == [] and "base-has-no-cu" in failed_guards(report)


def test_a_base_version_that_does_not_exist_aborts(capsys):
    fake = production_world()
    code, report, _ = provision(fake, capsys, "--apply", base_version="7.7.7")
    assert code == 2 and fake.posts() == [] and "base-version-found" in failed_guards(report)


def test_production_must_be_identified_remotely_not_inferred(capsys):
    fake = production_world()
    code, report, _ = provision(fake, capsys, "--apply", prod_slug="missing-prod")
    assert code == 2 and fake.posts() == [] and failed_guards(report) == {"production-slug-identified"}
    code, report, _ = provision(production_world(), capsys, "--apply", prod_service_name="missing-service")
    assert code == 2 and failed_guards(report) == {"production-service-identified"}


def test_unknown_state_of_the_dev_target_is_refused(capsys):
    fake = production_world()
    fake.statuses[("sphere.test", "GET", f"{SPHERE_CREATE}/{DEV_SLUG}")] = 500
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 2 and fake.posts() == [] and "dev-slug-state-known" in failed_guards(report)
    fake = production_world()
    fake.statuses[("space.test", "GET", f"/api/v1/services/{DEV_SERVICE}")] = 500
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 2 and fake.posts() == [] and "dev-service-state-known" in failed_guards(report)


def test_services_of_another_organization_are_refused(capsys):
    fake = production_world()
    fake.raw_bodies[("space.test", "GET", "/api/v1/services")] = [{"name": "openbinding", "organizationId": "someone-else"}]
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 2 and fake.posts() == [] and "space-organization-identified" in failed_guards(report)


# -- remote refusals ---------------------------------------------------------------------


def test_createdat_with_time_rejected_by_space_is_reported_literally_and_not_retried(capsys):
    fake = production_world()
    fake.space_upload_response = (422, {"error": f"The createdAt field must be a valid date, not a date-time (key {SPACE_KEY})"})
    code, report, captured = provision(fake, capsys, "--apply")
    assert code == 4
    space_posts = fake.posts("space.test")
    assert len(space_posts) == 1, "a rejected upload must not be retried in another format"
    assert len(fake.posts("sphere.test")) == 1
    step = report["steps"][-1]
    assert step["step"] == "space-upload" and step["rejected"] is True and step["request"]["status"] == 422
    assert "The createdAt field must be a valid date, not a date-time" in step["request"]["body"]
    assert SPACE_KEY not in captured.out and "[REDACTED]" in step["request"]["body"]
    assert common.yaml_meta(fake.uploads[-1]["file"])["createdAtFormat"] == "YYYY-MM-DDTHH:mm:ssZ"  # format never changed
    assert report["outcome"]["exitCode"] == 4


def test_a_sphere_rejection_stops_before_space(capsys):
    fake = production_world()
    fake.sphere_upload_response = (400, {"error": "createdAt rejected"})
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 4 and len(fake.posts("sphere.test")) == 1 and fake.posts("space.test") == []
    assert report["steps"][0]["rejected"] is True and "skipped" in report["steps"][1]
    assert "createdAt rejected" in report["steps"][0]["request"]["body"]


def test_sphere_losing_the_private_flag_stops_the_run_and_flags_public_exposure(capsys):
    fake = production_world()
    fake.sphere_store_private = False
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 4 and fake.posts("space.test") == []
    assert report["steps"][0]["verification"]["warning"] == "PUBLIC EXPOSURE"
    assert "private=true" in report["outcome"]["reason"]
    assert fake.sphere[DEV_SLUG][0]["version"] == "0.1.0"  # nothing is deleted or changed by the tool


def test_unreported_visibility_is_not_assumed_private(capsys):
    fake = production_world()
    fake.sphere_report_private = False
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 4 and fake.posts("space.test") == []
    assert report["steps"][0]["verification"]["warning"] == "visibility not reported"


def test_space_accepting_without_listing_the_version_is_not_success(capsys):
    fake = production_world()
    fake.space_upload_response = (201, {"ok": True})  # accepted, but no service appears
    code, report, _ = provision(fake, capsys, "--apply")
    assert code == 4 and "could not be confirmed" in report["outcome"]["reason"]


# -- command line --------------------------------------------------------------------------


def test_every_identifying_argument_is_required(capsys):
    for missing in DEFAULTS:
        argv = [item for key, value in DEFAULTS.items() if key != missing for item in (f"--{key}", value)]
        with pytest.raises(SystemExit) as caught:
            remote_provision.main(["--apply", *argv], environ=ENV)
        assert caught.value.code == 2
    capsys.readouterr()


def test_plan_and_apply_are_mutually_exclusive(capsys):
    argv = [item for key, value in DEFAULTS.items() for item in (f"--{key}", value)]
    with pytest.raises(SystemExit) as caught:
        remote_provision.main(["--plan", "--apply", *argv], environ=ENV)
    assert caught.value.code == 2
    capsys.readouterr()


def test_bad_environment_exits_2_without_values(capsys):
    fake = production_world()
    code, report, captured = provision(fake, capsys, "--apply", environ={**ENV, "SPHERE_URL": "http://sphere.test", "SPACE_API_KEY": ""})
    assert code == 2 and report is None and fake.requests == []
    assert "SPHERE_URL must use the https scheme" in captured.err and "SPACE_API_KEY is not set" in captured.err
    assert "http://sphere.test" not in captured.err


def test_protected_names_cannot_be_uploaded_even_by_a_direct_call():
    async def attempt():
        env = common.load_env(ENV)
        fake = FakeRemotes()
        sphere, space = common.SphereRemote(env, transport=fake.transport()), common.SpaceRemote(env, transport=fake.transport())
        try:
            with pytest.raises(common.RemoteError):
                await sphere.upload_private(slug="OpenBinding", version="0.1.0", saas_name="x", content=b"x", endpoint="create",
                                            protected_slugs=["openbinding"])
            with pytest.raises(common.RemoteError):
                await space.upload_service(content=pricing_yaml(saas="openbinding"), filename="x.yaml", protected_service_names=["OPENBINDING"])
            with pytest.raises(common.RemoteError):
                await space.upload_service(content=b"a: 1\n", filename="x.yaml", protected_service_names=[])
        finally:
            await sphere.aclose()
            await space.aclose()
        assert fake.requests == []

    import asyncio

    asyncio.run(attempt())


# -- the development YAML ---------------------------------------------------------------------


def build(base: bytes = BASE_YAML, saas: str = DEV_SERVICE):
    return remote_provision.build_dev_yaml(base, saas_name=saas, created_at=NOW_TEXT)


def test_build_changes_only_version_created_at_and_saas_name():
    built, changes = build()
    assert lines_changed(BASE_YAML, built) == [
        ("saasName: openbinding", f"saasName: {DEV_SERVICE}"),
        ("version: 1.0.0", "version: 0.1.0"),
        ("createdAt: '2026-09-01T10:00:00Z'", f"createdAt: '{NOW_TEXT}'"),
    ]
    assert changes["createdAt"] == {"from": "2026-09-01T10:00:00Z", "to": NOW_TEXT, "inserted": False, "quoted": True}
    assert changes["version"] == {"from": "1.0.0", "to": "0.1.0"}


def test_build_keeps_the_quote_style_of_the_base_and_always_quotes_created_at():
    double = BASE_YAML.replace(b"createdAt: '2026-09-01T10:00:00Z'", b'createdAt: "2026-09-01T10:00:00Z"')
    double = double.replace(b"version: 1.0.0", b'version: "1.0.0"').replace(b"saasName: openbinding", b"saasName: 'openbinding'")
    text = build(double)[0].decode()
    assert f'createdAt: "{NOW_TEXT}"' in text and 'version: "0.1.0"' in text and f"saasName: '{DEV_SERVICE}'" in text
    unquoted = BASE_YAML.replace(b"createdAt: '2026-09-01T10:00:00Z'", b"createdAt: 2026-09-01T10:00:00Z")
    assert f"createdAt: '{NOW_TEXT}'" in build(unquoted)[0].decode()
    date_only = BASE_YAML.replace(b"createdAt: '2026-09-01T10:00:00Z'", b"createdAt: 2026-09-01")
    assert f"createdAt: '{NOW_TEXT}'" in build(date_only)[0].decode()


def test_build_inserts_a_missing_created_at_after_the_version_line():
    base = pricing_yaml(created=None)
    built, changes = build(base)
    text = built.decode()
    assert changes["createdAt"]["inserted"] is True
    assert f"version: 0.1.0\ncreatedAt: '{NOW_TEXT}'\ncurrency: EUR" in text
    assert yaml.safe_load(built)["createdAt"] == NOW_TEXT


def test_build_preserves_crlf_line_endings():
    built, _ = build(pricing_yaml(crlf=True))
    assert built.count(b"\n") == built.count(b"\r\n") and b"\r\n" in built
    inserted, _ = build(pricing_yaml(created=None, crlf=True))
    assert inserted.count(b"\n") == inserted.count(b"\r\n")


def test_build_leaves_the_saas_name_alone_when_it_already_matches():
    built, changes = build(BASE_YAML, saas="openbinding")
    assert changes["saasName"]["from"] == changes["saasName"]["to"] == "openbinding"
    assert [a for a, _ in lines_changed(BASE_YAML, built)] == ["version: 1.0.0", "createdAt: '2026-09-01T10:00:00Z'"]


@pytest.mark.parametrize(
    "base",
    [
        b"a: [broken",
        b"- not\n- a mapping\n",
        b"\xff\xfe",
        b"saasName: x\ncreatedAt: '2026-01-01T00:00:00Z'\n",  # no version
        b"version: 1.0.0\n",  # no saasName
        b"saasName: x\nversion: 1.0.0\nversion: 2.0.0\n",
    ],
)
def test_build_refuses_documents_it_cannot_edit_exactly(base):
    with pytest.raises(remote_provision.YamlBuildError):
        build(base)


def test_created_at_round_trip_check():
    assert remote_provision.created_at_round_trips(f"createdAt: '{NOW_TEXT}'", NOW_TEXT, "'")
    assert remote_provision.created_at_round_trips(f'createdAt: "{NOW_TEXT}"', NOW_TEXT, '"')
    assert not remote_provision.created_at_round_trips(f"createdAt: {NOW_TEXT}", NOW_TEXT, "'")  # unquoted parses as a datetime
    assert not remote_provision.created_at_round_trips(f"createdAt: '{NOW_TEXT}'", NOW_TEXT, '"')
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", NOW_TEXT)
