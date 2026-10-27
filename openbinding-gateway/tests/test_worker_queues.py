"""M9.6: the Dramatiq worker serves only the ``default`` queue.

The analysis queue, its ``analyze_archive_message`` actor and the module that
held it (``analysis_jobs``) are gone, so a worker started with
``dramatiq openbinding_gateway.worker`` declares no other queue.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util

from _paths import GATEWAY_ROOT

from openbinding_gateway import job_dispatch

SOURCE = GATEWAY_ROOT / "src" / "openbinding_gateway"


def declared_queues(broker) -> set[str]:
    return {broker.get_actor(name).queue_name for name in broker.get_declared_actors()}


def actor_queues(source: str) -> list[str]:
    """The queue of every ``@dramatiq.actor(...)`` in ``source``; ``default`` when none is named."""
    queues: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            target = decorator.func if isinstance(decorator, ast.Call) else decorator
            if not (isinstance(target, ast.Attribute) and target.attr == "actor"):
                continue
            named = [
                keyword.value for keyword in getattr(decorator, "keywords", []) if keyword.arg == "queue_name"
            ]
            queues.append(named[0].value if named and isinstance(named[0], ast.Constant) else "default")
    return queues


def test_the_worker_declares_actors_only_on_the_default_queue():
    # [utest->req~job-execution-default-queue-only~1]
    worker = importlib.import_module("openbinding_gateway.worker")
    broker = job_dispatch.run_persisted_job_message.broker

    assert declared_queues(broker) == {"default"}
    assert broker.get_declared_queues() == {"default"}
    assert "openbinding.run_persisted_job" in broker.get_declared_actors()
    assert "openbinding.analyze_archive" not in broker.get_declared_actors()
    assert not hasattr(worker, "analyze_archive_message")
    assert worker.__all__ == ["run_persisted_job_message"]


def test_the_analysis_queue_module_is_gone():
    # [utest->req~job-execution-default-queue-only~1]
    assert importlib.util.find_spec("openbinding_gateway.analysis_jobs") is None


def test_no_actor_in_the_gateway_names_another_queue():
    # [utest->req~job-execution-default-queue-only~1]
    found = {
        path.relative_to(SOURCE).as_posix(): actor_queues(path.read_text(encoding="utf-8"))
        for path in sorted(SOURCE.rglob("*.py"))
        if "__pycache__" not in path.parts
    }
    actors = {module: queues for module, queues in found.items() if queues}

    assert actors == {"job_dispatch.py": ["default"]}


def test_the_queue_detector_sees_named_and_default_queues():
    source = "\n".join(
        [
            "@dramatiq.actor(actor_name='a', queue_name='analysis')",
            "async def a(): ...",
            "@dramatiq.actor(max_retries=0)",
            "def b(): ...",
            "@dramatiq.actor",
            "def c(): ...",
            "@other.decorator",
            "def d(): ...",
        ]
    )

    assert actor_queues(source) == ["analysis", "default", "default"]
