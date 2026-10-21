Status: DRAFT for owner review (2026-10-21)

# AGENTS.md — operating guide for agents working on bim-toolchain

This directory is the future root of the private repository `isa-group/bim-toolchain` (still inside OpenBinding at
`bim-toolchain/`). Read `INTENT.md`, `constitution.md`, `REVIEW.md` and `openspec/specs/` here before changing
anything. While it lives inside OpenBinding, the OpenBinding branch and commit rules apply (`../CONTRIBUTING.md`).

## What this is

BIM is a **service-composition and binding language** (not Building Information Modeling). A BIM package (JSON and
BPMN documents) describes an application workflow, candidate services, constraints and an optimization; the compiler
lowers it to a canonical, digest-addressed `BindingProblem` IR that solver engines consume.

| Package | What | Entry points |
|---|---|---|
| `packages/bim-core` | the language: load, compile, canonical JSON/digests, evaluate, re-evaluate, engine protocol, compatibility, neighbourhood, conformance kit | `bim_core.__all__` (43 names), `docs/CONTRACT.md` |
| `packages/bim-service` | stateless FastAPI service under `/bim/v1` with bearer-token auth, limits, worker pool | `bim_service.app:create_app`, `docs/SERVICE.md` |
| `packages/bim-client` | `BimPort` with `InProcessBim` and `HttpBim` (must be equivalent) | `bim_client`, `docs/CLIENT.md` |
| `contracts/` | `openapi/bim-service.v1.json` (generated), `consumers/openbinding/*.json` (consumer fixtures) | `contracts/README.md` |
| `golden/` | frozen and normalized baselines, synthetic golden, vectors | `docs/DIGESTS.md`, `docs/GOLDEN_METADATA.md` |
| `tools/` | baseline, OpenAPI dump, consumer fixtures, release verification, export | `README.md` |

Python ≥ 3.11; dependencies `jsonschema`, `lxml`, `pyyaml` (core), `fastapi`, `pydantic`, `uvicorn` (service),
`httpx` (client); version 0.2.0 for all three distributions; licence CC-BY-4.0 (OMG XSDs excluded, see `NOTICE.md`).

## Commands (from `bim-toolchain/`)

```bash
# all suites in one session (needs jsonschema, lxml, pyyaml, fastapi, pydantic, httpx, pytest, and uv for tools/)
PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src \
  python -m pytest --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools
# without the OpenBinding corpus (exported repository)
PYTHONPATH=... python -m pytest --rootdir=. -m 'not openbinding_corpus' -rs packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools
# contracts and goldens
PYTHONPATH=packages/bim-core/src python tools/baseline_core.py --check
PYTHONPATH=packages/bim-core/src:packages/bim-service/src python tools/dump_service_openapi.py --check
PYTHONPATH=packages/bim-core/src:packages/bim-service/src python tools/consumer_fixtures.py --check
python tools/verify_release.py            # two reproducible builds, clean venv smoke, digests (add --skip-corpus without corpus)
ruff check packages tools
# run the service (refuses to start without a valid tokens file)
BIM_SERVICE_TOKENS_FILE=/run/secrets/bim_tokens PYTHONPATH=packages/bim-core/src:packages/bim-service/src \
  uvicorn --factory bim_service.app:create_app --port 8080
```

From OpenBinding, the consumer side is `openbinding-gateway/tests/test_bim_consumer_contract.py`,
`test_bim_boundary.py`, `test_bim_port_host.py` and `test_bim_schema_parity.py`; run them whenever a contract here changes.

## Conventions

- Requirements: EARS + OpenFastTrace ids `req~bim-<capability>-<slug>~<rev>` in `openspec/specs/`.
- `bim_core` reads no environment variables, never locates itself in a repository, reaches resources only through
  `importlib.resources`, and imports nothing of the platform (`packages/bim-core/tests/test_boundary.py`).
- Errors are a closed hierarchy (`BimError` → `PackageError`, `CompileError`, `ContractError`, `EvaluationError`,
  `ProtocolError`, …) with stable `code`s; hosts map codes, never messages.
- Any change under `packages/bim-core/src` changes `compilerDigest`; record it in `CHANGELOG.md` and refresh the
  `toolchain` members of the goldens (`tools/regen_normalized_metadata.py --write`), never the semantic members.
- Evidence honesty: report only executed checks with the SHA; otherwise `NOT EXECUTED`.

## Do / Don't

Do: write the failing test first; keep `InProcessBim` and `HttpBim` equivalent (extend `test_equivalence.py`); keep
fixtures free of embedded IR; keep the OpenAPI document generated and committed.

Don't: change semantics, digests, goldens or the IR schema without a CRP and a version bump (`constitution.md`);
introduce platform concepts (accounts, jobs, pricing, persistence); edit `golden/bim_baseline/` (frozen); publish,
tag, push or create repositories; commit the OpenBinding corpus or datasets; add network access to `bim_core`.
