"""``derived`` writes a candidate's ``from`` from the provenance it is given (plain mappings), with the version id
and the raw plan name, and the same inputs give the same bytes."""

from __future__ import annotations

from functools import cache

from _paths import gateway_tool
from openbinding_gateway.composition import text
from openbinding_gateway.composition.derive import derived
from openbinding_gateway.composition.document import Evidence, ProblemRef, Provenance
from openbinding_gateway.composition.problem import ProblemFacts, provenance_findings
from openbinding_gateway.integrations import bim

tool = gateway_tool("dump_sphere_goldens")
BINDING = {
    "login": {"resource": "catalog", "id": "auth.builtin.local"},
    "dailySummary": {"resource": "sphere-email", "id": "email.mailgun.foundation"},
    "export": {"resource": "catalog", "id": "storage.local.disk"},
    "quotes": {"resource": "catalog", "id": "quotes.zenquotes.free"},
}
PROVENANCE = {
    "sphere-email/email.mailgun.foundation": {
        "sphere": "danruilop1/mailgun", "version": "6ade36454b2b5b01c587db3d", "plan": "FOUNDATION",
    },
    "sphere-email/email.sendgrid.pro": {
        "sphere": "danruilop1/sendgrid", "version": "6adf1a62daa2ba78b21d7119", "plan": "PRO", "addons": ["x"],
    },
}


@cache
def _compiled():
    return bim.build_bim().compile(tool.Runner().generated("tomatometer-email").archive())


def _document(provenance):
    compiled = _compiled()
    facts = ProblemFacts.from_ir(compiled["ir"], compiled.get("sourceMap"))
    return derived(
        slug="summary", label="1.0.0", kind="application", problem_ref=ProblemRef("acme", "tomatometer-email", "2"),
        compilation_digest=compiled["compilationDigest"], facts=facts, bim_binding=BINDING,
        features={"subscription": 35.0, "availability": 0.98, "latency": 375.0}, evidence=Evidence(manual=True),
        provenance=provenance,
    )


def test_provenance_in_from_out():
    document = _document(PROVENANCE)
    entries = dict(document.binding)
    assert entries["dailySummary"].source == Provenance(
        sphere="danruilop1/mailgun", version="6ade36454b2b5b01c587db3d", plan="FOUNDATION",
    )
    assert entries["login"].source is None
    content = text.serialise(document)
    assert (
        "  dailySummary:\n    candidate: email.mailgun.foundation\n    from:\n      sphere: danruilop1/mailgun\n"
        "      version: 6ade36454b2b5b01c587db3d\n      plan: FOUNDATION\n"
    ) in content
    assert text.serialise(_document(PROVENANCE)) == content
    assert "from:" not in text.serialise(_document(None))


def test_the_findings_compare_every_field():
    document = _document(PROVENANCE)
    assert provenance_findings(document.binding, BINDING, PROVENANCE) == ()
    without = _document(None)
    found = provenance_findings(without.binding, BINDING, PROVENANCE)
    assert [(f.code, f.severity, f.path) for f in found] == [("c2y_provenance_missing", "warning", "binding.dailySummary")]
    other = {**PROVENANCE, "sphere-email/email.mailgun.foundation": {**PROVENANCE["sphere-email/email.mailgun.foundation"],
                                                                    "registry": "onprem"}}
    found = provenance_findings(document.binding, BINDING, other)
    assert [(f.code, f.path) for f in found] == [("c2y_provenance_mismatch", "binding.dailySummary.from")]
