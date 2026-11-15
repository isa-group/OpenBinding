"""A run request: what ``createRun`` and a study cell launch hand to the job submission.

The HTTP route reads the body (media type, size, fields) into one of these; a study cell builds
one from its pinned engine, mode, options and seed. Nothing here knows about HTTP.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

#: Idempotency keys the gateway writes for study cells; clients cannot claim them.
STUDY_CELL_KEY_PREFIX = "study-cell:"

#: The fields of a run request body, besides nothing else.
REQUEST_FIELDS = frozenset({"revision", "engine", "registration", "mode", "options", "optimization"})

#: The engine a request that names none runs on.
DEFAULT_ENGINE = "random-search"


@dataclass(frozen=True)
class RunRequest:
    """One request to run a problem revision of an organization.

    ``organization_id`` is the organization the run belongs to (the one in the address, or the
    study's); ``revision_id`` names the revision as the client sent it, still unparsed. ``engine``
    is a built-in engine name or an immutable reference; ``registration`` an optional immutable
    reference. ``body_size`` is the size of the request body as read (0 for a study cell).
    """

    organization_id: uuid.UUID
    revision_id: str
    engine: Any = DEFAULT_ENGINE
    registration: Any = None
    mode: Any = None
    options: Any = field(default_factory=dict)
    optimization: Any = None
    idempotency_key: str | None = None
    body_size: int = 0

    def body(self) -> dict[str, Any]:
        """The request as a document: what its idempotency fingerprint is taken over.

        ``registration``, ``mode`` and ``optimization`` appear only when given, so the same
        request reads the same whether a field was left out or sent as null.
        """
        document: dict[str, Any] = {"revision": self.revision_id, "engine": self.engine, "options": self.options}
        for name in ("registration", "mode", "optimization"):
            value = getattr(self, name)
            if value is not None:
                document[name] = value
        return document

    @classmethod
    def from_document(
        cls,
        organization_id: uuid.UUID,
        document: dict[str, Any],
        *,
        idempotency_key: str | None = None,
        body_size: int = 0,
    ) -> "RunRequest":
        """A request out of a body already known to hold only ``REQUEST_FIELDS`` and a ``revision`` string."""
        return cls(
            organization_id=organization_id,
            revision_id=document["revision"],
            engine=document.get("engine", DEFAULT_ENGINE),
            registration=document.get("registration"),
            mode=document.get("mode"),
            options=document.get("options", {}),
            optimization=document.get("optimization"),
            idempotency_key=idempotency_key,
            body_size=body_size,
        )
