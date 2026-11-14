# Delivery

The exact steps to turn `bim-toolchain/` of an OpenBinding clone into its own repository, `javiercavlop/bim-toolchain`, on a
machine where `git` and `gh` are installed and `gh` is already authenticated. They were run on 2026-11-14 from OpenBinding
`2cb8a7a3` (export, section 2 and the values of section 4), in a `python:3.11-slim` container with `uv 0.8.14`. No secret and no credential is stored in this repository or needed by the tool: publishing uses the
`gh` session that already exists on that machine, and it is a separate, deliberate step.

## 0. Before starting

* Python 3.11 or later, `git`, `uv` (the export self-test and `verify_release.py` build wheels and need it) and, for the last
  steps, `gh` (`gh auth status` shows the account).
* An OpenBinding clone at the commit to export, **committed**: `git status --short bim-toolchain` prints nothing. The export
  takes the committed contents (`git archive`), never the working tree, and refuses if `bim-toolchain/` has uncommitted
  changes (`--allow-dirty` exports the committed contents anyway).
* `git config user.name` and `git config user.email` are set in that clone: the single commit of the new repository is
  authored by that identity. The message is neutral (`Import bim-toolchain from OpenBinding at <commit>`) and cites the commit
  it came from. The tool never adds trailers and never names a tool or an assistant.
* The OMG XSD files ([`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md)) are **never** in the repository: the clone does not version
  them (`git ls-files` does not list them; `python3 bim-toolchain/tools/xsd_inventory.py --check` fails if it does), and the
  export refuses a committed tree that does and never copies them. Every build downloads them from omg.org over https and
  verifies their SHA-256. The wheels, sdists, SDK and images do carry them; whether they may stay there is a decision of the
  owner, taken on 2026-11-14: they do (the rights are still not demonstrated). The old switch (`--xsd auto|include|exclude`) no longer exists.
* The hashes of section 4 are those of the export of OpenBinding `2cb8a7a3` (2026-11-14). A different `hatchling` or `uv`
  may write other bytes: compare `generator` first, and take the hashes from `python3 tools/verify_release.py --skip-corpus`.

## 1. Export (writes only the output directory)

```sh
cd /path/to/openbinding                       # the clone, on the commit to export
python3 bim-toolchain/tools/export_repo.py --output "$HOME/export/bim-toolchain"
```

The output directory must not exist or be empty. The tool stages the committed tree, leaves out what never travels
(bootstrap markers, configuration and credentials, logs, datasets, caches and build output), and **refuses, creating
nothing**, if any of these fails: the scan for secrets (it reports file, line and kind, never the secret); the license
inventory (`licenses.json` coherent, `present_in_tree` false, `CC-BY-4.0` everywhere, the four `NOTICE.md` equal, `Private :: Do
Not Upload` kept); the OMG XSDs (the committed tree must not version any of them); no file that is not the holder's own
(nothing vendored that `licenses.json` does not declare, no binary file); no Markdown link that leaves the repository; and
self-containment: the tree, copied elsewhere, passes `pytest -m 'not openbinding_corpus'` from scratch with an empty corpus
and no skipped test (a few minutes: it builds the wheels and a clean venv). In that copy the OMG files are **downloaded** from
omg.org with their SHA-256 checked, so this step needs network access. `--skip-self-test` skips only that last check. It prints
a JSON summary (commit, tree, number of files, source commit, how the OMG files arrive).

Then it creates the repository: `git init`, branch `main`, one commit. It adds no remote, no tag, and pushes nothing.

## 2. Look before publishing

```sh
cd "$HOME/export/bim-toolchain"
git log --stat | head -50          # one commit, your identity, the message above
git ls-files | wc -l               # the number of files in the summary
git remote -v; git tag             # both print nothing
git show --stat HEAD | grep -E 'licenses.json|NOTICE.md|LICENSE'
python3 tools/xsd_inventory.py --check
```

Download the OMG files (this is the step the workflows run after every checkout; `verify_release.py` and the builds also do
it when a file is missing) and verify the release the way it is verified here:

```sh
python3 tools/xsd_inventory.py --ensure   # needs network unless the five files are already there; writes nothing unless all five SHA-256 match
python3 -m pip install 'jsonschema>=4.21,<5' 'lxml>=5.2,<7' 'pyyaml>=6,<7' 'fastapi>=0.110,<1.0' 'pydantic>=2,<3' 'uvicorn>=0.27,<1.0' 'httpx>=0.27,<1.0' 'pytest>=8,<9'
python3 tools/verify_release.py --skip-corpus --artifacts-out /tmp/bim-release
```

After the download `git status` does not list the five files (`.gitignore` ignores them) and `git ls-files` never does:
`python3 tools/xsd_inventory.py --check` fails if that changes. Never `git add --force` them while their rights are not
demonstrated. `verify_release.py` prints one JSON summary and exits 0 only if everything passed; its artifact hashes are
the ones to compare with section 4.

## 3. Publish (by hand, after you have looked)

```sh
gh auth status
gh repo view javiercavlop/bim-toolchain   # created empty and private on 2026-10-14; otherwise:
# gh repo create javiercavlop/bim-toolchain --private --description "BIM toolchain: bim-core, bim-service, bim-client"
git remote add origin https://github.com/javiercavlop/bim-toolchain.git
git push -u origin main
```

The actions of the workflows are already pinned to commit SHAs (`licenses.json`, `action_pins`). Check the first run of
`ci.yml`, and only then tag (`RELEASING.md`). The repository has no corpus: set the repository variable
`BIM_CORPUS_OPTIONAL` to `true` (`gh variable set BIM_CORPUS_OPTIONAL --body true`) so that the golden/corpus job says it
skipped instead of failing; OpenBinding runs the corpus comparison as its consumer contract. Nothing is published to any
package index (`Private :: Do Not Upload`).

## 4. Expected values

Obtained by `python tools/verify_release.py --skip-corpus` on the export of OpenBinding `2cb8a7a3` (nothing under
`packages/` changed between that export and the one that carries this table), two builds in two directories with `SOURCE_DATE_EPOCH=1767225600`, the five OMG XSD files
downloaded and verified. A different `hatchling` or `uv` may write other bytes: compare `generator` first. A wheel built
without the five files is another file, and the `compilerDigest` differs too.

<!-- delivery-hashes:begin -->

Environment of the run (2026-11-14): Python 3.11.18, `uv 0.8.14`, `hatchling 1.33.0` (the `Generator` of the wheels),
`SOURCE_DATE_EPOCH=1767225600`. Both builds gave the same bytes for all six artifacts. These replace the values of
2026-10-14 (`hatchling 1.32.4`, `compilerDigest` `sha256-ccc55839…`): since then `bim-core` gained the build hook that
downloads the OMG XSDs, an `artifacts` entry and a new `NOTICE.md`, and `compiler.py` validates `uniqueItems` in linear time
and inlines non-recursive local `$ref` (`CHANGELOG.md`), so all six files, `compilerDigest`, the builtin Profile and Dialect
versions and every `irDigest` changed; the semantic digests, evaluations and diagnostics did not.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `bim_core-0.2.0-py3-none-any.whl` | 134620 | `a1a125d71b3df0c772b1ec19faae7124aaeb6eb09d7e39a22cb5be32bdf2f0a0` |
| `bim_core-0.2.0.tar.gz` | 118928 | `ed2e5fceae00526c843eacf67e31ef677870fe752801a302ed688371a259e663` |
| `bim_service-0.2.0-py3-none-any.whl` | 61098 | `26d23bd28329b38eaaf6941b3a2e911ad1a1d81a65f3cb6ce5ed3c89a605d301` |
| `bim_service-0.2.0.tar.gz` | 52868 | `e3e1940dbb88b7d7f551521197b508f52946309850b09093d9cc23920ec2ee8c` |
| `bim_client-0.2.0-py3-none-any.whl` | 26866 | `7d42f43e7e3b3cf40035530d88a23747ee9f96ce6dabaded00bcfad4e0df1ddb` |
| `bim_client-0.2.0.tar.gz` | 21676 | `9aefec181d3b9acd0499db8d3cd24c91f75f333bf66e5a98925b67c8f4b1e04c` |

| Value | Expected |
| --- | --- |
| `compilerDigest` (wheel, source tree, unpacked sdist, installed distribution and service: all five equal) | `sha256-b91fc3a05d1a58d128f5589f35396aaf8ebd0c3854e1e072ce17c765fe42b4d4` |
| `protocolDigest` | `sha256-1de9afb5af0d4ea913c5c0e6e24948cc76a58ebcd7edc54a53e68a5a2f761563` |
| `irDigest` of the example package (`smoke_installed.py`) | `sha256-e4d09ae27ac4d97447935698fe504c13499e8764ec490014e2f2e23570ef5d40` |
| `golden/bim_normalized/corpus.json` (`GOLDEN_METADATA.md`) | `3b9e972cbdcff9594822722014448d6450ca6798e50db55da2b2b8586c7cc259` |
| `golden/bim_normalized/zip_equivalence.json` (unchanged) | `992b09e934d47e6f0ae346428f211702763a226c836fe3ba6191758a0fbc0305` |

`toolchain.json` is not in the table: it records the versions of Python, `lxml`, `jsonschema` and `pyyaml` in use, and a clean
venv installs whatever the index offers, so its bytes depend on the machine. Everything else in it (`packages`, digests,
`profiles`, `dialects`, `schemas`, `vendor`) was equal between the installed wheels and the source tree, and
`verify_release.py` checks exactly that. (SHA-256 of that run's `toolchain.json`, with `lxml 6.1.3.0`, `jsonschema 4.26.0`,
`pyyaml 6.0.3`: `f6dee6648521257b54432074041641319b83b13e655d4f7cab553bc985fcc908`.)

The release workflow builds on GitHub with Python 3.12 and the `uv` and `hatchling` of that run; the hashes of a release are
those of its `SHA256SUMS`, and the release notes say whether they equal the table above.

<!-- delivery-hashes:end -->

## 5. Rollback

* Before step 3: delete the output directory. The OpenBinding clone was not modified (the export only reads it).
* After `gh repo create` and before anything depends on it: delete the repository (`gh repo delete javiercavlop/bim-toolchain
  --yes`; needs the `delete_repo` scope, `gh auth refresh -s delete_repo`) and the local export; nothing was released and no
  tag exists.
* After the push: the repository is private and has one commit and no tag. Delete it as above, or make a fixing commit; do not
  rewrite what others may have cloned. Never reuse a tag once one exists (`RELEASING.md`).
* If the OMG XSD files were committed by mistake (`xsd_inventory.py --check` and the export refuse that): delete the repository
  (its history holds them) rather than removing the files in a later commit.
