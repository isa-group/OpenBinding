# Contract of bim-core 0.1.0

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
| `ContractError` | invalid limits (`invalid_limit`); IR integrity (`ir_malformed`, `ir_not_supported`, `ir_digest_mismatch`, `ir_schema`, `contract_not_installed`) | per case |
| `EvaluationError`, `ProtocolError` | defined for the evaluator and engine protocol | not raised yet, see below |

Messages are unchanged from OpenBinding. `CompileDiagnostic` keeps its own codes (`schema`, `reference`, ...).
`CompileDiagnostic` is a plain frozen dataclass, not an exception: it is the element of `BimError.diagnostics`.

The binding validator and evaluator still raise plain `ValueError` for bad bindings, exactly as before, because
the baseline records the exception type name. `EvaluationError` and `ProtocolError` exist so the next step can
move those sites (and the engine protocol) onto them without breaking `except ValueError`.

## Settings

Nothing is read from the environment, ever, by the library.

- `Limits` is a frozen dataclass with `max_compressed_bytes` (16 MiB), `max_expanded_bytes` (64 MiB),
  `max_entry_bytes` (16 MiB), `max_entries` (256), `max_compression_ratio` (100), `max_path_depth` (16): the former
  `BIM_MAX_*` values.
- `Limits.from_env(environ)` is pure: it reads `BIM_MAX_COMPRESSED_BYTES`, `BIM_MAX_EXPANDED_BYTES`,
  `BIM_MAX_ENTRY_BYTES`, `BIM_MAX_ENTRIES`, `BIM_MAX_COMPRESSION_RATIO`, `BIM_MAX_PATH_DEPTH` from the mapping it is
  given; the host passes `os.environ` if it wants that.
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

## What stays in OpenBinding

- The Engine manifests (`schemas/bim/v1/manifests/*.json`): they describe the engines OpenBinding runs, a
  platform catalog, not the language.
- Accounts, organizations, API keys, projects, pricing and metering, persisted snapshots (storing and reading
  them, using `from_document` and `compilation_digest`), the artifact library, engine registries, the job queue,
  studies, reports, the resolver, adaptive routing, the HTTP generator and the gateway routes.
- The corpus of BIM packages and the datasets.
- `archive.py`, `archive_geometry.py`, `analysis.py` and `remote.py` of the gateway's `v1` package.
- Engine mode compatibility, re-evaluation of engine results and the protocol digest (to move here in a later
  step, together with `EvaluationError` and `ProtocolError`).
