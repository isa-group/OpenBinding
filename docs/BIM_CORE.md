# BIM core

> **Superseded.** The BIM language implementation is being extracted into
> [`bim-toolchain/`](../bim-toolchain/README.md), a self-contained directory that
> will become the private repository `javiercavlop/bim-toolchain` (the remote has
> **not** been created). This page used to describe packaging the compiler *in
> place* from `openbinding_gateway/v1`; that approach is replaced and only
> summarised under [History](#history).

## Current state (transitional)

| Piece | Where | State in this tree |
|---|---|---|
| `bim-core`: package loading, canonical JSON, expressions, compilation, evaluation, re-evaluation, engine protocol, compatibility, conformance kit | `bim-toolchain/packages/bim-core` | **Present.** Its extraction log (`bim-toolchain/docs/EXTRACTION_LOG.md`) records 1014 tests passed and 1 strict xfail with the corpus present; I did not re-run them for this document |
| `bim-service`: HTTP API under `/bim/v1` | planned in `bim-toolchain/` | **Not found** in this tree; not described as available |
| `bim-client`: `BimPort` with `InProcessBim` and `HttpBim` | planned in `bim-toolchain/` | **Not found** in this tree; not described as available |
| OpenBinding consuming the toolchain | — | **Not done.** OpenBinding still compiles and evaluates with its own copy under `openbinding-gateway/src/openbinding_gateway/v1` (`openbinding_gateway/v1` is imported by routes, services and the generator) |

Until the cut-over the two copies coexist. `bim-core` was *copied*, not moved,
and then edited (injected limits instead of environment reads, resources through
`importlib.resources`, typed errors, a public evaluation and protocol API); see
`bim-toolchain/docs/EXTRACTION_LOG.md` for the exact differences and
`bim-toolchain/docs/CONTRACT.md` for the public surface. Because those edits
change the bytes behind `compiler_bundle_digest()`, the two copies do **not**
produce the same toolchain digest; the baseline comparison and the reasons are in
`bim-toolchain/docs/DIGESTS.md`.

The cut-over (OpenBinding depending on the toolchain through the `BimPort`
boundary, regenerating every digest pinned in examples, fixtures and stored
snapshots) is **pending work**. Historical snapshots keep their old exact
contracts and need the old toolchain to be recompiled. No date is promised.

## Boundary (what stays in OpenBinding)

The toolchain does not know accounts, organizations, projects, plans, jobs,
queues, persistence, the artifact library, studies, reports, the resolver or the
HTTP routes. See [ARCHITECTURE.md](ARCHITECTURE.md#the-bim--platform-boundary).
Engine manifests are a platform catalogue; the toolchain only uses four of them
as test fixtures.

`openbinding-gateway/tests/test_bim_core_boundary.py` still checks the in-place
copy's import rule (standard library, `jsonschema`, `lxml` and itself).

## Licence and publication

No licence has been decided; `bim-toolchain/NOTICE.md` says so. Creating the
remote repository or publishing a package to any index requires explicit human
approval and has not happened.

## History

The first approach left every file in `openbinding_gateway/v1` and assembled a
wheel from those paths (`packages/bim-core/pyproject.toml`, hatch `force-include`),
so every digest stayed identical. That wheel was **never built**: the authoring
environment had no shell. The directory `packages/bim-core/` of the repository
root is that older, unverified packaging and is superseded by
`bim-toolchain/packages/bim-core`; it is left in place until the cut-over and
should not be treated as the reference.
