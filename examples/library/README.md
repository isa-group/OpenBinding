# Shared example authoring

These files are the source of truth for the explicitly shared resources listed
in `manifest.json`. Each named resource has an authored version directory.
The complete packages under `examples/demo` remain independently distributable;
their mapped resources are generated copies, not separate editing authorities.

The fulfillment JSON/BPMN twins share their catalog, constraints, optimization
and placement. Their applications and routing stay separate because the workflow
references differ. The constrained analysis and journey examples share application,
catalog and constraints, retaining their original package metadata; their different
optimization policies stay separate. These are explicit authoring decisions,
not identities inferred automatically from similar `spec` values.

Edit the source once, then run:

```sh
python3 tools/build_shared_examples.py
python3 tools/build_shared_examples.py --check
```

CI checks document equality, so whitespace is not an editorial change. To evolve
a resource independently, create another version directory and change only the
intended consumers in the manifest. Do not edit generated resource content directly.
This authoring manifest is separate from organization-owned runtime identities;
the development seeder validates and seals those through the artifact service.
