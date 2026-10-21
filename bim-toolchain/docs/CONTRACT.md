# Contract of bim-core 0.2.0

What `bim_core` offers to a host such as OpenBinding, and what it does not.

## Public surface

Everything in `bim_core.__all__`:

| Group | Names |
| --- | --- |
| Load and compile | `load_package`, `InstancePackage`, `compile_instance`, `BindingProblem`, `CompileDiagnostic` |
| Canonical JSON | `canonical_json`, `digest`, `digest_bytes` |
| Integrity | `BindingProblem.from_document`, `ir_digest`, `compilation_digest`, `compiler_bundle_digest` |
| Identity | `toolchain_identity()`, `__version__` |
| Settings | `Limits`, `configure`, `default_limits` |
| Errors | `BimError`, `PackageError`, `CompileError`, `EvaluationError`, `ProtocolError`, `ContractError`, `ExpressionError`, `CanonicalizationError` |
| Host helpers (formerly private) | `schema_root`, `dialect_type_matches`, `dialect_xml_type_matches`, `resource_schema_diagnostics`, `dialect_descriptor`, `profile_descriptor` |
| Evaluate | `evaluate`, `evaluate_many`, `validate_binding` (module `bim_core.evaluator`, which also has `evaluate_features`, `evaluate_violations`, `evaluate_objectives`) |
| Re-evaluate | `reevaluate_result` (module `bim_core.reevaluate`, which also has `candidate_ref`, `binding_violations`, `authoritative_evaluation`) |
| Engine protocol | `validate_result`, `protocol_document`, `protocol_digest` (module `bim_core.protocol`, which also has `validate_job_receipt`, `validate_job`, `is_termination`, `contains_non_finite`) |
| Compatibility | `mode_compatibility`, `ir_features`, `engine_contract_diagnostics`, `resolve_optimization` (module `bim_core.compat`, which also has `candidate_count`, `schema_diagnostics`, `select_mode`, `validate_options`, `resolve_engine_mode`, `engine_ref`, `selector_values`, `mode_execution_contract`, `persisted_mode_contract`, `embedded_secret_paths`) |
| Analysis | `analyze_neighborhood` (module `bim_core.neighborhood`) |
| Conformance kit | `openapi_diagnostics` (module `bim_core.conformance`, which also has `schema_semantics`, `assert_operation_auth`, `assert_protocol_schema`, `operation_schema`, `conformance_mode`, `conformance_shape`, `conformance_problem`, `conformance_options`, `conformance_optimization`, `assert_conformance_result`) |

`bim_core.__all__` lists 43 names; the functions of the modules above that are not in `__all__` are public by
name and stable within a MINOR series, like the compiler helpers below.

### Evaluation

`BindingProblem` keeps the evaluation semantics (`validate_binding`, `evaluate_binding`, `evaluate_constraints`,
`evaluate_objectives`, `evaluate`): they share its private helpers, and moving them would have meant a circular
import with no change of behaviour. `bim_core.evaluator` is the stable entry point: it validates the binding and
delegates, and it reports an invalid binding or a failed evaluation as `EvaluationError` (a `ValueError`). The
methods themselves still raise `ValueError`/`KeyError`/`TypeError`/`ArithmeticError`, because the baseline records
those type names. An exception that is none of those (a bug) is never turned into an `EvaluationError`.

### Engine protocol and re-evaluation

`validate_result(payload, *, finite=False)` decides whether a decoded message is a `bim-engine/v1` result. It is
structural: closed key sets, types, signs. By default a `float` NaN/Infinity is accepted, as in the platform,
whose strict JSON parser has already refused them; pass `finite=True` for messages that did not go through such a
parser. A termination, enforcement or job state that is not hashable is simply invalid.
`reevaluate_result(problem, result, execution=None, allowed_terminations=("FEASIBLE", "UNKNOWN"))` never believes
the engine's numbers: only the binding of each decision survives and everything else is recomputed; the
termination is lowered to `UNKNOWN` unless the solutions and the declared guarantees support it. Provenance is
opaque and passed through unchanged (`test_vectors_extra.py` pins that, including a non-finite value).

### Compatibility and execution options

Engine manifests are plain dictionaries passed in. A rejection that the platform answered with an HTTP error is a
`ContractError` with the same `code`, the same `diagnostics` and `http_status` (422): the host translates it. The
library does not speak HTTP; `bim-service` is a host that does (`SERVICE.md`: `application/problem+json`, `status` =
`http_status` or 422), and `bim-client` turns that back into the same errors (`CLIENT.md`).

The host helpers replace `_schema_root`, `_dialect_type_matches`, `_dialect_xml_type_matches`,
`_resource_schema_diagnostics`, `_dialect_descriptor` and `_profile_descriptor`. The old underscore names no
longer exist. Other functions of `bim_core.compiler` that OpenBinding uses (`installed_profile_manifests`,
`installed_dialect_manifests`, `manifest_id`, `manifest_reference`, `selected_contracts`, `RegisteredResource`,
`install_extension_validator`) are public by name but not part of `__all__`; they are stable within a MINOR
series. Names starting with an underscore are not API.

`toolchain_identity()` returns a JSON-compatible dict: `name`, `version`, `apiVersion`, `compilerDigest`, and the
`profiles` and `dialects` the toolchain installs, each as `{namespace, name, version, digest}`.

## Errors

Every deliberate error derives from `BimError(code, message, diagnostics)`; `str(error)` is the message,
`error.code` is machine-readable, `error.diagnostics` is a list and `error.as_dict()` is JSON-compatible. Concrete
errors also derive from `ValueError`, as the pre-existing ones always did.

| Error | Raised for | `code` |
| --- | --- | --- |
| `PackageError` | transport and security of a package (ZIP, paths, JSON, XML) | `package_error` |
| `CompileError` | one or more compile diagnostics; `.diagnostics` are `CompileDiagnostic` | `compile_error` |
| `ExpressionError` | invalid or unsafe expression; has `.span` | `expression_error` |
| `CanonicalizationError` | a value with no RFC 8785 form | `canonicalization_error` |
| `ContractError` | invalid limits (`invalid_limit`); IR integrity (`ir_malformed`, `ir_not_supported`, `ir_digest_mismatch`, `ir_schema`, `contract_not_installed`); engine declarations and execution options (below); has `.http_status` | per case |
| `EvaluationError` | an invalid binding or a failed evaluation (`bim_core.evaluator`, `reevaluate`, `neighborhood`) | `binding_invalid`, `evaluation_failed`, `evaluation_input_invalid`, `neighborhood_limit`, `task_not_bound`, `non_finite_evaluation` |
| `ProtocolError` | a message or document that violates `bim-engine/v1` | see below |

Messages are unchanged from OpenBinding. `CompileDiagnostic` keeps its own codes (`schema`, `reference`, ...).
`CompileDiagnostic` is a plain frozen dataclass, not an exception: it is the element of `BimError.diagnostics`.

`BimError.as_dict()` is `{code, message[, diagnostics]}`; a `ContractError` with a suggested status adds
`httpStatus`.

Codes of `ContractError` raised by `bim_core.compat` (all with `http_status == 422`):
`engine_contract_invalid`, `engine_mode_incompatible`, `invalid_option`, `unknown_option`, `option_limit`,
`optimization_required`, `invalid_optimization_type`, `scalarization_required`, `invalid_criteria`,
`objective_cardinality`, `scalarization_incompatible`, `optimization_type_incompatible`, `invalid_weights`,
`weights_forbidden`, `weights_required`, `criteria_required`. Their `diagnostics` are the ones the platform
returned in the body of its 422.

Codes of `ProtocolError`:

- `bim_core.protocol`: `result_not_object`, `invalid_termination`, `solutions_missing`,
  `solution_decision_invalid`, `solution_features_invalid`, `solution_objectives_invalid`,
  `objective_component_invalid`, `penalties_invalid`, `violations_not_array`, `violation_invalid`,
  `unknown_fields`, `provenance_invalid`, `non_finite_number` (only with `finite=True`), `job_receipt_invalid`,
  `job_not_object`, `job_invalid`, `engine_job_failed`, `protocol_document_invalid`.
- `bim_core.conformance`: `openapi_ref_not_local`, `openapi_ref_unresolved`, `openapi_ref_siblings`,
  `openapi_ref_unapproved`, `openapi_ref_recursive`, `openapi_schema_missing`, `openapi_schema_not_object`,
  `openapi_security_invalid`, `openapi_auth_mismatch`, `openapi_schema_not_equivalent`, `conformance_no_shape`,
  `conformance_no_mode`, `conformance_failed`. `openapi_diagnostics` returns findings (`{code, check, message}`)
  instead of raising, and adds `openapi_not_object`, `openapi_version`, `openapi_protocol`,
  `openapi_digest_unpinned`, `protocol_not_installed`, `openapi_operation_missing`, `openapi_responses_missing`,
  `openapi_job_path`, `openapi_health_missing` and `openapi_malformed`.

The messages of `ProtocolError` are those of the platform's `RemoteEngineError`.

## Settings

Nothing is read from the environment, ever, by the library.

- `Limits` is a frozen dataclass with `max_compressed_bytes` (16 MiB), `max_expanded_bytes` (64 MiB),
  `max_entry_bytes` (16 MiB), `max_entries` (256), `max_compression_ratio` (100), `max_path_depth` (16): the former
  `BIM_MAX_*` values; and `max_integer_bits` (1 000 000), the largest integer an expression may produce with `pow`,
  products or weighted products (a larger one is `ExpressionError` with code `integer_limit`). Expressions read it
  from the process default (`configure`), not from the package: `Limits.from_env` reads `BIM_MAX_INTEGER_BITS`, but a
  host that wants another value than 1 000 000 must install it with `configure`; the service and `InProcessBim`
  pass their `Limits` to `load_package` only, so they keep the default.
- `Limits.from_env(environ)` is pure: it reads `BIM_MAX_COMPRESSED_BYTES`, `BIM_MAX_EXPANDED_BYTES`,
  `BIM_MAX_ENTRY_BYTES`, `BIM_MAX_ENTRIES`, `BIM_MAX_COMPRESSION_RATIO`, `BIM_MAX_PATH_DEPTH`, `BIM_MAX_INTEGER_BITS`
  from the mapping it is given; the host passes `os.environ` if it wants that.
- A ZIP entry is read only if its compression method is STORED or DEFLATED, in chunks, and is refused as soon as it
  yields more than the size its header declares (`PackageError`).
- `load_package(source, *, limits=None)`; an `InstancePackage` remembers the limits it was built with
  (`package.limits`) and uses them again for `to_zip()`.
- `configure(limits)` replaces the process default used when no `limits=` is passed. It is the only module-level
  state besides memoised, content-addressed caches (compiled XSD, schema validators, the bundle digest).

## Resources

Data files live in `bim_core/resources/` and are read only through `importlib.resources`:

- `schemas/bim/v1/*.schema.json` (12 schemas), reachable with `schema_root()`;
- `schemas/engine-contract.openapi.yaml`;
- `vendor/omg/bpmn/2.0.2/*.xsd` and its `README.md`.

No path is computed from `__file__` or from a repository layout and `SCHEMAS_DIR` is not honoured. The BPMN XSD
bundle is compiled from a real directory (`importlib.resources.as_file`), so the package must be installed on a
file system (a wheel, not a zip import).

## Digests

See [`DIGESTS.md`](DIGESTS.md). In short: `compiler_bundle_digest()` covers all code and resources;
`BindingProblem.digest` is the `irDigest`; equivalence between toolchains is shown with the semantic digest and
evaluations.

**`packageDigest` identifies the canonical package, and so does the IR.** `InstancePackage.package_digest` is the
digest of `to_zip()`, which writes every JSON resource with sorted object members, so two uploads of the same package (a
directory, the ZIP of its bytes, `to_zip()`, the same JSON with its members in another order) have the same
`packageDigest`. Since 0.2.0 they also compile to the same IR, byte for byte (canonical JSON), the same `irDigest` and
the same semantic digest: the sets the IR lists are put in one canonical order (next section) and an integral JSON number
is read as an integer in every form. Up to 0.1.x the lists followed the order the package *declared* its objects, so 64 of
the 82 corpus packages had another IR from their canonical ZIP than from their directory; a host that stored one
compilation per `packageDigest` had to compile always the same form. That is no longer needed. See
[`DIGESTS.md`](DIGESTS.md#directory-raw-zip-and-canonical-zip) and `docs/qa/IR_NORMALIZATION.md`.

### Order of the sets of the IR

JSON gives no meaning to the order of the members of an object, so a list the compiler builds by iterating objects is a
set and is written in one order that does not depend on how the package was serialized (a compile-time rule, not the ZIP
writer's):

| List of `spec` | Order (Python string comparison, code point by code point) |
| --- | --- |
| `eligibility[task]` | `(resource, id)` of the candidate |
| `constraints` | `(ref.resource, ref.id)` |
| `placement` | `resource` of the model |
| `placement[].demands` | `(candidate.resource, candidate.id)` |
| `placement[].transitions` | `(ref.resource, ref.id)` |
| `sourceMap` | the keys that carry a position (`/spec/constraints/<i>`, `/spec/placement/<i>/...`) are written after sorting, so `<i>` is the final index |

The arrays the author writes as arrays keep their order, because the order is data: `placement[].network`,
`placement[].capacityRules` (a rule is identified by its position, `capacityRules/<i>`), `optimization.criteria` and
`penalties`, the workflow (`sequence`, `exclusive`, `parallel`) and `routing.entries`.

Position in these lists is not part of any contract with the engines: bindings, solutions, violations and penalties
name candidates and constraints by `{resource, id}` (`bim-engine/v1`), `reevaluate_result` and `analyze_neighborhood`
work by identifier and sort their own output. What an engine does index is `eligibility[task]` — a seeded engine draws
`eligible[random.nextInt(n)]` and MiniZinc indexes candidates by position — and that index space is now the same for
every form of a package; the binding a given seed yields changes once, with this version (`docs/qa/IR_NORMALIZATION.md`).
Number formats: a number written `6.0` is `6` in the IR, as the canonical form writes it.

## What stays in OpenBinding

- The Engine manifests (`schemas/bim/v1/manifests/*.json`): they describe the engines OpenBinding runs, a
  platform catalog, not the language.
- Accounts, organizations, API keys, projects, pricing and metering, persisted snapshots (storing and reading
  them, using `from_document` and `compilation_digest`), the artifact library, engine registries, the job queue,
  studies, reports, the resolver, adaptive routing, the HTTP generator and the gateway routes.
- The corpus of BIM packages and the datasets.
- `archive.py` and `archive_geometry.py` of the gateway's `v1` package, and the transport half of `remote.py`
  (HTTP client, endpoint policy and DNS pinning, size limits): `bim_core.protocol` only validates decoded messages.
- Finding an Engine manifest (catalog, database, ownership and visibility of revisions and registrations),
  installing registrations, the network half of registration verification (fetching the served OpenAPI, the health
  call, running the probe) and the translation of `ContractError` to HTTP.
- The Engine manifests themselves (see above); the tests use copies as fixtures.

## Dependencies

`jsonschema`, `lxml` and `pyyaml` (the latter only to read the `bim-engine/v1` OpenAPI contract shipped in the
resources), plus the standard library. Nothing else is imported, which `tests/test_boundary.py` checks.
