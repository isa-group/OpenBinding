"""Revision 3 of ``tomatometer-email``: the combined recipe (``examples/tomatometer/tomatometer-recipe.json``)
applied after the e-mail recipe adds Dropbox for ``export`` and the built-in quotes for ``quotes``, keeps the
e-mail candidates of revision 2 exactly, and compiles with the pinned toolchain."""

from __future__ import annotations

import asyncio
import json

from bim_core.compiler import compile_instance
from bim_core.package import load_package

from _paths import gateway_tool
from _repo import REPO_ROOT
from openbinding_gateway.composition.problem import ProblemFacts

tool = gateway_tool("dump_sphere_goldens")
RUNNER = tool.Runner()
RECIPE = REPO_ROOT / "examples" / "tomatometer" / "tomatometer-recipe.json"
EMAIL_RECIPE = REPO_ROOT / "examples" / "tomatometer" / "email-recipe.json"
DROPBOX_PLANS = ["advanced", "family", "plus", "professional", "standard"]


def _catalog(files: dict[str, bytes], name: str) -> dict:
    return json.loads(files[f"{name}.json"])["spec"]["candidates"]


def _email_origins(origins: list[dict]) -> list[dict]:
    return [origin for origin in origins if origin["candidateKey"].startswith("sphere-email/")]


def test_the_e_mail_task_is_the_e_mail_recipe_verbatim():
    combined = json.loads(RECIPE.read_text(encoding="utf-8"))
    email = json.loads(EMAIL_RECIPE.read_text(encoding="utf-8"))
    assert combined["tasks"][0] == email["tasks"][0]
    assert {key: combined[key] for key in ("currency", "billing", "demand", "features")} == {
        key: email[key] for key in ("currency", "billing", "demand", "features")
    }
    # No storage requirement: storage.local.disk needs no storageLimit and no existing golden moves.
    assert all("require" not in task for task in combined["tasks"][1:])


def test_revision_3_keeps_revision_2s_e_mail_candidates():
    two = RUNNER.generated("tomatometer-email")
    three = RUNNER.generated("tomatometer-r3")
    assert not [d for d in three.diagnostics if d.severity == "error"]
    assert _catalog(three.files, "sphere-email") == _catalog(two.files, "sphere-email")
    assert _email_origins(three.origins) == _email_origins(two.origins)
    assert json.loads(three.files["candidates.json"]) == json.loads(two.files["candidates.json"])
    two_tasks = json.loads(two.files["application.json"])["spec"]["tasks"]
    three_tasks = json.loads(three.files["application.json"])["spec"]["tasks"]
    assert three_tasks == two_tasks


def test_export_offers_local_disk_and_the_five_dropbox_plans_with_a_manual_latency():
    three = RUNNER.generated("tomatometer-r3")
    storage = _catalog(three.files, "sphere-storage")
    assert sorted(storage) == [f"storage.dropbox.{plan}" for plan in DROPBOX_PLANS]
    assert storage["storage.dropbox.plus"]["features"] == {"availability": 0.999, "latency": 180, "subscription": 9.99}
    assert all(entry["provides"] == "service/storage" for entry in storage.values())
    assert "storage.local.disk" in _catalog(three.files, "candidates")
    latency = {o["candidateKey"]: o["sourceKind"] for o in three.origins
               if o["candidateKey"].startswith("sphere-storage/") and o["target"] == "latency"}
    assert set(latency.values()) == {"manual"} and len(latency) == len(DROPBOX_PLANS)
    export = sorted(c["id"] for c in three.candidates if c["task"] == "export")
    assert export == [f"storage.dropbox.{plan}" for plan in DROPBOX_PLANS]
    assert all(c["eligible"] for c in three.candidates if c["task"] == "export")


def test_quotes_offers_two_candidates():
    three = RUNNER.generated("tomatometer-r3")
    quotes = _catalog(three.files, "sphere-quotes")
    assert quotes == {
        "quotes.builtin.static": {
            "features": {"availability": 0.999, "latency": 2, "subscription": 0},
            "name": "Built-in quotes",
            "provider": {"id": "builtin", "resource": "sphere-quotes"},
            "provides": "service/quotes",
        }
    }
    assert "quotes.zenquotes.free" in _catalog(three.files, "candidates")
    hand = [c for c in three.candidates if c["task"] == "quotes"]
    assert [(c["id"], c["handMade"], c["sphere"]) for c in hand] == [("quotes.builtin.static", True, None)]


def test_revision_3_compiles_and_every_task_has_its_choices():
    three = RUNNER.generated("tomatometer-r3")
    compiled = compile_instance(load_package(three.archive()))
    facts = ProblemFacts.from_ir(compiled.document, compiled.source_map)
    eligible = {task: sorted(str(ref).rsplit("/", 1)[-1] for ref in refs) for task, refs in facts.eligibility.items()}
    assert eligible["export"] == sorted(["storage.local.disk", *(f"storage.dropbox.{p}" for p in DROPBOX_PLANS)])
    assert eligible["quotes"] == ["quotes.builtin.static", "quotes.zenquotes.free"]
    assert eligible["login"] == ["auth.builtin.local"]
    assert "email.brevo.professional" in eligible["dailySummary"]
    assert "email.resend.pro" in eligible["dailySummary"]
    digest, _ = asyncio.run(tool.compiled(three))
    assert (tool.DEFAULT_OUT / "tomatometer-r3.package.digest").read_text() == digest + "\n"
