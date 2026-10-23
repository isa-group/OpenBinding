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
[`../../docs/DIGESTS.md`](../../docs/DIGESTS.md).

## The OMG BPMN schemas

`bim_core` validates BPMN with the five OMG BPMN 2.0.2 XML Schemas that live under
`bim_core/resources/vendor/omg/bpmn/2.0.2/`. The source repository does not version them (Git ignores them); the wheel and
the sdist carry them. `hatch_build.py`, next to `pyproject.toml`, is the build hook: before every build (`pip install` from
the sources, `pip install -e`, `uv sync`, `uv build`) it downloads the files from omg.org over https, compares the SHA-256
of each with the declared one and writes nothing unless all five match; it does nothing if they are already there.
`bim_core` itself downloads nothing when it is used. To put them in place by hand, with network access:

```sh
python3 hatch_build.py --ensure          # from this directory
```

## License

The code, schemas and documentation written for this package are licensed under **CC-BY-4.0**
(Creative Commons Attribution 4.0 International), the license of OpenBinding; holder: javiercavlop (titular del
repositorio OpenBinding). The text is the `LICENSE` file shipped in this distribution. The five OMG BPMN 2.0.2 XML
Schemas under `bim_core/resources/vendor/omg/bpmn/2.0.2/` and third-party dependencies are **not** covered (rights
not demonstrated, respectively their own licenses). See [`NOTICE.md`](NOTICE.md) (also shipped) and
[`../../docs/LICENSING.md`](../../docs/LICENSING.md).

## Tests

From `bim-toolchain/packages/bim-core`, with `jsonschema`, `lxml`, `pyyaml` and `pytest`
available:

```sh
python3 hatch_build.py --ensure        # the OMG XSDs, if they are not there
PYTHONPATH=src python -m pytest tests
```

The test session ensures them too (`../../tools/xsd_session.py`).

Tests that read the OpenBinding corpus carry the marker `openbinding_corpus` and look for it under
`BIM_CORPUS_ROOT`. Without a corpus, run everything else with
`python -m pytest -m 'not openbinding_corpus' tests`; the synthetic golden (`golden/synthetic/`) stands in for it
([`../../docs/DELIVERY.md`](../../docs/DELIVERY.md)).
