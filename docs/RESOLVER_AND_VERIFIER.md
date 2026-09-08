# Cryptographic Element Resolver & Digital Signature Verifier

Status: **normative**.
Implemented in: `openbinding-gateway/src/openbinding_gateway/routes/resolve.py`, `frontend/src/pages/Platform/VerifierPage.tsx`.

---

## 1. Overview

OpenBinding guarantees mathematical reproducibility across all optimization cases, instances, reports, and artifacts. The **Unified Resolver & Digital Signature Verifier** provides a cryptographic authenticity mechanism akin to a digital signature validator:

1. Given a canonical **SHA-256 digest** (or raw binary hash) and an element **`kind`**, it verifies whether the element exists and is authentic.
2. It returns rich provenance, authoritative signatures, ownership metadata, and every project/organization location where the element is cataloged.
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
  "citations": {
    "uri": "https://doi.org/10.5281/zenodo.openbinding.case-revision.sha256-a1b2c3d4...",
    "bibtex": "@article{openbinding_case-revision_sha256-a1b2c3d4...,\n  title={Production Flow V2},\n  author={Ada Lovelace},\n  year={2026}\n}"
  }
}
```

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
