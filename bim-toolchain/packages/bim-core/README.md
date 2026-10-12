# bim-core

BIM v1 implementation: it loads an Instance package, validates it against its
Profile and Dialects, and lowers it to the canonical `BindingProblem` that engines
consume (`bim-engine/v1`). BIM here is a service-composition and binding language;
it has nothing to do with Building Information Modeling.

```python
import bim_core

package = bim_core.load_package("path/to/instance-dir-or.bim.zip")
problem = bim_core.compile_instance(package)      # BindingProblem
problem.document, problem.digest                   # IR and its semantic digest

stored = bim_core.BindingProblem.from_document(problem.document)  # rehydrate + verify
bim_core.toolchain_identity()                      # version, compilerDigest, contracts
```

Evaluation, re-evaluation of an engine's answer and engine compatibility are pure functions of the IR and of
plain dictionaries (the engine manifests are inputs):

```python
from bim_core import (
    EvaluationError, analyze_neighborhood, evaluate, mode_compatibility,
    protocol_digest, reevaluate_result, resolve_optimization, validate_result,
)

evaluation = evaluate(problem, binding)                    # EvaluationError(code="binding_invalid") if the binding is not valid
answer = validate_result(engine_json)                      # ProtocolError(code=...) if it is not bim-engine/v1
trusted = reevaluate_result(problem, answer, execution)    # the engine's QoS claims are replaced, never believed
diagnostics = mode_compatibility(problem, mode)            # [] if the engine mode can run the problem
```

Resource limits are injected, never read from the environment on import:

```python
import os
from bim_core import Limits, configure, load_package

limits = Limits.from_env(os.environ)   # BIM_MAX_* variables, if the host wants them
configure(limits)                       # process default (optional)
load_package(data, limits=limits)       # or per call
```

The public surface, errors, settings, resources and digests are described in
[`../../docs/CONTRACT.md`](../../docs/CONTRACT.md) and
[`../../docs/DIGESTS.md`](../../docs/DIGESTS.md). The license of the code is pending
the holder's decision; see [`../../NOTICE.md`](../../NOTICE.md).

## Tests

From `bim-toolchain/packages/bim-core`, with `jsonschema`, `lxml`, `pyyaml` and `pytest`
available:

```sh
PYTHONPATH=src python -m pytest tests
```

Tests that need the OpenBinding corpus look for it under `BIM_CORPUS_ROOT` and skip
with a warning when it is not there.
