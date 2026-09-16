"""Exact references and editorial requests; content and version hashes differ."""
from __future__ import annotations
from typing import Any, Literal
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field

DIGEST = r"^sha256-[0-9a-f]{64}$"
NAME = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"


class ArtifactRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    namespace: str = Field(min_length=1, max_length=128)
    name: str = Field(pattern=NAME)
    version: str = Field(min_length=1, max_length=64)
    versionDigest: str = Field(pattern=DIGEST)


class ArtifactCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=NAME)
    display_name: str = Field(min_length=1, max_length=160)
    kind: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=4000)


class ArtifactUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    labels: dict[str, str] | None = None
    archived: bool | None = None


class DraftContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: dict[str, Any] | str
    media_type: str = Field(default="application/json", max_length=160)
    contracts: list[dict[str, str]] = Field(default_factory=list, max_length=32)
    dependencies: list[ArtifactRef] = Field(default_factory=list, max_length=256)


class DraftCreate(DraftContent):
    based_on_id: UUID | None = None


class DraftUpdate(DraftContent):
    revision: int = Field(gt=0)


class SealDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(gt=0)
    version: str | None = Field(default=None, min_length=1, max_length=64)


class PublishVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    citation: dict[str, Any] = Field(default_factory=dict)


class ArtifactUse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = Field(pattern=NAME)
    alias: str = Field(pattern=NAME)
    artifact: ArtifactRef
    bindings: dict[str, str] = Field(default_factory=dict)


class ArtifactView(BaseModel):
    id: UUID
    organization_id: UUID
    namespace: str
    name: str
    display_name: str
    kind: str
    description: str
    labels: dict[str, str]
    archived: bool
    created_at: datetime


class ArtifactAddress(BaseModel):
    model_config = ConfigDict(extra='forbid')
    namespace: str = Field(min_length=1, max_length=128)
    name: str = Field(pattern=NAME)
    version: str = Field(min_length=1, max_length=64)


class ContractRef(ArtifactAddress):
    digest: str = Field(pattern=DIGEST)


class EvidenceRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['StudyRun', 'Job']
    id: UUID
    digest: str = Field(pattern=DIGEST)


class ArtifactManifest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    apiVersion: Literal['openbinding/artifact/v1']
    kind: str = Field(min_length=1, max_length=128)
    identity: ArtifactAddress
    contentDigest: str = Field(pattern=DIGEST)
    mediaType: str = Field(min_length=1, max_length=160)
    contracts: list[ContractRef]
    dependencies: list[ArtifactRef]
    evidence: list[EvidenceRef] = Field(default_factory=list)


class ArtifactVersionView(BaseModel):
    id: UUID
    artifact_id: UUID
    ordinal: int
    ref: ArtifactRef
    contentDigest: str = Field(pattern=DIGEST)
    manifest: ArtifactManifest
    based_on_id: UUID | None
    created_at: datetime
    public: bool
    withdrawn: bool


class ArtifactDraftView(BaseModel):
    id: UUID
    revision: int
    payload: DraftContent
    based_on_id: UUID | None


class DraftRevisionView(BaseModel):
    id: UUID
    revision: int


class CaseRevisionRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    caseRevisionId: UUID
    compositionDigest: str = Field(pattern=DIGEST)


class StudyArtifactContent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    apiVersion: Literal['openbinding/study/v1']
    cases: list[CaseRevisionRef] = Field(min_length=1, max_length=250)
    engines: list[dict[str, str]] = Field(min_length=1, max_length=50)
    parameter_sets: list[dict[str, Any]] = Field(default_factory=lambda: [{}], min_length=1, max_length=100)
    seeds: list[int] = Field(default_factory=lambda: [0], min_length=1, max_length=100)
    collection: ArtifactRef | None = None

    def definition(self):
        if any(not engine.get('mode') for engine in self.engines):
            raise ValueError('Every study engine must select an explicit mode.')
        from .platform import StudyDefinition
        return StudyDefinition(case_revision_ids=[case.caseRevisionId for case in self.cases],
            engines=self.engines, parameter_sets=self.parameter_sets, seeds=self.seeds)


class CollectionArtifactContent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    apiVersion: Literal['openbinding/collection/v1']
    members: list[CaseRevisionRef | ArtifactRef] = Field(max_length=1000)
