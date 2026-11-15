"""What the rest of the gateway reads of execution.

Code outside ``modules/execution`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the routers of ``adapters``.
"""

from ..domain.run_request import STUDY_CELL_KEY_PREFIX, RunRequest
from .presets import PresetNotFound, expand as expand_preset
from .runs import RunSolutions, run_solutions

__all__ = [
    "STUDY_CELL_KEY_PREFIX",
    "PresetNotFound",
    "RunRequest",
    "RunSolutions",
    "expand_preset",
    "run_solutions",
]
