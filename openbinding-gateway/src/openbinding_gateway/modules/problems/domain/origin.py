"""Where a problem revision came from, as a closed set the problem list can filter on.

An upload may name its ``producer`` (``?producer=``), which a revision keeps as written in its provenance. The
origin is that producer read into one of four words, fixed when the revision is stored.
"""

from __future__ import annotations

from typing import Literal

ProblemOrigin = Literal["upload", "editor", "qacoforge", "sphere"]

#: Every origin; the database checks the column against this list.
ORIGINS: tuple[str, ...] = ("upload", "editor", "qacoforge", "sphere")

#: What the problem editor sends as its producer.
EDITOR_PRODUCER = "openbinding-problem-editor"
#: The producer of a revision generated from SPHERE pricings (``sphere/apply``).
SPHERE_PRODUCER = "openbinding-sphere-import"


def origin_of(producer: str | None) -> ProblemOrigin:
    """The origin of a revision whose upload named ``producer``.

    The problem editor's producer is ``editor``, a SPHERE import's (``sphere/apply``) is ``sphere``, any producer
    starting with ``qacoforge`` is ``qacoforge``, and everything else (no producer, the upload dialog, a script) is
    ``upload``.
    """
    if producer == EDITOR_PRODUCER:
        return "editor"
    if producer == SPHERE_PRODUCER:
        return "sphere"
    if producer and producer.startswith("qacoforge"):
        return "qacoforge"
    return "upload"
