# Delivery

The exact steps to turn `bim-toolchain/` of an OpenBinding clone into its own repository, `javiercavlop/bim-toolchain`, on the
Mac where `git` and `gh` are installed and `gh` is already authenticated. **Nothing here has been run against GitHub**: the
export tool was exercised in temporary directories and on this tree (below), and no remote was created, no tag was made
and nothing was pushed. No secret and no credential is stored in this repository or needed by the tool: publishing uses the
`gh` session that already exists on the Mac, and it is a separate, deliberate step.

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
  owner (the rights are not demonstrated). The old switch (`--xsd auto|include|exclude`) no longer exists.
* **The hashes of the artifacts in section 4 are out of date.** The build hook, `artifacts` and the new text of `NOTICE.md`
  changed all six files (`compilerDigest` did not). Run `python3 tools/verify_release.py --skip-corpus` and use its hashes.

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
demonstrated. `verify_release.py` prints one JSON summary and exits 0 only if everything passed; **its artifact hashes
replace the table below, which is out of date** (see the note in section 4).

## 3. Publish (by hand, after you have looked)

```sh
gh auth status
gh repo create javiercavlop/bim-toolchain --private --description "BIM toolchain: bim-core, bim-service, bim-client"
git remote add origin https://github.com/javiercavlop/bim-toolchain.git
git push -u origin main
```

Then, in the new repository: pin the actions to commit SHAs (the workflows mark each `uses:` `PIN-PENDING`; the list is in
`licenses.json`, `action_pins`), check the first run of `ci.yml` (it has never run anywhere), and only then tag
(`RELEASING.md`). Nothing is published to any package index (`Private :: Do Not Upload`).

## 4. Expected values

**Out of date.** The six artifact hashes below were obtained before the OMG XSDs stopped being versioned. `bim-core` now
has a build hook (`hatch_build.py`, also in its sdist), an `artifacts` entry and a new `NOTICE.md` (copied into the three
packages), so **all six artifacts changed** (`compilerDigest`, `protocolDigest`, `irDigest` and the goldens did not). Run
`python3 tools/verify_release.py --skip-corpus` after `python3 tools/xsd_inventory.py --ensure` and take the hashes from its
summary; they have not been recomputed here.

Obtained by `python tools/verify_release.py` (Python 3.11, `uv build`, hatchling as recorded in `generator`), two builds in two
directories with `SOURCE_DATE_EPOCH=1767225600`. They held for that content of the packages (sources, readmes, notices,
`pyproject.toml`) **with the five OMG XSD files in place**; a wheel built without them is another file, and the
`compilerDigest` differs too. A different `hatchling` or `uv` may write other bytes: compare `generator` first.

<!-- delivery-hashes:begin -->

Environment of the run that produced them: Python 3.11.2, `uv 0.8.14`, `hatchling 1.32.4` (the `Generator` of the wheels),
`SOURCE_DATE_EPOCH=1767225600`. Both builds gave the same bytes for all six artifacts. These values replace the previous ones:
every wheel and sdist now also carries `LICENSE` (the unchanged CC-BY-4.0 text) and a README that states the license, so all six
files changed; `compilerDigest` did not.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `bim_core-0.2.0-py3-none-any.whl` | 132869 | `80dd58ba38d71cea28ae3ba483609298882feb9c23c61a400ac05c56b44311f0` |
| `bim_core-0.2.0.tar.gz` | 114061 | `690da1fb26e1bc3ceb5befbc5407cd7fc6c6c4d4c5ae7e726a3752756e8512c8` |
| `bim_service-0.2.0-py3-none-any.whl` | 61046 | `45ca51bdda278090244c1ba08f9cbdd676582ab3f7cf6c5c07b39dd5f006a2e9` |
| `bim_service-0.2.0.tar.gz` | 52687 | `e767c77f105909a24f88a745328571cbc0e0a44c395456e23cf2de71ec4177c4` |
| `bim_client-0.2.0-py3-none-any.whl` | 26817 | `5cff0e6cbc0a134e7f726444240e1046741f411b1a0b362def669cb7065ea4c3` |
| `bim_client-0.2.0.tar.gz` | 21509 | `725621fc7c21fdc94bc41444c2e6bc2d3242c39483c6fe0b9bb349c9fb4dba5e` |

| Value | Expected |
| --- | --- |
| `compilerDigest` (wheel, source tree, unpacked sdist, installed distribution and service: all five equal) | `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e` |
| `protocolDigest` | `sha256-1de9afb5af0d4ea913c5c0e6e24948cc76a58ebcd7edc54a53e68a5a2f761563` |
| `irDigest` of the example package (`smoke_installed.py`) | `sha256-0dcc0b0a230d45cf768edef5f0da70f0ca366c8ab29c3e8168c3c16328c22270` |
| `golden/bim_normalized/corpus.json` after the refresh (`GOLDEN_METADATA.md`) | `6f60c4fa83576ae0b5bf2da1437fb32e348deee80b34ee410f8d19a9313c0a07` |
| `golden/bim_normalized/zip_equivalence.json` (unchanged) | `992b09e934d47e6f0ae346428f211702763a226c836fe3ba6191758a0fbc0305` |

`toolchain.json` is not in the table: it records the versions of Python, `lxml`, `jsonschema` and `pyyaml` in use, and a clean
venv installs whatever the index offers (the run above installed `lxml 6.1.3.0`, the project's test environment has
`6.1.1.0`), so its bytes depend on the machine. Everything else in it (`packages`, digests, `profiles`, `dialects`,
`schemas`, `vendor`) was equal between the installed wheels and the source tree, and `verify_release.py` checks exactly that.
(SHA-256 of that run's `toolchain.json`: `5af837d8d7a3c9234a70bd86a127eaf0e735507f195c8b7eb7439011e2d67aa4`.)

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
