"""What the rest of the gateway reads of execution.

Code outside ``modules/execution`` reaches the module through this package only
(``tests/test_modules_skeleton.py``); the composition root mounts the router of ``adapters``.
"""

from ..domain.run_request import STUDY_CELL_KEY_PREFIX, RunRequest
from .runs import RunSolutions, run_solutions

__all__ = ["STUDY_CELL_KEY_PREFIX", "RunRequest", "RunSolutions", "run_solutions"]
