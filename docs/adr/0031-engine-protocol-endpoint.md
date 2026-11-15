# 0031. `GET /v1/engines/protocol` replaces `/v1/profiles`

- Status: accepted
- Date: 2026-11-14 (F0b, decision D12 of the F0b implementation plan)

## Context

F0b removed the raw BIM API, `/v1/profiles` with it. Federated engine registration still needs the protocol digest
and the capability vocabulary at runtime, anonymously.

## Decision

`GET /v1/engines/protocol` returns the same payload `/v1/profiles` did. It is declared in `routes/v1.py` before
`/v1/engines/{name}`, so the engine route cannot capture it, and it is open to anonymous callers.

## Consequences

- Registering a federated engine (manifests, credentials, activation, publication moderation) works as before.
- The registration screen and Home read the profiles from it.

Where: `routes/v1.py`, `tests/test_engine_protocol_route.py`.
