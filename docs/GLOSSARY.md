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
| **Value source** | Fuente del valor | What a candidate value a SPHERE import wrote was read from: `priced` (a plan's price per month), `guarantee`, `limit` (a usage limit), `feature` or `manual` (set by hand when importing), with the upstream plan; screens badge it Priced, Guarantee, Limit, Feature or Manual. A value with no source was written by hand in the package | `problem_value_origins`; the facts' `source` |
| **Import recipe** | Receta de importación | What a SPHERE import generates a revision from: the pricings and pinned versions, the plans and add-ons, how each feature is read, the demand and the requirements. Pinned in the generated revision's provenance; the wizard builds it | `SphereImportRecipe`; `GET …/sphere/recipe` |
| **Pricing snapshot** | Instantánea de pricing | An immutable copy of one pricing version the gateway read (SPHERE, a registry or a URL), by sha256 and SPHERE's content hash; screens draw upstream plans and offerings from it and never call SPHERE to show them | `pricing_snapshots`; `…/pricing-snapshots/{id}/yaml` |
| **Verified values** | Valores verificados | Global values the gateway computed with the toolchain on the linked problem when sealing (`evaluatedBy: gateway`); they replace whatever the author wrote | `values_status = verified` |
| **Declared values** | Valores declarados | Global values of a composition linked to no problem, stored as written (`evaluatedBy: declared`) and never compared with verified ones | `values_status = declared` |
| **Unverified values** | Valores sin verificar | A linked version whose current evaluation is not the verified outcome (the binding became invalid, or the problem's semantics changed): its values stay as sealed, marked Unverified until it is re-evaluated or derived again | the current evaluation's `outcome` |
| **Visibility** | Visibilidad | Who reads a composition: `private` (its organization's members; every composition and every fork starts so) or `public` (anybody, redacted to what its documents carry). An organization's ADMIN changes it | `compositions.visibility` |
| **Showcase** | Escaparate | The public page of a composition, `/c/<organization>/<composition>`: what its documents say (workflow, values and their status, upstream plan references, the problem's reference, the offering, the versions), with Fork for anybody signed in. A member also sees "Open in the app" | `pub-showcase` |
| **Catalog** | Catálogo | Two things named alike: the renderer's `catalog` mode, a composition's identity, value status, values, binding, offering, evidence and problem as its Overview shows them; and the public list of every organization's public compositions, `/compositions` (`GET /v1/compositions`). A problem's catalogs of candidates are BIM resources (`CandidateCatalog`) | `widgets/composition-renderer`; `pub-compositions` |
| **Facts** | Hechos (del problema) | The gateway's projection of a compiled problem for screens: tasks, candidates with their written names and values, features, constraints, objectives, the binding-space size and the workflow in Composition2Yaml's shape. The frontend never reads the IR | `…/compilations/{compilation}/facts`; `validate?include=facts` |
| **Fork** | Fork | A copy of a version into a new, private composition of another organization, with a `forked_from` snapshot of its source. A version that links a problem is forked only without it, its values then declared | `POST …/fork`; `composition_versions.forked_from` |
| **Environment** | Entorno | A composition environment: where an application reads the version of a composition in effect, with its operator, its adoption policy (who may adopt), its expected users and, from F8, its SPACE links. Its slug is part of its feed's address and never changes. OpenBinding's own development, lab, preview and production are its *stages*, never environments; "deployment" is only a federated engine's | `composition_environments` |
| **Adoption** | Adopción | A person making a sealed version the one in effect in an environment, with the environment's ETag: one immutable, numbered history row that pins the evaluation the version was judged on | `POST …/environments/{environment}/adopt`; `composition_adoptions` |
| **In effect** | En vigor | The version an environment's feed serves: the one adopted last ("Adoption #3") | `composition_environments.adopted_version_id` |
| **Feed** | Feed | What an application polls: the adopted version's Composition2Yaml bytes, with its content digest as ETag, changing only on adopt | `GET …/environments/{environment}/composition` |
| **Feed key** | Clave del feed | An environment's own credential (`obe_…`): reads that environment's feed and nothing else, outlives its creator, shown once, at most two live | `composition_environment_keys` |
| **Margin per plan** | Margen por plan | A plan's revenue per month minus the composition's upstream cost per user, apportioned uniformly, for each plan of the offering alone and with each single add-on | `GET …/versions/{version}/margins` |
| **Upstream event** | Evento upstream | The immutable record of a new version of an upstream pricing (or of the offering) against a live composition version (an offering event: against the composition), with its category (no impact, values changed, binding invalid, offering changed), diff and state: **Open** (abierto), **Reviewed** (revisado, once, with a note) or **Resolved** (resuelto, only by a person sealing a version that pins the new version or a newer one). It changes nothing by itself | `composition_upstream_events` |
| **Watch** | Vigilancia | The watcher's state for one upstream source and read scope (a SPHERE family, a registry's, or an offering URL): when it was last answered, its latest version, its back-off. Shared by every composition that reads the source | `pricing_watches` |
| **Watch reference** | Referencia vigilada | What one sealed version reads upstream: a watch, the subject (binding or offering), the pinned version and the bound selection. Written when the version is sealed, never changed | `pricing_watch_refs` |
| **Rebinding recommended** | Rebinding recomendado | What a `binding_invalid` upstream event says: the pinned plan or add-on is gone, private, not priced, or no longer meets a requirement, so a person should re-solve or rebind | the event's `category` and `reasons` |
| **No impact** | Sin impacto | An upstream event whose new version changed nothing the bound selection reads (only other plans, the catalog or metadata): stored, never told or badged | `category = no_impact` |
| **Proposal** | Propuesta | A typed change (ORBIT's plan): steps with their base revisions, shown, confirmed by its author, applied step by step and audited. It changes nothing until then. "Plan" is kept for pricing plans | `proposals`; `POST …/proposals`, `…/proposals/{proposal}/confirm` |
| **Step** | Paso | One typed action of a proposal (seal a derived version, adopt a version), with its parameters, base revision and, once confirmed, its outcome: done, failed or skipped | `proposal_steps` |
| **Base revision** | Revisión base | What a step was built against: the head version and the digest of the document shown, or an environment's ETag. Confirming checks it again before anything runs | a step's `base` |
| **Stale** | Desfasada | A proposal whose base no longer holds when its author confirms it: nothing is applied, and a new proposal is needed | `status = stale` |

## On screen

The interface is English (F2 design choice C7); the redesign plan's Spanish names map as follows.

| On screen | Plan | Where |
|---|---|---|
| Tools | Herramientas | the header menu of the editors: Composition editor (`/editor`), Problem editor (`/problem-editor`), Composition2Yaml (`/language`) |
| Explore | Explorar | the header menu of the public lists: Organizations (`/organizations`), Compositions (`/compositions`), Engines (`/engines`) |
| Compositions | Composiciones | an organization's tab (`/orgs/<organization>/compositions`); the account's `/me/compositions`; the public list `/compositions` |
| Overview · Analytics · Configuration · Versions · Settings | Resumen · Analítica · Configuración · Versiones · Ajustes | the tabs of a composition (`/compositions/<organization>/<composition>/<tab>`) |
| Permanent link | Enlace permanente | `/p/<composition id>` (`?version=`): the address that keeps working whatever the composition is called; it answers the same for missing and unreadable |
| New version (Code editor, Visual editor, Upload Composition2Yaml, Derive from a run) | Nueva versión | the composition header |
| Publish | Publicar | the editor's Publish dialog: a new composition, or a new version, which never changes once sealed |
| Keep as composition | Derivar composición | a run's page, the Configuration tab and a study's front |
| Structured · File | Estructurada · Fichero | the two views of a comparison in Versions (`?from=&to=&diff=file`) |
| Verified · Declared · Unverified | Verificado · Declarado · Sin verificar | `ValueBadge`, always in words |
| Public · Private | Pública · Privada | a composition's badge and Settings → Visibility |
| Fork | Fork | the composition header |
| Language | Lenguaje | Tools; `/language`, the Composition2Yaml reference (its examples open in `/editor`) |

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
