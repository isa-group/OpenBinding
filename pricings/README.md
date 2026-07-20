# FaaS iPricings (Pricing2Yaml)

Machine-readable pricing models — **iPricings** — for the three FaaS providers used by
OpenBinding4Placement to derive candidate execution costs in CLASP-FaaS instances:

| Provider | Offering | Billing mode used in the study | Files |
|---|---|---|---|
| AWS | Lambda | `ON_DEMAND` | `aws/aws_lambda_pricing.yml` + `aws/lambda_variables.yml` |
| Azure | Functions | `CONSUMPTION` | `azure/azure_functions_pricing.yml` + `azure/azure_functions_variables.yml` |
| Google Cloud | Cloud Run functions | `REQUEST_BASED` | `gcloud/google_cloud_functions_pricing.yml` + `gcloud/google_cloud_functions_variables.yml` |

Each iPricing is written in **Pricing2Yaml** (`syntaxVersion: '3.2'`) using an **experimental
variables extension**: because stock Pricing2Yaml only supports inline scalar variables, it cannot
adequately represent multidimensional FaaS pricings. In the extension, variables are typed
declarative entities that can be resolved from external structured sources:

- **`valueType: ENUM`** — selector variables (region, architecture, plan tier) whose domains may be
  computed from other variables, e.g. `enumValues: '#pricesPerRegionAndArchitecture.keys()'`.
- **`valueType: EXTERNAL`** — volatile rate tables resolved through a `connector`
  (`type: LOCAL`, `path`, `key`) pointing to the sibling `*_variables.yml` file, which is
  regenerated from the provider pricing APIs by `generate_*_variables.py` without modifying the
  stable structure of the offering.
- Billing modes are modeled as **plans**, billable meters (requests, GB-seconds, vCPU-seconds) as
  **quantitative add-ons**, monthly allowances as **renewable usage limits**, and prices reference
  variables through `#` expressions, e.g.
  `price: '#pricesPerRegionAndArchitecture[#region][#architecture]["firstGbSeconds"]'`.

The metering transformation that combines these iPricings with expected-consumption profiles
(invocations, execution duration, allocated resources) to obtain per-candidate monthly costs lives
in `experimentation/icsoc/bimstar/pricing.py`; the resulting cost is attached to each candidate as
a BIM′ feature.
