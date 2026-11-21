"""The upstream classifier (F6): goldens G1-G20, precedence, origins, the direct delta, determinism and purity."""

from __future__ import annotations

import ast
import json
from dataclasses import replace
from pathlib import Path

import pytest

from _paths import gateway_tool
from openbinding_gateway.modules.compositions.application import upstream_classify as uc
from openbinding_gateway.modules.compositions.domain.upstream import Category, State, at_least_as_new, may_move

tool = gateway_tool("dump_upstream_goldens")
DOCUMENT = json.loads(tool.CASES.read_text())
CASES = {case["name"]: case for case in DOCUMENT["cases"]}
RECIPES = tool.Recipes()


def _run(name: str, **change) -> dict:
    return tool.run(dict(CASES[name], **change), RECIPES)


@pytest.mark.parametrize("name", sorted(CASES))
def test_every_golden_matches(name: str) -> None:
    expected = (tool.DEFAULT_OUT / f"{name}.json").read_bytes()
    found = _run(name)
    assert tool.text(found) == expected
    assert found.get("category") == CASES[name]["expect"]


def test_the_price_raise_has_its_direct_delta() -> None:
    diff = _run("G03-price-raise")["diff"]
    assert diff["global"] == [{"feature": "subscription", "unit": "USD/month", "before": "508.990000",
                               "after": "558.990000", "delta": "50.000000", "rule": "sum/selectedCandidate"}]
    price = diff["entries"][0]["comparison"]["price"]
    assert (price["before"]["subtotal"], price["after"]["subtotal"]) == ("499.000000", "549.000000")
    assert diff["notes"] == ["domain_may_change", "values_not_reevaluated"]


def test_a_period_change_at_the_same_amount_is_a_value_change() -> None:
    yearly = {"ref": CASES["G03-price-raise"]["old"]["ref"], "edits": [["set", "plans.PROFESSIONAL.unit", "account/year"]],
              "versionId": "6fff0000000000000000a003", "label": "2026-10 (yearly)"}
    found = _run("G03-price-raise", new=yearly)
    price = found["diff"]["entries"][0]["comparison"]["price"]
    assert (price["before"]["unit"], price["after"]["unit"]) == ("USD/month", "USD/year")
    assert price["before"]["subtotal"] == price["after"]["subtotal"]
    assert found["category"] == "values_changed" and found["notify"] is True


def test_a_selection_already_private_is_not_invalidated_again() -> None:
    """A hand-written ``from`` on a plan that was already private: a later version changing nothing it reads is no
    new invalidity (the reasons compare with the pinned side)."""
    case = CASES["G11a-plan-private"]
    entries = [{key: value for key, value in entry.items() if key not in ("origins", "recipe")}
               for entry in case["entries"]]
    later = dict(case["new"], versionId="6fff0000000000000000a004", label="2026-12")
    found = _run("G11a-plan-private", old=case["new"], new=later, entries=entries)
    assert found["category"] == "no_impact" and found["reasons"] == []
    assert _run("G11a-plan-private", entries=entries)["category"] == "binding_invalid"  # it became private
    # With value origins too: the recipe refusing both sides the same way is no new reason.
    assert _run("G11a-plan-private", old=case["new"], new=later)["category"] == "no_impact"


def test_a_guarantee_changes_without_a_delta() -> None:
    found = _run("G04-guarantee")
    (attribute,) = [a for a in found["diff"]["entries"][0]["attributes"] if a["target"] == "availability"]
    assert (attribute["before"], attribute["after"], attribute["delta"]) == ("0.990000", "0.999500", None)
    assert "no_direct_mapping" in found["diff"]["notes"] and found["diff"]["global"] == []


def test_a_renamed_twin_is_named() -> None:
    (reason,) = _run("G08-plan-renamed")["reasons"]
    assert reason == {"code": "plan_removed", "plan": "PROFESSIONAL", "renamedTo": "PROFESSIONAL_PLUS"}


def test_required_limits_and_features() -> None:
    (limit,) = _run("G10-required-limit-below-demand")["reasons"]
    assert (limit["code"], limit["kind"], limit["demand"], limit["after"]) == (
        "requirement_unmet", "limit", "1000.000000", "500.000000",
    )
    (feature,) = _run("G09-required-feature-lost")["reasons"]
    assert (feature["code"], feature["kind"], feature["name"]) == ("requirement_unmet", "feature", "ssoSaml")


def test_unreadable_beats_a_removed_plan() -> None:
    found = _run("G13-pricing-unreadable", entries=[dict(CASES["G13-pricing-unreadable"]["entries"][0],
                                                          selection={"plan": "NO_SUCH_PLAN", "addOns": []})])
    assert [r["code"] for r in found["reasons"]] == ["pricing_unreadable"]


def test_the_origin_mismatch_is_listed() -> None:
    entry = _run("G20-origin-mismatch")["diff"]["entries"][0]
    assert entry["originMismatch"] == [{"target": "subscription", "stored": "450.000000", "recomputed": "499.000000"}]


def test_without_origins_there_is_no_attribute_and_no_delta() -> None:
    diff = _run("G05b-limit-openbinding")["diff"]
    assert diff["entries"][0]["attributes"] == [] and diff["global"] == []
    assert "no_value_origins" in diff["notes"]


def test_declared_values_give_no_global_delta() -> None:
    case = CASES["G03-price-raise"]
    found = _run("G03-price-raise", context=dict(case["context"], valuesStatus="declared"))
    assert found["category"] == "values_changed" and found["diff"]["global"] == []
    assert all(a["delta"] is None for a in found["diff"]["entries"][0]["attributes"])


def test_two_tasks_on_one_family_sum_their_deltas() -> None:
    (row,) = _run("G18-two-tasks-one-family")["diff"]["global"]
    assert row["delta"] == "100.000000"


def test_the_offering_margins_move_only_where_the_offering_did() -> None:
    environment = _run("G16b-offering-margins-move")["diff"]["margins"]["environments"][0]
    moved = {(b["plan"], tuple(b["addOns"])) for b, a in zip(environment["before"]["rows"], environment["after"]["rows"], strict=True)
             if b["margin"] != a["margin"]}
    assert moved == {("basic", ()), ("basic", ("extraTimers",))}
    zero = _run("G16a-offering-zero-delta")["diff"]["margins"]["environments"][0]
    assert all(b["margin"] == a["margin"] for b, a in zip(zero["before"]["rows"], zero["after"]["rows"], strict=True))


def test_the_same_inputs_give_the_same_bytes() -> None:
    first = uc.canonical(_run("G03-price-raise")["diff"])
    assert all(uc.canonical(_run("G03-price-raise")["diff"]) == first for _ in range(3))


def test_the_diff_is_bounded() -> None:
    big = {"schema": uc.DIFF_SCHEMA, "entries": [{"x": "y" * 1000} for _ in range(200)], "plans": []}
    bounded = uc._bounded(big)
    assert bounded["truncated"] is True and len(uc.canonical(bounded)) <= uc.MAX_DIFF_BYTES


def test_the_state_machine_and_the_version_order() -> None:
    assert may_move(State.OPEN, State.REVIEWED) and may_move("reviewed", "resolved")
    assert not may_move("resolved", "open") and not may_move("reviewed", "open")
    order = ["n", "m", "p"]
    assert at_least_as_new("m", "p", order) and at_least_as_new("p", "p", order)
    assert not at_least_as_new("p", "m", order)
    assert at_least_as_new("n", "gone-version", order) and not at_least_as_new("m", "gone-version", order)
    assert Category("values_changed") is Category.VALUES_CHANGED


def test_the_classifier_reads_no_database_network_or_clock(monkeypatch) -> None:
    source = Path(uc.__file__).read_text()
    imported = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    assert not imported & {"sqlalchemy", "httpx", "fastapi", "datetime", "time", "asyncio"}

    import datetime as real_datetime
    import time

    def refuse(*args, **kwargs):
        raise AssertionError("the classifier read the clock")

    monkeypatch.setattr(time, "time", refuse)
    monkeypatch.setattr(time, "monotonic", refuse)

    class Frozen(real_datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            refuse()

        @classmethod
        def utcnow(cls):
            refuse()

    monkeypatch.setattr(real_datetime, "datetime", Frozen)
    assert _run("G03-price-raise")["category"] == "values_changed"
    assert _run("G16b-offering-margins-move")["category"] == "offering_changed"


def test_a_side_without_a_baseline_never_says_no_impact() -> None:
    old = tool.side(CASES["G03-price-raise"]["old"])
    new = tool.side(CASES["G03-price-raise"]["new"])
    entry = uc.EntryInput("dailySummary", "email.brevo.professional", uc.Selection.of("PROFESSIONAL"))
    found = uc.classify_binding(replace(old, pricing=None), new, uc.Facts({}), [entry], uc.BindingContext("verified"))
    assert found.category == Category.VALUES_CHANGED and "baseline_unavailable" in found.diff["notes"]
