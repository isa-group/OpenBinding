import uuid

import pytest
import pytest_asyncio

from _pricing import pricing_catalog
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.services import execution
from openbinding_gateway.services.engine_registry import CancellationCapability
from openbinding_gateway.v1 import remote


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.commit()
    return user


class RemoteStub:
    """Stands in for ``cancel_remote`` and records which remote jobs were asked to stop."""

    def __init__(self) -> None:
        self.cancelled: list[str] = []

    async def cancel(self, _registration, engine_job_id, **_kwargs) -> bool:
        self.cancelled.append(engine_job_id)
        return True


@pytest.fixture
def remote_stub(monkeypatch) -> RemoteStub:
    stub = RemoteStub()
    # Both names: a fix may call the transport through either module.
    monkeypatch.setattr(execution, "cancel_remote", stub.cancel)
    monkeypatch.setattr(remote, "cancel_remote", stub.cancel)
    return stub


@pytest.fixture
def declared_cancellation(monkeypatch) -> CancellationCapability:
    """The built-in engines of the jobs submitted over HTTP declare nothing; this one declares per-attempt cancellation."""
    capability = CancellationCapability(declared=True, supported=True, id_scope="attempt")
    monkeypatch.setattr(execution, "registration_cancellation", lambda _registration: capability)
    return capability
