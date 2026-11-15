"""The coherence of a Composition2Yaml document: every rule the document alone decides.

One case per rule, each with its code, severity and path; every finding of a document
collected rather than the first one raised; an offering warning that leaves the document
valid; exact xor sums; the same registry alias a warning under ``offering`` and an error under
``from``; and the stored mode, which skips the rules that depend on the deployment or the
entity.
"""

from __future__ import annotations

import json

import pytest

from openbinding_gateway.composition import checks, text
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.document import Document, Entry, Evidence, Offering
from openbinding_gateway.composition.workflow import Sequence, TaskNode

HEAD = 'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\n'
PROBLEM = "problem: {ref: isa/problems/shop@3, compilation: sha256-" + "0" * 64 + "}\n"
RUN = "3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90"
LAB = text.Context(registries=frozenset({"lab"}))


def _source(
    workflow: str = "a",
    binding: str = "{a: {candidate: ca}}",
    values: str = "{}",
    extra: str = "",
    *,
    problem: bool = False,
) -> str:
    return (
        HEAD + (PROBLEM if problem else "")
        + f"workflow: {workflow}\nbinding: {binding}\nvalues: {values}\n" + extra
    )


def _found(reading: text.Reading) -> list[tuple[str, str, str]]:
    return [(item.code, item.severity, item.path) for item in reading.diagnostics]


def _offering(offering: str) -> str:
    return _source(extra=f"offering: {offering}\n")


def _from(provenance: str) -> str:
    return _source(binding=f"{{a: {{candidate: ca, from: {provenance}}}}}")


def _evidence(evidence: str, *, problem: bool = True) -> str:
    return _source(extra=f"evidence: {evidence}\n", problem=problem)


def _error(code: str, path: str) -> list[tuple[str, str, str]]:
    return [(code, "error", path)]


RULES = [
    # the workflow and the binding
    ("task unbound", _source("{seq: [a, b]}"), _error(codes.TASK_UNBOUND, "workflow.seq[1]")),
    ("task unbound once", _source("{seq: [b, a, b]}"), _error(codes.TASK_UNBOUND, "workflow.seq[0]")),
    ("task unbound in a loop", _source("{seq: [a, {loop: b, count: 2}]}"), _error(codes.TASK_UNBOUND, "workflow.seq[1].loop")),
    ("unknown task", _source(binding="{a: {candidate: ca}, z: {candidate: cz}}"), _error(codes.BINDING_UNKNOWN_TASK, "binding.z")),
    ("no task, no entry", _source("null", "{}"), []),
    ("candidate and local", _source(binding="{a: {candidate: ca, local: true}}"), _error(codes.BINDING_ENTRY, "binding.a")),
    ("neither", _source(binding="{a: {}}"), _error(codes.BINDING_ENTRY, "binding.a")),
    ("local false", _source(binding="{a: {candidate: ca, local: false}}"), _error(codes.BINDING_ENTRY, "binding.a.local")),
    (
        "local with from",
        _source(binding="{a: {local: true, from: {sphere: acme/p, version: v1, plan: Basic}}}"),
        _error(codes.BINDING_ENTRY, "binding.a.from"),
    ),
    # xor
    (
        "xor mixed",
        _source("{xor: [{probability: 0.5, flow: a}, b]}", "{a: {candidate: ca}, b: {candidate: cb}}"),
        _error(codes.XOR_PROBABILITIES, "workflow"),
    ),
    (
        "xor uniform with probabilities",
        _source(
            "{xor: [{probability: 0.5, flow: a}, {probability: 0.5, flow: b}], uniform: true}",
            "{a: {candidate: ca}, b: {candidate: cb}}",
        ),
        _error(codes.XOR_PROBABILITIES, "workflow.uniform"),
    ),
    (
        "xor sum",
        _source(
            "{seq: [{xor: [{probability: 0.5, flow: a}, {probability: 0.4, flow: b}]}]}",
            "{a: {candidate: ca}, b: {candidate: cb}}",
        ),
        _error(codes.XOR_SUM, "workflow.seq[0]"),
    ),
    (
        "xor nested in a weighted branch",
        _source(
            "{xor: [{probability: 1, flow: {xor: [{probability: 0.7, flow: a}, {probability: 0.7, flow: b}]}}]}",
            "{a: {candidate: ca}, b: {candidate: cb}}",
        ),
        _error(codes.XOR_SUM, "workflow.xor[0].flow"),
    ),
    # from
    ("from without version", _from("{sphere: acme/p, plan: Basic}"), _error(codes.FROM_VERSION_MISSING, "binding.a.from.version")),
    ("from without plan", _from("{sphere: acme/p, version: v1}"), _error(codes.FROM_INCOMPLETE, "binding.a.from.plan")),
    ("from without sphere", _from("{version: v1, plan: Basic}"), _error(codes.FROM_INCOMPLETE, "binding.a.from.sphere")),
    ("from sphere", _from("{sphere: acme, version: v1, plan: Basic}"), _error(codes.FROM_SHAPE, "binding.a.from.sphere")),
    ("from alias", _from("{sphere: acme/p, registry: Lab_1, version: v1, plan: Basic}"), _error(codes.FROM_SHAPE, "binding.a.from.registry")),
    ("from version id", _from("{sphere: acme/p, version: 'v 1', plan: Basic}"), _error(codes.FROM_SHAPE, "binding.a.from.version")),
    ("from plan", _from('{sphere: acme/p, version: v1, plan: "Basic\\x01"}'), _error(codes.FROM_SHAPE, "binding.a.from.plan")),
    (
        "from addons twice",
        _from("{sphere: acme/p, version: v1, plan: Basic, addons: [sso, audit, sso]}"),
        _error(codes.FROM_SHAPE, "binding.a.from.addons[2]"),
    ),
    (
        "from registry unknown",
        _from("{sphere: acme/p, registry: lab, version: v1, plan: Basic}"),
        _error(codes.FROM_REGISTRY_UNKNOWN, "binding.a.from.registry"),
    ),
    # the offering
    ("offering empty", _offering("{}"), _error(codes.OFFERING_SOURCES, "offering")),
    ("offering two sources", _offering("{sphere: isa/shop, url: 'https://x.org/p.yml'}"), _error(codes.OFFERING_SOURCES, "offering")),
    ("offering registry alone", _offering("{registry: lab}"), _error(codes.OFFERING_SOURCES, "offering")),
    ("offering not a mapping", _offering("isa/shop"), _error(codes.OFFERING_SHAPE, "offering")),
    ("offering sphere", _offering("{sphere: shop}"), _error(codes.OFFERING_SHAPE, "offering.sphere")),
    ("offering sphere type", _offering("{sphere: 3}"), _error(codes.OFFERING_SHAPE, "offering.sphere")),
    ("offering alias", _offering("{sphere: isa/shop, registry: '-lab'}"), _error(codes.OFFERING_SHAPE, "offering.registry")),
    ("offering registry with url", _offering("{url: 'https://x.org/p.yml', registry: lab}"), _error(codes.OFFERING_SHAPE, "offering.registry")),
    ("offering plans", _offering("{sphere: isa/shop, plans: {}}"), _error(codes.OFFERING_SHAPE, "offering.plans")),
    ("offering price", _offering("{sphere: isa/shop, price: 10}"), _error(codes.OFFERING_SHAPE, "offering.price")),
    ("offering version", _offering("{sphere: isa/shop, version: '2024'}"), _error(codes.OFFERING_SHAPE, "offering.version")),
    ("offering unknown key", _offering("{sphere: isa/shop, label: Shop}"), _error(codes.OFFERING_SHAPE, "offering.label")),
    ("offering http", _offering("{url: 'http://x.org/p.yml'}"), _error(codes.OFFERING_URL_NOT_HTTPS, "offering.url")),
    ("offering ftp", _offering("{url: 'ftp://x.org/p.yml'}"), _error(codes.OFFERING_URL_NOT_HTTPS, "offering.url")),
    ("offering relative", _offering("{url: pricing.yml}"), _error(codes.OFFERING_URL_NOT_HTTPS, "offering.url")),
    ("offering upper-case scheme", _offering("{url: 'HTTPS://x.org/p.yml'}"), _error(codes.OFFERING_URL_NOT_HTTPS, "offering.url")),
    ("offering userinfo", _offering("{url: 'https://me:pw@x.org/p.yml'}"), _error(codes.OFFERING_SHAPE, "offering.url")),
    ("offering no host", _offering("{url: 'https:///p.yml'}"), _error(codes.OFFERING_SHAPE, "offering.url")),
    ("offering space", _offering("{url: 'https://x.org/my pricing.yml'}"), _error(codes.OFFERING_SHAPE, "offering.url")),
    ("offering port", _offering("{url: 'https://x.org:https/p.yml'}"), _error(codes.OFFERING_SHAPE, "offering.url")),
    (
        "offering long url",
        _offering("{url: 'https://x.org/" + "p" * 2040 + "'}"),
        _error(codes.OFFERING_SHAPE, "offering.url"),
    ),
    ("offering longest url", _offering("{url: 'https://x.org/" + "p" * 2034 + "'}"), []),
    (
        "offering registry unknown",
        _offering("{sphere: isa/shop, registry: lab}"),
        [(codes.OFFERING_REGISTRY_UNKNOWN, "warning", "offering.registry")],
    ),
    # values
    ("value boolean", _source(values="{encrypted: true}"), _error(codes.VALUE_SHAPE, "values.encrypted")),
    ("value boolean in a mapping", _source(values="{encrypted: {value: no, unit: flag}}"), _error(codes.VALUE_SHAPE, "values.encrypted")),
    ("unit empty", _source(values="{cost: {value: 3, unit: ''}}"), _error(codes.VALUE_SHAPE, "values.cost.unit")),
    ("bare number", _source(values="{cost: 3, ratio: 0.5}"), []),
    # evidence
    ("run and manual", _evidence(f"{{run: {RUN}, manual: true}}"), _error(codes.EVIDENCE_SHAPE, "evidence.manual")),
    ("run and manual false", _evidence(f"{{run: {RUN}, manual: false}}"), []),
    ("point without run", _evidence("{point: 2}"), _error(codes.EVIDENCE_SHAPE, "evidence.point")),
    ("negative point", _evidence(f"{{run: {RUN}, point: -1}}"), _error(codes.EVIDENCE_SHAPE, "evidence.point")),
    ("run not a uuid", _evidence("{run: job-7}"), _error(codes.EVIDENCE_SHAPE, "evidence.run")),
    ("evaluated by", _evidence("{evaluatedBy: robot}"), _error(codes.EVIDENCE_SHAPE, "evidence.evaluatedBy")),
    ("empty toolchain", _evidence("{evaluatedBy: declared, toolchain: ''}"), _error(codes.EVIDENCE_SHAPE, "evidence.toolchain")),
    (
        "gateway without problem",
        _evidence("{evaluatedBy: gateway}", problem=False),
        _error(codes.EVIDENCE_GATEWAY_WITHOUT_PROBLEM, "evidence.evaluatedBy"),
    ),
    ("declared without problem", _evidence("{manual: true, evaluatedBy: declared}", problem=False), []),
    (
        "run without problem",
        _evidence(f"{{run: {RUN}}}", problem=False),
        _error(codes.EVIDENCE_RUN_WITHOUT_PROBLEM, "evidence.run"),
    ),
]


@pytest.mark.parametrize(("source", "expected"), [case[1:] for case in RULES], ids=[case[0] for case in RULES])
def test_each_rule_reports_its_code_severity_and_path(source: str, expected: list) -> None:
    reading = text.read(source)
    assert _found(reading) == expected
    assert all(item.span is not None for item in reading.diagnostics)
    assert reading.valid is not any(severity == "error" for _, severity, _ in expected)


def test_a_json_body_is_judged_by_the_same_rules() -> None:
    body = {
        "syntaxVersion": "1.0", "composition": "shop", "version": "1.0.0", "kind": "workflow",
        "workflow": {"seq": ["a", "b"]}, "binding": {"a": {"candidate": "ca"}}, "values": {},
        "offering": {"url": "http://x.org/p.yml"},
    }
    reading = text.compose(json.loads(json.dumps(body)))
    assert _found(reading) == [
        (codes.TASK_UNBOUND, "error", "workflow.seq[1]"),
        (codes.OFFERING_URL_NOT_HTTPS, "error", "offering.url"),
    ]
    assert reading.document is None and reading.diagnostics[0].span is None


def test_every_finding_is_collected() -> None:
    source = _source(
        "{seq: [a, b, {xor: [{probability: 0.3, flow: c}, {probability: 0.3, flow: d}]}]}",
        "{a: {candidate: ca, from: {sphere: acme/p, plan: Basic}}, c: {candidate: cc}, d: {candidate: cd}}",
        "{encrypted: true}",
        f"evidence: {{run: {RUN}}}\n",
    )
    reading = text.read(source)
    assert _found(reading) == [
        (codes.TASK_UNBOUND, "error", "workflow.seq[1]"),
        (codes.XOR_SUM, "error", "workflow.seq[2]"),
        (codes.FROM_VERSION_MISSING, "error", "binding.a.from.version"),
        (codes.VALUE_SHAPE, "error", "values.encrypted"),
        (codes.EVIDENCE_RUN_WITHOUT_PROBLEM, "error", "evidence.run"),
    ]
    assert reading.document is None


def test_the_findings_of_four_independent_faults_are_four() -> None:
    source = _source(
        "{seq: [a, b]}",
        "{a: {candidate: ca}, z: {candidate: cz}}",
        extra="offering: {}\nevidence: {evaluatedBy: gateway}\n",
    )
    assert [code for code, _, _ in _found(text.read(source))] == [
        codes.TASK_UNBOUND, codes.BINDING_UNKNOWN_TASK, codes.OFFERING_SOURCES,
        codes.EVIDENCE_GATEWAY_WITHOUT_PROBLEM,
    ]


def test_an_offering_warning_leaves_the_document_valid() -> None:
    source = _offering("{sphere: isa/shop, registry: lab}")
    reading = text.read(source)
    assert reading.valid and reading.document is not None
    assert [item.code for item in reading.warnings] == [codes.OFFERING_REGISTRY_UNKNOWN]
    assert text.parse(source).offering == Offering(sphere="isa/shop", registry="lab")
    assert text.read(source, context=LAB).diagnostics == ()


def test_xor_probabilities_add_up_as_the_decimals_they_are_written_as() -> None:
    assert 0.7 + 0.2 + 0.1 != 1
    tenths = _source(
        "{xor: [{probability: 0.7, flow: a}, {probability: 0.2, flow: b}, {probability: 0.1, flow: c}]}",
        "{a: {candidate: ca}, b: {candidate: cb}, c: {candidate: cc}}",
    )
    assert text.read(tenths).diagnostics == ()
    third = 0.3333333333333333
    thirds = _source(
        f"{{xor: [{{probability: {third}, flow: a}}, {{probability: {third}, flow: b}}, {{probability: {third}, flow: c}}]}}",
        "{a: {candidate: ca}, b: {candidate: cb}, c: {candidate: cc}}",
    )
    (found,) = text.read(thirds).diagnostics
    assert (found.code, found.path) == (codes.XOR_SUM, "workflow")
    assert "0.9999999999999999" in found.message and "uniform: true" in found.message


def test_the_same_alias_is_a_warning_on_the_offering_and_an_error_on_a_provenance() -> None:
    source = _source(
        binding="{a: {candidate: ca, from: {sphere: acme/p, registry: edge, version: v1, plan: Basic}}}",
        extra="offering: {sphere: isa/shop, registry: edge}\n",
    )
    assert _found(text.read(source, context=LAB)) == [
        (codes.FROM_REGISTRY_UNKNOWN, "error", "binding.a.from.registry"),
        (codes.OFFERING_REGISTRY_UNKNOWN, "warning", "offering.registry"),
    ]
    defined = text.Context(registries=frozenset({"edge"}))
    assert text.read(source, context=defined).diagnostics == ()


def test_the_slug_the_entity_has_is_an_info_when_it_differs() -> None:
    source = _source()
    found = text.read(source, context=text.Context(entity_slug="store"))
    assert _found(found) == [(codes.SLUG_MISMATCH, "info", "composition")]
    assert found.valid
    assert text.read(source, context=text.Context(entity_slug="shop")).diagnostics == ()


def test_the_stored_mode_skips_the_deployment_and_entity_rules() -> None:
    source = _source(
        binding="{a: {candidate: ca, from: {sphere: acme/p, registry: edge, version: v1, plan: Basic}}}",
        extra="offering: {sphere: isa/shop, registry: edge}\n",
    )
    stored = text.Context(stored=True, entity_slug="store")
    assert text.read(source, context=stored).diagnostics == ()
    assert text.read_stored(source).offering == Offering(sphere="isa/shop", registry="edge")
    # Every other rule still holds: a stored document that breaks one is a bug.
    with pytest.raises(text.StoredContentError) as refused:
        text.read_stored(_source("{seq: [a, b]}"))
    assert [item.code for item in refused.value.diagnostics] == [codes.TASK_UNBOUND]


def test_a_document_built_in_code_is_judged_at_the_nearest_path() -> None:
    built = Document(
        syntax_version="1.0", composition="shop", version="1.0.0", kind="workflow", problem=None,
        workflow=Sequence((TaskNode("a"), TaskNode("b"))),
        binding=(("a", Entry(candidate="ca")),), values=(),
        evidence=Evidence(evaluated_by="gateway"),
    )
    found = checks.coherence(built, context=text.Context())
    assert [(item.code, item.path, item.pointer) for item in found] == [
        (codes.TASK_UNBOUND, "workflow", "/workflow"),
        (codes.EVIDENCE_GATEWAY_WITHOUT_PROBLEM, "evidence.evaluatedBy", "/evidence/evaluatedBy"),
    ]
