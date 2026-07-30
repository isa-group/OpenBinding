"""Finding out whether a registered engine actually works, before anybody relies on it.

A manifest is a set of claims. Parsing it establishes that the claims are
well-formed; it establishes nothing about whether the operations exist, whether
the pointers land on anything, or whether the engine answers at all. Those need
the document and the engine, which is why they happen at registration rather
than at parse time.

The probe deliberately uses a problem so small that any solver can answer it: a
two-task sequence with two candidates each, four possible bindings. Failing this
is not a statement about an engine's quality, it is a statement that the mapping
in the manifest does not describe the engine's actual responses - which is the
only thing registration can usefully check.

Every finding says what was expected, what happened, and which field to change.
An engine that fails stays registered and unusable with its report attached,
because "here is what went wrong" is worth more than a rejected submission.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

import httpx
import jsonschema  # type: ignore

from ..models.manifest import EngineManifest, resolve_pointer
from .transport import FederatedTransport, TransportError, find_operation


@dataclass
class Finding:
    """One thing that is wrong, and where."""

    code: str
    message: str
    #: The manifest field to change, when there is one.
    field: Optional[str] = None


@dataclass
class ConformanceReport:
    """What the checks found. Stored on the row and shown to the owner."""

    passed: bool = False
    findings: List[Finding] = field(default_factory=list)
    #: Human-readable record of what the probe did, so a passing report is
    #: still informative.
    steps: List[str] = field(default_factory=list)

    def add(self, code: str, message: str, field_name: Optional[str] = None) -> None:
        self.findings.append(Finding(code=code, message=message, field=field_name))

    def as_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "findings": [asdict(finding) for finding in self.findings],
            "steps": self.steps,
        }


# -- The probe instance -----------------------------------------------------


def micro_instance() -> Dict[str, Any]:
    """The smallest thing that is still a binding problem.

    Two tasks in sequence, two candidates each, one QoS feature. Four possible
    bindings, so an exhaustive engine and a heuristic one both answer in
    milliseconds and neither can plausibly time out.

    Built in code rather than read from ``examples/`` so that probing does not
    depend on which files a deployment happened to ship.
    """
    return {
        "metadata": {
            "id": "conformance-probe",
            "name": "conformance probe",
            "version": "1.0",
            "created_at": "2026-01-01T00:00:00Z",
        },
        "features": [
            {
                "id": "cost",
                "name": "Cost",
                "direction": "MINIMIZE",
                "unit": "eur",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 100},
            }
        ],
        "providers": [{"id": "p1", "name": "P1"}],
        "tasks": [{"id": "t1", "name": "T1"}, {"id": "t2", "name": "T2"}],
        "candidates": [
            {"id": "c1a", "task_ids": ["t1"], "provider_id": "p1", "name": "C1A", "features": {"cost": 1}},
            {"id": "c1b", "task_ids": ["t1"], "provider_id": "p1", "name": "C1B", "features": {"cost": 2}},
            {"id": "c2a", "task_ids": ["t2"], "provider_id": "p1", "name": "C2A", "features": {"cost": 3}},
            {"id": "c2b", "task_ids": ["t2"], "provider_id": "p1", "name": "C2B", "features": {"cost": 4}},
        ],
        "composition": {
            "type": "STRUCTURED",
            "root": {
                "kind": "SEQ",
                "id": "root",
                "children": [
                    {"kind": "TASK", "id": "n1", "task_id": "t1"},
                    {"kind": "TASK", "id": "n2", "task_id": "t2"},
                ],
            },
        },
        "aggregation_policies": {
            "cost": {
                "neutral": 0,
                "compose": {
                    "seq": {"fn": "SUM"},
                    "and": {"fn": "SUM"},
                    "xor": {"fn": "WEIGHTED_SUM"},
                    "loop": {"fn": "SCALED_SUM"},
                },
            }
        },
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
        "constraints": [],
    }


# -- Static checks ----------------------------------------------------------


def check_operations(manifest: EngineManifest, document: Dict[str, Any], report: ConformanceReport):
    """Every operation the manifest maps has to exist in the document."""
    transport = manifest.transport
    if transport is None:
        report.add("no_transport", "This manifest describes no federated engine.", "transport")
        return

    declared = [("solve", transport.operations.solve)]
    if transport.operations.job is not None:
        declared.append(("job", transport.operations.job))
    if transport.operations.health is not None:
        declared.append(("health", transport.operations.health))

    for name, reference in declared:
        try:
            method, path = find_operation(document, reference.operation_id)
            report.steps.append(
                f"{name}: {reference.operation_id} is {method} {path}"
            )
        except TransportError as error:
            report.add(
                "operation_not_found",
                str(error),
                f"transport.operations.{name}.operationId",
            )


def check_base_url(manifest: EngineManifest, document: Dict[str, Any], report: ConformanceReport):
    transport = manifest.transport
    if transport is None:
        return
    if transport.base_url:
        return
    servers = document.get("servers")
    if not (isinstance(servers, list) and servers):
        report.add(
            "no_base_url",
            "The document declares no servers[], so the manifest has to say where the "
            "engine is.",
            "transport.base_url",
        )


def check_instance_schema(manifest: EngineManifest, report: ConformanceReport):
    """The instance schema has to accept what the capabilities claim.

    A schema that rejects the probe instance is not necessarily wrong - an
    engine may genuinely not take a two-task sequence - but the manifest then
    claims TASK and SEQ support it does not have, and the two have to agree
    before anything is routed to it.
    """
    instance = micro_instance()
    nodes = set(manifest.capabilities.composition_nodes_supported)
    objectives = set(manifest.capabilities.objective_types_supported)

    if not {"TASK", "SEQ"} <= nodes or "MONO" not in objectives:
        report.steps.append(
            "instance schema not exercised: the engine does not claim TASK, SEQ and MONO, "
            "which is what the probe uses"
        )
        return

    validator = jsonschema.Draft202012Validator(manifest.instance_schema)
    errors = list(validator.iter_errors(instance))
    if errors:
        report.add(
            "instance_schema_too_strict",
            (
                "The engine claims to support TASK, SEQ and MONO objectives, but its "
                f"instance schema rejects the simplest instance of exactly that: "
                f"{errors[0].message}. Either widen the schema or narrow the capabilities."
            ),
            "instance_schema",
        )
    else:
        report.steps.append("instance schema accepts the probe instance")


def static_checks(manifest: EngineManifest, document: Dict[str, Any]) -> ConformanceReport:
    """Everything checkable without contacting the engine."""
    report = ConformanceReport()
    check_operations(manifest, document, report)
    check_base_url(manifest, document, report)
    check_instance_schema(manifest, report)
    report.passed = not report.findings
    return report


# -- The live probe ---------------------------------------------------------


def check_binding(binding: Any, instance: Dict[str, Any], report: ConformanceReport) -> None:
    """A binding has to name every task, and choose a candidate that can serve it."""
    if not isinstance(binding, dict) or not binding:
        report.add(
            "no_binding",
            "The response contained no task-to-candidate map at the mapped pointer. "
            "This is the one thing a federated engine has to return.",
            "transport.response_mapping.binding",
        )
        return

    task_ids = {task["id"] for task in instance["tasks"]}
    candidates_for = {
        task: {c["id"] for c in instance["candidates"] if task in (c.get("task_ids") or [])}
        for task in task_ids
    }

    missing = task_ids - set(binding)
    if missing:
        report.add(
            "incomplete_binding",
            f"The binding leaves {', '.join(sorted(missing))} unbound.",
            "transport.response_mapping.binding",
        )

    unknown = set(binding) - task_ids
    if unknown:
        report.add(
            "unknown_tasks",
            f"The binding names tasks that are not in the instance: {', '.join(sorted(unknown))}. "
            f"The pointer may be landing on the wrong object.",
            "transport.response_mapping.binding",
        )

    for task, candidate in binding.items():
        legal = candidates_for.get(task)
        if legal is not None and candidate not in legal:
            report.add(
                "illegal_candidate",
                f"Task {task} was bound to {candidate!r}, which is not one of its candidates "
                f"({', '.join(sorted(legal))}).",
                "transport.response_mapping.binding",
            )

    if not report.findings:
        report.steps.append(f"the engine returned a legal binding: {binding}")


async def probe(
    manifest: EngineManifest,
    transport: FederatedTransport,
    *,
    client: Optional[httpx.AsyncClient] = None,
    timeout: float = 60.0,
) -> ConformanceReport:
    """Solve the micro instance and read the answer back through the mapping.

    Synchronous engines only for now: an asynchronous one is accepted on its
    static checks, because probing it properly means polling to completion and
    that is a different shape of operation. The report says so rather than
    implying it was tested.
    """
    report = ConformanceReport()
    instance = micro_instance()

    owns_client = client is None
    client = client or httpx.AsyncClient()
    try:
        try:
            response = await transport.solve(
                client, {"instance": instance, "options": {}}, timeout=timeout
            )
        except Exception as error:  # noqa: BLE001 - every failure mode is the owner's to see
            report.add("unreachable", f"The engine could not be reached: {error}")
            report.passed = False
            return report

        if response.status_code >= 400:
            report.add(
                "error_status",
                f"The engine answered {response.status_code} to the probe instance: "
                f"{response.text[:200]}",
            )
            report.passed = False
            return report

        try:
            body = response.json()
        except ValueError:
            report.add("not_json", "The engine's answer was not JSON.")
            report.passed = False
            return report

        report.steps.append(f"the engine answered {response.status_code}")

        assert manifest.transport is not None
        mapping = manifest.transport.response_mapping

        if manifest.transport.is_asynchronous:
            job_id = resolve_pointer(body, mapping.job_id or "")
            if job_id is None:
                report.add(
                    "no_job_id",
                    "The engine declares a polling operation, but the mapped job_id pointer "
                    "found nothing in its answer.",
                    "transport.response_mapping.job_id",
                )
            else:
                report.steps.append(
                    f"the engine accepted the work and returned job {job_id!r}; asynchronous "
                    f"engines are not polled to completion by the probe"
                )
            report.passed = not report.findings
            return report

        solutions = resolve_pointer(body, mapping.solutions)
        if isinstance(solutions, dict):
            solutions = [solutions]
        if not isinstance(solutions, list) or not solutions:
            report.add(
                "no_solutions",
                "The mapped solutions pointer found no list of solutions in the answer. "
                "Check that it points at the array, and that the engine solved rather than "
                "refusing the instance.",
                "transport.response_mapping.solutions",
            )
            report.passed = False
            return report

        report.steps.append(f"the mapping found {len(solutions)} solution(s)")
        check_binding(resolve_pointer(solutions[0], mapping.binding), instance, report)

        if mapping.objective is not None:
            objective = resolve_pointer(solutions[0], mapping.objective)
            if isinstance(objective, (int, float)):
                report.steps.append(
                    f"the engine reported its own objective ({objective}); the gateway "
                    f"recomputes its own and reports both"
                )
            else:
                report.steps.append(
                    "the mapped objective pointer found nothing numeric; it is optional, "
                    "so this is a note rather than a failure"
                )

        report.passed = not report.findings
        return report
    finally:
        if owns_client:
            await client.aclose()


async def verify(
    manifest: EngineManifest,
    document: Dict[str, Any],
    transport: FederatedTransport,
    *,
    client: Optional[httpx.AsyncClient] = None,
) -> ConformanceReport:
    """Static checks, then the live probe if they passed.

    Probing an engine whose operations do not exist would produce a confusing
    failure about the network when the answer is in the document.
    """
    report = static_checks(manifest, document)
    if not report.passed:
        report.steps.append("the engine was not contacted: the manifest has to be fixed first")
        return report

    live = await probe(manifest, transport, client=client)
    report.findings.extend(live.findings)
    report.steps.extend(live.steps)
    report.passed = not report.findings
    return report
