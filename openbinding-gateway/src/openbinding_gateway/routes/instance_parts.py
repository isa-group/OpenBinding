"""Taking an instance apart and putting it back together, over HTTP.

An instance is I' = (M_A, M'_C, Delta, O), and each component of that tuple can
be written as its own file: the same application model over several
infrastructures, the same infrastructure under several objectives. The split is
already what the authoring tools and the bundled examples use; exposing it here
is what lets a client - the Playground, say - show an instance the same way
without reimplementing which key belongs where.

The wire format of solving does not change: ``/v1/solve`` still takes a whole
instance, and ``compose`` is what produces one.
"""

from fastapi import APIRouter, HTTPException, status

from ..models.api import ComposeRequest, ComposeResponse, SplitRequest, SplitResponse
from ..semantics.instance_parts import (
    NORMALIZATION_PART,
    PART_KEYS,
    TUPLE_MODELS,
    PartsError,
    compose,
    split,
)

router = APIRouter(prefix="/v1/instance", tags=["Instance parts"])


def _groups() -> dict:
    """Which model each part belongs to, plus the parts outside the tuple."""
    grouped = {model: list(parts) for model, parts in TUPLE_MODELS.items()}
    claimed = {part for parts in TUPLE_MODELS.values() for part in parts}
    other = [part for part in PART_KEYS if part not in claimed]
    other.append(NORMALIZATION_PART)
    grouped["other"] = other
    return grouped


@router.post("/split", response_model=SplitResponse)
async def split_instance(request: SplitRequest):
    """One instance in, one file's worth of content per component out."""
    try:
        parts = split(request.instance)
    except PartsError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)
        )
    return SplitResponse(parts=parts, groups=_groups())


@router.post("/compose", response_model=ComposeResponse)
async def compose_instance(request: ComposeRequest):
    """The inverse: the parts merged back into the instance they describe.

    A key given by two parts, or given to a part that does not own it, is an
    error rather than a silent overwrite - which is the whole reason the split
    is safe to edit part by part.
    """
    try:
        instance = compose(request.parts)
    except PartsError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)
        )
    return ComposeResponse(instance=instance)
