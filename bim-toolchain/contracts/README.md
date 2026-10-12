# contracts

The machine-readable contracts of the BIM toolchain that are not code.

| Path | What | Written by | Checked by |
| --- | --- | --- | --- |
| `openapi/bim-service.v1.json` | OpenAPI 3.1 document of `bim-service/v1` (every route under `/bim/v1`), generated from the application | `tools/dump_service_openapi.py` | `tools/dump_service_openapi.py --check` (CI) and `packages/bim-service/tests/test_service_openapi.py` |
| `consumers/openbinding/*.json` | The interactions OpenBinding has with BIM, as scripts of HTTP requests with the responses it expects | `tools/consumer_fixtures.py` | `packages/bim-service/tests/test_service_consumers.py` (replayed against the service) and `packages/bim-client/tests/test_equivalence.py` (run through both implementations of the port) |

The OpenAPI document contains nothing that depends on the configuration or on the digests of the installed toolchain,
so it only changes when the API changes. A change to it is a change of the contract: review it as one, and follow
`docs/SERVICE.md` for what is compatible.

## Consumer fixtures

`consumers/openbinding/<name>.json` (`schema: bim-toolchain/consumer-fixture/1`) is a short script of `steps`; each
step has a `request` (`method`, `path`, `body`) and the `expect`ed `status` and `body`. A request may use
`{"$ref": "<step id>#/json/pointer"}` to take a member of what an earlier step answered, typically the IR: no fixture
embeds an IR, because an IR pins the toolchain that made it and the fixtures have to survive a change of
`compilerDigest`.

For the same reason the *expected* body is normalized: `irDigest`, `compilationDigest` and `toolchain` are dropped and
`ir` is reduced to `{apiVersion, kind, semanticDigest}`, the digest of `spec` without `profile`, `dialects`, `instance`
and `sourceMap` (`docs/DIGESTS.md`). A step that compiled records the `compilerDigest` and `irDigest` it saw under a
`toolchain` key, which is informative and never compared.

| Fixture | Interactions |
| --- | --- |
| `compile` | compile and validate a small package; a package with a diagnostic (findings as data in `validate`, 422 in `compile`); bytes that are not a package |
| `compatibility` | an Engine mode that can run the IR, the same with options, one that cannot (with the unsupported capabilities), an unknown mode, an unknown option |
| `optimization` | execution-time optimization: equal and explicit weights, `MULTI` with `pareto-front`, and a selection the mode refuses |
| `evaluate` | one binding, a good and a bad binding with `onError=collect`, the same with `raise`, and the neighbourhood of a binding |
| `reevaluate-agreement` | an engine answer whose numbers are right: the authoritative result repeats them |
| `reevaluate-discrepancy` | an engine answer with invented numbers and an `OPTIMAL` it cannot back: only the binding survives, the termination is lowered to `UNKNOWN` (or kept when the mode is trusted with it) |
| `validate-result` | a valid `bim-engine/v1` result and four ways to be invalid |

The fixtures are written by the first run of `test_the_fixtures_exist_or_are_created` (which fails once to say so) or by
`python tools/consumer_fixtures.py`; delete a file to regenerate it, and review the change. Their requests are also
compared with the scripts in `tools/consumer_fixtures.py`, so editing a fixture by hand is caught.
