"""What the rest of the gateway reads of plans: the entitlement ids of pricing 0.2.0, the per-account quotas,
the reading of Pricing2Yaml pricings and the ``PricingSource`` port (SPHERE, its registries, URLs).

Code outside ``modules/plans`` reaches the module through this package only
(``tests/test_modules_cross_import.py``).
"""

from ..domain import entitlement_map, pricing2yaml, quotas
from ..domain.errors import PricingDiagnostic, PricingError, PricingInvalid
from ..domain.money import (
    MAX_AMOUNT,
    AmountOutOfRange,
    exact,
    in_range,
    money_context,
    money_str,
    quantize6,
)
from ..domain.pricing2yaml.units import month_factor
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
from . import connections, discovery
from .discovery import FamilyAmbiguous, resolve_family
from .discovery import manifest as sphere_manifest
from .own_pricing import OwnPricing, OwnPricingUnavailable, own_pricing
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
    "MAX_AMOUNT",
    "AmountOutOfRange",
    "DEFAULT_ENDPOINT",
    "SPHERE_ID",
    "Credential",
    "FamilyAmbiguous",
    "CredentialRejected",
    "FamilyIdentity",
    "FetchedYaml",
    "Manifest",
    "ManifestVersion",
    "NotModified",
    "OwnPricing",
    "OwnPricingUnavailable",
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
    "discovery",
    "entitlement_map",
    "exact",
    "in_range",
    "get_pricing_source",
    "installed_pricing_source",
    "is_sphere_id",
    "latest_for",
    "mark_invalid",
    "money_context",
    "money_str",
    "month_factor",
    "normalised",
    "own_pricing",
    "parse",
    "parse_sync",
    "pricing2yaml",
    "pricing_source_override",
    "quantize6",
    "quotas",
    "read_snapshot",
    "read_version",
    "readable_scopes",
    "resolve_family",
    "set_pricing_source",
    "snapshot_bytes",
    "snapshot_url",
    "snapshot_version",
    "sphere_manifest",
    "url_snapshot_bytes",
]
