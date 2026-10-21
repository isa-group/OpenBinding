Status: DRAFT for owner review (2026-10-21)

# Constitution — bim-toolchain

Non-negotiable rules for the BIM language and its three distributions. Only the owner amends them. Articles 1–3 and
14 of OpenBinding's `constitution.md` (spec first, test first, traceability, flow) apply here unchanged.

## Article 1 — One version, three distributions

1.1 `bim-core`, `bim-service` and `bim-client` MUST share one version `MAJOR.MINOR.PATCH` and be released together
(`version` in each `pyproject.toml` and `_version.py`; a test fails if they differ).
1.2 Dependents MUST declare `bim-core` as a plain range (`>=0.x,<0.y`), never a path.

## Article 2 — Semantic versioning of the language

2.1 PATCH: no valid package changes meaning; semantic digests, evaluations, diagnostic codes and locations in the
goldens are identical.
2.2 MINOR: backward-compatible additions (public API, accepted constructs, new diagnostics for what was invalid,
OpenAPI only gains); every package that compiled keeps its semantic digest and evaluations.
2.3 MAJOR: anything else — a valid package changes digest or evaluation or is rejected; an incompatible change of the
IR schema, the engine protocol or the HTTP API; a removed public name. Before 1.0 the MINOR number marks MAJOR changes.
2.4 A MAJOR change MUST keep the previous golden as a frozen fixture, record the new baseline next to it, state why in
`CHANGELOG.md` and `docs/DIGESTS.md`, and go through a CRP.

## Article 3 — Digests and identity

3.1 `compilerDigest` covers every `.py` file and all resources of `bim_core`; an IR is valid only for the toolchain that
produced it, and the toolchain MUST refuse an IR of another toolchain (`contract_not_installed`).
3.2 Equal canonical packages MUST compile to byte-identical IR in every form (directory, raw ZIP, canonical ZIP,
member permutations).
3.3 Canonical JSON is RFC 8785; non-finite numbers are not JSON.
3.4 Goldens MUST NOT be regenerated to silence a failure; only `toolchain` metadata members may be refreshed by the tool.

## Article 4 — Consumer contracts

4.1 The `bim-service` HTTP API is versioned in its path (`/bim/v1`); within v1 changes are additive only; removing or
changing a member requires `/bim/v2`.
4.2 `contracts/openapi/bim-service.v1.json` MUST be the generated document (`dump_service_openapi.py --check`).
4.3 Consumer fixtures (`contracts/consumers/<consumer>/`) MUST be replayed in this repository's CI and in the
consumer's CI; a fixture change is a contract change.
4.4 `InProcessBim` and `HttpBim` MUST return the same values and raise the same errors for every port method.
4.5 Errors MUST carry stable `code`s; consumers map codes, never message text.

## Article 5 — Purity and boundary

5.1 `bim_core` MUST NOT read the environment, locate itself in a repository, access the network, or import platform
code; resources are reached only through `importlib.resources`.
5.2 No platform concepts (accounts, organizations, jobs, pricing, persistence) in any package.
5.3 `bim-service` is stateless: every answer is a pure function of the request and the installed toolchain.

## Article 6 — Security of untrusted input

6.1 Packages and XML MUST be parsed with bounded sizes, entry counts, ratios and depth, no DTD/external entities,
duplicate JSON names refused, symlinks refused; BPMN validated offline against the vendored OMG schema.
6.2 Expressions MUST be bounded (integer size, power, products) so hostile inputs fail in bounded time.
6.3 The service MUST refuse to start without a valid tokens file (anonymous only with the explicit development flag),
compare tokens in constant time, never log tokens or package content, and decide 401/413 before reading a body.

## Article 7 — Releases and supply chain

7.1 Releases MUST be reproducible bit for bit (`tools/verify_release.py`) and smoke-tested from a clean venv.
7.2 GitHub Actions MUST be pinned by commit SHA before the first CI run (`licenses.json` `action_pins`).
7.3 Third-party material keeps its notices; nothing whose redistribution is not demonstrated is exported.
7.4 Nothing is published (repository, tag, wheel, image) without the owner's order.
