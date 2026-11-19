# TomatoMeter

TomatoMeter's back end as a BIM problem, and the SPHERE import recipes that add real pricings to it.

| File | What it is |
|---|---|
| `tomatometer-email.base.json` | Revision 1 of the `tomatometer-email` problem: sign in, then send the daily summary e-mail and export the data in parallel, then fetch a quote. One hand-made candidate per task; the e-mail candidate (Postfix on a VPS) carries the `emailsPerMonth` and `emailsPerDay` properties the e-mail requirements read. Features `subscription` (USD/month, paid once per selected candidate), `availability` (a ratio, multiplied along the workflow) and `latency` (ms). |
| `email-recipe.json` | The flagship SPHERE import for the `dailySummary` task: the five e-mail providers of the `danruilop1` set (SendGrid, Mailgun, Brevo, Resend, Postmark, version `2026-10` each), a demand of 30 000 e-mails a month and 1 000 a day, the subscription from each plan's price, the availability from the uptime guarantees through one table (SendGrid and Postmark, which publish none, by hand) and the latency by hand. SendGrid declares no daily limit, so the recipe assumes it unlimited. |
| `tomatometer-recipe.json` | The combined import that makes revision 3: the `dailySummary` task copied verbatim from `email-recipe.json`, `export` from the five Dropbox plans (`atenea/dropbox`, version `2021`, one seat, latency 180 ms by hand, no storage requirement) and `quotes` with one hand-made candidate, `quotes.builtin.static` (TomatoMeter's own ten hard-coded quotes: 0 USD, availability 0.999, 2 ms). |
| `storage-recipe.json` | A new problem born from SPHERE: Dropbox (`atenea`, version `2021`) for an `export` task needing 1 000 GB. |

## The three revisions of `tomatometer-email`

| Revision | Made by | Choices |
|---|---|---|
| 1 | uploading `tomatometer-email.base.json` | one hand-made candidate per task |
| 2 | applying `email-recipe.json` | `dailySummary`: Postfix and the 17 public plans of the five e-mail providers |
| 3 | applying `tomatometer-recipe.json` | the same e-mail candidates; `export`: local disk and the five Dropbox plans; `quotes`: ZenQuotes and the built-in quotes |

A problem owns one recipe at a time: the generator rewrites only the catalogs and requirement predicates its
previous recipe made, and refuses one it did not make. So revision 3 is **one combined recipe** that repeats the
e-mail task exactly (same sources, same ids, same values) and adds the two new tasks, rather than a storage recipe
applied on top. `email-recipe.json` stays: it is the step that made revision 2 and the input of the generator's
goldens. The demand is the e-mail recipe's: 30 000 e-mails a month and 1 000 a day, which is TomatoMeter's daily
summary for 1 000 users (30 a month each). `export` has no storage requirement, so the base's local disk needs no
`storageLimit` and stays eligible. The generator's golden for revision 3 is the case `tomatometer-r3` of
`openbinding-gateway/tests/golden/sphere/cases.json`.

## Why JSON bundles and not package directories

Every directory of the repository that holds an `instance.json` joins the BIM corpus (`tools/check_bim_corpus.py`),
whose size is fixed and whose golden must equal bim-toolchain's byte for byte. So the base problem is a **JSON file
map** (`{"<path>": <JSON document>}`), as are the generator's goldens (`openbinding-gateway/tests/golden/sphere/`).
To make a `.bim.zip` of it:

```python
import json
from openbinding_gateway.integrations.packages import zip_files
from openbinding_gateway.modules.problems.application.sphere import dump

files = {path: dump(document) for path, document in json.load(open("tomatometer-email.base.json")).items()}
open("tomatometer-email.bim.zip", "wb").write(zip_files(files))
```

Upload it as a new problem, then preview and apply `email-recipe.json` on it, then `tomatometer-recipe.json`
(`POST /v1/organizations/{org}/problems/tomatometer-email/sphere/expand` and `…/sphere/apply`, once per recipe). `docs/SPHERE.md` describes the recipe.
