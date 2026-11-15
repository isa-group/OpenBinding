"""What the rest of the gateway reads of compositions.

Code outside ``modules/compositions`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the router of ``adapters``.
"""

from .language import LanguageRefusal, diff, parse, serialise, validate
from .slots import evaluation_slot, language_slot

__all__ = [
    "LanguageRefusal",
    "diff",
    "evaluation_slot",
    "language_slot",
    "parse",
    "serialise",
    "validate",
]
