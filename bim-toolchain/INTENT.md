Status: DRAFT for owner review (2026-10-21)

# INTENT — bim-toolchain

Owner: Francisco Javier Cavero López (`@javiercavlop`). Owner's document; agents propose edits by PR.
Inferred from `bim-toolchain/` at OpenBinding `spec/platform-baseline` (from `integration/platform` @ 912648c). Guesses are marked `> OPEN QUESTION:`.

## 1. Purpose

Give QoS-aware service binding one precise, extensible, versioned language — BIM v1 — and a toolchain that turns a
package into exactly one canonical, digest-addressed `BindingProblem` IR and judges any engine's answer against it,
identically in process or over HTTP, so that every host and engine shares one semantics.

## 2. Users (consumers)

| Consumer | Uses | Contract |
|---|---|---|
| OpenBinding gateway (primary) | `bim-client` `BimPort` (`InProcessBim` / `HttpBim`) | `contracts/consumers/openbinding/*.json`, `docs/CLIENT.md` |
| Engine authors | the IR schema, the `bim-engine/v1` protocol and conformance kit | `resources/schemas`, `bim_core.conformance` |
| Researchers / tools (QACOBench, generators) | `bim-core` library, `bim-service` | `docs/CONTRACT.md`, `contracts/openapi/bim-service.v1.json` |
| Language authors (Profiles, Dialects) | installed, digest-pinned extension contracts | `docs/BIM_V1.md` in OpenBinding |

## 3. Value

One semantics everywhere (library, service, client), reproducible identities (`compilerDigest`, `irDigest`,
`packageDigest`), untrusted input handled safely in an isolated process, and independent releases.

## 4. Measurable objectives

| Id | Objective | Target | Today |
|---|---|---|---|
| B1 | Semantic stability | 0 unintended changes of semantic digests/evaluations per release (goldens) | goldens enforced |
| B2 | Implementation equivalence | `InProcessBim` ≡ `HttpBim` on 100 % of consumer interactions, corpus and vectors | equivalence battery |
| B3 | Reproducible releases | wheels/sdists bit-identical across two builds | `tools/verify_release.py` |
| B4 | Service footprint | fits **256 MiB** with headroom ≥ **10 %** in process mode | N1 headroom ≈ 1 % (tight) |
| B5 | Latency | p95 compile of a corpus-size package ≤ **1 s** in the lab | not measured |

> OPEN QUESTION: B4 headroom 10 % and B5 1 s are placeholders invented for this draft.

## 5. Non-goals

No accounts, organizations, pricing, persistence, jobs, queues, engine registry or solver execution; no
authorization beyond service tokens; no TLS termination; no network access from `bim_core`; scheduling,
probabilistic QoS and runtime adaptation are outside `qos-binding/v1`.

## 6. Hard constraints

- Private repository `isa-group/bim-toolchain` (owner decision; to be created), licence CC-BY-4.0 for own material.
  OpenBinding pins a release tag and both CIs run the consumer contracts.
  > OPEN QUESTION: redistribution of the five OMG BPMN 2.0.2 XSDs (`docs/OMG_XSD_RIGHTS.md`); the export excludes them by default.
- Python ≥ 3.11; `bim_core` depends only on `jsonschema`, `lxml`, `pyyaml`.
- OpenBinding pins a released version; consumer-contract tests run in both CIs.

## 7. Signals to watch

`compilerDigest` drift, golden diffs, consumer fixture failures, equivalence failures, OpenAPI diffs, memory headroom
of the service profile, the `xfail` of thread mode (B8), pending Action pins (`licenses.json` `action_pins`).

## 8. Decisions that need a CRP

Any semantic change (MAJOR), IR schema or protocol change, removal of a public name, OpenAPI breaking change
(`/bim/v2`), goldens regeneration beyond `toolchain` members, licence/XSD decisions, publishing (repo, tags, wheels,
images), new runtime dependencies, raising service limits.
