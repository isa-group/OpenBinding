"""TomatoMeter as the lab seeds it, for the F6 tests (not a test module).

``seeded`` makes, over the recorded SPHERE, a member's organization with the template-made TomatoMeter 1.0.0 (Brevo
PROFESSIONAL, Dropbox PLUS, ZenQuotes, offering ``sphere/tomatometer``) and 1.1.0 (the e-mail provider switched to
Resend PRO, derived from revision 3 as ``tools/seed_lab.py`` does), and, when asked, ``production`` adopting 1.0.0
with 1000 expected users.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from openbinding_gateway.db.models import (
    BindingCaseRevision,
    Composition,
    CompositionDerivation,
    CompositionEnvironment,
    CompositionVersion,
    Organization,
    OrganizationRole,
    User,
)
from openbinding_gateway.core import revision as etags
from openbinding_gateway.modules.compositions.application import adoption, derive_version, persist, templates
from openbinding_gateway.modules.compositions.application.offering import before_seal
from problems._sphere_helpers import member

BREVO = "6ade2d4440e55445692b07f1"
BREVO_2026_10 = "6ade2d444b2b5b01c587d80d"
DROPBOX = "6ab0a323697330667ccce9c1"
RESEND = "6ade2d2540e55445692b07c6"
TOMATOMETER = "6ab0a323697330667ccce8cd"


@dataclass
class Seeded:
    headers: dict
    org: str
    organization: Organization
    user: User
    composition: Composition
    v100: CompositionVersion
    v110: CompositionVersion
    revision: BindingCaseRevision
    production: CompositionEnvironment | None = None


async def derive_and_seal(session, organization, composition, user, label: str, binding: dict, revision: int,
                          offering=None) -> CompositionVersion:
    spec = templates.template("tomatometer").composition
    derived = await derive_version(
        session, organization, composition, caller=user, label=label,
        offering=spec["offering"] if offering is None else offering,
        revision=f"tomatometer-email@{revision}", binding={**spec["binding"], **binding},
    )
    assessment = await before_seal(session, organization, derived.assessment, user, source=derived.content,
                                   composition_id=composition.id)
    sealed = await persist(session, composition, assessment, actor=user, derivation=derived.derivation)
    return sealed.version


async def seeded(api_client, registration, db_session, gate, *, production: bool = True) -> Seeded:
    headers, org, organization, user = await member(api_client, registration, db_session, gate)
    made = await templates.instantiate(db_session, organization, user, "tomatometer", slug="tomatometer")
    composition = made.composition
    v100 = made.sealed.version
    derivation = await db_session.scalar(select(CompositionDerivation).where(CompositionDerivation.version_id == v100.id))
    revision = await db_session.get(BindingCaseRevision, derivation.revision_id)
    v110 = await derive_and_seal(db_session, organization, composition, user, "1.1.0",
                                 {"dailySummary": "email.resend.pro"}, revision.revision)
    found = Seeded(headers, org, organization, user, composition, v100, v110, revision)
    if production:
        environment = CompositionEnvironment(
            organization_id=organization.id, composition_id=composition.id, slug="production", name="Production",
            created_by_id=user.id, operator_id=user.id, adopt_role="MEMBER", expected_users=1000,
        )
        db_session.add(environment)
        await db_session.commit()
        await adoption.adopt(
            db_session, organization=organization, composition=composition, environment=environment,
            role=OrganizationRole.OWNER, version_ref="1.0.0", actor=user, if_match=etags.etag_for(environment),
        )
        await db_session.commit()
        found.production = await db_session.get(CompositionEnvironment, environment.id)
    return found
