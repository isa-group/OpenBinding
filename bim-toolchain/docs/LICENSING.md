# Licensing

What the license of this repository is, whom it credits, what it covers and what it does not, and the one risk that is
recorded. The machine-readable version is [`licenses.json`](../licenses.json); the files that carry it are `LICENSE`,
`NOTICE.md` (and its three copies in `packages/*/`), `THIRD_PARTY_NOTICES.md` and the `license` field of each
`pyproject.toml`.

## License

The material written for this repository is licensed under **CC-BY-4.0**, Creative Commons Attribution 4.0 International
(SPDX identifier `CC-BY-4.0`). It is the same license as OpenBinding, the repository this code was extracted from; the text
is the unchanged `LICENSE` of OpenBinding, and the deed is <https://creativecommons.org/licenses/by/4.0/>.

Holder: **javiercavlop (titular del repositorio OpenBinding)**. This is how the holder appears as the owner of the OpenBinding
repository. The legal name of the holder is not recorded anywhere in the repository and none has been inferred from the
account name; if a legal name is required (a copyright line, a contract), the holder supplies it and `licenses.json`,
`NOTICE.md` and the three copies are updated together.

## Attribution

CC BY 4.0 asks whoever shares or adapts the material to: give credit (the holder above, the name of the work, a link to the
license), link to the license, and indicate whether changes were made. Distributions of this toolchain carry `NOTICE.md`,
which states the license, the holder, the link and the scope, in every wheel and sdist together with the full text
(`LICENSE`), both declared in `license-files`, and `License-Expression: CC-BY-4.0` in the metadata. Each package directory
keeps a byte copy of the root `LICENSE` and `NOTICE.md`, and tests fail if a copy differs.

## Scope

| Material | License |
| --- | --- |
| Python sources of `bim-core`, `bim-service`, `bim-client`; their tests; `tools/`; `docs/`; `contracts/`; `.github/` | CC-BY-4.0 |
| The JSON Schemas and the engine contract in `bim_core/resources/schemas` (written for BIM) | CC-BY-4.0 |
| `golden/` (digests and numeric summaries computed by this toolchain; no dataset content) | CC-BY-4.0 |
| The five OMG BPMN 2.0.2 XML Schemas under `bim_core/resources/vendor/omg/bpmn/2.0.2/` (not versioned in Git: downloaded and verified at build time, carried by the wheels, sdists, SDK and images) | **Not covered.** Rights not demonstrated: [`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md) |
| Python dependencies (`jsonschema`, `lxml`, `PyYAML`, `FastAPI`, `pydantic`, `uvicorn`, `httpx`) and the build backend | **Not covered, not vendored.** Each is installed from an index under its own license |
| The material credited in `THIRD_PARTY_NOTICES.md` (the Universidad de Sevilla mark and the MIT projects of OpenBinding) | **Not covered.** Only its notice is here; none of that material is |

`THIRD_PARTY_NOTICES.md` is OpenBinding's file, copied unchanged and followed by one section that says what this repository
adds. `LICENSE` is OpenBinding's file, copied unchanged.

## Why the identifier is not in every source file

The SPDX identifier is declared once per distribution (`license = "CC-BY-4.0"` in `pyproject.toml`) and once in
`licenses.json`. It is deliberately not added as a comment header to each `.py` file: `compilerDigest` covers every `.py`
file of `bim_core`, so a header would change it, and with it the builtin Profile and Dialect versions, every `irDigest` and
the metadata of the goldens ([`DIGESTS.md`](DIGESTS.md)). A test fails if a source file carries a header, so that the two
declarations stay the ones that count.

## A recorded risk: CC BY 4.0 is not designed for software

Creative Commons recommends against using its licenses for software. CC BY 4.0 does not say what "source code" is, does not
grant or address patents, has no clause for distributing binaries or for the warranty of code in the way software licenses
do, and is not on the list of licenses that software projects and package indexes usually accept. The consequences can be
practical (a downstream project's compliance tooling may not recognize it as a software license) and legal (an unclear
patent position). This is **recorded, not decided**: the holder chose the same license as OpenBinding, the decision of the
holder is untouched, and changing it later means replacing `LICENSE`, the `license` field of the three `pyproject.toml`,
`NOTICE.md` and its copies, `licenses.json` and the tests that pin them (`tools/test_license_metadata.py`,
`tools/test_packaging_metadata.py`, `packages/bim-core/tests/test_boundary.py`). Nothing here is legal advice.

## What this does not settle

* The rights over the OMG schemas (state: not demonstrated). The repository never versions the five files and every build
  downloads them with a verified SHA-256, but the wheels, sdists, SDK and images do carry them, so whether they may stay in
  the artifacts and in a release is a decision of the owner ([`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md)).
* The rights of anyone who contributed code or data before it was in this repository: the holder is the person who decides
  and answers for it.
* The license of the dependencies a user installs.
* Whether a legal name should appear next to the holder.

The long README of each package (`packages/*/README.md`, shipped as the long description of the wheels) states the license,
the holder and the scope, and `tools/test_license_metadata.py` fails if it says otherwise.
