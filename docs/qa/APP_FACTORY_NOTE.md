# App factory: import effects that remain

`openbinding_gateway.main.create_app(settings=None)` builds routers, middleware, handlers and lifespan with no
shared state. `app = create_app()` stays at the end of `main.py` for `uvicorn openbinding_gateway.main:app`.
No engine, session, Redis connection or task is created at import or by `create_app`; they start in the lifespan.

Import effects that remain:

- `main.py` (module bottom): `load_environment_file()` reads `OPENBINDING_ENV_FILE` or `./.env` into `os.environ` on import.
- `main.py` (module bottom): `settings = get_settings()` caches the process settings on import; `tests/test_b2_cors.py` reads `main.settings`.
- `main.py` (`create_app`, only when called without settings): `configure_logging()` replaces the root and uvicorn log handlers, so `app = create_app()` does this on import.
- `job_dispatch.py:120`: `_TIME_LIMIT_MS` calls `get_settings()` on import (outside the allowed scope); `main.py` imports it through the routes, before `load_environment_file()` runs, so it sees `.env` values only if they are already in the process environment.
- `security/bodylimit.py:108`: `BodyLimitMiddleware` calls `get_settings()` per request, so an explicit `Settings` given to `create_app` does not set the body limits (outside the allowed scope).
- `main.py` (`readiness`): the dependency uses `Depends(get_settings)`, so an explicit `Settings` does not reach `/health/ready`.
