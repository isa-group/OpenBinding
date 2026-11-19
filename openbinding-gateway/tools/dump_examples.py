#!/usr/bin/env python3
"""Write the examples the gateway produces: ``examples/tomatometer/composition.yaml``.

``composition.yaml`` is the Composition2Yaml document the lab seals as ``lab-main/tomatometer`` 1.0.0, byte for byte.
A document links its organization's problem (``problem.ref``) and the toolchain's compilation digest, so it cannot be
written by hand: this tool runs the gateway in process (SQLite, the recorded SPHERE of ``tests/fixtures/sphere``, the
installed toolchain), creates the organization ``lab-main`` and instantiates the TomatoMeter composition template
there (``POST …/compositions/from-template``, the function the lab seed calls), then reads 1.0.0's stored content.
Nothing reaches the network.

    python tools/dump_examples.py              # rewrite examples/tomatometer/composition.yaml
    python tools/dump_examples.py --out DIR    # write DIR/composition.yaml instead
    python tools/dump_examples.py --check      # fail if the checked-in file differs

``--out DIR --switch`` also writes ``DIR/composition-1.1.0.yaml``, the 1.1.0 the seed derives (Resend PRO instead of
Brevo PROFESSIONAL), for the tests that read what the toolchain sums for each.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
from pathlib import Path

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", GATEWAY_ROOT.parent)).resolve()
TOMATOMETER = REPO_ROOT / "examples" / "tomatometer" / "composition.yaml"
#: The organization the lab seeds TomatoMeter into: the document's ``problem.ref`` names it.
ORGANIZATION = "lab-main"

sys.path.insert(0, str(GATEWAY_ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))


async def _documents(work: Path) -> dict[str, bytes]:
    """``1.0.0`` as the template seals it, and ``1.1.0`` as the seed derives it (the e-mail provider switched)."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from dump_frontend_fixtures import _install_recorded_sphere, _ok
    from openbinding_gateway import space_client
    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.access.work_limits import WorkRateLimiter, set_work_limiter
    from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app
    from openbinding_gateway.modules.compositions.application import templates
    from openbinding_gateway.space_client import OpenGate

    settings = get_settings()
    settings.artifact_root = str(work / "artifacts")
    settings.work_rate_limit_compile_requests = 0
    settings.work_rate_limit_read_requests = 0
    settings.work_rate_limit_evaluate_requests = 0
    set_work_limiter(WorkRateLimiter(primary=None))
    set_auth_limiter(AuthRateLimiter(primary=None))
    space_client.set_gate(OpenGate())
    settings.sphere_enabled = True
    _install_recorded_sphere(settings)

    engine = create_async_engine(f"sqlite+aiosqlite:///{work / 'examples.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _no_implicit_transactions(dbapi_connection, _record):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _begin_explicitly(connection):
        if connection.get_execution_options().get("isolation_level") != "AUTOCOMMIT":
            connection.exec_driver_sql("BEGIN")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    spec = templates.template("tomatometer").composition
    try:
        async with factory() as session:
            async def _session():
                yield session

            app.dependency_overrides[session_dependency] = _session
            app.dependency_overrides[optional_session] = _session
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
                details = {"username": "lab-owner", "email": "lab-owner@example.org", "password": "examples-throwaway-password"}
                _ok(await client.post("/v1/auth/register", json=details), 201)
                login = await client.post("/v1/auth/login",
                                          json={"username_or_email": "lab-owner", "password": details["password"]})
                headers = {"Authorization": f"Bearer {_ok(login, 200).json()['access_token']}"}
                _ok(await client.post("/v1/organizations", json={"slug": ORGANIZATION, "name": "Lab Main"},
                                      headers=headers), 201)
                base = f"/v1/organizations/{ORGANIZATION}/compositions"
                made = _ok(await client.post(f"{base}/from-template", json={"template": "tomatometer"},
                                             headers=headers), 201).json()
                revision = made["problem"]["revision"]
                _ok(await client.post(f"{base}/tomatometer/derive", headers=headers, json={
                    "revision": f"{made['problem']['slug']}@{revision}", "version": "1.1.0",
                    "binding": {**spec["binding"], "dailySummary": "email.resend.pro"}, "offering": spec["offering"],
                }), 201)
                documents = {}
                for label in ("1.0.0", "1.1.0"):
                    content = await client.get(f"{base}/tomatometer/versions/{label}/content", headers=headers)
                    documents[label] = _ok(content, 200).content
    finally:
        app.dependency_overrides.clear()
        space_client.set_gate(None)
        set_work_limiter(None)
        set_auth_limiter(None)
        await engine.dispose()
    return documents


def generate() -> dict[str, bytes]:
    """The documents of ``1.0.0`` and ``1.1.0`` by label; ``1.0.0`` is ``composition.yaml``."""
    from dump_frontend_fixtures import _environment

    _environment()
    with tempfile.TemporaryDirectory(prefix="openbinding-examples-") as work:
        return asyncio.run(_documents(Path(work)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--out", type=Path, help="Write composition.yaml to this directory instead.")
    target.add_argument("--check", action="store_true", help="Do not write; exit non-zero if the checked-in file differs.")
    parser.add_argument("--tomatometer", action="store_true", help="The TomatoMeter example (the only one; the default).")
    parser.add_argument("--switch", action="store_true",
                        help="With --out, also write composition-1.1.0.yaml: 1.1.0 as the lab seed derives it.")
    arguments = parser.parse_args(argv)

    documents = generate()
    produced = documents["1.0.0"]
    if arguments.check:
        current = TOMATOMETER.read_bytes() if TOMATOMETER.is_file() else b""
        if current != produced:
            print(f"{TOMATOMETER.relative_to(REPO_ROOT)} is out of date; run tools/dump_examples.py and commit the result.")
            return 1
        print(f"{TOMATOMETER.relative_to(REPO_ROOT)} is up to date.")
        return 0
    target_path = arguments.out / "composition.yaml" if arguments.out else TOMATOMETER
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(produced)
    print(f"Wrote {target_path}")
    if arguments.out and arguments.switch:
        (arguments.out / "composition-1.1.0.yaml").write_bytes(documents["1.1.0"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
