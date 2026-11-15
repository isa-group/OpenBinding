"""What the rest of the gateway reads of compositions.

Code outside ``modules/compositions`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the router of ``adapters``.
"""

from .assess import STRICTER_THAN_TOOLCHAIN, Assessment, Resolved, assess
from .compositions import (
    composition_by_ref,
    create_composition,
    delete_composition,
    list_compositions,
    organization_for,
    update_composition,
)
from .fork import Forked, NameTaken, fork_composition
from .language import LanguageRefusal, diff, diff_stored, parse, serialise, validate
from .seal import Checked, Sealed, check, insert_evaluation, judge, persist, seal_into
from .slots import evaluation_slot, language_slot
from .versions import diff_pair, list_versions, required_version, summaries, version_by_ref

__all__ = [
    "STRICTER_THAN_TOOLCHAIN",
    "Assessment",
    "Checked",
    "Forked",
    "LanguageRefusal",
    "NameTaken",
    "Resolved",
    "Sealed",
    "assess",
    "check",
    "composition_by_ref",
    "create_composition",
    "delete_composition",
    "diff",
    "diff_pair",
    "diff_stored",
    "evaluation_slot",
    "fork_composition",
    "insert_evaluation",
    "judge",
    "language_slot",
    "list_compositions",
    "list_versions",
    "organization_for",
    "parse",
    "persist",
    "required_version",
    "seal_into",
    "serialise",
    "summaries",
    "update_composition",
    "validate",
    "version_by_ref",
]
