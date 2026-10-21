Status: DRAFT for owner review (2026-10-21)

# ADR-0013: The committed OpenAPI snapshot is the HTTP contract

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner

## Decision

`docs/openapi.json` is generated from the FastAPI app by `openbinding-gateway/tools/dump_openapi.py` and committed;
CI fails if it is stale (`--check`). Contract changes are therefore visible and reviewed in the diff. Operation ids,
tags, summaries, security requirements and error shapes are checked by tests.

## Evidence

`openbinding-gateway/tools/dump_openapi.py`, `.github/workflows/ci.yml`, `openbinding-gateway/tests/test_openapi_contract.py`.
