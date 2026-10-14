# Releasing

Nothing has been released. There is no remote repository, no tag, and the licence is undecided. This is the procedure
for when there is.

The single external step pending to publish `javiercavlop/bim-toolchain` is: (1) written confirmation of the rights
(ownership, and the terms of OMG for the vendored BPMN XSDs) and (2) a Git credential limited to that repository. No new
licence is created and nothing is published until then. The status of the other items is in "Estado reconciliado" of
`EXTRACTION_LOG.md`.

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
2. Tests of all packages and `tools/`, with the corpus when available (`BIM_CORPUS_ROOT`; set `BIM_REQUIRE_CORPUS=1`
   so that a missing corpus fails instead of skipping), and `tools/baseline_core.py --check` (it also compares the
   package compiled from its ZIP with the directory the goldens were generated from). A skipped corpus test is not a
   pass: say so in the release notes. The directory/ZIP equivalence on synthetic packages never skips.
3. `python tools/dump_service_openapi.py --check` and `python tools/consumer_fixtures.py --check`. The OpenAPI
   document changes only with the API; review the diff as a contract change.
4. Build the three wheels and sdists, install them in a clean venv, run `tools/smoke_installed.py` with `-I` and
   compare the three `compilerDigest`s (`PACKAGING.md`). The release workflow does steps 2-4 again.
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

`bim-toolchain/` is self-contained (nothing outside it is read at build or test time; the corpus is optional). To make
the repository:

```sh
git subtree split --prefix=bim-toolchain -b bim-toolchain-split   # run in the OpenBinding repository
mkdir ../bim-toolchain && cd ../bim-toolchain && git init -b main
git pull ../openbinding bim-toolchain-split                        # path of the OpenBinding checkout
```

Do not create the remote or push before the decisions below. Afterwards: review `git log --stat` of the split branch (it
holds only the commits that touched the prefix, with their original messages), add the remote
(`javiercavlop/bim-toolchain`, private), push `main`, and pin the actions to SHAs (security TODO in both workflows).

### Decide before extracting

1. **Licence and holder.** `NOTICE.md` says the licence is pending. Someone with the rights must choose it (and the
   copyright holder, which may not be the same for code written inside a university project). Then: add the licence
   text and a `license` / `license-files` entry to the three `pyproject.toml`; update `NOTICE.md` and its four copies;
   decide whether `LICENSE` (CC BY 4.0, OpenBinding's content licence) and `THIRD_PARTY_NOTICES.md` (OpenBinding's
   credits) stay, change or go; fix `tools/test_packaging_metadata.py` and `test_boundary.py`, which assert that no
   licence is invented.
2. **Whether the history may travel.** The split carries the commit messages of this directory.
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
