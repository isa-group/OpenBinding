# bim-toolchain

The BIM toolchain, prepared as the root of its own (future, private) repository.

**BIM here is a service-composition and binding language**: a package of JSON (and BPMN) documents describes an
application workflow, the candidate services that can fill each task, constraints and an optimization, and the
compiler lowers it to a canonical, digest-addressed `BindingProblem` that solver engines consume. It has nothing to
do with Building Information Modeling.

OpenBinding will consume this directory as a dependency. For now the code was copied, not moved; see
[`docs/EXTRACTION_LOG.md`](docs/EXTRACTION_LOG.md).

## Layout

```
bim-toolchain/
  LICENSE, THIRD_PARTY_NOTICES.md   copied unchanged from OpenBinding
  NOTICE.md                         license pending; OMG BPMN notices; no datasets
  packages/bim-core/
    pyproject.toml, README.md
    src/bim_core/                   the package (src layout)
      resources/                    JSON Schemas, engine contract, vendored OMG BPMN 2.0.2 XSDs
    tests/
  golden/bim_baseline/              digests and numeric summaries recorded in OpenBinding
  tools/baseline_core.py            recomputes the baseline with bim_core only
  docs/                             CONTRACT.md, DIGESTS.md, EXTRACTION_LOG.md
```

## Running the tests

They need `jsonschema`, `lxml` and `pytest` (Python ≥ 3.11):

```sh
cd bim-toolchain/packages/bim-core
PYTHONPATH=src python -m pytest tests
```

The corpus of BIM packages is not part of this directory. Tests that need it look under `BIM_CORPUS_ROOT`
(default: the directory that contains `bim-toolchain/`) and skip with a warning when it is missing. By default the
equivalence test compares all packages with the goldens; `BIM_BASELINE_SAMPLE_ONLY=1` limits it to ten.

To compare or regenerate the baseline by hand:

```sh
PYTHONPATH=packages/bim-core/src python tools/baseline_core.py --check          # compare with the goldens
PYTHONPATH=packages/bim-core/src python tools/baseline_core.py                  # rewrite them (reviewed changes only)
```

## License status

The license of the code has **not been decided**; nothing is declared in the package metadata. `LICENSE`
(CC BY 4.0) and `THIRD_PARTY_NOTICES.md` are OpenBinding's, kept unchanged. The OMG BPMN 2.0.2 schemas keep their
notices. No dataset is redistributed. See [`NOTICE.md`](NOTICE.md).
