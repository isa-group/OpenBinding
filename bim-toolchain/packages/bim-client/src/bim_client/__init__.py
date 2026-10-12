"""Client of the BIM toolchain: the :class:`BimPort` interface and its two implementations.

``InProcessBim`` calls ``bim_core``; ``HttpBim`` calls a ``bim-service``.  Both return the same values and
raise the same errors (see ``docs/CLIENT.md``).  Nothing is read from the environment.
"""

from ._version import __version__
from .errors import BimServiceError, exception_from_problem
from .http import HttpBim
from .inprocess import InProcessBim
from .port import BimPort

__all__ = ["BimPort", "BimServiceError", "HttpBim", "InProcessBim", "__version__", "exception_from_problem"]
