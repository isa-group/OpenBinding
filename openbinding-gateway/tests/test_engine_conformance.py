"""Establishing that a registered engine works, before anybody depends on it.

A manifest is a set of claims and parsing only checks they are well formed.
Whether the operations exist, whether the pointers land on anything, and
whether the engine answers at all need the document and the engine.

The probe uses a problem with four possible bindings, so failing it is never a
statement about a solver's quality - it is a statement that the mapping does
not describe the engine's actual responses. Which is the only thing
registration can usefully establish.
"""

from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import patch

import httpx
import pytest

from openbinding_gateway.federation.conformance import (
    check_binding,
    micro_instance,
    probe,
    static_checks,
    verify,
)
from openbinding_gateway.federation.transport import FederatedTransport
from openbinding_gateway.models.manifest import EngineManifest

THEIR_OPENAPI: Dict[str, Any] = {
    "openapi": "3.1.0",
    "servers": [{"url": "https://acme.example"}],
    "paths": {
        "/optimize": {"post": {"operationId": "postOptimize"}},
        "/optimize/{id}": {"get": {"operationId": "getOptimize"}},
        "/health": {"get": {"operationId": "getHealth"}},
    },
}


def a_manifest(**transport_overrides) -> EngineManifest:
    transport = {
        "openapi": {"document": THEIR_OPENAPI},
        "operations": {"solve": {"operationId": "postOptimize"}},
        "response_mapping": {"solutions": "/results", "binding": "/assignment"},
    }
    transport.update(transport_overrides)
    return EngineManifest.model_validate(
        {
            "manifest_version": "1",
            "engine_id": "tabu",
            "display_name": "ACME Tabu",
            "type": "HEURISTIC",
            "capabilities": {
                "composition_nodes_supported": ["TASK", "SEQ"],
                "objective_types_supported": ["MONO"],
            },
            "instance_schema": {"type": "object"},
            "transport": transport,
        }
    )


def a_transport(manifest: EngineManifest | None = None) -> FederatedTransport:
    return FederatedTransport(manifest or a_manifest(), THEIR_OPENAPI, require_https=True)


class Answering:
    """An engine that replies with whatever it was given."""

    def __init__(self, body: Any, status: int = 200):
        self.body = body
        self.status = status

    async def __call__(self, request, **kwargs):
        return httpx.Response(
            status_code=self.status,
            content=json.dumps(self.body).encode(),
            headers={"content-type": "application/json"},
            request=request,
        )


async def probe_against(body, manifest=None, status=200):
    manifest = manifest or a_manifest()
    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            with patch.object(httpx.AsyncClient, "send", new=Answering(body, status)):
                return await probe(manifest, a_transport(manifest), client=client)


def a_good_answer():
    return {"results": [{"assignment": {"t1": "c1a", "t2": "c2b"}}]}


# -- The probe instance -----------------------------------------------------


def test_the_probe_instance_is_valid_against_the_general_schema():
    # A probe that fails every engine because the gateway's own fixture is
    # malformed would be worse than no probe.
    from openbinding_gateway.validation.pipeline import ValidationPipeline

    assert ValidationPipeline().validate_general_schema(micro_instance()) == []


def test_the_probe_instance_is_small_enough_that_any_engine_can_answer():
    instance = micro_instance()

    assert len(instance["tasks"]) == 2
    assert len(instance["candidates"]) == 4


# -- Static checks ----------------------------------------------------------


def test_a_manifest_whose_operation_does_not_exist_is_caught():
    manifest = a_manifest(operations={"solve": {"operationId": "postSolve"}})

    report = static_checks(manifest, THEIR_OPENAPI)

    assert report.passed is False
    assert report.findings[0].code == "operation_not_found"
    assert report.findings[0].field == "transport.operations.solve.operationId"


def test_every_declared_operation_is_checked_not_just_solve():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "job": {"operationId": "getNothing"},
        },
        response_mapping={"solutions": "/results", "binding": "/assignment", "job_id": "/id"},
    )

    report = static_checks(manifest, THEIR_OPENAPI)

    assert [f.field for f in report.findings] == ["transport.operations.job.operationId"]


def test_a_document_with_nowhere_to_send_the_request_is_caught():
    document = {"openapi": "3.1.0", "paths": THEIR_OPENAPI["paths"]}

    report = static_checks(a_manifest(), document)

    assert any(f.code == "no_base_url" for f in report.findings)


def test_an_instance_schema_that_contradicts_the_capabilities_is_caught():
    # Claiming SEQ while rejecting a sequence is the failure mode that produces
    # an engine nobody can route anything to.
    manifest = EngineManifest.model_validate(
        {
            **json_of(a_manifest()),
            "instance_schema": {
                "type": "object",
                "properties": {"composition": {"properties": {"type": {"const": "DAG"}}}},
            },
        }
    )

    report = static_checks(manifest, THEIR_OPENAPI)

    assert any(f.code == "instance_schema_too_strict" for f in report.findings)
    assert "narrow the capabilities" in report.findings[0].message


def test_an_engine_that_does_not_claim_the_probe_shape_is_not_held_to_it():
    manifest = EngineManifest.model_validate(
        {
            **json_of(a_manifest()),
            "capabilities": {
                "composition_nodes_supported": ["TASK"],
                "objective_types_supported": ["MANY"],
            },
        }
    )

    report = static_checks(manifest, THEIR_OPENAPI)

    assert report.passed is True
    assert any("not exercised" in step for step in report.steps)


def test_a_sound_manifest_passes_and_says_what_it_checked():
    report = static_checks(a_manifest(), THEIR_OPENAPI)

    assert report.passed is True
    assert any("postOptimize is POST /optimize" in step for step in report.steps)


def json_of(manifest: EngineManifest) -> dict:
    return manifest.model_dump(mode="json", exclude_none=True)


# -- Reading a binding ------------------------------------------------------


def test_a_legal_binding_passes():
    from openbinding_gateway.federation.conformance import ConformanceReport

    report = ConformanceReport()
    check_binding({"t1": "c1a", "t2": "c2a"}, micro_instance(), report)

    assert report.findings == []


@pytest.mark.parametrize(
    "binding,code",
    [
        ({}, "no_binding"),
        ({"t1": "c1a"}, "incomplete_binding"),
        ({"t1": "c1a", "t2": "c2a", "t9": "c9"}, "unknown_tasks"),
        ({"t1": "c2a", "t2": "c2b"}, "illegal_candidate"),
    ],
)
def test_a_binding_that_is_not_an_answer_is_caught(binding, code):
    from openbinding_gateway.federation.conformance import ConformanceReport

    report = ConformanceReport()
    check_binding(binding, micro_instance(), report)

    assert code in [f.code for f in report.findings]


def test_a_candidate_from_the_wrong_task_names_the_legal_ones():
    # The likeliest cause is a pointer landing one level off, so the message
    # has to be enough to see that.
    from openbinding_gateway.federation.conformance import ConformanceReport

    report = ConformanceReport()
    check_binding({"t1": "c2a", "t2": "c2b"}, micro_instance(), report)

    assert "c1a" in report.findings[0].message


# -- The live probe ---------------------------------------------------------


@pytest.mark.asyncio
async def test_an_engine_that_answers_correctly_passes():
    report = await probe_against(a_good_answer())

    assert report.passed is True
    assert any("legal binding" in step for step in report.steps)


@pytest.mark.asyncio
async def test_an_unreachable_engine_is_reported_rather_than_raising():
    manifest = a_manifest()
    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", side_effect=OSError("no route")):
            report = await probe(manifest, a_transport(manifest), client=client)

    assert report.passed is False
    assert report.findings[0].code == "unreachable"


@pytest.mark.asyncio
async def test_an_error_status_is_reported_with_what_the_engine_said():
    report = await probe_against({"error": "unsupported instance"}, status=422)

    assert report.findings[0].code == "error_status"
    assert "unsupported instance" in report.findings[0].message


@pytest.mark.asyncio
async def test_a_mapping_that_finds_nothing_says_which_pointer_to_fix():
    report = await probe_against({"answers": [{"assignment": {"t1": "c1a"}}]})

    assert report.findings[0].code == "no_solutions"
    assert report.findings[0].field == "transport.response_mapping.solutions"


@pytest.mark.asyncio
async def test_a_binding_pointer_that_lands_elsewhere_says_so():
    report = await probe_against({"results": [{"score": 4.0}]})

    assert report.findings[0].code == "no_binding"
    assert report.findings[0].field == "transport.response_mapping.binding"


@pytest.mark.asyncio
async def test_an_engine_binding_a_task_to_the_wrong_candidate_fails():
    report = await probe_against({"results": [{"assignment": {"t1": "c2a", "t2": "c2b"}}]})

    assert report.passed is False
    assert "illegal_candidate" in [f.code for f in report.findings]


@pytest.mark.asyncio
async def test_a_single_object_answer_is_accepted():
    report = await probe_against({"results": {"assignment": {"t1": "c1a", "t2": "c2a"}}})

    assert report.passed is True


@pytest.mark.asyncio
async def test_an_objective_the_engine_reports_is_noted_not_believed():
    manifest = a_manifest(
        response_mapping={"solutions": "/results", "binding": "/assignment", "objective": "/score"}
    )
    report = await probe_against(
        {"results": [{"assignment": {"t1": "c1a", "t2": "c2a"}, "score": 4.0}]}, manifest
    )

    assert report.passed is True
    assert any("recomputes its own" in step for step in report.steps)


@pytest.mark.asyncio
async def test_an_asynchronous_engine_is_probed_as_far_as_its_receipt():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "job": {"operationId": "getOptimize"},
        },
        response_mapping={"solutions": "/results", "binding": "/assignment", "job_id": "/id"},
    )

    report = await probe_against({"id": "run-1"}, manifest)

    assert report.passed is True
    # The report has to be honest about what it did not do.
    assert any("not polled to completion" in step for step in report.steps)


@pytest.mark.asyncio
async def test_an_asynchronous_engine_whose_receipt_has_no_identifier_fails():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "job": {"operationId": "getOptimize"},
        },
        response_mapping={"solutions": "/results", "binding": "/assignment", "job_id": "/id"},
    )

    report = await probe_against({"accepted": True}, manifest)

    assert report.findings[0].code == "no_job_id"


# -- The two together -------------------------------------------------------


@pytest.mark.asyncio
async def test_a_broken_manifest_is_not_probed():
    # Contacting an engine whose operations do not exist produces a confusing
    # failure about the network when the answer is in the document.
    manifest = a_manifest(operations={"solve": {"operationId": "nope"}})

    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", side_effect=AssertionError("should not be contacted")):
            report = await verify(manifest, THEIR_OPENAPI, a_transport(manifest), client=client)

    assert report.passed is False
    assert any("not contacted" in step for step in report.steps)


@pytest.mark.asyncio
async def test_a_sound_engine_passes_both_halves():
    manifest = a_manifest()
    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            with patch.object(httpx.AsyncClient, "send", new=Answering(a_good_answer())):
                report = await verify(manifest, THEIR_OPENAPI, a_transport(manifest), client=client)

    assert report.passed is True
    assert report.as_dict()["findings"] == []
    assert len(report.as_dict()["steps"]) > 2
