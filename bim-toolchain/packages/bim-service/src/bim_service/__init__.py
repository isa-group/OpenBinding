"""HTTP service over ``bim_core``.

Importing this package does not import FastAPI or read the environment; the application is built by
:func:`bim_service.app.create_app` (``uvicorn --factory bim_service.app:create_app``).
"""

from ._version import API_PREFIX, API_VERSION, __version__

__all__ = ["API_PREFIX", "API_VERSION", "__version__"]
