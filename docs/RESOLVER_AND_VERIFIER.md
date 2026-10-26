# Content Digest Resolver and Verifier

Status: **normative**.
Implemented in: `openbinding-gateway/src/openbinding_gateway/routes/resolve.py`, `frontend/src/pages/Platform/VerifierPage.tsx`.

---

## 1. Overview

The resolver locates accessible records by content digest. SHA-256 verifies content equality; it is not an author signature and does not guarantee mathematical or numerical reproducibility. The organization library uses separate content and version-manifest digests; see [versioned artifacts](VERSIONED_ARTIFACTS.md). The legacy resolver provides:

1. Given a canonical **SHA-256 digest** (or raw binary hash) and an element **`kind`**, it verifies whether an accessible matching element exists.
2. It returns rich provenance, recorded ownership metadata, and every project/organization location where the element is cataloged.
3. It allows in-situ inspection and downloading of the canonical content without needing prior knowledge of internal database IDs or project URLs.
4. It replaces and supersedes all legacy `/v1/public/*` routes with an authenticated, paginated, and cache-optimized architecture.

```
                  ┌─────────────────────────────────────────┐
                  │    Digest + Kind (SHA-256 RFC 8785)     │
                  └────────────────────┬────────────────────┘
                                       │
                         GET /v1/resolve/{kind}/{digest}
                                       │
                  ┌────────────────────▼────────────────────┐
                  │       Security & Permission Gate        │
                  │  (Public domain OR Caller has access)   │
                  └────────────────────┬────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │                                           │
         Found & Allowed                           Not found or private
                 │                                           │
     ┌───────────▼───────────┐                     ┌─────────▼─────────┐
     │ 200 OK Response       │                     │ 404 Not Found     │
     │ - Cryptographic Seal  │                     │ (Zero Information │
     │ - Provenance Metadata │                     │  Leakage)         │
     │ - Locations (Offset/L)│                     └───────────────────┘
     │ - In-situ Content URL │
     └───────────────────────┘
```

---

## 2. API Contract

### 2.1 Metadata & Location Resolution

```http
GET /v1/resolve/{kind}/{digest_value}?limit={limit}&offset={offset}
```

#### Path Parameters
* `kind` (*string*, required): The kebab-case element kind.
* `digest_value` (*string*, required): Canonical digest. Accepts `sha256-<hex>` or raw 64-character hexadecimal `<hex>`.

#### Query Parameters
* `limit` (*integer*, optional, default: 10, min: 1, max: 100): Number of catalog locations to return per page.
* `offset` (*integer*, optional, default: 0, min: 0): Zero-based starting index of catalog locations.

#### Headers
* `Authorization: Bearer <token>` (*optional*): If provided, caller permissions are evaluated across organizations and private projects. If omitted, only public elements are resolved.

#### Supported Element Kinds

All `kind` parameters strictly use **kebab-case**:

| Kind | Target Object | Digest Standard |
|---|---|---|
| `case-revision` | Binding case revision | RFC 8785 canonical JSON SHA-256 |
| `resource-revision` | Project resource revision | RFC 8785 canonical JSON SHA-256 |
| `collection-revision` | Curated collection revision | RFC 8785 canonical JSON SHA-256 |
| `report` | Published benchmark/study report | RFC 8785 canonical JSON SHA-256 |
| `artifact` | Binary or text artifact file | Raw file SHA-256 |
| `engine` | Engine manifest specification | RFC 8785 canonical JSON SHA-256 |
| `dialect` | Dialect manifest specification | RFC 8785 canonical JSON SHA-256 |
| `registered-resource` | Global resource definition | RFC 8785 canonical JSON SHA-256 |
| `instance-snapshot` | Frozen problem instance snapshot | RFC 8785 canonical JSON SHA-256 |
| `binding-ir` | Emitted BindingProblem IR | RFC 8785 canonical JSON SHA-256 |

#### Response Schema (`200 OK`)

```json
{
  "verified": true,
  "kind": "case-revision",
  "digest": "sha256-a1b2c3d4...",
  "normalized_digest": "sha256-a1b2c3d4...",
  "canonical_url": "/v1/resolve/case-revision/sha256-a1b2c3d4.../content",
  "name": "Production Flow V2",
  "title": "High-Throughput QoS Flow",
  "media_type": "application/json",
  "size_bytes": 45120,
  "created_at": "2026-03-15T10:00:00Z",
  "author": {
    "id": "usr_99120",
    "name": "Ada Lovelace",
    "email": "ada@openbinding.org"
  },
  "organization": {
    "id": "org_us_research",
    "slug": "isa-group",
    "name": "ISA Research Group"
  },
  "project": {
    "id": "prj_qos_eval",
    "slug": "qos-benchmarks",
    "name": "QoS Benchmarks",
    "visibility": "public"
  },
  "metadata": {
    "revision_number": 2,
    "case_id": "case_prod_flow",
    "notes": "Verified against 100k simulated requests"
  },
  "locations": [
    {
      "organization_slug": "isa-group",
      "organization_name": "ISA Research Group",
      "project_slug": "qos-benchmarks",
      "project_name": "QoS Benchmarks",
      "visibility": "public",
      "role": "primary",
      "catalog_url": "/app/isa-group/qos-benchmarks/cases"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 10,
    "offset": 0,
    "has_more": false
  },
  "citation": {
    "title": "Production Flow V2",
    "authors": [],
    "year": 2026,
    "doi": null,
    "venue": null,
    "url": "https://<frontend origin>/resolve/case-revision/sha256-a1b2c3d4...",
    "bibtex": "...",
    "markdown_badge": "..."
  }
}
```

#### `citation`

`citation` is an object with `title`, `authors`, `year`, `doi`, `venue`, `url`,
`bibtex` and `markdown_badge`. It never contains invented metadata
(`req~resolver-verifier-citation-no-invented-metadata~1`):

* `doi` and `venue` come only from the recorded publication citation of the
  exact version. A DOI is shown only when it is well-formed; otherwise `doi` is
  `null`. Without a recorded publication both `doi` and `venue` are `null`.
* `authors` is `[]` when none is recorded.
* `doi`, `venue` and `authors` come only from the recorded publication of the
  exact library version. A withdrawn publication is not cited.
* `year` comes from the recorded citation; if there is none, from the
  publication date; if there is none, from the creation date of the cited
  version or element (`req~resolver-verifier-citation-year~1`).
* `url` and the badge link are on the configured `FRONTEND_URL` origin and are
  the public permanent link `/resolve/<kind>/<digest>`
  (`req~resolver-verifier-citation-url~1`).

For `POST /v1/verifier/inspect` and `/inspect-file`:

* `citation` is `null` when no visible element matches the digest: computed,
  mismatch, not_found, hidden and unknown digests all alike.
* Otherwise the first visible match is cited. Its `kind` is `case-revision`,
  `collection-revision`, `report`, `artifact` or `engine`.
* A snapshot, a study run and a file that belongs to no project have no
  resolvable link; they use `/app/verifier?digest=<digest>`. A snapshot
  resolves only for its owner.

#### `locations[].web_url`

`web_url` is a path of the **current frontend** (`frontend/src/routes/d*.tsx`) or
`null` when the element has no screen. It is never a route that does not exist.

| Kind | `web_url` |
|---|---|
| `case-revision` | `/app/{org}/{project}/cases/{case}/revisions/{revision}` |
| `resource-revision` | `/app/{org}/library/{artifact-id}/versions/{version}` |
| `collection-revision` | library version as above; legacy project collections: `/app/{org}/{project}/collections/{collection}` |
| `report` | `/app/{org}/{project}/reports/{report}` |
| `artifact` (file) | `/app/{org}/{project}/files` |
| `engine` | `/engines/{namespace}/{name}/{version}` |
| `instance-snapshot`, `binding-ir` | `/app/{org}/{project}/snapshots/{snapshot-id}` when the caller owns the snapshot and a case revision of a project they can open was sealed from it; otherwise `null` |
| `dialect`, `registered-resource` | `null` (no detail screen) |

Library artifacts are addressed by id because a name can only be resolved by
members of the owning organization. Every path segment is URL-escaped.

---

### 2.2 Content Download & Streaming

```http
GET /v1/resolve/{kind}/{digest_value}/content
```

Directly streams the raw payload (canonical JSON document, binary artifact, or report).

* **Public elements**: Response includes HTTP headers `ETag: "{digest}"` and `Cache-Control: public, max-age=31536000, immutable`.
* **Private elements**: Response includes HTTP headers `Cache-Control: private, no-cache, no-store`.

---

## 3. Security & Anti-Leakage Architecture

To protect private intellectual property, the resolver adheres to a strict **Zero Information Leakage** principle:

1. **Uniform 404 Status**: If an element is private and the caller lacks permissions (or is unauthenticated), the endpoint returns `404 Not Found`. It **never** returns `403 Forbidden`, ensuring that malicious callers cannot enumerate or confirm the existence of private organizational models.
2. **Permission Boundary**: The resolver checks the user's membership and organization roles via `get_optional_user`. If any location containing the digest is public or accessible to the caller, the response succeeds with `200 OK` and only lists the locations the user is permitted to see.

### Verifier endpoints

`POST /v1/verifier/inspect` and `POST /v1/verifier/inspect-file` keep requiring an account (an anonymous call is `401`, as before). The registered elements they list are filtered by what the caller can see:

* a case, collection or study-run revision, and a project file, appear only to members of the organization (or an ancestor of it), or when the project is public (a file also needs to be marked public);
* a library version or report appears to members of its organization or once published;
* an engine appears when published or when the caller owns it; a snapshot when it is shared, owned by the caller, or used by a case of a project the caller can see.

Anything else is dropped before the response is built, so a private element of someone else is **indistinguishable from an unregistered digest**: same status (`not_found` for a digest, `computed` for a document or file), same fields and the same `detail` text, with no organization, project, title or count of the hidden element. The same queries run whatever the digest matches, so response time does not depend on how many hidden elements exist. Project names are shown only for projects the caller could open themselves. Platform administrators get no wider view than any other account.

---

## 4. Frontend Verifier & Replication Studio

The OpenBinding web client includes a dedicated **Digital Signature & Provenance Verifier** at `/app/verifier`:

* **Dynamic Holographic Seal**: Displays an animated SVG badge with rotating cryptographic rings, gradient pulse, and authoritative verification tick upon match.
* **Client-Side Canonical Dual-Check**: Users can paste JSON source code directly into the browser. The UI parses and computes RFC 8785 canonical hash locally and compares it with the resolver's remote verification in real-time.
* **Direct File Dropzone**: Drag-and-drop any binary or data artifact to compute its browser-side SHA-256 and look it up immediately in the platform registry.
* **Provenance & Identity Grid**: Clear visual breakdown of author, owner organization, visibility, creation timestamps, and payload byte size.
* **Multi-Location Pagination**: Browse all projects and workspaces referencing the verified revision with previous/next offset paging controls.
* **In-Situ Document Viewer**: Inspect formatted JSON contents inline or download directly with a single click.
* **Open Science Citations**: One-click copy for persistent URI / DOI references and academic BibTeX entries.
