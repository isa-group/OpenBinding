"""The coherence of a Composition2Yaml document: every rule the document alone decides.

The section readers of :mod:`.text` judge each element by itself: its type, its keys, its
pattern. What is left is how the elements agree with one another, and the rules that need
the deployment or the entity the document is submitted to:

* every task of the workflow has exactly one binding entry, and every entry names a task of
  the workflow; an entry binds a candidate or says ``local: true``, and only a candidate has
  a ``from``;
* the branches of an ``xor`` state their probabilities all or none, never beside
  ``uniform: true``, and stated probabilities add up to exactly 1, compared as the decimals
  their ``repr`` writes, the way the compiler compares routing probabilities;
* a ``from`` pins a SPHERE pricing's plan at a version, on a registry the deployment defines;
* an ``offering`` names exactly one source, well formed; a registry the deployment does not
  define is only a warning there, since the offering never decides whether the binding holds;
* a value is a number, never a boolean, with a non-empty unit;
* the evidence is coherent: a run is not also manual, a point belongs to a run, and only a
  composition linked to a problem was evaluated by the gateway or comes from a run;
* the slug the document names is the slug of the composition it is submitted to (an info).

Whether a unit is absent or unknown is decided only against a problem: without one, a bare
number is dimensionless and any non-empty unit is accepted, because the toolchain has no unit
catalogue to judge one by.

Every finding is collected, addressed by path so the reader can underline it. A document read
in stored mode (``Context.stored``) skips the rules that depend on the deployment or the
entity, so a sealed version stays readable after a registry alias leaves the configuration.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from . import diagnostics as codes
from . import ids
from .diagnostics import Diagnostic, Path, at
from .document import DIMENSIONLESS, Document, Evidence, Offering, Provenance
from .workflow import Exclusive, Location, TaskNode, tasks, walk

if TYPE_CHECKING:
    from .text import Context

#: The longest offering URL a document may name.
MAX_URL_CHARS = 2048

#: Who may have evaluated a document's values.
EVALUATED_BY = ("gateway", "declared")

_WORKFLOW = Path(("workflow",))
_OFFERING = Path(("offering",))
_EVIDENCE = Path(("evidence",))


def coherence(doc: Document, *, context: Context) -> tuple[Diagnostic, ...]:
    """Every coherence finding of ``doc``, in the order its sections are written."""
    found: list[Diagnostic] = []
    found += _slug(doc, context)
    found += _workflow(doc)
    found += _binding(doc, context)
    found += _values(doc)
    if doc.offering is not None:
        found += _offering(doc.offering, context)
    if doc.evidence is not None:
        found += _evidence(doc.evidence, has_problem=doc.problem is not None)
    return tuple(found)


# --------------------------------------------------------------------------- the slug


def _slug(doc: Document, context: Context) -> list[Diagnostic]:
    if context.stored or context.entity_slug is None or context.entity_slug == doc.composition:
        return []
    return [at(
        ("composition",), codes.SLUG_MISMATCH,
        f"the document names the composition {doc.composition!r}, but it is submitted to "
        f"{context.entity_slug!r}; the composition's slug is the one that counts",
        severity="info",
    )]


# --------------------------------------------------------------------------- workflow and binding


def _node_path(doc: Document, location: Location) -> Path:
    """The source path of the node at ``location``, or of its nearest ancestor that has one."""
    nodes = doc.paths.nodes
    while True:
        found = nodes.get(location)
        if found is not None:
            return found
        if not location:
            return _WORKFLOW
        location = location[:-1]


def _workflow(doc: Document) -> list[Diagnostic]:
    """The xor rules, and the tasks with no binding entry, in the order the workflow is written."""
    found: list[Diagnostic] = []
    bound = {task for task, _ in doc.binding}
    seen: set[str] = set()
    for location, node in walk(doc.workflow):
        if isinstance(node, Exclusive):
            found += _exclusive(node, _node_path(doc, location))
        elif isinstance(node, TaskNode) and node.task not in seen:
            seen.add(node.task)
            if node.task not in bound:
                path = doc.paths.leaves.get(node.task) or _node_path(doc, location)
                found.append(at(
                    path, codes.TASK_UNBOUND,
                    f"task {node.task!r} has no binding entry: bind a candidate, or write "
                    f"{node.task}: {{local: true}} for a step done in house",
                ))
    return found


def _exclusive(node: Exclusive, path: Path) -> list[Diagnostic]:
    stated = [branch.probability for branch in node.branches if branch.probability is not None]
    if not stated:
        return []
    if node.uniform:
        return [at(
            path.child("uniform"), codes.XOR_PROBABILITIES,
            "uniform: true says every branch is equally likely: leave the probabilities out, or "
            "drop uniform and state them",
        )]
    if len(stated) != len(node.branches):
        return [at(
            path, codes.XOR_PROBABILITIES,
            f"{len(stated)} of the {len(node.branches)} branches of this xor state a probability: "
            "every branch states one, or none does",
        )]
    total = sum((Decimal(repr(probability)) for probability in stated), Decimal(0))
    if total != 1:
        return [at(
            path, codes.XOR_SUM,
            f"the probabilities of this xor add up to {total}, not exactly 1; for equal branches "
            "write uniform: true",
        )]
    return []


def _binding(doc: Document, context: Context) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    written = set(tasks(doc.workflow))
    root = Path(("binding",))
    for task, entry in doc.binding:
        path = root.child(task)
        if task not in written:
            found.append(at(
                path, codes.BINDING_UNKNOWN_TASK,
                f"{task!r} is not a task of the workflow: every binding entry names one",
            ))
        if entry.candidate is not None and entry.local:
            found.append(at(
                path, codes.BINDING_ENTRY,
                "an entry binds a candidate or says local: true, not both",
            ))
        elif entry.candidate is None and not entry.local:
            found.append(at(
                path, codes.BINDING_ENTRY,
                "an entry binds a candidate ({candidate: <id>}) or says the step is done in house "
                "({local: true})",
            ))
        if entry.source is not None:
            if entry.candidate is None:
                found.append(at(
                    path.child("from"), codes.BINDING_ENTRY,
                    "only a bound candidate comes from a pricing: a local step has no from",
                ))
            found += _provenance(entry.source, path.child("from"), context)
    return found


def _provenance(source: Provenance, path: Path, context: Context) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    if source.sphere is None:
        message = "from names the SPHERE pricing the candidate came from: write sphere: <owner>/<name>"
        if source.registry is not None:
            message += "; a registry says which SPHERE holds it, and needs the sphere"
        found.append(at(path.child("sphere"), codes.FROM_INCOMPLETE, message))
    elif not ids.PRICING.fullmatch(source.sphere):
        found.append(at(
            path.child("sphere"), codes.FROM_SHAPE,
            f"{source.sphere!r} is not a SPHERE pricing: write <owner>/<name>",
        ))
    if source.registry is not None:
        if not ids.ALIAS.fullmatch(source.registry):
            found.append(at(
                path.child("registry"), codes.FROM_SHAPE,
                f"{source.registry!r} is not a registry alias: lower-case letters, digits and inner "
                "hyphens, at most 32 characters",
            ))
        elif not context.stored and source.registry not in context.registries:
            found.append(at(
                path.child("registry"), codes.FROM_REGISTRY_UNKNOWN,
                f"the registry {source.registry!r} is not configured in this deployment: a provenance "
                "on it can be neither watched nor checked",
            ))
    if source.version is None:
        found.append(at(
            path.child("version"), codes.FROM_VERSION_MISSING,
            "from pins the SPHERE version the candidate was chosen against: without it, upstream "
            "changes cannot be detected",
        ))
    elif not ids.VERSION_ID.fullmatch(source.version):
        found.append(at(
            path.child("version"), codes.FROM_SHAPE,
            f"{source.version!r} is not a SPHERE version id",
        ))
    if source.plan is None:
        found.append(at(
            path.child("plan"), codes.FROM_INCOMPLETE,
            "from names the plan chosen: write plan: <name>",
        ))
    elif not ids.PLAN.fullmatch(source.plan):
        found.append(at(
            path.child("plan"), codes.FROM_SHAPE,
            "a plan name has one to 128 characters, none of them a control character",
        ))
    seen: set[str] = set()
    for position, addon in enumerate(source.addons):
        where = path.child("addons", position)
        if not ids.PLAN.fullmatch(addon):
            found.append(at(
                where, codes.FROM_SHAPE,
                "an add-on name has one to 128 characters, none of them a control character",
            ))
        elif addon in seen:
            found.append(at(where, codes.FROM_SHAPE, f"the add-on {addon!r} is listed twice"))
        seen.add(addon)
    return found


# --------------------------------------------------------------------------- values


def _values(doc: Document) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    root = Path(("values",))
    for name, value in doc.values:
        path = root.child(name)
        if isinstance(value.value, bool):
            found.append(at(
                path, codes.VALUE_SHAPE,
                f"a value is a number, not the boolean {str(value.value).lower()} (YAML reads yes, no, "
                "on and off as booleans)",
            ))
        if value.unit != DIMENSIONLESS and not value.unit:
            found.append(at(
                path.child("unit"), codes.VALUE_SHAPE,
                "a unit is a non-empty string; write a bare number for a dimensionless value",
            ))
    return found


# --------------------------------------------------------------------------- the offering


def _offering(offering: Offering, context: Context) -> list[Diagnostic]:
    sources = [key for key, value in (("sphere", offering.sphere), ("url", offering.url)) if value is not None]
    if len(sources) != 1:
        if sources:
            message = "an offering has exactly one source: a SPHERE pricing or a URL, not both"
        elif offering.registry is not None:
            message = (
                "an offering has exactly one source; a registry says which SPHERE holds the pricing "
                "and needs sphere: <owner>/<name>"
            )
        else:
            message = "an offering has exactly one source: {sphere: <owner>/<name>} or {url: https://...}"
        return [at(_OFFERING, codes.OFFERING_SOURCES, message)]
    if offering.sphere is not None:
        return _offering_sphere(offering.sphere, offering.registry, context)
    found: list[Diagnostic] = []
    if offering.registry is not None:
        found.append(at(
            _OFFERING.child("registry"), codes.OFFERING_SHAPE,
            "a registry names the SPHERE that holds a pricing; an offering by URL has none",
        ))
    found += _offering_url(offering.url or "")
    return found


def _offering_sphere(sphere: str, registry: str | None, context: Context) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    if not ids.PRICING.fullmatch(sphere):
        found.append(at(
            _OFFERING.child("sphere"), codes.OFFERING_SHAPE,
            f"{sphere!r} is not a SPHERE pricing: write <owner>/<name>",
        ))
    if registry is None:
        return found
    if not ids.ALIAS.fullmatch(registry):
        found.append(at(
            _OFFERING.child("registry"), codes.OFFERING_SHAPE,
            f"{registry!r} is not a registry alias: lower-case letters, digits and inner hyphens, "
            "at most 32 characters",
        ))
    elif not context.stored and registry not in context.registries:
        found.append(at(
            _OFFERING.child("registry"), codes.OFFERING_REGISTRY_UNKNOWN,
            f"the registry {registry!r} is not configured in this deployment, so the offering cannot "
            "be read: the composition stays valid, without margins",
            severity="warning",
        ))
    return found


def _offering_url(url: str) -> list[Diagnostic]:
    path = _OFFERING.child("url")
    if len(url) > MAX_URL_CHARS:
        return [at(path, codes.OFFERING_SHAPE, f"the URL is longer than {MAX_URL_CHARS} characters")]
    if any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F for character in url):
        return [at(path, codes.OFFERING_SHAPE, "a URL has no spaces or control characters")]
    try:
        parts = urlsplit(url)
        _ = parts.port  # a port that is not a number raises here
    except ValueError:
        return [at(path, codes.OFFERING_SHAPE, f"{url!r} is not a URL")]
    if not url.startswith("https://"):
        if parts.scheme.lower() == "https" and url[len("https:"):].startswith("//"):
            message = "write the scheme in lower case: https://"
        elif parts.scheme:
            message = f"the offering is read over HTTPS only, not {parts.scheme}"
        else:
            message = "the offering is an absolute https:// URL"
        return [at(path, codes.OFFERING_URL_NOT_HTTPS, message)]
    if "@" in parts.netloc:
        return [at(path, codes.OFFERING_SHAPE, "the URL carries credentials: an offering is a public file")]
    if not parts.hostname:
        return [at(path, codes.OFFERING_SHAPE, "the URL names no host")]
    return []


# --------------------------------------------------------------------------- evidence


def _evidence(evidence: Evidence, *, has_problem: bool) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    if evidence.run is not None:
        if not ids.UUID.fullmatch(evidence.run):
            found.append(at(
                _EVIDENCE.child("run"), codes.EVIDENCE_SHAPE,
                f"{evidence.run!r} is not a run id: a lower-case UUID",
            ))
        if evidence.manual:
            found.append(at(
                _EVIDENCE.child("manual"), codes.EVIDENCE_SHAPE,
                "the binding comes from a run or was chosen by hand, not both",
            ))
        if not has_problem:
            found.append(at(
                _EVIDENCE.child("run"), codes.EVIDENCE_RUN_WITHOUT_PROBLEM,
                "a run solves a problem revision: link the problem the run solved",
            ))
    if evidence.point is not None:
        if evidence.run is None:
            found.append(at(
                _EVIDENCE.child("point"), codes.EVIDENCE_SHAPE,
                "a point is a solution of a run's front: name the run",
            ))
        if evidence.point < 0:
            found.append(at(
                _EVIDENCE.child("point"), codes.EVIDENCE_SHAPE,
                f"a point is a solution index, zero or more, not {evidence.point}",
            ))
    if evidence.evaluated_by is not None:
        if evidence.evaluated_by not in EVALUATED_BY:
            found.append(at(
                _EVIDENCE.child("evaluatedBy"), codes.EVIDENCE_SHAPE,
                f"{evidence.evaluated_by!r} is not who evaluated the values: gateway or declared",
            ))
        elif evidence.evaluated_by == "gateway" and not has_problem:
            found.append(at(
                _EVIDENCE.child("evaluatedBy"), codes.EVIDENCE_GATEWAY_WITHOUT_PROBLEM,
                "the gateway evaluates a composition against its problem: link the problem, or write "
                "evaluatedBy: declared",
            ))
    if evidence.toolchain is not None and not evidence.toolchain:
        found.append(at(
            _EVIDENCE.child("toolchain"), codes.EVIDENCE_SHAPE,
            "the toolchain is named <name> <version>, not left empty",
        ))
    return found
