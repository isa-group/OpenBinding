## ADDED Requirements

### Requirement: One Verify page
THE frontend SHALL serve opening a permanent link, looking up a digest and checking a document or a file on one public routed screen `verify` at `/verify/:kind?/:digest?`, in place of the screens `pub-resolve` and `verifier`.

`req~frontend-nav-verify-page~1`

Needs: impl, utest

In the scenarios of this delta, `D` stands for `sha256-` followed by 64 times the digit `1`. Notes: design.md §11.21.

#### Scenario: One screen in the registry
- **GIVEN** the route registry after the change
- **WHEN** the verify area test lists its screens
- **THEN** it lists only `verify` with the path `/verify/:kind?/:digest?`, in the public layout and with no sign-in requirement
- **AND** neither `pub-resolve` nor `verifier` is declared

#### Scenario: A permanent link in the address
- **GIVEN** a gateway that resolves the report digest `D` to the published result `Engine comparison`
- **WHEN** a visitor opens `/verify/report/D`
- **THEN** the frontend sends `GET /v1/resolve/report/D` once
- **AND** the page shows `Engine comparison`

#### Scenario: A permanent link pasted into the form
- **GIVEN** a visitor on `/verify` in the mode `Link or digest`
- **WHEN** the visitor pastes `https://ob.example/resolve/case-revision/D` and submits
- **THEN** the address becomes `/verify/case-revision/D`

#### Scenario: A digest without a kind, signed in
- **GIVEN** a signed-in person
- **WHEN** the person opens `/verify?digest=D`
- **THEN** the frontend posts the digest `D` to `/v1/verifier/inspect`
- **AND** the matches the gateway lists are shown

#### Scenario: A document and a file, signed in
- **GIVEN** a signed-in person on `/verify`
- **WHEN** the person checks a pasted document in the mode `Document` and then a file in the mode `File`
- **THEN** the frontend posts the document to `/v1/verifier/inspect` and the file to `/v1/verifier/inspect-file`

### Requirement: Permanent verification links keep working
WHEN a person opens `/resolve/:kind/:digest` or `/app/verifier`, THE frontend SHALL replace the current history entry with `/verify/<kind>/<digest>` or `/verify` respectively, keeping the query and the hash, whether or not the person is signed in.

`req~frontend-nav-verify-permanent-links~1`

Needs: impl, utest

`D` as in "One Verify page". Notes: design.md §11.22.

#### Scenario: Every resolver kind while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/resolve/<kind>/D` for each kind of `case-revision`, `resource-revision`, `collection-revision`, `report`, `artifact`, `engine`, `dialect`, `registered-resource`, `instance-snapshot` and `binding-ir`
- **THEN** each address becomes `/verify/<kind>/D`
- **AND** `/login` is never shown

#### Scenario: Signed in, with a query and a hash
- **GIVEN** a signed-in person
- **WHEN** the person opens `/resolve/report/D?page=2#locations`
- **THEN** the address becomes `/verify/report/D?page=2#locations`

#### Scenario: Verifier citation link while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/app/verifier?digest=D`
- **THEN** the address becomes `/verify?digest=D`
- **AND** `/login` is never shown

#### Scenario: The entries stay
- **GIVEN** the moved-routes table
- **WHEN** the verify area test reads it
- **THEN** it holds the entries `/resolve/:kind/:digest` and `/app/verifier`, both marked `permanent`
- **AND** the test fails when either entry is missing or not marked `permanent`

#### Scenario: Copied permanent link
- **GIVEN** a visitor on `/verify/report/D` and a resolved published result
- **WHEN** the visitor copies its permanent link
- **THEN** the clipboard holds `<origin>/resolve/report/D`

### Requirement: Verify without an account
WHILE no person is signed in, THE Verify page SHALL resolve links and digests only through `GET /v1/resolve/{kind}/{digest}` and show, in place of the document and file checks, the text `Log in to check a document or a file` with a link to `/login` that returns to the Verify page.

`req~frontend-nav-verify-signed-out~1`

Needs: impl, utest

`D` as in "One Verify page". Notes: design.md §11.23.

#### Scenario: A permanent link while signed out
- **GIVEN** no session and a gateway that resolves the report digest `D`
- **WHEN** the visitor opens `/verify/report/D`
- **THEN** the frontend sends `GET /v1/resolve/report/D`
- **AND** it sends no request whose path starts with `/v1/verifier/`

#### Scenario: Document mode while signed out
- **GIVEN** no session, on `/verify`
- **WHEN** the visitor chooses the mode `Document`
- **THEN** the text `Log in to check a document or a file` is shown with a link to `/login`
- **AND** following the link and signing in returns to `/verify`
- **AND** no document field and no request to `/v1/verifier/inspect` exist

#### Scenario: A digest without a kind while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/verify?digest=D`
- **THEN** the digest field holds `D` and a kind selector is shown
- **AND** no request is sent until the visitor chooses a kind
- **AND** choosing `case-revision` sends `GET /v1/resolve/case-revision/D` and changes the address to `/verify/case-revision/D`

#### Scenario: Nothing public matches
- **GIVEN** no session and a gateway that answers 404 to `GET /v1/resolve/report/D`
- **WHEN** the visitor opens `/verify/report/D`
- **THEN** the text `Nothing public matches this digest` is shown, with the form still available
- **AND** the page shows the same text when the gateway's 404 is for a private element

### Requirement: Verify shows no raw JSON
THE Verify page SHALL show the canonical JSON of a checked document only through `SourceView`, in a region named `Canonical JSON` inside a disclosure that starts collapsed.

`req~frontend-nav-verify-no-raw-json~1`

Needs: impl, utest

Notes: design.md §11.24.

#### Scenario: Canonical JSON collapsed
- **GIVEN** a signed-in person on `/verify` and a verifier answer with a `canonical_json` for the pasted document
- **WHEN** the result is shown
- **THEN** a disclosure `Canonical JSON` is shown collapsed, and the canonical JSON is not visible
- **AND** opening it shows a `SourceView` region named `Canonical JSON` with the button `Copy Canonical JSON`

#### Scenario: No raw block on the page
- **GIVEN** the rendered Verify page after a document check, with the disclosure open
- **WHEN** the test lists the `pre` elements of the page
- **THEN** every `pre` element is inside a `SourceView` region

#### Scenario: Offender 6 is gone
- **GIVEN** the raw-rendering allow-list after the change
- **WHEN** the hygiene test reads it
- **THEN** no entry names `pages/Reports/Verifier.tsx` or a file under `pages/Verify/`
- **AND** no detector finding is reported in a file under `pages/Verify/`
