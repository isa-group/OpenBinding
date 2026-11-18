"""What the rest of the gateway reads of compositions.

Code outside ``modules/compositions`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the router of ``adapters``.
"""

from .assess import (
    STRICTER_THAN_TOOLCHAIN,
    Assessment,
    Resolved,
    StoredLink,
    assess,
    installed_compilation,
    resolve_link,
)
from .compositions import (
    composition_by_ref,
    create_composition,
    delete_composition,
    matching,
    organization_for,
    update_composition,
)
from .derive import DerivationBug, Derived, derive_version
from .evaluate import Evaluated, Reevaluated, evaluate_binding, neighbourhood, reevaluate
from .fork import Forked, NameTaken, fork_composition
from .language import LanguageRefusal, diff, diff_stored, parse, serialise, validate
from .offering import OfferingOutcome, read_offering, with_offering
from .upstream import resolve_provenance
from .seal import Checked, Sealed, check, insert_derivation, insert_evaluation, judge, persist, seal_into
from .slots import evaluation_slot, language_slot
from .versions import diff_pair, list_versions, required_version, summaries, version_by_ref

__all__ = [
    "OfferingOutcome",
    "resolve_provenance",
    "read_offering",
    "with_offering",
    "STRICTER_THAN_TOOLCHAIN",
    "Assessment",
    "Checked",
    "DerivationBug",
    "Derived",
    "Evaluated",
    "Forked",
    "LanguageRefusal",
    "NameTaken",
    "Reevaluated",
    "Resolved",
    "Sealed",
    "StoredLink",
    "assess",
    "check",
    "composition_by_ref",
    "create_composition",
    "delete_composition",
    "derive_version",
    "diff",
    "diff_pair",
    "diff_stored",
    "evaluate_binding",
    "evaluation_slot",
    "fork_composition",
    "insert_derivation",
    "insert_evaluation",
    "installed_compilation",
    "judge",
    "language_slot",
    "list_versions",
    "matching",
    "neighbourhood",
    "organization_for",
    "parse",
    "persist",
    "reevaluate",
    "required_version",
    "resolve_link",
    "seal_into",
    "serialise",
    "summaries",
    "update_composition",
    "validate",
    "version_by_ref",
]
