"""Environment validation, CU scan, createdAt handling, ordering and tolerant normalizers."""

from __future__ import annotations

import pytest

import _remote_common as common
from fakes import ENV, SPACE_KEY, SPHERE_KEY, pricing_yaml


# -- environment ------------------------------------------------------------


def test_load_env_accepts_a_valid_environment_and_normalizes_origins():
    env = common.load_env({**ENV, "SPACE_URL": "https://SPACE.test/", "SPHERE_URL": "https://sphere.test"})
    assert env.space_url == "https://space.test"
    assert env.sphere_url == "https://sphere.test"
    assert env.secrets() == (SPACE_KEY, SPHERE_KEY)


def test_repr_and_description_never_contain_the_keys():
    env = common.load_env(ENV)
    for text in (repr(env), str(env.describe())):
        assert SPACE_KEY not in text and SPHERE_KEY not in text
    assert env.describe()["spaceKeyConfigured"] is True


@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"SPACE_URL": "http://space.test"}, "SPACE_URL must use the https scheme"),
        ({"SPACE_URL": "https://user:pw@space.test"}, "SPACE_URL must not embed credentials"),
        ({"SPACE_URL": "https://space.test/api/v1"}, "SPACE_URL must be an origin without a path"),
        ({"SPHERE_URL": "https://sphere.test?x=1"}, "SPHERE_URL must not carry a query"),
        ({"SPHERE_URL": "https://sphere.test#frag"}, "SPHERE_URL must not carry a query"),
        ({"SPHERE_URL": "ftp://sphere.test"}, "SPHERE_URL must use the https scheme"),
        ({"SPHERE_URL": "not a url"}, "SPHERE_URL contains whitespace"),
        ({"SPACE_API_KEY": ""}, "SPACE_API_KEY is not set"),
        ({"SPACE_API_KEY": "has space"}, "SPACE_API_KEY contains whitespace"),
        ({"SPHERE_API_KEY": "clave-con-ñ"}, "SPHERE_API_KEY contains whitespace or characters"),
        ({"SPACE_ORGANIZATION_ID": "../x"}, "SPACE_ORGANIZATION_ID is not a valid organization identifier"),
        ({"SPHERE_ORGANIZATION_ID": ""}, "SPHERE_ORGANIZATION_ID is not set"),
    ],
)
def test_load_env_rejects_bad_values_without_echoing_them(overrides, fragment):
    with pytest.raises(common.ConfigError) as caught:
        common.load_env({**ENV, **overrides})
    message = str(caught.value)
    assert fragment in message
    for value in overrides.values():
        if len(value) > 3:
            assert value not in message


def test_load_env_reports_every_problem_at_once_and_can_skip_a_service():
    with pytest.raises(common.ConfigError) as caught:
        common.load_env({})
    assert str(caught.value).count("is not set") == 6
    assert common.load_env({k: v for k, v in ENV.items() if k.startswith("SPACE")}, sphere=False).sphere_url == ""


# -- redaction ---------------------------------------------------------------


def test_redactor_removes_exact_encoded_and_inline_secrets():
    secret = "s3cr3t/value+with chars"
    redactor = common.Redactor([secret])
    text = f"a {secret} b %s c %s" % (common.quote(secret, safe=""), common.quote_plus(secret))
    assert secret not in redactor.text(text) and "s3cr3t" not in redactor.text(text)
    assert "abc123" not in redactor.text("x-api-key: abc123 and Authorization: Bearer abc123")
    assert redactor.obj({"X-Api-Key": "abc", "nested": [{"token": "t", "ok": f"v {secret}"}]}) == {
        "X-Api-Key": "[REDACTED]",
        "nested": [{"token": "[REDACTED]", "ok": "v [REDACTED]"}],
    }
    assert redactor.headers({"X-API-KEY": secret, "Accept": "x"}) == {"X-API-KEY": "[REDACTED]", "Accept": "x"}


def test_redactor_error_and_excerpt_are_bounded():
    redactor = common.Redactor(["topsecret"])
    assert "topsecret" not in redactor.error(RuntimeError("failed with topsecret"))
    assert len(redactor.excerpt("x" * 5000)) < 2100


def test_shape_of_describes_without_values():
    shape = common.shape_of({"secretish": "VALUE-NOT-SHOWN", "items": [{"a": 1}]})
    assert "VALUE-NOT-SHOWN" not in str(shape)
    assert shape["keys"] == ["items", "secretish"]


# -- createdAt, digests, versions ---------------------------------------------


@pytest.mark.parametrize(
    "value, kind, fmt",
    [
        ("2026-10-12T09:30:15Z", "datetime", "YYYY-MM-DDTHH:mm:ssZ"),
        ("2026-10-12", "date", "YYYY-MM-DD"),
        ("2026-10-12T09:30:15.123Z", "datetime", "other-datetime"),
        ("2026-10-12T09:30:15+02:00", "datetime", "other-datetime"),
        ("12/10/2026", "other", "other"),
        (None, "missing", "missing"),
    ],
)
def test_created_at_format_is_classified(value, kind, fmt):
    assert common.classify_created_at(value) == {"kind": kind, "format": fmt}


def test_parse_created_at_orders_dates_and_datetimes_in_utc():
    parse = common.parse_created_at
    assert parse("2026-10-12").isoformat() == "2026-10-12T00:00:00+00:00"
    assert parse("2026-10-12T02:00:00+02:00") == parse("2026-10-12T00:00:00Z")
    assert parse("garbage") is None and parse(None) is None


def test_version_order_is_numeric_not_lexicographic():
    ordered = sorted(["1.10.0", "1.2.0", "0.9.0", "1.2.0-rc1"], key=common.version_key)
    assert ordered == ["0.9.0", "1.2.0", "1.2.0-rc1", "1.10.0"]


def test_digest_is_of_the_exact_bytes_and_normalizes():
    digest = common.sha256_digest(b"abc")
    assert digest == "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert common.normalize_digest(digest) == common.normalize_digest(digest.replace("sha256-", "sha256:").upper())
    assert common.normalize_digest(digest[:-1]) is None and common.normalize_digest(None) is None
    assert common.sha256_digest(b"abc\n") != digest


def test_digest_spec_accepts_full_digests_and_12_to_64_hex_prefixes_only():
    full = common.sha256_digest(b"abc")
    hexed = full.removeprefix("sha256-")
    assert common.parse_digest_spec(full) == hexed and common.parse_digest_spec(hexed) == hexed
    assert common.parse_digest_spec(full[:19]) == hexed[:12] and common.parse_digest_spec(hexed[:12].upper()) == hexed[:12]
    assert common.parse_digest_spec(full.replace("sha256-", "sha256:")[:30]) == hexed[:23]
    for bad in (full[:18], hexed[:11], "sha256-", "", hexed + "0", "g" * 20, None):
        assert common.parse_digest_spec(bad) is None
    assert common.normalize_digest(full[:19]) is None  # a prefix is never a full digest


@pytest.mark.parametrize(
    "created, quote, expected",
    [
        ("2026-09-01T10:00:00Z", "'", ("datetime", True)),
        ("2026-09-01T10:00:00Z", '"', ("datetime", True)),
        ("2026-09-01", "", ("date", False)),
    ],
)
def test_yaml_meta_reads_version_created_at_and_saas_name(created, quote, expected):
    meta = common.yaml_meta(pricing_yaml(created=created, quote=quote, saas="abc", version="2.0.1"))
    assert (meta["createdAtKind"], meta["createdAtQuoted"]) == expected
    assert (meta["version"], meta["saasName"], meta["createdAt"], meta["parsed"]) == ("2.0.1", "abc", created, True)


def test_yaml_meta_handles_missing_and_broken_documents_without_raising():
    assert common.yaml_meta(pricing_yaml(created=None))["createdAtKind"] == "missing"
    broken = common.yaml_meta(b"a: [unclosed\nb: 1\n")
    assert broken["parsed"] is False and broken["parseError"].startswith(("ParserError", "ScannerError"))
    assert common.yaml_meta(b"\xff\xfe\x00")["parseError"] == "UnicodeDecodeError"
    assert common.yaml_meta(b"- a\n- b\n")["parseError"] == "not-a-mapping"
    assert common.yaml_meta(b"version: 1.0.0\nversion: 2.0.0\n")["parseError"] == "duplicate-version"


# -- capacity-unit scan ----------------------------------------------------------


def test_scan_is_clean_for_functional_limits():
    result = common.scan_cu(pricing_yaml())
    assert (result["status"], result["hasCu"], result["findings"]) == ("clean", False, [])
    assert result["limitNames"] == ["maxIterations"] and result["planLimitNames"] == ["maxIterations"]


def test_scan_flags_a_capacity_counter_as_class_a_everywhere_it_appears():
    result = common.scan_cu(pricing_yaml(cu=True))
    assert result["status"] == "cu" and result["hasCu"] is True and result["hasUsageCounters"] is False
    assert {item["name"] for item in result["findings"]} == {"capacityUnits"}
    assert {item["class"] for item in result["findings"]} == {"A"}
    assert (result["cuCount"], result["counterCount"]) == (len(result["findings"]), 0)
    assert "capacityUnits" in result["limitNames"]


def test_usage_counters_alone_are_class_b_and_not_cu():
    result = common.scan_cu(pricing_yaml(counters=True))
    assert (result["status"], result["hasCu"], result["hasUsageCounters"]) == ("counters", False, True)
    assert {item["class"] for item in result["findings"]} == {"B"}
    assert common.finding_names(result, "B") == ["concurrentJobs", "solverSeconds", "taskStarts"]
    assert common.finding_names(result, "A") == []
    assert result["cuCount"] == 0 and result["counterCount"] == len(result["findings"]) > 0


def test_both_classes_in_one_document_are_reported_separately_and_status_is_cu():
    result = common.scan_cu(pricing_yaml(cu=True, counters=True))
    assert (result["status"], result["hasCu"], result["hasUsageCounters"]) == ("cu", True, True)
    assert common.finding_names(result, "A") == ["capacityUnits"]
    assert "taskStarts" in common.finding_names(result, "B")


@pytest.mark.parametrize("counter", list(common.CU_COUNTERS))
def test_capacity_units_key_is_class_a_even_when_spelled_differently(counter):
    for spelled in (counter, counter.lower(), "capacity_units", "Capacity-Units", counter[0].upper() + counter[1:]):
        result = common.scan_cu({"usageLimits": {spelled: {"unit": "x"}}})
        assert (result["hasCu"], result["hasUsageCounters"]) == (True, False), spelled
        assert (result["findings"][0]["kind"], result["findings"][0]["class"]) == ("counter-key", "A")


@pytest.mark.parametrize("counter", list(common.USAGE_COUNTERS))
def test_every_usage_counter_is_class_b_even_when_spelled_differently(counter):
    for spelled in (counter, counter.lower(), counter[0].upper() + counter[1:]):
        result = common.scan_cu({"usageLimits": {spelled: {"unit": "x"}}})
        assert (result["hasCu"], result["hasUsageCounters"]) == (False, True), spelled
        assert (result["findings"][0]["kind"], result["findings"][0]["class"]) == ("counter-key", "B")


@pytest.mark.parametrize(
    "name, unit, kind, finding_class",
    [
        ("monthlyCredits", "credit", "credit-like", "A"),
        ("budget", "Credits", "credit-like", "A"),
        ("compute", "CU", "capacity-unit-like", "A"),
        ("pool", "capacity units", "capacity-unit-like", "A"),
        ("quota", "solver seconds", "solver-time-like", "B"),
        ("solverTime", "minute", "solver-time-like", "B"),
    ],
)
def test_limits_whose_name_or_unit_suggest_credits_cu_or_solver_time_are_classified(name, unit, kind, finding_class):
    result = common.scan_cu({"usageLimits": {name: {"unit": unit}}})
    assert [(item["kind"], item["class"]) for item in result["findings"]] == [(kind, finding_class)]


def test_a_counter_limit_measured_in_cu_is_also_class_a():
    result = common.scan_cu({"usageLimits": {"taskStarts": {"unit": "CU"}}})
    assert result["hasCu"] is True and result["hasUsageCounters"] is True


def test_scan_flags_plan_limits_addon_extensions_and_expression_references():
    document = {
        "features": {
            "solve": {"expression": "subscriptionContext['studyRuns'] < pricingContext['usageLimits']['maxIterations']"},
            "bill": {"expression": "subscriptionContext['capacityUnits'] > 0"},
            "pay": {"expression": "pricingContext['usageLimits']['extraCredits'] > 0"},
        },
        "usageLimits": {"maxIterations": {"unit": "iteration"}},
        "plans": {"PRO": {"usageLimits": {"taskStarts": {"value": 5}}}},
        "addOns": {"X": {"usageLimitsExtensions": {"extraCredits": {"value": 1}}}},
    }
    kinds = {(item["kind"], item["class"], item["path"]) for item in common.scan_cu(document)["findings"]}
    assert ("expression-reference", "B", "features.solve.expression") in kinds
    assert ("expression-reference", "A", "features.bill.expression") in kinds
    assert ("expression-reference", "A", "features.pay.expression") in kinds
    assert ("counter-key", "B", "plans.PRO.usageLimits.taskStarts") in kinds
    assert ("credit-like", "A", "addOns.X.usageLimitsExtensions.extraCredits") in kinds


def test_functional_look_alikes_are_not_flagged():
    document = {"usageLimits": {"maxTimeoutSeconds": {"unit": "second"}, "cutoff": {"unit": "item"}, "apiKeys": {"unit": "key"},
                                "federatedEngines": {"unit": "engine"}}}
    assert common.scan_cu(document)["status"] == "clean"


def test_unreadable_documents_are_unparsed_never_clean():
    for content in (b"a: [broken", b"- list\n", b"\xff\xfe"):
        result = common.scan_cu(content)
        assert (result["status"], result["hasCu"], result["hasUsageCounters"], result["parsed"]) == ("unparsed", None, None, False)
        assert result == common.unparsed_scan()


def test_scan_is_deterministic():
    assert common.scan_cu(pricing_yaml(cu=True)) == common.scan_cu(pricing_yaml(cu=True))


# -- tolerant normalizers ------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [None, "text", 7, {}, {"versions": "nope"}, {"versions": [1, "a", None]}, [{"nover": 1}], {"unrelated": [1, 2]}],
)
def test_sphere_version_normalizer_never_raises_on_odd_shapes(body):
    versions, notes = common.normalize_sphere_versions(body)
    assert versions == [] and notes


def test_sphere_version_normalizer_reads_the_known_and_variant_shapes():
    body = {"slug": "s", "versions": [
        {"version": "1.0.0", "private": "true", "yaml": "/static/pricings/s/1.0.0.yml", "createdAt": "2026-01-01"},
        {"version": "1.1.0", "isPrivate": False, "url": "/a/b/c.yml"},
        {"version": "1.2.0"},
    ]}
    versions, _ = common.normalize_sphere_versions(body)
    assert [(item["version"], item["private"]) for item in versions] == [("1.0.0", True), ("1.1.0", False), ("1.2.0", None)]
    assert versions[1]["yamlUrl"] == "/a/b/c.yml" and versions[0]["apiCreatedAt"] == "2026-01-01"
    assert common.normalize_sphere_versions({"version": "9.9.9", "private": True})[0][0]["version"] == "9.9.9"


@pytest.mark.parametrize("body", [None, "x", 3, {}, {"services": "no"}, {"services": [1, {"name": 3}, {}]}])
def test_space_services_normalizer_never_raises_on_odd_shapes(body):
    services, notes = common.normalize_space_services(body)
    assert services == []
    assert notes or body == {} or body is None or body == {"services": "no"}


def test_space_services_normalizer_reads_maps_lists_and_single_objects():
    services, _ = common.normalize_space_services({"services": [
        {"name": "a", "id": "1", "disabled": False, "activePricings": {"1.0.0": {"id": "p"}}, "archivedPricings": {"0.9.0": {}}},
        {"name": "b", "pricings": [{"version": "2.0.0", "status": "active"}, 5, {"version": 3}]},
    ]})
    assert [(item["name"], [(v["version"], v["status"]) for v in item["versions"]]) for item in services] == [
        ("a", [("0.9.0", "archived"), ("1.0.0", "active")]),
        ("b", [("2.0.0", "active")]),
    ]
    single, _ = common.normalize_space_services({"name": "solo", "activePricings": ["1.0.0"]})
    assert single[0]["versions"][0]["version"] == "1.0.0"
