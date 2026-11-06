"""The composition endpoints: today, the diff.

The repository's standing rule is that every operation reachable from the web interface is
also a documented API endpoint, and phase F1 step 6 produced an operation -- comparing two
versions of a composition -- that only existed as a library function. This is that
operation, served.

**It takes the two sources rather than naming two stored versions, because nothing stores a
composition yet.** A repository-wide search finds no model, no table and no route that
persists one: phases F0 and F1 built the language, not its storage. An endpoint shaped
`/compositions/{id}/diff?from=&to=` would therefore have had to invent persistence to have
anything to read, which is a larger piece than this one and belongs with the Studio's own
storage. When that arrives, the stored-version form is an addition here, not a rewrite: the
response body does not change.

So the request carries two Composition2Yaml documents and the response is the typed change
list of ``composition/diff.py`` -- sectioned like the model, with ``renamed`` and ``moved``
among the verdicts. It reads nothing, writes nothing and touches no database; it is a POST
only because it takes two bodies.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..composition.diff import SECTIONS, diff
from ..composition.text import TextError, parse
from ..access.dependencies import get_optional_user
from ..db.models import User

router = APIRouter(prefix="/v1/compositions", tags=["Compositions"])


class CompositionDiffRequest(BaseModel):
    """Two Composition2Yaml documents, as the author writes them."""

    model_config = ConfigDict(extra="forbid")

    before: str = Field(min_length=1, description="The earlier composition, as YAML source.")
    after: str = Field(min_length=1, description="The later composition, as YAML source.")


class CompositionChange(BaseModel):
    """One difference, in the terms the author wrote rather than the ones the package has."""

    model_config = ConfigDict(extra="forbid")

    section: str = Field(description=f"One of: {', '.join(SECTIONS)}.")
    subject: str = Field(description="What the change is about: an id, or an id and a field.")
    kind: str = Field(
        description=(
            "added, removed, changed, renamed or moved. The last two exist so the first "
            "three mean something: without them every rename is a removal plus an addition."
        ),
    )
    was: Any = None
    now: Any = None


class CompositionDiffResponse(BaseModel):
    """What changed, and nothing about how it is rendered."""

    model_config = ConfigDict(extra="forbid")

    identical: bool = Field(
        description=(
            "True when the two compositions are the same model. An empty change list means "
            "this and not that the comparison was shallow: the diff of any package in the "
            "phase F1 gate against itself is empty."
        ),
    )
    changes: list[CompositionChange]
    counts: dict[str, int] = Field(
        description="How many changes each section holds, including the sections with none.",
    )


@router.post(
    "/diff",
    response_model=CompositionDiffResponse,
    operation_id="diffCompositions",
    summary="Compare two compositions",
    responses={422: {"description": "One of the two documents is not a composition."}},
)
async def diff_compositions(
    request: CompositionDiffRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionDiffResponse:
    """Compare two Composition2Yaml documents and return the typed change list.

    Nothing is read from or written to storage, so no account is required: the request
    carries both operands and the response is a pure function of them.
    """
    before = _parse(request.before, "before")
    after = _parse(request.after, "after")
    changes = diff(before, after)
    counts = dict.fromkeys(SECTIONS, 0)
    for change in changes:
        counts[change.section] += 1
    return CompositionDiffResponse(
        identical=not changes,
        changes=[CompositionChange(**change.as_dict()) for change in changes],
        counts=counts,
    )


def _parse(source: str, which: str):
    try:
        return parse(source)
    except TextError as error:
        raise HTTPException(status_code=422, detail=f"{which}: {error}") from error
    except Exception as error:  # a malformed YAML document is the caller's mistake too
        raise HTTPException(
            status_code=422, detail=f"{which}: not a readable composition: {error}",
        ) from error
