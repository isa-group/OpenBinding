from __future__ import annotations

import copy

import pytest
from fastapi import HTTPException

from openbinding_gateway.routes import v1 as routes


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("option", "limit_name"),
    [
        ("iterations", "maxIterations"),
        ("max_evaluations", "maxIterations"),
        ("population_size", "maxPopulation"),
        ("archive_size", "maxSolutions"),
        ("time_budget_ms", "maxTimeBudgetMs"),
    ],
)
async def test_v1_option_names_are_bounded_by_their_declared_mode_limit(
    monkeypatch, option: str, limit_name: str
) -> None:
    manifest = copy.deepcopy(routes._manifest("random-search"))
    mode = manifest["spec"]["modes"][0]
    mode["id"] = "bounded"
    mode["optionsSchema"] = {
        "type": "object",
        "properties": {option: {"type": "integer", "minimum": 1}},
        "additionalProperties": False,
    }
    mode["limits"] = {limit_name: 100}

    async def installed_manifest(*_args, **_kwargs):
        return manifest

    monkeypatch.setattr(routes, "_manifest_async", installed_manifest)

    with pytest.raises(HTTPException) as raised:
        await routes._engine_mode("bounded-engine", "bounded", {option: 101})

    assert raised.value.status_code == 422
    assert raised.value.detail["code"] == "option_limit"
    assert raised.value.detail["diagnostics"] == [
        {
            "code": "effective_limit",
            "message": f"option {option!r} exceeds mode limit 100",
        }
    ]
