"""OpenBinding gateway for the BIM v1 language.

The public language surface is deliberately assembled from the v1 router and
the account routers only.  Source instances are compiled by the v1 pipeline;
there is no second HTTP surface that accepts an earlier document shape.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import space_client
from .access import metering
from .access.dependencies import session_dependency
from .core.settings import get_settings
from .core.logging import configure_logging
from .db import base as db_base
from .db.bootstrap import (
    DEFAULT_ADMIN_USERNAME,
    ensure_administrator,
    seed_default_administrator,
)
from .pricing_catalog import PricingCatalogError
from .routes.admin import router as admin_router
from .routes.artifacts import public_router as public_artifacts_router
from .routes.artifacts import router as artifacts_router
from .routes.auth import router as auth_router
from .routes.cas import identity_router, router as cas_router
from .routes.jobs import router as jobs_router
from .routes.notifications import router as notifications_router
from .routes.organizations import invitation_router, router as organizations_router
from .routes.pricing import admin_router as pricing_admin_router
from .routes.pricing import public_router as pricing_router
from .routes.studies import public_router as public_studies_router
from .routes.studies import router as studies_router
from .routes.users import router as users_router
from .routes.v1 import router as v1_router
from .security.apikeys import (
    ALL_PERMISSIONS,
    ENGINE_LIMITED_PERMISSIONS,
    required_permissions,
)

load_dotenv()

_startup_settings = get_settings()
configure_logging(
    level=_startup_settings.log_level,
    secrets=(
        _startup_settings.gateway_jwt_secret or "",
        _startup_settings.space_api_key or "",
        _startup_settings.space_destructive_api_key or "",
        _startup_settings.sphere_api_key or "",
        _startup_settings.bootstrap_admin_password or "",
        _startup_settings.federation_secret_key or "",
    ),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.database_url:
        db_base.init_engine(settings.database_url)

    async def resolve_catalog(version: str):
        if not settings.database_url:
            raise PricingCatalogError("A database is required to resolve pricing metadata")
        from .pricing_catalog import catalog_for_version

        async with db_base.session_factory()() as catalog_session:
            return await catalog_for_version(catalog_session, settings, version)

    space_client.set_gate(
        space_client.build_gate(
            settings,
            catalog_resolver=resolve_catalog if settings.database_url else None,
        )
    )

    if settings.database_url:
        async with db_base.session_factory()() as session:
            try:
                configured = await ensure_administrator(session, settings)
                if (
                    not configured
                    and settings.app_env != "prod"
                    and await seed_default_administrator(session)
                ):
                    logging.getLogger(__name__).warning(
                        "No administrator existed, so bootstrap account '%s' was created. "
                        "Sign in, create a real administrator, and delete the bootstrap account.",
                        DEFAULT_ADMIN_USERNAME,
                    )
            except PricingCatalogError as error:
                logging.getLogger(__name__).warning(
                    "Account bootstrap is waiting for an active SPHERE pricing: %s",
                    error,
                )
            await session.commit()

    reconciler = None
    if settings.database_url:
        reconciler = asyncio.create_task(
            metering.run_reconciler(space_client.get_gate(), settings=settings)
        )
    try:
        yield
    finally:
        if reconciler is not None:
            reconciler.cancel()
            with suppress(asyncio.CancelledError):
                await reconciler
        gate = space_client.get_gate()
        if hasattr(gate, "aclose"):
            await gate.aclose()
        space_client.set_gate(None)
        await db_base.dispose_engine()


TAGS_METADATA = [
    {"name": "Health", "description": "Whether the gateway is answering."},
    {"name": "BIM v1", "description": "Modular deterministic QoS binding."},
    {"name": "Authentication", "description": "Accounts and sessions."},
    {"name": "Users", "description": "Your account, keys and quotas."},
    {"name": "Administration", "description": "Account administration."},
    {"name": "Organizations", "description": "Nested organizations, members and sponsors."},
    {"name": "Projects", "description": "Collaborative projects and immutable binding cases."},
    {"name": "Studies", "description": "Reproducible comparative studies, reports and publications."},
    {"name": "Artifacts", "description": "Content-addressed artifacts and portable packages."},
    {"name": "Jobs", "description": "Durable job lifecycle, retries and events."},
    {"name": "Notifications", "description": "Account inbox and preferences."},
    {"name": "Explore", "description": "Public projects, publications and immutable resources."},
    {"name": "Pricing", "description": "The public LIVE pricing metadata and compatibility proxy."},
    {"name": "Pricing Administration", "description": "SPHERE and SPACE pricing lifecycle control room."},
]

app = FastAPI(
    title="OpenBinding Gateway",
    version="1.0.0",
    summary="OpenBinding gateway for deterministic BIM v1 QoS binding.",
    description=(
        "OpenBinding validates modular BIM v1 Instance packages, lowers them to a "
        "canonical BindingProblem IR, and reevaluates every returned binding."
    ),
    openapi_tags=TAGS_METADATA,
    license_info={"name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"},
    lifespan=lifespan,
    root_path="/api",
)

_BIM_PATH_PREFIXES = (
    "/v1/profiles",
    "/v1/dialects",
    "/v1/catalog",
    "/v1/schemas",
    "/v1/examples",
    "/v1/engines",
    "/v1/engine-registrations",
    "/v1/resources",
    "/v1/instances",
    "/v1/analyze",
    "/v1/jobs",
)


def _is_bim_request(request: Request) -> bool:
    return any(request.url.path.startswith(prefix) for prefix in _BIM_PATH_PREFIXES)


def _problem_response(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: list[dict] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body: dict = {
        "type": f"https://openbinding.dev/problems/{code}",
        "title": code,
        "status": status_code,
        "detail": detail,
    }
    if diagnostics:
        body["diagnostics"] = diagnostics
    return JSONResponse(
        body,
        status_code=status_code,
        media_type="application/problem+json",
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def bim_request_validation_error(request: Request, exc: RequestValidationError):
    if not _is_bim_request(request):
        from fastapi.exception_handlers import request_validation_exception_handler

        return await request_validation_exception_handler(request, exc)
    diagnostics = [
        {
            "code": error.get("type", "request_validation"),
            "message": error.get("msg", "request validation failed"),
            "pointer": "/" + "/".join(str(part) for part in error.get("loc", ())),
        }
        for error in exc.errors()
    ]
    return _problem_response(422, "request_validation", "Request validation failed", diagnostics)


@app.exception_handler(HTTPException)
async def bim_http_error(request: Request, exc: HTTPException):
    if not _is_bim_request(request):
        from fastapi.exception_handlers import http_exception_handler

        return await http_exception_handler(request, exc)
    detail = exc.detail
    if isinstance(detail, dict):
        code = str(detail.get("code", "request_error"))
        message = str(detail.get("message", code))
        diagnostics = detail.get("diagnostics")
    else:
        code = "request_error"
        message = str(detail)
        diagnostics = None
    return _problem_response(
        exc.status_code,
        code,
        message,
        diagnostics,
        headers=exc.headers,
    )

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=settings.cors_credentials_allowed,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["Health"], operation_id="health", summary="Whether the gateway is up")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/live", tags=["Health"], operation_id="liveness", summary="Process liveness")
async def liveness() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", tags=["Health"], operation_id="readiness", summary="Required dependencies")
async def readiness(
    session: AsyncSession = Depends(session_dependency, scope="function"),
    runtime_settings=Depends(get_settings),
) -> dict:
    dependencies = {"database": "unavailable", "redis": "not-required"}
    try:
        await session.execute(text("SELECT 1"))
        dependencies["database"] = "ok"
        if runtime_settings.job_dispatch_mode == "dramatiq":
            redis = Redis.from_url(runtime_settings.redis_url)
            try:
                await redis.ping()
                dependencies["redis"] = "ok"
            finally:
                await redis.aclose()
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "not_ready", "dependencies": dependencies},
        ) from exc
    dependencies["sphere"] = "configured" if runtime_settings.sphere_enabled else "disabled"
    dependencies["space"] = "configured" if runtime_settings.space_enabled else "disabled"
    return {"status": "ready", "dependencies": dependencies}


app.include_router(v1_router)
app.include_router(auth_router)
app.include_router(cas_router)
app.include_router(users_router)
app.include_router(identity_router)
app.include_router(admin_router)
app.include_router(pricing_router)
app.include_router(pricing_admin_router)
app.include_router(organizations_router)
app.include_router(invitation_router)
app.include_router(studies_router)
app.include_router(public_studies_router)
app.include_router(artifacts_router)
app.include_router(public_artifacts_router)
app.include_router(jobs_router)
app.include_router(notifications_router)


_generated_openapi = app.openapi


def openapi_with_security_contract() -> dict:
    """Add the failures implied by shared auth dependencies in one place."""

    if app.openapi_schema is not None:
        return app.openapi_schema
    document = _generated_openapi()
    problem_schema = {
        "type": "object",
        "required": ["type", "title", "status", "detail"],
        "properties": {
            "type": {"type": "string", "format": "uri-reference"},
            "title": {"type": "string"},
            "status": {"type": "integer"},
            "detail": {"type": "string"},
            "diagnostics": {"type": "array", "items": {"type": "object"}},
        },
    }
    document.setdefault("components", {}).setdefault("schemas", {}).setdefault(
        "ProblemDetails", problem_schema
    )
    document["x-api-key-permissions"] = list(ALL_PERMISSIONS)
    schemas = document["components"]["schemas"]
    schema_root = Path(settings.schemas_dir)
    if not schema_root.is_dir():
        schema_root = Path(__file__).resolve().parents[3] / "schemas"

    def embedded_schema(filename: str, component: str) -> dict:
        value = json.loads((schema_root / "bim" / "v1" / filename).read_text(encoding="utf-8"))

        def rewrite(item):
            if isinstance(item, dict):
                return {
                    key: (
                        f"#/components/schemas/{component}{child[1:]}"
                        if key == "$ref" and isinstance(child, str) and child.startswith("#/")
                        else rewrite(child)
                    )
                    for key, child in item.items()
                }
            if isinstance(item, list):
                return [rewrite(child) for child in item]
            return item

        return rewrite(value)

    schemas["EngineManifest"] = embedded_schema("engine.schema.json", "EngineManifest")
    schemas["EngineRegistrationManifest"] = embedded_schema(
        "engine-registration.schema.json", "EngineRegistrationManifest"
    )
    schemas["InstanceManifest"] = embedded_schema("instance.schema.json", "InstanceManifest")
    schemas["BindingProblem"] = embedded_schema(
        "binding-problem.schema.json", "BindingProblem"
    )
    schemas["ProfileManifest"] = embedded_schema("profile.schema.json", "ProfileManifest")
    schemas["DialectManifest"] = embedded_schema("dialect.schema.json", "DialectManifest")
    digest_schema = {"type": "string", "pattern": "^sha256-[0-9a-f]{64}$"}
    diagnostic_list = {"type": "array", "items": {"type": "object"}}
    digest_map = {"type": "object", "additionalProperties": digest_schema}
    resource_ref_required = ["namespace", "name", "version", "digest"]
    resource_ref_properties = {
        "namespace": {"type": "string"},
        "name": {"type": "string"},
        "version": {"type": "string"},
        "digest": digest_schema,
    }
    schemas["ImmutableResourceRef"] = {
        "type": "object",
        "additionalProperties": False,
        "required": resource_ref_required,
        "properties": resource_ref_properties,
    }
    schemas["EngineRevision"] = {
        "type": "object",
        "required": [*resource_ref_required, "status"],
        "properties": {
            **resource_ref_properties,
            "status": {"type": "string", "enum": ["private", "published"]},
        },
        "additionalProperties": False,
    }
    registration_status = {
        "type": "string",
        "enum": ["private", "pending_review", "published", "rejected"],
    }
    registration_active = {
        "type": "boolean",
        "description": "Whether the owner has enabled this deployment for their own account.",
    }
    schemas["EngineRegistrationRevision"] = {
        "type": "object",
        "required": [*resource_ref_required, "status", "active"],
        "properties": {
            **resource_ref_properties,
            "status": registration_status,
            "active": registration_active,
        },
        "additionalProperties": False,
    }
    schemas["EngineCatalog"] = {
        "type": "object",
        "required": ["engines"],
        "properties": {
            "engines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [*resource_ref_required, "id", "ref", "modes"],
                    "properties": {
                        **resource_ref_properties,
                        "id": {"type": "string"},
                        "ref": {"$ref": "#/components/schemas/ImmutableResourceRef"},
                        "modes": {
                            "type": "array",
                            "items": {
                                "$ref": "#/components/schemas/EngineManifest/$defs/mode"
                            },
                        },
                    },
                    "additionalProperties": False,
                },
            }
        },
    }
    schemas["ProfileCatalogEntry"] = {
        "type": "object",
        "required": [
            "apiVersion",
            "kind",
            "metadata",
            "spec",
            "id",
            "digest",
            "output",
            "protocol",
            "protocolDigest",
        ],
        "properties": {
            "apiVersion": {"const": "bim/v1"},
            "kind": {"const": "Profile"},
            "metadata": {"type": "object"},
            "spec": {"type": "object"},
            "id": {"type": "string"},
            "digest": digest_schema,
            "output": {"type": "object"},
            "protocol": {"const": "bim-engine/v1"},
            "protocolDigest": digest_schema,
        },
        "additionalProperties": False,
    }
    schemas["DialectCatalogEntry"] = {
        "type": "object",
        "required": ["apiVersion", "kind", "metadata", "spec", "digest"],
        "properties": {
            "apiVersion": {"const": "bim/v1"},
            "kind": {"const": "Dialect"},
            "metadata": {"type": "object"},
            "spec": {"type": "object"},
            "digest": digest_schema,
        },
        "additionalProperties": False,
    }
    schemas["ReviewableRevision"] = {
        "type": "object",
        "required": [*resource_ref_required, "status"],
        "properties": {
            **resource_ref_properties,
            "status": {
                "type": "string",
                "enum": ["pending_review", "published"],
            },
        },
        "additionalProperties": False,
    }
    schemas["RegisteredResourceSummary"] = {
        "type": "object",
        "required": [
            *resource_ref_required,
            "role",
            "apiVersion",
            "kind",
            "dialect",
            "mediaType",
            "status",
        ],
        "properties": {
            **resource_ref_properties,
            "role": {"type": "string"},
            "apiVersion": {"type": "string"},
            "kind": {"type": "string"},
            "dialect": {"type": "string"},
            "mediaType": {"type": "string"},
            "status": {"const": "published"},
        },
        "additionalProperties": False,
    }
    schemas["ProfileList"] = {
        "type": "object",
        "required": ["profiles"],
        "properties": {
            "profiles": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/ProfileCatalogEntry"},
            }
        },
        "additionalProperties": False,
    }
    schemas["DialectList"] = {
        "type": "object",
        "required": ["dialects"],
        "properties": {
            "dialects": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/DialectCatalogEntry"},
            }
        },
        "additionalProperties": False,
    }
    schemas["RegisteredResourceList"] = {
        "type": "object",
        "required": ["resources"],
        "properties": {
            "resources": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/RegisteredResourceSummary"},
            }
        },
        "additionalProperties": False,
    }
    schemas["ExampleList"] = {
        "type": "object",
        "required": ["examples"],
        "properties": {
            "examples": {"type": "array", "items": {"type": "string"}}
        },
        "additionalProperties": False,
    }
    schemas["BimCatalog"] = {
        "type": "object",
        "required": ["apiVersion", "profiles", "dialects", "resources", "examples", "engines"],
        "properties": {
            "apiVersion": {"const": "bim/v1"},
            "profiles": schemas["ProfileList"]["properties"]["profiles"],
            "dialects": schemas["DialectList"]["properties"]["dialects"],
            "resources": schemas["RegisteredResourceList"]["properties"]["resources"],
            "examples": schemas["ExampleList"]["properties"]["examples"],
            "engines": schemas["EngineCatalog"]["properties"]["engines"],
        },
        "additionalProperties": False,
    }
    schemas["EngineRegistrationList"] = {
        "type": "object",
        "required": ["registrations"],
        "properties": {
            "registrations": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/EngineRegistrationRevision"},
            }
        },
    }
    schemas["EngineVerificationReport"] = {
        "type": "object",
        "required": ["protocol", "protocolDigest", "status", "checks"],
        "properties": {
            "protocol": {"const": "bim-engine/v1"},
            "protocolDigest": {
                "type": "string",
                "pattern": "^sha256-[0-9a-f]{64}$",
            },
            "status": {"type": "string", "enum": ["pending", "verified", "failed"]},
            "checks": {"type": "array", "items": {"type": "object"}},
            "durationMs": {"type": "number", "minimum": 0},
            "verifiedAt": {"type": "string", "format": "date-time"},
        },
        "additionalProperties": True,
    }
    nullable_digest = {
        "oneOf": [
            {"type": "string", "pattern": "^sha256-[0-9a-f]{64}$"},
            {"type": "null"},
        ]
    }
    schemas["EngineRegistrationReport"] = {
        "type": "object",
        "required": [
            *resource_ref_required,
            "status",
            "active",
            "openapiDigest",
            "openapi",
            "engine",
            "report",
        ],
        "properties": {
            **resource_ref_properties,
            "status": registration_status,
            "active": registration_active,
            "openapiDigest": nullable_digest,
            "openapi": {
                "oneOf": [
                    {
                        "$ref": (
                            "#/components/schemas/EngineRegistrationManifest/"
                            "properties/spec/properties/openapi"
                        )
                    },
                    {"type": "null"},
                ]
            },
            "engine": {
                "oneOf": [
                    {"$ref": "#/components/schemas/EngineManifest"},
                    {"type": "null"},
                ]
            },
            "report": {
                "oneOf": [
                    {"$ref": "#/components/schemas/EngineVerificationReport"},
                    {"type": "null"},
                ]
            },
        },
        "additionalProperties": False,
    }
    schemas["EngineCredentialInput"] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["secret"],
        "properties": {"secret": {"type": "string", "minLength": 1, "writeOnly": True}},
    }
    schemas["SnapshotReference"] = {
        "type": "object",
        "required": ["snapshot"],
        "properties": {"snapshot": {"type": "string", "format": "uuid"}},
        "additionalProperties": False,
    }
    schemas["ValidationResult"] = {
        "type": "object",
        "required": [
            "valid",
            "instanceDigest",
            "packageDigest",
            "fileDigests",
            "resourceDigests",
            "irDigest",
            "diagnostics",
        ],
        "properties": {
            "valid": {"const": True},
            "instanceDigest": digest_schema,
            "packageDigest": digest_schema,
            "fileDigests": digest_map,
            "resourceDigests": digest_map,
            "irDigest": digest_schema,
            "diagnostics": diagnostic_list,
        },
    }
    schemas["EngineCompatibility"] = {
        "type": "object",
        "required": ["engine", "registration", "mode", "compatible", "diagnostics"],
        "properties": {
            "engine": {"$ref": "#/components/schemas/ImmutableResourceRef"},
            "registration": {"$ref": "#/components/schemas/ImmutableResourceRef"},
            "mode": {"type": "string"},
            "compatible": {"type": "boolean"},
            "diagnostics": diagnostic_list,
        },
        "additionalProperties": False,
    }
    schemas["AnalysisResult"] = {
        "type": "object",
        "required": [
            *schemas["ValidationResult"]["required"],
            "analysis",
            "compatibleModes",
        ],
        "properties": {
            **schemas["ValidationResult"]["properties"],
            "analysis": {
                "type": "object",
                "required": ["tasks", "candidates", "constraints", "placement"],
                "properties": {
                    "tasks": {"type": "integer", "minimum": 0},
                    "candidates": {"type": "integer", "minimum": 0},
                    "constraints": {"type": "integer", "minimum": 0},
                    "placement": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
            "compatibleModes": {
                "type": "array",
                "items": {"$ref": "#/components/schemas/EngineCompatibility"},
            },
        },
        "additionalProperties": False,
    }
    schemas["SnapshotCreated"] = {
        "type": "object",
        "required": [
            "id",
            "kind",
            "instanceDigest",
            "packageDigest",
            "irDigest",
            "fileDigests",
            "resourceDigests",
        ],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "kind": {"const": "InstanceSnapshot"},
            "instanceDigest": digest_schema,
            "packageDigest": digest_schema,
            "irDigest": digest_schema,
            "fileDigests": digest_map,
            "resourceDigests": digest_map,
        },
        "additionalProperties": False,
    }
    schemas["SnapshotView"] = {
        "type": "object",
        "required": [*schemas["SnapshotCreated"]["required"], "instance", "createdAt"],
        "properties": {
            **schemas["SnapshotCreated"]["properties"],
            "instance": {"$ref": "#/components/schemas/InstanceManifest"},
            "createdAt": {"type": "string", "format": "date-time"},
        },
        "additionalProperties": False,
    }
    schemas["JobRequest"] = {
        "type": "object",
        "required": ["snapshot"],
        "properties": {
            "snapshot": {"type": "string", "format": "uuid"},
            "engine": {
                "oneOf": [
                    {"type": "string"},
                    {"$ref": "#/components/schemas/ImmutableResourceRef"},
                ]
            },
            "registration": {"$ref": "#/components/schemas/ImmutableResourceRef"},
            "mode": {"type": "string"},
            "options": {"type": "object"},
        },
        "additionalProperties": False,
    }
    schemas["JobAccepted"] = {
        "type": "object",
        "required": ["id", "status", "profile", "irDigest"],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "status": {
                "type": "string",
                "enum": ["queued", "running", "completed", "failed"],
            },
            "profile": {"type": "string"},
            "irDigest": digest_schema,
            "idempotent": {"type": "boolean"},
        },
        "additionalProperties": False,
    }
    schemas["GatewayBindingResult"] = {
        "type": "object",
        "required": ["termination", "solutions"],
        "properties": {
            "termination": {
                "type": "string",
                "enum": ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"],
            },
            "solutions": {"type": "array", "items": {"type": "object"}},
            "provenance": {"type": "object"},
            "error": {"type": "string"},
        },
        "additionalProperties": False,
    }
    schemas["JobView"] = {
        "type": "object",
        "required": ["id", "status", "provenance"],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "status": {
                "type": "string",
                "enum": ["queued", "running", "completed", "failed"],
            },
            "provenance": {"type": "object"},
            "result": {"$ref": "#/components/schemas/GatewayBindingResult"},
        },
        "additionalProperties": False,
    }
    schemas["JobInstanceView"] = {
        "type": "object",
        "required": [
            "id",
            "instanceDigest",
            "packageDigest",
            "fileDigests",
            "resourceDigests",
            "instance",
        ],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "instanceDigest": digest_schema,
            "packageDigest": digest_schema,
            "fileDigests": digest_map,
            "resourceDigests": digest_map,
            "instance": {"$ref": "#/components/schemas/InstanceManifest"},
        },
        "additionalProperties": False,
    }
    schemas["JobReport"] = {
        "type": "object",
        "required": ["id", "gatewayEvaluation", "remote", "provenance"],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "gatewayEvaluation": {
                "type": "object",
                "required": ["termination", "solutions"],
                "properties": {
                    "termination": {
                        "oneOf": [
                            {
                                "type": "string",
                                "enum": ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"],
                            },
                            {"type": "null"},
                        ]
                    },
                    "solutions": {"type": "array", "items": {"type": "object"}},
                },
                "additionalProperties": False,
            },
            "remote": {"type": "object"},
            "provenance": {"type": "object"},
        },
        "additionalProperties": False,
    }

    def refusal(description: str) -> dict:
        return {
            "description": description,
            "content": {
                "application/problem+json": {
                    "schema": {"$ref": "#/components/schemas/ProblemDetails"}
                }
            },
        }

    methods = {"get", "post", "put", "patch", "delete"}
    for path, path_item in document.get("paths", {}).items():
        for method, operation in path_item.items():
            if method not in methods or not operation.get("security"):
                continue
            responses = operation.setdefault("responses", {})
            responses.setdefault("401", refusal("Missing or invalid account credential."))
            responses.setdefault(
                "503", refusal("Account authentication is not configured on this deployment.")
            )
            permissions = sorted(required_permissions(path, method))
            operation["x-required-api-key-permissions"] = permissions
            if set(permissions) & ENGINE_LIMITED_PERMISSIONS:
                operation["x-api-key-engine-access"] = "exact-revision-allow-list-or-all"
            if path == "/v1/engine-registrations" and method == "get":
                operation["x-conditional-api-key-permissions"] = {
                    "review=true": ["engines:moderate"]
                }
            responses.setdefault(
                "403",
                refusal(
                    "The account role, API-key permission, or Engine allow-list does not permit this request."
                ),
            )
            admin_only = (
                path.startswith("/v1/admin/")
                or path.endswith("/approve")
                or path.endswith("/reject")
            )
            if admin_only:
                operation["x-required-role"] = "admin"
                responses.setdefault("403", refusal("An administrator account is required."))

    def json_body(component: str, description: str) -> dict:
        return {
            "required": True,
            "description": description,
            "content": {
                "application/json": {"schema": {"$ref": f"#/components/schemas/{component}"}}
            },
        }

    def json_response(component: str, description: str) -> dict:
        return {
            "description": description,
            "content": {
                "application/json": {"schema": {"$ref": f"#/components/schemas/{component}"}}
            },
        }

    zip_schema = {"type": "string", "format": "binary"}
    zip_media_types = (
        "application/vnd.bim+zip",
        "application/x-bim+zip",
        "application/zip",
        "application/octet-stream",
    )

    def package_body(description: str, *, json_component: str | None = None, multipart: bool = False) -> dict:
        content = {media_type: {"schema": zip_schema} for media_type in zip_media_types}
        if json_component is not None:
            content["application/json"] = {
                "schema": {"$ref": f"#/components/schemas/{json_component}"}
            }
        if multipart:
            content["multipart/form-data"] = {
                "schema": {
                    "type": "object",
                    "required": ["package"],
                    "properties": {"package": zip_schema},
                    "additionalProperties": False,
                }
            }
        return {"required": True, "description": description, "content": content}

    def zip_response(description: str) -> dict:
        return {
            "description": description,
            "headers": {
                "Digest": {
                    "description": "SHA-256 digest of the returned archive.",
                    "schema": {"type": "string"},
                },
                "Content-Disposition": {
                    "description": "Suggested .bim.zip filename.",
                    "schema": {"type": "string"},
                },
            },
            "content": {"application/vnd.bim+zip": {"schema": zip_schema}},
        }

    paths = document["paths"]
    profiles = paths["/v1/profiles"]["get"]
    profiles["responses"]["200"] = json_response("ProfileList", "Installed BIM Profiles.")
    dialects = paths["/v1/dialects"]
    dialects["get"]["responses"]["200"] = json_response(
        "DialectList", "Installed BIM Dialects."
    )
    dialects["post"]["summary"] = "Submit an immutable Dialect revision"
    dialects["post"]["description"] = (
        "Stores the caller-owned revision for administrator approval. Publication records "
        "never install executable adapter code; the adapter must already be deployed."
    )
    dialects["post"]["requestBody"] = json_body(
        "DialectManifest", "Immutable BIM v1 Dialect manifest."
    )
    dialects["post"]["responses"]["201"] = json_response(
        "ReviewableRevision", "Dialect revision awaiting administrator review."
    )
    dialect_approval = paths["/v1/dialects/{name}/approve"]["post"]
    dialect_approval["summary"] = "Approve an installed Dialect revision"
    dialect_approval["responses"]["200"] = json_response(
        "ReviewableRevision", "Published Dialect revision."
    )

    resources = paths["/v1/resources"]
    resources["get"]["responses"]["200"] = json_response(
        "RegisteredResourceList", "Published immutable BIM resources."
    )
    resources["post"]["requestBody"] = {
        "required": True,
        "description": "JSON or XML resource governed by an installed Dialect.",
        "content": {
            "application/json": {"schema": {"type": "object"}},
            "application/xml": {"schema": {"type": "string"}},
            "text/xml": {"schema": {"type": "string"}},
            "application/vnd.omg.bpmn+xml": {"schema": {"type": "string"}},
        },
    }
    resources["post"]["summary"] = "Submit an immutable BIM resource revision"
    resources["post"]["description"] = (
        "Stores JSON or XML source data only; executable adapters are never accepted. "
        "Ordinary users receive pending_review, while administrators may publish directly."
    )
    resources["post"]["responses"]["201"] = json_response(
        "ReviewableRevision", "Stored immutable resource revision."
    )
    resource = paths["/v1/resources/{name}"]["get"]
    resource["responses"]["200"] = {
        "description": "Exact published resource bytes in their registered media type.",
        "headers": {
            "Digest": {
                "description": "SHA-256 digest of the resource.",
                "schema": {"type": "string"},
            }
        },
        "content": {
            "application/json": {"schema": {"type": "object"}},
            "application/xml": {"schema": {"type": "string"}},
            "text/xml": {"schema": {"type": "string"}},
            "application/vnd.omg.bpmn+xml": {"schema": {"type": "string"}},
            "application/*+xml": {"schema": {"type": "string"}},
        },
    }
    resource_approval = paths["/v1/resources/{name}/approve"]["post"]
    resource_approval["summary"] = "Approve a BIM resource revision"
    resource_approval["responses"]["200"] = json_response(
        "ReviewableRevision", "Published immutable resource revision."
    )
    paths["/v1/catalog"]["get"]["responses"]["200"] = json_response(
        "BimCatalog", "Profiles, Dialects, resources, examples and visible Engines."
    )
    paths["/v1/schemas/{kind}"]["get"]["responses"]["200"] = {
        "description": "Requested JSON Schema or the BIM Engine OpenAPI contract.",
        "content": {
            "application/json": {
                "schema": {"type": "object", "additionalProperties": True}
            }
        },
    }
    paths["/v1/pricing"]["get"]["responses"]["200"] = {
        "description": "Pricing2Yaml contract enforced by this deployment.",
        "content": {
            "application/yaml": {"schema": {"type": "string"}}
        },
    }
    examples = paths["/v1/examples"]
    examples["get"]["responses"]["200"] = json_response(
        "ExampleList", "Available BIM example package identifiers."
    )
    paths["/v1/examples/{example_path}"]["get"]["responses"]["200"] = zip_response(
        "Portable BIM example package."
    )

    engines = paths["/v1/engines"]
    engines["get"]["summary"] = "List Engines visible to the authenticated account"
    engines["get"]["description"] = (
        "Returns built-in and published Engines plus the caller's own private revisions. "
        "Private revisions owned by other accounts, including administrators, are never disclosed."
    )
    engines["get"]["responses"]["200"] = json_response("EngineCatalog", "Visible Engine revisions.")
    engines["post"]["summary"] = "Create an immutable private Engine revision"
    engines["post"]["description"] = (
        "Creates a revision owned by the caller. It is private until a related "
        "EngineRegistration publication request is approved."
    )
    engines["post"]["requestBody"] = json_body("EngineManifest", "Portable BIM v1 Engine manifest.")
    engines["post"]["responses"]["201"] = json_response("EngineRevision", "Private Engine revision created.")

    engine = paths["/v1/engines/{name}"]["get"]
    engine["summary"] = "Read one exact visible Engine revision"
    engine["responses"]["200"] = json_response("EngineManifest", "Exact Engine manifest.")

    registrations = paths["/v1/engine-registrations"]
    registrations["post"]["summary"] = "Create an immutable private engine deployment"
    registrations["post"]["description"] = (
        "Stores endpoint details and the complete submitted OpenAPI document privately. "
        "Creation does not notify administrators and the deployment starts inactive."
    )
    registrations["post"]["requestBody"] = json_body(
        "EngineRegistrationManifest", "Deployment, protocol, authentication and pinned OpenAPI contract."
    )
    registrations["post"]["responses"]["201"] = json_response(
        "EngineRegistrationRevision", "Private inactive registration created."
    )
    registrations["get"]["summary"] = "List visible engine deployments"
    registrations["get"]["description"] = (
        "Normally returns the caller's registrations and published registrations. "
        "Administrators may set review=true to receive only explicit publication requests."
    )
    registrations["get"]["responses"]["200"] = json_response(
        "EngineRegistrationList", "Visible registrations."
    )

    registration = paths["/v1/engine-registrations/{name}"]["get"]
    registration["summary"] = "Read one exact visible engine deployment"
    registration["description"] = (
        "Visible only to its owner, to authenticated users after publication, or to an "
        "administrator while this exact revision is pending review."
    )
    registration["responses"]["200"] = json_response(
        "EngineRegistrationManifest", "Exact immutable registration manifest."
    )
    action_summaries = {
        "activate": "Verify and enable a deployment for its owner",
        "deactivate": "Disable a deployment for its owner",
        "publication-request": "Submit a verified deployment for publication review",
        "approve": "Approve a publication request",
        "reject": "Reject a publication request",
    }
    action_descriptions = {
        "activate": (
            "Owner-only. Revalidates the live pinned OpenAPI and response contract, then "
            "enables this deployment for the owner's own account without changing its "
            "publication state."
        ),
        "deactivate": (
            "Owner-only. Disables this deployment for the owner's account; its publication "
            "state and availability to other authenticated users do not change."
        ),
        "publication-request": (
            "Owner-only. Revalidates an active deployment and makes this exact revision "
            "discoverable to administrators for the first time."
        ),
        "approve": (
            "Administrator-only. Revalidates a pending request and publishes its immutable "
            "Engine and deployment to every authenticated account."
        ),
        "reject": (
            "Administrator-only. Removes a pending request from moderation and returns it "
            "to private owner-only visibility."
        ),
    }
    for action, summary in action_summaries.items():
        operation = paths[f"/v1/engine-registrations/{{name}}/{action}"]["post"]
        operation["summary"] = summary
        operation["description"] = action_descriptions[action]
        operation["responses"]["200"] = json_response(
            "EngineRegistrationRevision", "Updated registration lifecycle state."
        )
    report = paths["/v1/engine-registrations/{name}/report"]["get"]
    report["summary"] = "Inspect a visible engine deployment contract"
    report["description"] = (
        "Returns the immutable submitted OpenAPI document, its digest, the exact Engine "
        "manifest and the latest conformance report. It follows the same private, pending-review "
        "and published visibility rules as the registration itself."
    )
    report["responses"]["200"] = json_response(
        "EngineRegistrationReport", "Pinned deployment contract and verification evidence."
    )
    credential = paths["/v1/engine-registrations/{name}/credential"]["put"]
    credential["summary"] = "Replace a private deployment credential"
    credential["requestBody"] = json_body(
        "EngineCredentialInput", "Secret stored encrypted and never returned."
    )
    credential["responses"]["200"] = json_response(
        "EngineRegistrationRevision", "Credential stored; registration is inactive and private."
    )

    validation = paths["/v1/instances/validate"]["post"]
    validation["requestBody"] = package_body(
        "Portable BIM source package to validate without executing an Engine."
    )
    validation["responses"]["200"] = json_response(
        "ValidationResult", "Canonical validation and digest result."
    )
    analysis = paths["/v1/analyze"]["post"]
    analysis["requestBody"] = package_body(
        "Portable BIM source package, or an exact snapshot owned by the caller.",
        json_component="SnapshotReference",
    )
    analysis["responses"]["200"] = json_response(
        "AnalysisResult", "Compiled complexity and exact compatible Engine deployments."
    )
    snapshots = paths["/v1/instances"]
    snapshots["post"]["requestBody"] = package_body(
        "Portable BIM source package to persist privately."
    )
    snapshots["post"]["responses"]["201"] = json_response(
        "SnapshotCreated", "Private immutable Instance snapshot created."
    )
    snapshot = paths["/v1/instances/{snapshot_id}"]["get"]
    snapshot["responses"]["200"] = json_response(
        "SnapshotView", "Exact private Instance snapshot."
    )
    snapshot_source = paths["/v1/instances/{snapshot_id}/source"]["get"]
    snapshot_source["responses"]["200"] = zip_response(
        "Original portable source package for the private snapshot."
    )
    snapshot_ir = paths["/v1/instances/{snapshot_id}/ir"]["get"]
    snapshot_ir["responses"]["200"] = json_response(
        "BindingProblem", "Canonical immutable BindingProblem IR."
    )

    jobs = paths["/v1/jobs"]
    jobs["post"]["requestBody"] = package_body(
        "A BIM package using the default built-in Engine, or a JSON snapshot request that "
        "selects an exact Engine and deployment.",
        json_component="JobRequest",
        multipart=True,
    )
    jobs["post"].setdefault("parameters", []).append(
        {
            "name": "Idempotency-Key",
            "in": "header",
            "required": False,
            "description": "Reuse the first response only when the complete request fingerprint matches.",
            "schema": {"type": "string", "minLength": 1, "maxLength": 255},
        }
    )
    jobs["post"]["responses"]["202"] = json_response(
        "JobAccepted", "Private asynchronous solve accepted."
    )
    job = paths["/v1/jobs/{job_id}"]["get"]
    job["responses"]["200"] = json_response(
        "JobView", "Owned job status, provenance and optional result."
    )
    job_ir = paths["/v1/jobs/{job_id}/ir"]["get"]
    job_ir["responses"]["200"] = json_response(
        "BindingProblem", "Canonical BindingProblem dispatched for the owned job."
    )
    job_instance = paths["/v1/jobs/{job_id}/instance"]["get"]
    job_instance["responses"]["200"] = json_response(
        "JobInstanceView", "Private source Instance snapshot used by the owned job."
    )
    job_report = paths["/v1/jobs/{job_id}/report"]["get"]
    job_report["responses"]["200"] = json_response(
        "JobReport", "Gateway reevaluation, remote provenance and immutable execution pins."
    )

    def add_problem(operation: dict, status_code: int, description: str) -> None:
        operation.setdefault("responses", {})[str(status_code)] = refusal(description)

    for path, path_item in paths.items():
        if not any(path.startswith(prefix) for prefix in _BIM_PATH_PREFIXES):
            continue
        for method, operation in path_item.items():
            if method in methods and "422" in operation.get("responses", {}):
                add_problem(operation, 422, "The request does not satisfy the BIM v1 contract.")

    add_problem(dialects["post"], 403, "The Dialect namespace does not belong to the caller.")
    add_problem(dialects["post"], 409, "The revision is immutable or its adapter is not installed.")
    add_problem(dialects["post"], 413, "The Dialect manifest exceeds the request size limit.")
    add_problem(dialects["post"], 422, "The Dialect manifest is invalid.")
    add_problem(dialect_approval, 404, "The exact Dialect revision does not exist.")
    add_problem(dialect_approval, 409, "The referenced adapter contract is not installed.")
    add_problem(resources["post"], 403, "The resource namespace does not belong to the caller.")
    add_problem(resources["post"], 409, "The immutable identity or Dialect contract conflicts.")
    add_problem(resources["post"], 413, "The resource exceeds the request size limit.")
    add_problem(resources["post"], 415, "The resource media type is not supported.")
    add_problem(resources["post"], 422, "The resource does not satisfy its installed Dialect.")
    add_problem(resource, 404, "The exact published resource does not exist.")
    add_problem(resource_approval, 404, "The exact resource revision does not exist.")
    add_problem(paths["/v1/schemas/{kind}"]["get"], 404, "The requested BIM schema does not exist.")
    add_problem(paths["/v1/pricing"]["get"], 404, "This deployment has no pricing document.")
    add_problem(paths["/v1/examples/{example_path}"]["get"], 404, "The example package does not exist.")
    add_problem(paths["/v1/examples/{example_path}"]["get"], 422, "The installed example package is invalid.")
    add_problem(engines["post"], 403, "The manifest namespace does not belong to the caller.")
    add_problem(engines["post"], 409, "That immutable Engine identity already has different content.")
    add_problem(engines["post"], 413, "The Engine manifest exceeds the request size limit.")
    add_problem(engines["post"], 422, "The Engine manifest is invalid.")
    add_problem(engine, 404, "The exact Engine revision is absent or not visible to the caller.")
    add_problem(registrations["post"], 403, "The registration namespace does not belong to the caller.")
    add_problem(registrations["post"], 409, "An immutable reference or protocol/OpenAPI digest does not match.")
    add_problem(registrations["post"], 413, "The registration exceeds the request size limit.")
    add_problem(registrations["post"], 422, "The registration, endpoint or submitted OpenAPI is invalid.")
    add_problem(registrations["get"], 403, "Only administrators may request the moderation queue.")
    add_problem(registration, 404, "The exact registration is absent or not visible to the caller.")
    add_problem(report, 404, "The exact registration report is absent or not visible to the caller.")
    for action in action_summaries:
        operation = paths[f"/v1/engine-registrations/{{name}}/{action}"]["post"]
        add_problem(operation, 404, "The exact registration is absent or not visible to this actor.")
        add_problem(operation, 409, "The requested lifecycle transition or conformance check failed.")
    add_problem(credential, 404, "The exact private registration is absent or not owned by the caller.")
    add_problem(credential, 409, "Published registration credentials are immutable.")
    add_problem(credential, 413, "The credential request exceeds the request size limit.")
    add_problem(credential, 422, "A non-empty secret is required.")
    for operation in (validation, analysis, snapshots["post"]):
        add_problem(operation, 413, "The BIM source package exceeds the request size limit.")
        add_problem(operation, 415, "The request media type is not a supported BIM package type.")
        add_problem(operation, 422, "The BIM source package or snapshot reference is invalid.")
    add_problem(analysis, 404, "The exact private snapshot does not exist for the caller.")
    for operation in (snapshot, snapshot_source, snapshot_ir):
        add_problem(operation, 404, "The exact private snapshot does not exist for the caller.")
    for operation in (job, job_ir, job_instance, job_report):
        add_problem(operation, 404, "The exact owned job or related artifact does not exist.")
    add_problem(jobs["post"], 404, "A selected snapshot, Engine or deployment is not visible.")
    add_problem(jobs["post"], 409, "An immutable selection or idempotency key conflicts.")
    add_problem(jobs["post"], 413, "The request exceeds the caller or transport size limit.")
    add_problem(jobs["post"], 415, "The request media type is not supported.")
    add_problem(jobs["post"], 422, "The package, selection, mode or options are invalid.")
    add_problem(jobs["post"], 429, "The caller's solve quota or concurrency allowance is exhausted.")
    app.openapi_schema = document
    return document


app.openapi = openapi_with_security_contract
