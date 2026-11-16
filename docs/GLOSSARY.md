# Glossary

The vocabulary of OpenBinding since the redesign around compositions. Each term gives its Spanish name (the
redesign plan's), what it is, and where it lives. Terms marked *(later)* name concepts of later phases, so that
documents and screens can use them consistently now.

| Term | Spanish | What it is | Where |
|---|---|---|---|
| **Composition** | Composición | A named binding of a workflow to services, owned by an organization: an immutable id, a slug unique in the organization, a `kind`, an `archived` flag and its versions. Its document is Composition2Yaml | `compositions` |
| **Kind** | Tipo (`kind`) | What a composition composes: `application`, `workflow`, `pipeline` or `system`, labelled Application, Workflow, Pipeline and System. Metadata only, for filtering: no rule depends on it | the document's `kind`; `compositions.kind` follows the latest version |
| **Composition version** | Versión de composición | The immutable canonical bytes of one Composition2Yaml document, labelled by its `version:` (semver) and numbered by an ordinal, with an optional link to a problem revision and its compilation, its values status, and lineage (`based_on`, `forked_from`) | `composition_versions` |
| **Evaluation** | Evaluación | The toolchain's verdict on a version: values, constraint violations, binding validity, the compilation and semantic digests, and diagnostics. One per version and toolchain for a linked version, one `declared` evaluation for a declared version. Called an evaluation, not a build, because nothing is compiled on the composition's side | `composition_evaluations` |
| **Derivation** | Derivación | The immutable edge from a binding of a problem (a revision, its compilation, the binding and, when there is one, a run and the point of its front) to the composition version derived from it | `composition_derivations` |
| **Run preset** | Preset de run | A named set of run settings of an organization: engine, registration, mode, options and optimisation (type, scalarisation, weights). A run copies them and records the preset; it never enters a composition document | `run_presets` |
| **Problem** | Problema | The BIM composition problem: tasks, alternative candidates, properties, constraints and objectives. Uploaded, edited in the BIM editor, produced by QACOForge or, later, generated from SPHERE; owned by an organization | `binding_cases` |
| **Revision** | Revisión (de problema) | An immutable uploaded BIM package of a problem, with its digests. Variants of a problem (another demand, other exclusions) are revisions | `binding_case_revisions` |
| **Compilation** | Compilado | The IR of a revision compiled by one toolchain release, with its analysis; insert-only, one per revision and toolchain (compile-or-get) | `problem_compilations` |
| **Semantic digest** | Digest semántico | The digest of what a compiled problem means: the canonical digest of the IR's `spec` without its descriptors. Two toolchain releases that read a problem alike give it the same semantic digest, so a composition's link to a compilation survives a release | `problem_compilations.semantic_digest` |
| **Offering** | Oferta | The composition's own pricing, from which margins per plan are computed: a reference with exactly one source (`{sphere}`, `{sphere, registry}` or `{url}`), optional and without a version in the document. Its content lives in SPHERE or a Pricing2Yaml file | the document's `offering`; `composition_versions.offering` |
| **Provenance (`from`)** | Procedencia (`from`) | Where a chosen candidate came from: a plan of a SPHERE pricing at a pinned version (`{sphere, registry?, version, plan, addons?}`), so a later version of that pricing can be detected | the document's `binding.<task>.from` |
| **Verified values** | Valores verificados | Global values the gateway computed with the toolchain on the linked problem when sealing (`evaluatedBy: gateway`); they replace whatever the author wrote | `values_status = verified` |
| **Declared values** | Valores declarados | Global values of a composition linked to no problem, stored as written (`evaluatedBy: declared`) and never compared with verified ones | `values_status = declared` |
| **Unverified values** | Valores sin verificar | A linked version whose current evaluation is not the verified outcome (the binding became invalid, or the problem's semantics changed): its values stay as sealed, marked Unverified until it is re-evaluated or derived again | the current evaluation's `outcome` |
| **Visibility** | Visibilidad | Who reads a composition: `private` (its organization's members; every composition and every fork starts so) or `public` (anybody, redacted to what its documents carry). An organization's ADMIN changes it | `compositions.visibility` |
| **Showcase** | Escaparate | The public page of a composition, `/c/<organization>/<composition>`: what its documents say (workflow, values and their status, upstream plan references, the problem's reference, the offering, the versions), with Fork for anybody signed in. A member also sees "Open in the app" | `pub-showcase` |
| **Catalog** | Catálogo | Two things named alike: the renderer's `catalog` mode, a composition's identity, value status, values, binding, offering, evidence and problem as its Overview shows them; and the public list of every organization's public compositions, `/compositions` (`GET /v1/compositions`). A problem's catalogs of candidates are BIM resources (`CandidateCatalog`) | `widgets/composition-renderer`; `pub-compositions` |
| **Facts** | Hechos (del problema) | The gateway's projection of a compiled problem for screens: tasks, candidates with their written names and values, features, constraints, objectives, the binding-space size and the workflow in Composition2Yaml's shape. The frontend never reads the IR | `…/compilations/{compilation}/facts`; `validate?include=facts` |
| **Fork** | Fork | A copy of a version into a new, private composition of another organization, with a `forked_from` snapshot of its source. A version that links a problem is forked only without it, its values then declared | `POST …/fork`; `composition_versions.forked_from` |
| **Environment** *(later, F4)* | Entorno | Where a composition runs: the composition version in force, its operator, its adoption policy and its SPACE links. Replaces "deployment" | `composition_environments` |
| **Upstream event** *(later, F6)* | Evento upstream | The immutable record of a new version of an upstream pricing (or of the offering) against a composition version, with its category, diff and status (open, reviewed, resolved). It changes nothing by itself | `composition_upstream_events` |
| **Proposal** *(later)* | Propuesta | A typed change plan (ORBIT's plan): steps with their base revisions, confirmed by a person, executed step by step and audited. "Plan" is kept for pricing plans | `proposals` |

## On screen

The interface is English (F2 design choice C7); the redesign plan's Spanish names map as follows.

| On screen | Plan | Where |
|---|---|---|
| Compositions | Composiciones | the header; `/app/<organization>/compositions`; the public list `/compositions` |
| Overview · Editor · Versions · Analysis · Settings | Resumen · Editor · Versiones · Análisis · Ajustes | the tabs of a composition |
| New version (Code editor, Visual editor, Upload Composition2Yaml, Derive from a run) | Nueva versión | the composition header |
| Seal version | Sellar versión | the editor's bottom bar: a sealed version never changes |
| Derive composition | Derivar composición | a run's result ("Keep it as a composition"), the Analysis tab |
| Table · Compare · File · Evolution | Tabla · Comparar · Fichero · Evolución | the views of Versions |
| Verified · Declared · Unverified | Verificado · Declarado · Sin verificar | `ValueBadge`, always in words |
| Public · Private | Pública · Privada | a composition's badge and Settings → Visibility |
| Fork | Fork | the composition header and the showcase |
| Language | Lenguaje | the header; `/language`, the Composition2Yaml reference and playground |

## Usage

- "Problem" always means the BIM problem. The BIM resource `Application` is called "the workflow and features
  document" where it appears.
- "Plan" is reserved for pricing plans; ORBIT's plans are **proposals**.
- "Environment" replaces "deployment"; "upstream event" is a notice about a third-party pricing, not a proposal.
- The language is [Composition2Yaml](COMPOSITION2YAML.md); its decisions are ADRs
  [0041](adr/0041-composition2yaml-final-composition.md) to [0046](adr/0046-compositions-module.md), and how
  compositions are published and shown on the web ADRs [0047](adr/0047-public-compositions.md) to
  [0050](adr/0050-frontend-layers-and-sphere-reuse.md).
- "Catalog" alone means the renderer's mode or the public list, never a BIM candidate catalog.
