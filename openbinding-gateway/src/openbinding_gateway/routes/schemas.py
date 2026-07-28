"""Serving the schema files themselves.

Static file delivery, with none of the solving pipeline's concerns, so it
lives apart from the endpoints that do the work.
"""

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..registry.engine import EngineRegistry

router = APIRouter(prefix="/v1/schemas", tags=["Schemas"])


def _schemas_dir() -> str:
    return os.getenv("SCHEMAS_DIR", "/app/schemas")


def _assert_engine_exists(engine_id: str) -> None:
    try:
        EngineRegistry.get_plugin(engine_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_id}' isn't here.")


def _general_schema_path(extension: str) -> str:
    return os.path.join(_schemas_dir(), "general", f"schema.{extension}")


def _specialization_schema_path(engine_id: str, extension: str) -> str:
    return os.path.join(_schemas_dir(), "specializations", f"{engine_id}.schema.{extension}")


@router.get("/general")
async def get_general_schema():
    schema_path = _general_schema_path("json")

    if not os.path.exists(schema_path):
        raise HTTPException(status_code=404, detail="General schema not found on server.")

    return FileResponse(schema_path)


@router.get("/general/model")
async def get_general_schema_model():
    model_path = _general_schema_path("mermaid")

    if not os.path.exists(model_path):
        raise HTTPException(status_code=404, detail="General model not found on server.")

    return FileResponse(model_path, media_type="text/plain; charset=utf-8")


@router.get("/{engine_id}")
async def get_engine_schema(engine_id: str):
    _assert_engine_exists(engine_id)
    schema_path = _specialization_schema_path(engine_id, "json")

    if not os.path.exists(schema_path):
        raise HTTPException(status_code=404, detail=f"No specialized schema for {engine_id}.")

    return FileResponse(schema_path)


@router.get("/{engine_id}/model")
async def get_engine_schema_model(engine_id: str):
    _assert_engine_exists(engine_id)
    model_path = _specialization_schema_path(engine_id, "mermaid")

    if not os.path.exists(model_path):
        raise HTTPException(status_code=404, detail=f"No specialized model for {engine_id}.")

    return FileResponse(model_path, media_type="text/plain; charset=utf-8")
