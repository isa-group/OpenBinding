"""What the rest of the gateway reads of execution.

Code outside ``modules/execution`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the routers of ``adapters``.
"""

from ..domain.presets import PresetRef
from ..domain.run_request import STUDY_CELL_KEY_PREFIX, RunRequest
from .presets import PresetNotFound, expand as expand_preset, preset_by_ref, settings_of
from .runs import RunSolutions, run_solutions

__all__ = [
    "STUDY_CELL_KEY_PREFIX",
    "PresetNotFound",
    "PresetRef",
    "RunRequest",
    "RunSolutions",
    "expand_preset",
    "preset_by_ref",
    "run_solutions",
    "settings_of",
]
