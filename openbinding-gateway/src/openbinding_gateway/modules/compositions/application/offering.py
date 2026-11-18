"""Reading a composition's offering through the ``PricingSource`` port, and recording the version read with the
evaluation that is being created.

The offering is read when, and only when, an evaluation row will be created for it: on a seal, a derivation that
seals, a fork and a re-evaluation, after the document was assessed (the assessment says which content and basis
the row would have) and before the row is inserted, with no evaluation slot held and no transaction open. A seal of
content that already has an evaluation on the requested basis returns the stored row and reads nothing (the
offering version per evaluation freezes at its first evaluation). ``versions/check``, ``evaluate`` and
``neighborhood`` never read it.

- ``sphere: owner/name`` (the default SPHERE or a registry): ``owner/name`` is resolved to a family
  (``plans.application.resolve_family``: by organization and exact slug, never by display name; two families with
  one name are "ambiguous"), then its latest version (by date) is snapshotted. A private offering uses the
  organization's connection.
- ``url``: an https Pricing2Yaml file through the outbound policy (global addresses only, at most three https
  redirects revalidated, 5 MiB, timeouts), kept as a snapshot of the organization (not fetched again within
  ``OFFERING_URL_MIN_INTERVAL_S``; the same bytes reuse the snapshot).

The content is judged by the normaliser. Nothing commercial invalidates a binding: an unreadable offering is the
warning ``c2y_offering_unreadable``, one that is not a Pricing2Yaml 3.x document ``c2y_offering_invalid_pricing``,
and an alias the deployment does not define stays ``c2y_offering_registry_unknown`` (the language's) with nothing
read. A failure is remembered for 60 s, so repeated seals do not hammer a dead source.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import diagnostics as codes
from ....composition import text
from ....composition.diagnostics import Diagnostic, at
from ....composition.document import Offering
from ....db.models import CompositionEvaluation, CompositionVersion, Organization, User
from ...plans.application import (
    FamilyAmbiguous,
    PricingInvalid,
    PricingNotFound,
    PricingSourceBusy,
    PricingSourceUnavailable,
    SphereEndpoint,
    credential_for,
    get_pricing_source,
    normalised,
    resolve_family,
    snapshot_url,
    snapshot_version,
    sphere_manifest,
)
from .assess import Assessment

logger = logging.getLogger(__name__)
#: The longest one offering read may take, all its requests together.
READ_TIMEOUT_S = 20.0
#: How long a failed read is remembered.
FAILURE_TTL_S = 60.0
_OFFERING = ("offering",)
_REASONS = {
    "timeout": "the source did not answer in time",
    "redirect": "the URL redirects somewhere it may not",
    "address": "the URL's host is not a public address",
    "dns": "the URL's host does not resolve",
    "scheme": "the URL is not https",
    "userinfo": "the URL carries credentials",
    "too_large": "the file is larger than 5 MiB",
    "connect": "the source cannot be reached",
    "encoding": "the source answered an encoded body",
    "unavailable": "the source cannot be read right now",
    "disabled": "SPHERE is not enabled in this deployment",
    "integrity": "the bytes do not match their digest",
}


@dataclass(frozen=True)
class OfferingOutcome:
    """How reading the offering went: ``read`` (with its snapshot), ``unreadable`` or ``invalid_pricing`` (with the
    reason in words), or ``registry_unknown`` (nothing read)."""

    status: str
    snapshot_id: uuid.UUID | None = None
    version_label: str | None = None
    reason: str | None = None


_FAILED: dict[tuple[str, str], tuple[float, OfferingOutcome]] = {}


def _key(organization_id: uuid.UUID, offering: Offering) -> tuple[str, str]:
    return (str(organization_id), f"{offering.registry or ''}|{offering.sphere or ''}|{offering.url or ''}")


def clear_failures() -> None:
    _FAILED.clear()


async def read_offering(
    session: AsyncSession,
    organization_id: uuid.UUID,
    offering: Offering,
    actor_id: uuid.UUID | None,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> OfferingOutcome:
    """Read ``offering`` for ``organization_id`` (see the module docstring); never raises for an unreadable source."""
    key = _key(organization_id, offering)
    remembered = _FAILED.get(key)
    if remembered is not None and remembered[0] > clock():
        return remembered[1]
    if offering.registry is not None and offering.registry not in get_pricing_source().registries():
        return OfferingOutcome("registry_unknown")
    try:
        async with asyncio.timeout(READ_TIMEOUT_S):
            outcome = await _read(session, organization_id, offering, actor_id)
    except TimeoutError:
        outcome = OfferingOutcome("unreadable", reason=_REASONS["timeout"])
    except FamilyAmbiguous as exc:
        outcome = OfferingOutcome("unreadable", reason=f"ambiguous: {len(exc.candidates)} SPHERE pricings have that name")
    except PricingNotFound:
        outcome = OfferingOutcome("unreadable", reason="not found or not visible")
    except PricingSourceBusy as exc:
        outcome = OfferingOutcome("unreadable", reason=f"the source is busy (retry in {exc.retry_after} s)")
    except PricingSourceUnavailable as exc:
        outcome = OfferingOutcome("unreadable", reason=_REASONS.get(exc.reason, exc.reason))
    except PricingInvalid as exc:
        outcome = OfferingOutcome("invalid_pricing", reason=exc.message)
    except Exception:  # noqa: BLE001 - nothing commercial may fail a seal: an unexpected failure is unreadable
        logger.warning("offering_unreadable organization=%s", organization_id, exc_info=True)
        outcome = OfferingOutcome("unreadable", reason="the source could not be read")
    if outcome.status != "read":
        _FAILED[key] = (clock() + FAILURE_TTL_S, outcome)
    return outcome


async def _read(
    session: AsyncSession, organization_id: uuid.UUID, offering: Offering, actor_id: uuid.UUID | None
) -> OfferingOutcome:
    if offering.url is not None:
        taken = await snapshot_url(session, organization_id, offering.url, actor_id=actor_id)
    else:
        assert offering.sphere is not None
        owner, _, slug = offering.sphere.partition("/")
        where = SphereEndpoint(offering.registry)
        credential = await credential_for(session, organization_id) if offering.registry is None else None
        if session.in_transaction():
            await session.commit()
        pricing_id = await resolve_family(session, where, owner, slug, credential)
        manifest = await sphere_manifest(where, pricing_id, credential)
        taken = await snapshot_version(session, organization_id, where, pricing_id, manifest.latest_version_id,
                                       credential, actor_id=actor_id)
    snapshot = taken.snapshot
    if session.in_transaction():
        await session.commit()
    parsed = await normalised(snapshot)
    if parsed.normalised is None:
        reason = parsed.refusal.message if parsed.refusal is not None else "not a Pricing2Yaml 3.x document"
        return OfferingOutcome("invalid_pricing", snapshot.id, snapshot.version_label, reason)
    if not parsed.normalised.valid:
        first = next((d for d in parsed.normalised.diagnostics if d.severity == "error"), None)
        return OfferingOutcome("invalid_pricing", snapshot.id, snapshot.version_label,
                               first.message if first else "the pricing has errors")
    return OfferingOutcome("read", snapshot.id, snapshot.version_label)


def offering_findings(outcome: OfferingOutcome | None) -> tuple[Diagnostic, ...]:
    """The warnings an offering read gives (none for a read one, or for an alias the language already reported)."""
    if outcome is None or outcome.status in ("read", "registry_unknown"):
        return ()
    if outcome.status == "invalid_pricing":
        return (at(_OFFERING, codes.OFFERING_INVALID_PRICING,
                   f"the offering is not a valid Pricing2Yaml pricing ({outcome.reason}); no margins",
                   severity="warning"),)
    return (at(_OFFERING, codes.OFFERING_UNREADABLE, f"the offering cannot be read: {outcome.reason}; no margins",
               severity="warning"),)


async def evaluation_will_be_created(session: AsyncSession, composition_id: uuid.UUID, assessment: Assessment) -> bool:
    """Whether storing ``assessment`` creates an evaluation row (its content, or its basis on that content, is new)."""
    if assessment.evaluation is None:
        return False
    if assessment.content_digest is None:  # a re-evaluation: the caller found no row on this basis
        return True
    version_id = await session.scalar(select(CompositionVersion.id).where(
        CompositionVersion.composition_id == composition_id,
        CompositionVersion.content_digest == assessment.content_digest,
    ))
    if version_id is None:
        return True
    return await session.scalar(select(CompositionEvaluation.id).where(
        CompositionEvaluation.version_id == version_id,
        CompositionEvaluation.basis_key == assessment.evaluation.basis_key,
    )) is None


async def with_offering(
    session: AsyncSession,
    organization: Organization,
    assessment: Assessment,
    actor: User,
    *,
    source: str | None,
    composition_id: uuid.UUID | None = None,
) -> Assessment:
    """``assessment`` with its offering read and recorded on its evaluation draft, when an evaluation row will be
    created for it (``composition_id`` ``None``: a new composition, so always). The warnings are located in
    ``source``, the text the assessment's diagnostics are located in."""
    document, draft = assessment.effective or assessment.document, assessment.evaluation
    if draft is None or document.offering is None:
        return assessment
    if composition_id is not None and not await evaluation_will_be_created(session, composition_id, assessment):
        return assessment
    organization_id, actor_id = organization.id, actor.id
    if session.in_transaction():
        await session.commit()
    outcome = await read_offering(session, organization_id, document.offering, actor_id)
    found = offering_findings(outcome)
    located = tuple(text.located(found, source)) if (found and source) else found
    return replace(
        assessment,
        diagnostics=(*assessment.diagnostics, *located),
        evaluation=replace(
            draft,
            diagnostics=(*draft.diagnostics, *found),
            offering_snapshot_id=outcome.snapshot_id,
            offering_status=outcome.status,
        ),
    )


async def before_seal(
    session: AsyncSession,
    organization: Organization,
    assessment: Assessment,
    actor: User,
    *,
    source: str | None,
    composition_id: uuid.UUID | None = None,
) -> Assessment:
    """The seal pre-phase, outside any transaction and slot: the offering read (when an evaluation row will be
    created) and the snapshots of the versions the binding's hand-written ``from`` pin (``upstream.resolve_provenance``,
    best effort, at most 8 over the network)."""
    from .upstream import provenance_entries, resolve_provenance

    assessment = await with_offering(session, organization, assessment, actor, source=source,
                                     composition_id=composition_id)
    entries = provenance_entries(assessment.effective)
    if entries:
        await resolve_provenance(session, organization.id, entries, actor_id=actor.id)
    return assessment


__all__ = [
    "OfferingOutcome",
    "before_seal",
    "clear_failures",
    "evaluation_will_be_created",
    "offering_findings",
    "read_offering",
    "with_offering",
]
