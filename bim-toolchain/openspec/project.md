Status: DRAFT for owner review (2026-10-21)

# Project context — bim-toolchain

## Purpose

The BIM v1 binding language and its toolchain: `bim-core` (library), `bim-service` (HTTP `/bim/v1`), `bim-client`
(`BimPort`). See `INTENT.md` and `constitution.md` in this directory. Future repository: `isa-group/bim-toolchain`
(today a directory of OpenBinding).

## Tech stack

Python ≥ 3.11 (CI matrix 3.11 and 3.12 planned), uv workspace, hatchling builds; `jsonschema`, `lxml`, `pyyaml`
(core); FastAPI, Pydantic 2, uvicorn (service); httpx (client); pytest; ruff. Version 0.2.0; licence CC-BY-4.0.

## Conventions

Same requirement layout as OpenBinding (`../openspec/project.md`): EARS sentence first, OpenFastTrace id
`req~bim-<capability>-<slug>~<rev>` on its own line, `Evidence:` paths relative to this directory, GIVEN/WHEN/THEN
scenarios, `## Out of scope` and `## TODO` in each spec.

## Capabilities

| Capability | Scope |
|---|---|
| `language-compiler` | canonical JSON, safe loading, installed contracts, diagnostics, form-independent IR, toolchain identity, purity |
| `evaluator-protocol` | evaluation, re-evaluation, termination lowering, result validation, protocol digest, compatibility, bounded expressions, neighbourhood |
| `service-api` | `/bim/v1` HTTP service: auth, limits, determinism, problems, OpenAPI |
| `client-port` | `BimPort`, `InProcessBim` ≡ `HttpBim` |
| `schema-versioning` | one version, goldens, frozen baselines, schema parity, reproducible releases, pinned actions |

## Consumers

OpenBinding gateway (fixtures in `contracts/consumers/openbinding/`). Engines consume the IR and protocol only.

## Constraints

No platform concepts; no network in `bim_core`; nothing published without the owner; OMG XSD redistribution undecided.
