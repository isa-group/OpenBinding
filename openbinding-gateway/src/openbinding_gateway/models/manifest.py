"""What an engine declares about itself.

Every engine has a manifest, in-tree or federated, and it is the same document
in both cases. An engine that ships with the gateway keeps its manifest as a
file under ``schemas/manifests/``; one registered at runtime keeps it in a
database row. The only structural difference between the two is ``transport``:
an in-tree engine is reached at a configured URL over the contract in
``schemas/engine-contract.openapi.yaml``, so it has nothing to describe, while a
federated engine has to say where it lives and how to speak to it.

That sameness is the point. Capabilities used to be a hand-written dictionary in
each plugin, which meant the gateway had two ways of learning what an engine can
do and no way of noticing when they disagreed. Now there is one, and
``get_capabilities()`` reads it rather than restating it.

The design decision worth defending in the federated half is that a manifest
**describes the third party's API as it is** rather than demanding they
implement ours. Nobody is going to rewrite a working solver's HTTP surface to
get listed here, and asking them to would mean the only federated engines are
the ones written for this gateway - which is precisely the thing federation
exists to avoid. So the manifest carries their OpenAPI document, a mapping from
our two logical operations to theirs by ``operationId``, and JSON Pointers
saying where in their payloads our fields live.

The reason so little is required is worth stating too. ``canonicalize_result_data``
re-derives every metric a solution carries with the reference evaluator, and
``Solution.binding`` is the only field the response model requires. So the
minimum a federated engine must return is a Task -> Candidate map: one pointer,
``response_mapping.binding``. Everything else in the mapping is an optimisation
or a convenience, and an engine that reports nothing but a binding still comes
back with full features, violations and feasibility, computed here.

Validation in this module is deliberately limited to what can be checked
without touching the network: shapes, vocabularies, pointer syntax, and the
interlocks between fields that would otherwise fail confusingly at solve time
(an async engine with no way to poll, an API-key auth with no header to put it
in). Whether the declared operations exist in the document, whether the
instance schema is a genuine restriction, and whether the engine actually
answers are checks that belong to registration, where there is a document to
read and an engine to ask.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Dict, List, Optional

import jsonschema  # type: ignore
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import capabilities as vocab

#: An engine's own name for itself, before it is qualified by its owner.
ENGINE_NAME_PATTERN = r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$"

#: Separates an owner from their engine's name in a qualified id. A tilde
#: because it is unreserved in RFC 3986, so a qualified id needs no escaping in
#: a URL path, and because usernames cannot contain one (see
#: ``accounts.USERNAME_PATTERN``) - which makes the split unambiguous and keeps
#: a federated id from ever colliding with a built-in one.
OWNER_SEPARATOR = "~"


def qualify(owner_username: str, engine_name: str) -> str:
    """The globally addressable id of somebody's engine.

    Two users may both call their engine ``tabu``; only one of them can have
    ``alice~tabu``.
    """
    return f"{owner_username}{OWNER_SEPARATOR}{engine_name}"


def split_qualified(engine_id: str) -> Optional[tuple[str, str]]:
    """``(owner, name)`` for a federated id, or ``None`` for a built-in one."""
    if OWNER_SEPARATOR not in engine_id:
        return None
    owner, _, name = engine_id.partition(OWNER_SEPARATOR)
    if not owner or not name:
        return None
    return owner, name


# -- JSON Pointer -----------------------------------------------------------

#: RFC 6901: the empty string, or one or more "/"-prefixed tokens in which "~"
#: only ever appears as "~0" or "~1".
_POINTER = re.compile(r"^(/([^/~]|~[01])*)*$")


def is_json_pointer(value: str) -> bool:
    return bool(_POINTER.match(value))


def resolve_pointer(document: Any, pointer: str) -> Any:
    """Follow a pointer, returning ``None`` rather than raising when it misses.

    A mapping that does not resolve is a fact about a particular engine
    response, not a programming error: an engine may legitimately omit an
    optional field on some answers. The one mapping that must resolve is
    ``binding``, and its absence is reported where it is used rather than here.
    """
    if pointer == "":
        return document

    current = document
    for raw_token in pointer.lstrip("/").split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                return None
            current = current[token]
        elif isinstance(current, list):
            try:
                index = int(token)
            except ValueError:
                return None
            if index < 0 or index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _validate_pointer(value: str, field: str) -> str:
    if not is_json_pointer(value):
        raise ValueError(
            f"{field} must be a JSON Pointer (RFC 6901): the empty string, or "
            f"tokens each starting with '/'. Got {value!r}."
        )
    return value


# -- The manifest -----------------------------------------------------------


class EngineType(str, Enum):
    """Whether the engine searches exhaustively.

    Not cosmetic: the router answers INFEASIBLE rather than UNKNOWN when an
    EXACT engine returns nothing, so a heuristic claiming EXACT converts "I did
    not find a solution" into "no solution exists".
    """

    EXACT = "EXACT"
    HEURISTIC = "HEURISTIC"


class AuthType(str, Enum):
    NONE = "none"
    BEARER = "bearer"
    API_KEY = "api_key"


class ManifestCapabilities(BaseModel):
    """The same dict ``get_capabilities()`` returns, with a vocabulary.

    Extra keys are allowed: the built-in plugins already add their own
    (``algorithms_supported`` on the evolutionary engine), and the engines
    endpoint passes capabilities through untouched.
    """

    model_config = ConfigDict(extra="allow")

    qos_features_supported: List[str] = Field(
        default_factory=lambda: [vocab.ANY],
        description="QoS feature ids the engine understands, or ['*'] for any.",
    )
    composition_nodes_supported: List[str] = Field(
        ...,
        min_length=1,
        description=(
            "Composition node kinds the engine can handle: TASK, ELEMENT, SEQ, "
            "AND, XOR, LOOP. '*' means all of them."
        ),
    )
    objective_types_supported: List[str] = Field(
        ..., min_length=1, description="MONO, MULTI or MANY. '*' means all of them."
    )
    constraints_supported: List[str] = Field(
        default_factory=list,
        description=(
            "Constraint families the engine enforces: attribute_bound, "
            "dependency, resource_capacity, latency_transition."
        ),
    )
    schema_version: str = Field(
        default="v1", description="Which revision of the general schema the engine reads."
    )

    @field_validator("composition_nodes_supported")
    @classmethod
    def _known_nodes(cls, value: List[str]) -> List[str]:
        if vocab.ANY in value:
            return sorted(vocab.COMPOSITION_NODES)
        offenders = vocab.unknown(value, vocab.COMPOSITION_NODES, upper=True)
        if offenders:
            raise ValueError(
                f"Unknown composition nodes: {', '.join(offenders)}. "
                f"Known: {', '.join(sorted(vocab.COMPOSITION_NODES))}."
            )
        return [vocab.normalise_upper(node) for node in value]

    @field_validator("objective_types_supported")
    @classmethod
    def _known_objectives(cls, value: List[str]) -> List[str]:
        if vocab.ANY in value:
            return sorted(vocab.OBJECTIVE_TYPES)
        offenders = vocab.unknown(value, vocab.OBJECTIVE_TYPES, upper=True)
        if offenders:
            raise ValueError(
                f"Unknown objective types: {', '.join(offenders)}. "
                f"Known: {', '.join(sorted(vocab.OBJECTIVE_TYPES))}."
            )
        return [vocab.normalise_upper(kind) for kind in value]

    @field_validator("constraints_supported")
    @classmethod
    def _known_constraints(cls, value: List[str]) -> List[str]:
        if vocab.ANY in value:
            return sorted(vocab.CONSTRAINT_FAMILIES)
        offenders = vocab.unknown(value, vocab.CONSTRAINT_FAMILIES, upper=False)
        if offenders:
            raise ValueError(
                f"Unknown constraint families: {', '.join(offenders)}. "
                f"Known: {', '.join(sorted(vocab.CONSTRAINT_FAMILIES))}."
            )
        return [vocab.normalise_constraint_family(family) for family in value]


class OpenApiSource(BaseModel):
    """Where the engine's OpenAPI document is.

    Either a URL we fetch or the document itself. Inline is offered because an
    engine behind an authenticating gateway may not serve its own spec
    anonymously, and because it makes a manifest self-contained and therefore
    reviewable.
    """

    model_config = ConfigDict(extra="forbid")

    url: Optional[str] = Field(
        default=None, description="Where to fetch the OpenAPI document from."
    )
    document: Optional[Dict[str, Any]] = Field(
        default=None, description="The OpenAPI document itself, inline."
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "OpenApiSource":
        if (self.url is None) == (self.document is None):
            raise ValueError("Give either transport.openapi.url or transport.openapi.document.")
        return self


class ManifestAuth(BaseModel):
    """How to authenticate to the engine.

    The secret is never part of the manifest. It arrives separately at
    registration and is stored encrypted, so that a manifest can be shown to
    its owner, reviewed by an administrator, or exported, without leaking a
    credential.
    """

    model_config = ConfigDict(extra="forbid")

    type: AuthType = Field(default=AuthType.NONE)
    header: Optional[str] = Field(
        default=None,
        description="Header the secret goes in. Required for api_key; bearer uses Authorization.",
    )

    @model_validator(mode="after")
    def _header_where_one_is_needed(self) -> "ManifestAuth":
        if self.type is AuthType.API_KEY and not self.header:
            raise ValueError("transport.auth.header is required when type is api_key.")
        if self.type is not AuthType.API_KEY and self.header:
            raise ValueError(
                f"transport.auth.header only applies to api_key; {self.type.value} does not use it."
            )
        return self

    @property
    def needs_secret(self) -> bool:
        return self.type is not AuthType.NONE


class OperationRef(BaseModel):
    """One of their operations, named by its id."""

    #: ``populate_by_name`` so the field is writable as either ``operationId``
    #: (what an OpenAPI author types) or ``operation_id`` (what Python reads).
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    operation_id: str = Field(
        ...,
        min_length=1,
        alias="operationId",
        description="The operationId as it appears in their OpenAPI document.",
    )


class ManifestOperations(BaseModel):
    """Our logical operations mapped onto theirs.

    ``solve`` is the only one that must exist. ``job`` is what makes an engine
    asynchronous - an engine that answers in the same response has nothing to
    poll. ``health`` is optional; without it the engine is simply never probed,
    which costs it the liveness dot in the catalogue and nothing else.
    """

    model_config = ConfigDict(extra="forbid")

    solve: OperationRef
    job: Optional[OperationRef] = None
    health: Optional[OperationRef] = None


class RequestMapping(BaseModel):
    """Where our request goes in their body.

    Pointers into the request body being built, so ``/problem`` puts the
    instance under a top-level ``problem`` key. The empty pointer means the body
    *is* the instance.
    """

    model_config = ConfigDict(extra="forbid")

    instance: str = Field(default="/instance")
    options: Optional[str] = Field(default="/options")

    @field_validator("instance", "options")
    @classmethod
    def _pointers(cls, value: Optional[str], info) -> Optional[str]:
        if value is None:
            return None
        return _validate_pointer(value, f"transport.request_mapping.{info.field_name}")


class StatusMapping(BaseModel):
    """Where their job status is, and what their words mean.

    Their vocabulary is theirs: an engine is free to call a finished job
    ``done`` or ``FINISHED`` or ``2``. The map translates into the four states
    the gateway has.
    """

    model_config = ConfigDict(extra="forbid")

    pointer: str
    map: Dict[str, str] = Field(
        default_factory=dict,
        description="Their status value -> queued | running | completed | failed.",
    )

    @field_validator("pointer")
    @classmethod
    def _pointer(cls, value: str) -> str:
        return _validate_pointer(value, "transport.response_mapping.job_status.pointer")

    @field_validator("map")
    @classmethod
    def _known_states(cls, value: Dict[str, str]) -> Dict[str, str]:
        known = {"queued", "running", "completed", "failed"}
        offenders = sorted({v for v in value.values() if str(v).lower() not in known})
        if offenders:
            raise ValueError(
                f"Unknown job states: {', '.join(offenders)}. Known: {', '.join(sorted(known))}."
            )
        return {key: str(state).lower() for key, state in value.items()}


class ResponseMapping(BaseModel):
    """Where our fields are in their response.

    ``solutions`` points at the list in the response body; the remaining
    solution-level pointers are resolved **within each element of that list**,
    which is why ``binding`` is ``/assignment`` and not
    ``/results/0/assignment``.

    Only ``binding`` is required, and that is the whole point of the design:
    everything else a solution carries is recomputed here by the reference
    evaluator, so an engine that reports nothing but which candidate serves
    which task is a complete engine.
    """

    model_config = ConfigDict(extra="forbid")

    solutions: str = Field(
        default="/solutions",
        description="The list of solutions. The empty pointer means the body is the list.",
    )
    binding: str = Field(
        ...,
        description="Within one solution: the Task -> Candidate map. The only required mapping.",
    )
    objective: Optional[str] = Field(
        default=None,
        description="Within one solution: the engine's own objective value, kept for comparison.",
    )
    job_id: Optional[str] = Field(
        default=None, description="For asynchronous engines: their job identifier."
    )
    job_status: Optional[StatusMapping] = Field(
        default=None, description="For asynchronous engines: where the status is."
    )

    @field_validator("solutions", "binding", "objective", "job_id")
    @classmethod
    def _pointers(cls, value: Optional[str], info) -> Optional[str]:
        if value is None:
            return None
        return _validate_pointer(value, f"transport.response_mapping.{info.field_name}")


class ManifestTransport(BaseModel):
    """How to reach the engine and how to speak to it."""

    model_config = ConfigDict(extra="forbid")

    openapi: OpenApiSource
    base_url: Optional[str] = Field(
        default=None,
        description="Overrides the document's servers[]. Required when it declares none.",
    )
    auth: ManifestAuth = Field(default_factory=ManifestAuth)
    operations: ManifestOperations
    request_mapping: RequestMapping = Field(default_factory=RequestMapping)
    response_mapping: ResponseMapping

    @model_validator(mode="after")
    def _asynchrony_is_all_or_nothing(self) -> "ManifestTransport":
        """An engine is asynchronous consistently or not at all.

        Half of it is worse than neither: a ``job`` operation with no
        ``job_id`` mapping means the gateway can poll but never knows what to
        poll for, and a ``job_id`` with no operation means it learns an
        identifier it cannot use. Both fail at solve time, on a real instance,
        with a message about a missing field. Failing here instead costs the
        author one line of feedback at registration.
        """
        polls = self.operations.job is not None
        has_job_id = self.response_mapping.job_id is not None

        if polls and not has_job_id:
            raise ValueError(
                "transport.operations.job is declared, so "
                "transport.response_mapping.job_id must say where the job identifier is."
            )
        if has_job_id and not polls:
            raise ValueError(
                "transport.response_mapping.job_id is declared, so "
                "transport.operations.job must say which operation polls it."
            )
        if self.response_mapping.job_status is not None and not polls:
            raise ValueError(
                "transport.response_mapping.job_status only applies to an asynchronous "
                "engine; declare transport.operations.job as well."
            )
        return self

    @property
    def is_asynchronous(self) -> bool:
        return self.operations.job is not None


class EngineManifest(BaseModel):
    """Everything the gateway needs in order to treat something as an engine."""

    model_config = ConfigDict(extra="forbid")

    manifest_version: str = Field(default="1", description="This document's own version.")
    engine_id: str = Field(
        ...,
        pattern=ENGINE_NAME_PATTERN,
        description=(
            "Lower-case letters, digits and hyphens. A federated engine's is "
            "qualified with its owner's username on registration, so 'tabu' "
            "becomes 'alice~tabu'."
        ),
    )
    display_name: str = Field(..., min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=2000)
    type: EngineType
    capabilities: ManifestCapabilities
    instance_schema: Dict[str, Any] = Field(
        ...,
        description=(
            "A JSON Schema restricting the general schema to the instances this "
            "engine accepts. Stage 2 of validation checks an instance against it."
        ),
    )
    options_schema: Dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "additionalProperties": True},
        description="A JSON Schema for the options the engine accepts.",
    )
    transport: Optional[ManifestTransport] = Field(
        default=None,
        description=(
            "How to reach a federated engine. Absent for an engine that ships "
            "with the gateway, which is reached at a configured URL over the "
            "contract every in-tree engine implements."
        ),
    )

    @field_validator("manifest_version")
    @classmethod
    def _supported_version(cls, value: str) -> str:
        if value != "1":
            raise ValueError(f"Unsupported manifest_version {value!r}; this gateway reads '1'.")
        return value

    @field_validator("instance_schema", "options_schema")
    @classmethod
    def _valid_json_schema(cls, value: Dict[str, Any], info) -> Dict[str, Any]:
        """The schema has to be a schema.

        Checked with the same validator class the pipeline uses, so a manifest
        cannot be accepted here and then fail on every instance later.
        """
        try:
            jsonschema.Draft202012Validator.check_schema(value)
        except jsonschema.SchemaError as error:
            raise ValueError(
                f"{info.field_name} is not a valid JSON Schema: {error.message}"
            ) from error
        return value

    @property
    def is_federated(self) -> bool:
        return self.transport is not None

    def as_capabilities_dict(self) -> Dict[str, Any]:
        """What ``get_capabilities()`` returns for this engine.

        ``type`` is folded in rather than left beside the capabilities because
        that is where the router reads it from when it decides between
        INFEASIBLE and UNKNOWN.
        """
        declared = self.capabilities.model_dump()
        declared["type"] = self.type.value
        return declared

    def default_options(self) -> Dict[str, Any]:
        """The options the gateway sends when the client sends none.

        Read off the options schema rather than declared twice. A property with
        no ``default`` is one the engine is happy to be left alone about; a
        property whose default is ``null`` is one that exists and is unset, and
        the difference matters to engines that filter their options on ``is not
        None``.
        """
        properties = self.options_schema.get("properties")
        if not isinstance(properties, dict):
            return {}
        return {
            name: entry["default"]
            for name, entry in properties.items()
            if isinstance(entry, dict) and "default" in entry
        }
