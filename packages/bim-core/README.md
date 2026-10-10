# bim-core

The pure BIM language core, packaged on its own: it loads an Instance package,
validates it against its Profile and Dialects, and lowers it to the canonical
IR `BindingProblem` that engines consume (`bim-engine/v1`).

BIM here is a language framework:

- **Instance**: the package of documents (application, candidates, constraints,
  optimization, ...) that describes one problem.
- **Profile**: the contract that fixes roles, cardinalities, output IR and
  capabilities for a family of instances.
- **Dialect**: a versioned sublanguage that defines the resource types an
  Instance may contain, each with its schema and adapter.
- **IR `BindingProblem`**: the canonical, digest-addressed output of
  compilation.
- **`bim-engine/v1`**: the protocol engines implement to solve a `BindingProblem`.

The core is deterministic: the same package and the same installed contracts
produce the same IR and the same digests.

## Status

`0.1.0` is a packaging of the existing sources, not a copy. The files stay in
`openbinding-gateway/src/openbinding_gateway/v1` and `schemas/`; `pyproject.toml`
assembles them into the wheel as `bim_core`. Their bytes are unchanged, so
`compiler_bundle_digest()`, the builtin Profile/Dialect versions and IR digests
equal the gateway's. `docs/BIM_CORE.md` lists what is still open, notably that
the wheel has not been built or installed in this repository yet and that two
code changes (reserved for a contract release) are needed before `bim_core`
works fully standalone.

The license is pending an owner decision (the repository is currently CC BY 4.0).

## Intended public API

```python
from bim_core import (
    BindingProblem, CompileError, InstancePackage, compile_instance, load_package,
)
from bim_core.canonical import canonical_json, digest, digest_bytes
from bim_core.compiler import installed_profile_manifests, installed_dialect_manifests

package = load_package("path/to/instance-dir-or.bim.zip")   # InstancePackage
problem = compile_instance(package)                          # BindingProblem
problem.document, problem.digest
```

| Name | Module | Purpose |
| --- | --- | --- |
| `load_package` | `package` | Safe, non-extracting reader for directories, bytes and `.bim.zip` |
| `InstancePackage` | `package` | Validated, immutable set of package files |
| `compile_instance` | `compiler` | Validate and lower an `InstancePackage` to the IR |
| `BindingProblem` | `compiler` | The canonical IR document plus its digest |
| `CompileError` | `compiler` | Diagnostics-carrying failure of compilation |
| `canonical_json`, `digest`, `digest_bytes` | `canonical` | Canonical serialization and `sha256-` digests |
| `installed_profile_manifests`, `installed_dialect_manifests` | `compiler` | Exact installed contracts |

Today `bim_core/__init__.py` re-exports `BindingProblem`, `CompileDiagnostic`,
`InstancePackage`, `PackageError`, `compile_instance` and `load_package`; the other names
are imported from their module. Promoting `CompileError` and the `canonical` helpers
to the top level means editing the core sources, so it is left for the contract release.

## What stays in OpenBinding

Accounts, organizations and API keys; projects; pricing and metering (SPHERE/SPACE);
persisted snapshots and the artifact library; engine registries and registrations;
the job queue and workers; studies and reports; the resolver; adaptive routing;
the HTTP generator and the gateway routes. None of these may be imported by the core;
`openbinding-gateway/tests/test_bim_core_boundary.py` enforces it.

## Building (unverified)

```sh
cd packages/bim-core
uv build --wheel
```

Build wheels only. Set `SCHEMAS_DIR` to a directory containing `bim/v1/` if the
schemas were not installed under the environment prefix.
