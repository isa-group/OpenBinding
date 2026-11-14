# Releasing

`v0.2.0` is the first release (2026-11-14), from `javiercavlop/bim-toolchain` (private). The license of the material
written here is CC-BY-4.0 (holder: javiercavlop, titular del repositorio OpenBinding; [`LICENSING.md`](LICENSING.md)).
[`DELIVERY.md`](DELIVERY.md) has the steps that created the repository and the expected values of that release.

## Current state (2026-11-14)

The repository was created by `tools/export_repo.py` from OpenBinding (one import commit, no history) and pushed to the
private `javiercavlop/bim-toolchain`. Before the push, on the export: `xsd_inventory.py --check` and `--ensure` passed, and
`verify_release.py --skip-corpus` (two builds, `SOURCE_DATE_EPOCH=1767225600`, Python 3.11.18, `uv 0.8.14`, `hatchling
1.33.0`) gave identical bytes for the six artifacts, the hashes of [`DELIVERY.md`](DELIVERY.md#4-expected-values), and
`compilerDigest` `sha256-b91fc3a05d1a58d128f5589f35396aaf8ebd0c3854e1e072ce17c765fe42b4d4` in wheel, sdist, installation,
service and tree. The corpus tier does not run here (no corpus in this repository; `BIM_CORPUS_OPTIONAL=true`): OpenBinding
runs it against each release as its consumer contract.

The owner decided on 2026-11-14 that the release artifacts carry the five OMG BPMN XSDs, whose redistribution is still **not
demonstrated** ([`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md)); this is a decision of the owner, not a clearance. The repository
and its releases are private; making them public (the plan is to move the repository to `SCORELabUS`) should be weighed
against that state. Nothing is uploaded to any package index.

OpenBinding consumes the wheels of the release by exact version and the SHA-256 of each release asset, pinned in its
`uv.lock`; while the repository is private it needs a token that can read it to download them.

## Version numbers

The three distributions share one version, `MAJOR.MINOR.PATCH`, and change together. Every release changes
`compilerDigest` (it covers every `.py` file and all resources), so the digest is not the reason to choose a number;
the behaviour is. The rules are those of [`DIGESTS.md`](DIGESTS.md#versioning-rules):

| Bump | When | What must still hold |
| --- | --- | --- |
| PATCH | no valid package changes meaning: refactors, performance, docs, message wording | semantic digests, evaluations and the codes and locations of diagnostics in `golden/bim_baseline` are identical |
| MINOR | backward-compatible additions: new public API, accepted constructs, diagnostics for what was not valid | every package that compiled still has the same semantic digest and evaluations; the OpenAPI document only gains |
| MAJOR | anything else: a valid package changes digest or evaluation or is rejected, an incompatible change of the IR schema, the engine protocol or the HTTP API, a removed public name | goldens are regenerated only in a reviewed change that says why |

Before 1.0 the minor number is the one that marks a MAJOR change: the semantic change of `0.2.0` (the order of the sets
of the IR) was a MAJOR change by the table above, and it widened `bim-core>=0.1,<0.2` in the other two distributions.
A MAJOR change leaves the previous golden as a frozen fixture and records the new baseline next to it (`DIGESTS.md`).

A change to `bim_core/toolchain.py` (the definition of what the digest covers) is a change of toolchain: record it in
`CHANGELOG.md` and `DIGESTS.md` with the reason and the old and new value. A MINOR bump of `bim-core` also widens
`bim-core>=0.x,<0.y` in `bim-service` and `bim-client`.

## Checklist

1. Choose the version. Edit `version` in the three `pyproject.toml` and `__version__` in the three `_version.py`
   (a test fails if they differ). Move `[Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD` and say whether
   the semantic digests, evaluations, diagnostics, OpenAPI or protocol changed.
2. Tests of all packages and `tools/`. The bim-service tests marked `runner_timing` measure CPU timing and do not hold on
   a shared runner: the workflows deselect them; run `python -m pytest -m runner_timing packages/bim-service/tests` on a
   dedicated machine and say in the release notes whether they passed. With the corpus (`BIM_CORPUS_ROOT`; set `BIM_REQUIRE_CORPUS=1` so that a missing
   corpus fails instead of skipping) the whole suite runs, and `tools/baseline_core.py --check` compares the package compiled
   from its ZIP with the directory the goldens were generated from. Without the corpus, `-m 'not openbinding_corpus'` runs
   everything else with no skip (a guard test proves it) and the golden it compares with is `golden/synthetic/corpus.json`.
   A skipped corpus test is not a pass: say so in the release notes. If `bim_core` changed, refresh the informative
   members of the goldens first: `python tools/regen_normalized_metadata.py --write` (`GOLDEN_METADATA.md`); a test fails
   until you do.
3. `python tools/dump_service_openapi.py --check` and `python tools/consumer_fixtures.py --check`. The OpenAPI
   document changes only with the API; review the diff as a contract change.
4. `python tools/verify_release.py` (add `--skip-corpus` in a tree without the corpus): puts the OMG XSDs in place (verified
   download, only if a file is missing), builds the three wheels and sdists
   twice in two directories and requires the same SHA-256 (and the XSDs inside the wheel and the sdist of `bim-core` with
   the bytes `licenses.json` declares), installs the wheels in a clean venv, runs
   `tools/smoke_installed.py` with `-I`, compares the `compilerDigest` of wheel, tree, sdist, installation and service
   (`PACKAGING.md`), checks the OpenAPI document, the consumer fixtures, the corpus baseline and `toolchain.json`, and
   prints the hashes. The release workflow does steps 2-4 again.
5. Review `toolchain.json`: the `compilerDigest` and `protocolDigest` are the ones the notes announce, and the runtime
   versions are the intended ones.
6. Commit, tag `vX.Y.Z` (signed if keys are available) and push the tag. The workflow checks that the tag, the
   `pyproject.toml` files, the `_version.py` files and the changelog agree, builds, and creates a **draft** release with
   the wheels, sdists, `toolchain.json` and `SHA256SUMS`.
7. A person reviews the draft and publishes it. Nothing is uploaded to PyPI or any index (the distributions carry
   `Private :: Do Not Upload`); consumers install from the release assets.
8. In OpenBinding: bump the pin, recompile stored IRs (`irDigest` and the pinned Profile move with the toolchain),
   regenerate the pinned digests, replay `contracts/consumers/openbinding/`.

## Rollback

Releases are additive and nothing is published to an index, so rolling back is not publishing, or withdrawing:

- Before step 7: delete the draft release and the tag (`git push --delete origin vX.Y.Z`, `git tag -d vX.Y.Z`). Nothing
  reached a consumer.
- After step 7: mark the release as a pre-release or delete it, tag the fix as the next PATCH (never reuse or move a
  tag), and tell consumers to pin the previous version. A digest published once is a fact about those bytes; do not
  rebuild them under the same number.
- In OpenBinding, return to the previous pin; the IRs stored with the previous `compilerDigest` are valid again.

## Extracting this directory into its own repository

`bim-toolchain/` is self-contained (nothing outside it is read at build or test time; the corpus is optional). The way to
make the repository is `tools/export_repo.py`, which writes a new repository with the committed contents of
`bim-toolchain/` at its root, **one** commit authored by whoever runs it, and no remote, tag or push
([`DELIVERY.md`](DELIVERY.md) has the exact commands, the expected hashes and the rollback):

```sh
python3 bim-toolchain/tools/export_repo.py --output ../bim-toolchain-export     # from a clone of OpenBinding, committed
```

It refuses to export (nothing is created) if it finds a secret, an inconsistent license inventory, a committed tree that
versions the OMG XSDs, a file that is not the holder's own, a link that leaves the repository, or if the exported tree does not pass `-m 'not openbinding_corpus'` from
scratch. The history is not carried over: the earlier alternative, `git subtree split`, carries the commit messages of this
directory and is no longer the documented way.

The decisions below were taken on 2026-11-14 for `v0.2.0` (owner `javiercavlop`, private, GitHub Releases only, the OMG XSDs
inside the artifacts); they are kept here for the next move of the repository.

### Decide before publishing

1. **The OMG XSDs.** Their redistribution is not demonstrated ([`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md)). The repository, and
   therefore the export, never carries the five files, and the workflows download them from the official source, verifying
   their SHA-256. The wheels and sdists of a release do carry them: whether that is acceptable is a decision of the owner,
   and a clearance recorded in `licenses.json` (`cleared`, `cleared_by`, `cleared_on`, `evidence`) is what would settle the
   rights. The license of the code, CC-BY-4.0, and its holder are already recorded ([`LICENSING.md`](LICENSING.md)); changing the
   license means changing `LICENSE`, the three `pyproject.toml`, `NOTICE.md` and its copies, `licenses.json` and the tests
   that pin them.
2. **Whether the history may travel.** The export does not carry it; the commit cites the OpenBinding commit it came from.
3. **Private index or release assets.** Whether `Private :: Do Not Upload` stays and how OpenBinding fetches releases.
4. **Corpus access** in CI (`vars.BIM_CORPUS_ROOT` points to a runner path; without it the golden/corpus job fails,
   unless `vars.BIM_CORPUS_OPTIONAL` is `true`, which skips it and says so in the job summary).
5. **The `meta-router-csp` manifest and the eligibility-order question** listed in `EXTRACTION_LOG.md`. The latter is
   closed in `0.2.0`: the owner decided on 2026-10-14 to canonicalise the order (a MAJOR change, `CHANGELOG.md`
   `semantic-change`); the directory, the raw ZIP, the canonical ZIP and any permutation of the JSON members of a package
   compile to the same IR in 82/82 corpus packages (`DIGESTS.md`, "Directory, raw ZIP and canonical ZIP";
   `packages/bim-core/tests/test_zip_dir_equivalence_corpus.py`), and a host no longer has to compile always the same
   form. `golden/bim_baseline` stays as the frozen baseline of `0.1.x`; the baseline of `0.2.0` is
   `golden/bim_normalized`.
