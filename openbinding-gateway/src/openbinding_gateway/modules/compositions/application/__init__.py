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
from .language import LanguageRefusal, diff, parse, serialise, validate
from .slots import evaluation_slot, language_slot

__all__ = [
    "STRICTER_THAN_TOOLCHAIN",
    "Assessment",
    "LanguageRefusal",
    "Resolved",
    "assess",
    "composition_by_ref",
    "create_composition",
    "delete_composition",
    "diff",
    "evaluation_slot",
    "language_slot",
    "list_compositions",
    "organization_for",
    "parse",
    "serialise",
    "update_composition",
    "validate",
]
