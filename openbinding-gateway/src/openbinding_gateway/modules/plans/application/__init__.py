"""What the rest of the gateway reads of plans: the entitlement ids of pricing 0.2.0, the per-account quotas,
the reading of Pricing2Yaml pricings and the ``PricingSource`` port (SPHERE, its registries, URLs).

Code outside ``modules/plans`` reaches the module through this package only
(``tests/test_modules_cross_import.py``).
"""

from ..domain import entitlement_map, pricing2yaml, quotas
from ..domain.errors import PricingDiagnostic, PricingError, PricingInvalid
from ..domain.refusal import Refusal
from ..domain.sources import (
    DEFAULT_ENDPOINT,
    SPHERE_ID,
    Credential,
    FamilyIdentity,
    FetchedYaml,
    Manifest,
    ManifestVersion,
    NotModified,
    SearchPage,
    SearchQuery,
    SearchRow,
    SphereEndpoint,
    SphereOrganization,
    SphereUser,
    is_sphere_id,
)
from . import connections
from .connections import credential_for, mark_invalid
from .parsing import ParsedPricing, parse, parse_sync
from .snapshots import (
    Snapshotted,
    account_stored_bytes,
    latest_for,
    normalised,
    read_snapshot,
    readable_scopes,
    snapshot_bytes,
    snapshot_url,
    snapshot_version,
    url_snapshot_bytes,
)
from .pricing_source import (
    CredentialRejected,
    PricingNotFound,
    PricingSource,
    PricingSourceBusy,
    PricingSourceUnavailable,
    VersionRead,
    get_pricing_source,
    installed_pricing_source,
    pricing_source_override,
    read_version,
    set_pricing_source,
)

__all__ = [
    "DEFAULT_ENDPOINT",
    "SPHERE_ID",
    "Credential",
    "CredentialRejected",
    "FamilyIdentity",
    "FetchedYaml",
    "Manifest",
    "ManifestVersion",
    "NotModified",
    "ParsedPricing",
    "PricingDiagnostic",
    "PricingError",
    "PricingInvalid",
    "PricingNotFound",
    "PricingSource",
    "PricingSourceBusy",
    "PricingSourceUnavailable",
    "Refusal",
    "SearchPage",
    "SearchQuery",
    "SearchRow",
    "Snapshotted",
    "SphereEndpoint",
    "SphereOrganization",
    "SphereUser",
    "VersionRead",
    "account_stored_bytes",
    "connections",
    "credential_for",
    "entitlement_map",
    "get_pricing_source",
    "installed_pricing_source",
    "is_sphere_id",
    "latest_for",
    "mark_invalid",
    "normalised",
    "parse",
    "parse_sync",
    "pricing2yaml",
    "pricing_source_override",
    "quotas",
    "read_snapshot",
    "read_version",
    "readable_scopes",
    "set_pricing_source",
    "snapshot_bytes",
    "snapshot_url",
    "snapshot_version",
    "url_snapshot_bytes",
]
