"""A run request: what ``createRun`` and a study cell launch hand to the job submission.

The HTTP route reads the body (media type, size, fields) into one of these; a study cell builds
one from its pinned engine, mode, options and seed. A request may name a run preset of its organization
instead of the settings: the submission expands it (``with_preset``) before anything else reads them.
Nothing here knows about HTTP.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from typing import Any

from .presets import SETTINGS_FIELDS, PresetRef, PresetSettings

#: Idempotency keys the gateway writes for study cells; clients cannot claim them.
STUDY_CELL_KEY_PREFIX = "study-cell:"

#: The fields of a run request body, besides nothing else.
REQUEST_FIELDS = frozenset({"revision", "engine", "registration", "mode", "options", "optimization", "preset"})

#: The engine a request that names none runs on.
DEFAULT_ENGINE = "random-search"


class RunRequestRefused(ValueError):
    """A run request whose fields do not hold together; ``code`` is the refusal's (422)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RunRequest:
    """One request to run a problem revision of an organization.

    ``organization_id`` is the organization the run belongs to (the one in the address, or the
    study's); ``revision_id`` names the revision as the client sent it, still unparsed. ``engine``
    is a built-in engine name or an immutable reference; ``registration`` an optional immutable
    reference. ``body_size`` is the size of the request body as read (0 for a study cell).
    ``compilation_id`` is set by a study cell only: the compilation its run pinned (D7), which the job
    runs instead of the installed toolchain's; ``createRun`` never sets it.

    ``preset_ref`` is the run preset the client named (slug or id), still unresolved, in place of the
    settings; ``preset`` is the preset it resolved to, once ``with_preset`` has copied its settings in.
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
    compilation_id: uuid.UUID | None = None
    preset_ref: str | None = None
    preset: PresetRef | None = None

    def with_preset(self, preset: PresetRef, settings: PresetSettings) -> "RunRequest":
        """This request with the settings of ``preset`` in place, as if the client had sent them."""
        return replace(self, preset=preset, **settings.as_fields())

    def body(self) -> dict[str, Any]:
        """The request as a document: what its idempotency fingerprint is taken over.

        ``registration``, ``mode`` and ``optimization`` appear only when given, so the same
        request reads the same whether a field was left out or sent as null. A request started from a
        preset carries the preset's id next to the settings it expanded: a preset edited between two
        sends of one ``Idempotency-Key`` makes them different requests.
        """
        document: dict[str, Any] = {"revision": self.revision_id, "engine": self.engine, "options": self.options}
        for name in ("registration", "mode", "optimization"):
            value = getattr(self, name)
            if value is not None:
                document[name] = value
        if self.compilation_id is not None:
            document["compilation"] = str(self.compilation_id)
        if self.preset is not None:
            document["preset"] = str(self.preset.id)
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
        """A request out of a body already known to hold only ``REQUEST_FIELDS`` and a ``revision`` string.

        ``RunRequestRefused``: ``preset`` beside any of the settings it holds (``preset_with_settings``), or a
        ``preset`` that is not a slug or id (``invalid_request_fields``).
        """
        if "preset" in document:
            preset = document["preset"]
            if not isinstance(preset, str) or not preset:
                raise RunRequestRefused(
                    "invalid_request_fields", "preset names a run preset of the organization by slug or id."
                )
            given = [name for name in SETTINGS_FIELDS if name in document]
            if given:
                raise RunRequestRefused(
                    "preset_with_settings",
                    f"A run started from a preset takes its settings from it; drop {', '.join(given)} or the preset.",
                )
            return cls(
                organization_id=organization_id,
                revision_id=document["revision"],
                preset_ref=preset,
                idempotency_key=idempotency_key,
                body_size=body_size,
            )
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
