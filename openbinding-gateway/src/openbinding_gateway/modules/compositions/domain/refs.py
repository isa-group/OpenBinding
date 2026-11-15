"""How a version and a problem revision are named in a composition's routes and documents.

A version is named by its id, its label or its ordinal, tried in that order (plan §2.1). A label is a
Semantic Versioning label, which always has two dots, so an all-digit reference is never a label and an
ordinal is never ambiguous.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from ....composition.ids import MAX_SEMVER_CHARS, SEMVER

#: The largest ordinal a reference may name: beyond it nothing exists, and a database integer would overflow.
MAX_ORDINAL = 2**31 - 1


@dataclass(frozen=True, slots=True)
class VersionRef:
    """A reference to a version: ``kind`` says which column ``value`` is compared with."""

    kind: Literal["id", "label", "ordinal", "none"]
    value: uuid.UUID | str | int | None = None


def version_ref(ref: str) -> VersionRef:
    """What ``ref`` names: a version id, a label (semver) or an ordinal (digits only); ``none`` otherwise."""
    try:
        return VersionRef("id", uuid.UUID(ref))
    except ValueError:
        pass
    if len(ref) <= MAX_SEMVER_CHARS and SEMVER.fullmatch(ref):
        return VersionRef("label", ref)
    if ref.isascii() and ref.isdigit() and not ref.startswith("0"):
        ordinal = int(ref)
        if ordinal <= MAX_ORDINAL:
            return VersionRef("ordinal", ordinal)
    return VersionRef("none")


def problem_ref_text(org_slug: str, problem_slug: str, revision_number: int) -> str:
    """``<organization>/problems/<problem>@<revision>``, as a document links a problem revision."""
    return f"{org_slug}/problems/{problem_slug}@{revision_number}"


__all__ = ["MAX_ORDINAL", "VersionRef", "problem_ref_text", "version_ref"]
