"""``create_app`` builds independent applications and opens nothing by itself."""

from __future__ import annotations

import pytest
from fastapi.middleware.cors import CORSMiddleware

from openbinding_gateway import main
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db import base as db_base


def _settings(origin: str):
    return get_settings().model_copy(update={"cors_allow_origins": origin})


def _cors_options(app) -> dict:
    (layer,) = [item for item in app.user_middleware if item.cls is CORSMiddleware]
    return dict(layer.kwargs)


def test_import_exposes_the_module_level_app() -> None:
    assert main.app is not None
    assert main.create_app is not None


def test_two_apps_share_no_state() -> None:
    first = main.create_app(_settings("https://one.example"))
    second = main.create_app(_settings("https://two.example"))

    assert first is not second
    assert first.state is not second.state
    assert first.router is not second.router
    assert first.user_middleware is not second.user_middleware
    assert first.exception_handlers is not second.exception_handlers

    first.state.marker = "one"
    assert not hasattr(second.state, "marker")

    first.dependency_overrides[main.health] = lambda: None
    assert second.dependency_overrides == {}


def test_create_app_respects_the_settings_it_is_given() -> None:
    first = main.create_app(_settings("https://one.example"))
    second = main.create_app(_settings("https://two.example"))

    assert _cors_options(first)["allow_origins"] == ["https://one.example"]
    assert _cors_options(second)["allow_origins"] == ["https://two.example"]


def test_create_app_opens_no_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    import redis.asyncio
    import sqlalchemy
    import sqlalchemy.ext.asyncio as sqlalchemy_asyncio

    opened: list[str] = []

    def detector(name: str):
        def fail(*args, **kwargs):
            opened.append(name)
            raise AssertionError(f"{name} called while building the app")

        return fail

    monkeypatch.setattr(sqlalchemy, "create_engine", detector("create_engine"))
    monkeypatch.setattr(sqlalchemy_asyncio, "create_async_engine", detector("create_async_engine"))
    monkeypatch.setattr(db_base, "create_async_engine", detector("db_base.create_async_engine"), raising=False)
    monkeypatch.setattr(redis.asyncio.Redis, "from_url", detector("Redis.from_url"))
    engine_before = db_base._engine

    main.create_app(_settings("https://one.example"))

    assert opened == []
    assert db_base._engine is engine_before


def test_openapi_matches_the_module_level_app() -> None:
    built = main.create_app(main.settings)

    assert built.openapi() == main.app.openapi()


def test_router_inclusion_order_is_kept() -> None:
    built = main.create_app(main.settings)
    paths = [route.path for route in built.routes if hasattr(route, "path")]

    assert paths[: len(["/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"])] == [
        "/openapi.json",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
    ]
    assert paths[4:7] == ["/health", "/health/live", "/health/ready"]


def test_openapi_is_cached_per_app() -> None:
    built = main.create_app(main.settings)

    assert built.openapi_schema is None
    document = built.openapi()
    assert built.openapi() is document
    assert built.openapi_schema is document
