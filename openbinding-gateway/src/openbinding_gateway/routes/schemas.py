"""Serving the schema files themselves.

Static file delivery, with none of the solving pipeline's concerns, so it
lives apart from the endpoints that do the work.
"""

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..core.settings import get_settings
from ..registry.engine import EngineRegistry
from ..validation.engine_plugins.base import manifests_dir
from ..validation.schema_bundle import load_general_schema

router = APIRouter(prefix="/v1/schemas", tags=["Schemas"])


def _schemas_dir() -> str:
    return get_settings().schemas_dir


def _assert_engine_exists(engine_id: str) -> None:
    try:
        EngineRegistry.get_plugin(engine_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_id}' isn't here.")


def _general_schema_path(extension: str) -> str:
    return os.path.join(_schemas_dir(), "general", f"schema.{extension}")


def _manifest_path(engine_id: str, extension: str) -> str:
    """A file sitting beside an engine's manifest, such as its Mermaid model.

    Resolved through the plugins' own helper rather than from ``schemas_dir``
    directly, so that the drawing is found wherever the manifest is found. Doing
    it separately meant the schema endpoint worked in a checkout and the model
    endpoint next to it returned 404, because only one of the two knew about the
    repository-relative fallback.
    """
    return os.path.join(manifests_dir(), f"{engine_id}.manifest.{extension}")


def _pricing_path() -> str:
    """Where the Pricing2Yaml document lives, across the layouts this runs in.

    The same fallback chain the schemas use: the configured directory is what a
    deployment sets, and the repository-relative path is what local development
    finds.
    """
    configured = os.path.join(os.path.dirname(_schemas_dir()), "space", "pricing", "openbinding.yml")
    if os.path.exists(configured):
        return configured
    return os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../../space/pricing/openbinding.yml")
    )


@router.get(
    "/pricing",
    operation_id="getPricing",
    summary="The pricing this gateway is sold under",
    responses={404: {"description": "This deployment ships no pricing document."}},
)
async def get_pricing():
    """The Pricing2Yaml document, as a document.

    Served rather than bundled into the interface because the plans are part of
    the API's description: a script deciding whether to ask for an upgrade
    should be able to read what the plans are, not screen-scrape a page. It is
    also what the interface renders, so the two cannot disagree.

    Public, because a pricing nobody can read before signing up is not much of
    a pricing.
    """
    path = _pricing_path()
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No pricing document on this server.")

    return FileResponse(path, media_type="application/yaml")


@router.get(
    "/engine-contract",
    operation_id="getEngineContract",
    summary="What a solver engine must implement",
    responses={404: {"description": "This deployment ships no engine contract."}},
)
async def get_engine_contract():
    """The engine-side contract, as an OpenAPI document.

    The other half of the gateway's own description: that one says what a client
    may ask OpenBinding, this says what OpenBinding asks an engine. It existed
    only as prose and as three response shapes implicit in the router until now,
    which is not something a third party can implement against.

    Public, and served rather than only committed, so that whoever is building
    an engine reads the version this gateway actually speaks.
    """
    path = os.path.join(_schemas_dir(), "engine-contract.openapi.yaml")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No engine contract on this server.")

    return FileResponse(path, media_type="application/yaml")


@router.get("/general")
async def get_general_schema():
    """The general schema as one self-contained document.

    The files on disk are split one per element of the tuple so each model can
    be reused on its own; consumers still want a single document, so what is
    served is the bundle, exactly what a monolithic file would have been.
    """
    try:
        return load_general_schema()
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error))


@router.get("/general/model")
async def get_general_schema_model():
    model_path = _general_schema_path("mermaid")

    if not os.path.exists(model_path):
        raise HTTPException(status_code=404, detail="General model not found on server.")

    return FileResponse(model_path, media_type="text/plain; charset=utf-8")


@router.get("/{engine_id}")
async def get_engine_schema(engine_id: str):
    """The instance schema one engine accepts, from its manifest.

    Asked of the engine rather than read off the disk, because the two kinds of
    engine keep their manifest in different places: an engine that ships with
    the gateway has a file, and one registered at runtime has a database row.
    Both answer the same question, so this endpoint asks the question.
    """
    try:
        plugin = EngineRegistry.get_plugin(engine_id)
    except ValueError as error:
        raise HTTPException(
            status_code=404, detail=f"Engine '{engine_id}' isn't here."
        ) from error

    try:
        return plugin.get_instance_schema()
    except (FileNotFoundError, OSError, ValueError) as error:
        raise HTTPException(
            status_code=404, detail=f"No instance schema for {engine_id}."
        ) from error


@router.get("/{engine_id}/model")
async def get_engine_schema_model(engine_id: str):
    """The Mermaid rendering of an engine's instance schema, when there is one.

    Only in-tree engines ship one, so this stays a file lookup. A registered
    engine has no drawing and the interface says so, which is the same thing it
    already does for a built-in engine whose author has not written one.
    """
    _assert_engine_exists(engine_id)
    model_path = _manifest_path(engine_id, "mermaid")

    if not os.path.exists(model_path):
        raise HTTPException(status_code=404, detail=f"No schema model for {engine_id}.")

    return FileResponse(model_path, media_type="text/plain; charset=utf-8")
