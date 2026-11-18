# TomatoMeter

TomatoMeter's back end as a BIM problem, and the SPHERE import recipes that add real pricings to it.

| File | What it is |
|---|---|
| `tomatometer-email.base.json` | Revision 1 of the `tomatometer-email` problem: sign in, then send the daily summary e-mail and export the data in parallel, then fetch a quote. One hand-made candidate per task; the e-mail candidate (Postfix on a VPS) carries the `emailsPerMonth` and `emailsPerDay` properties the e-mail requirements read. Features `subscription` (USD/month, paid once per selected candidate), `availability` (a ratio, multiplied along the workflow) and `latency` (ms). |
| `email-recipe.json` | The flagship SPHERE import for the `dailySummary` task: the five e-mail providers of the `danruilop1` set (SendGrid, Mailgun, Brevo, Resend, Postmark, version `2026-10` each), a demand of 30 000 e-mails a month and 1 000 a day, the subscription from each plan's price, the availability from the uptime guarantees through one table (SendGrid and Postmark, which publish none, by hand) and the latency by hand. SendGrid declares no daily limit, so the recipe assumes it unlimited. |
| `storage-recipe.json` | A new problem born from SPHERE: Dropbox (`atenea`, version `2021`) for an `export` task needing 1 000 GB. |

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

Upload it as a new problem, then preview and apply `email-recipe.json` on it
(`POST /v1/organizations/{org}/problems/tomatometer-email/sphere/expand` and `…/sphere/apply`); the lab seed
(`openbinding-gateway/tools/seed_lab.py`) does exactly that. `docs/SPHERE.md` describes the recipe.
