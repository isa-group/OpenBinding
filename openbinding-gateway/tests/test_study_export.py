"""A study run exported whole by the server, as CSV or JSON (F2b B5): ``exportStudyRun``."""

from __future__ import annotations

import csv
import io
import json

from sqlalchemy import update

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from openbinding_gateway.db.models import StudyCell
from openbinding_gateway.studies import EXPORT_COLUMNS, export_csv, export_json
from test_b1_cell_result import BASE, build_world


def export_url(world, file_format=None) -> str:
    url = f"{BASE}/studies/compare/runs/{world.run['id']}/export"
    return url + (f"?format={file_format}" if file_format else "")


async def a_world(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2],
    )
    first, second = world.cells
    await db_session.execute(update(StudyCell).where(StudyCell.id == first.id).values(metrics={
        **first.metrics, "objectives": {"latency": 30.5, "cost": 2}, "runtimeSeconds": 1.25,
        "detail": 'said "hello", then left',
    }))
    await db_session.execute(update(StudyCell).where(StudyCell.id == second.id).values(metrics={
        **second.metrics, "objectives": {"cost": 3}, "feasible": False, "runtimeSeconds": None,
    }))
    await db_session.commit()
    return world


async def test_the_csv_has_one_row_per_cell_in_a_fixed_column_order(
    api_client, db_session, registration, gate, monkeypatch  # noqa: F811
):
    world = await a_world(api_client, db_session, registration, gate, monkeypatch)

    response = await api_client.get(export_url(world, "csv"), headers=world.headers)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="compare-run-1.csv"'
    assert response.text.endswith("\r\n")
    rows = list(csv.reader(io.StringIO(response.text)))
    header, first, second = rows
    assert header == [
        *EXPORT_COLUMNS, "objective.cost", "objective.latency",
        "metric.detail", "metric.solutionIndex", "metric.termination",
    ]
    engine = world.cells[0].engine_ref
    assert first == [
        str(world.cells[0].id), "checkout", "1", engine["namespace"], engine["name"], engine["version"], "seeded",
        "{}", "1", "completed", "true", "1.25", "2", "30.5", 'said "hello", then left', "0",
        world.jobs[0].termination,
    ]
    assert second[:1] == [str(world.cells[1].id)]
    assert second[8:16] == ["2", "completed", "false", "", "3", "", "", "0"]
    # The quoting is CSV's: the quote is doubled and the field quoted.
    assert '"said ""hello"", then left"' in response.text


async def test_the_json_holds_the_frozen_definition_and_every_cell(
    api_client, db_session, registration, gate, monkeypatch  # noqa: F811
):
    world = await a_world(api_client, db_session, registration, gate, monkeypatch)
    run = await api_client.get(f"{BASE}/studies/compare/runs/{world.run['id']}", headers=world.headers)

    response = await api_client.get(export_url(world, "json"), headers=world.headers)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/json"
    assert response.headers["content-disposition"] == 'attachment; filename="compare-run-1.json"'
    body = response.json()
    assert set(body) == {"study", "run", "definition", "cells"}
    assert body["study"]["slug"] == "compare" and body["study"]["name"] == "Compare"
    assert body["run"]["id"] == world.run["id"] and body["run"]["run_number"] == 1
    assert body["run"]["definition_digest"] == run.json()["definition_digest"]
    assert body["definition"] == run.json()["definition"]
    assert [cell["id"] for cell in body["cells"]] == [str(cell.id) for cell in world.cells]
    first = body["cells"][0]
    assert (first["problem"], first["revision"], first["seed"], first["state"]) == ("checkout", 1, 1, "completed")
    assert first["engine"] == world.cells[0].engine_ref and first["job_id"] == str(world.jobs[0].id)
    assert first["metrics"]["objectives"] == {"latency": 30.5, "cost": 2}


async def test_an_unknown_or_missing_format_is_refused(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await a_world(api_client, db_session, registration, gate, monkeypatch)

    assert (await api_client.get(export_url(world, "xlsx"), headers=world.headers)).status_code == 422
    assert (await api_client.get(export_url(world), headers=world.headers)).status_code == 422


async def test_a_non_member_is_refused_and_a_viewer_exports(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await a_world(api_client, db_session, registration, gate, monkeypatch)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    assert (await put_member(api_client, world.headers, "lab", viewer["id"], "VIEWER")).status_code in (200, 201)

    assert (await api_client.get(export_url(world, "csv"), headers=stranger)).status_code == 403
    assert (await api_client.get(export_url(world, "csv"), headers=viewer_headers)).status_code == 200


async def test_an_api_key_needs_studies_read(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await a_world(api_client, db_session, registration, gate, monkeypatch)

    async def key(*permissions):
        made = await api_client.post("/v1/users/me/api-keys", headers=world.headers, json={
            "name": "export " + " ".join(permissions), "permissions": list(permissions),
            "engine_access": {"all": True, "engines": []}, "boundary": {},
        })
        assert made.status_code == 201, made.text
        return {"X-API-Key": made.json()["secret"]}

    assert (await api_client.get(export_url(world, "json"), headers=await key("studies:read"))).status_code == 200
    refused = await api_client.get(export_url(world, "json"), headers=await key("problems:read"))
    assert refused.status_code == 403, refused.text


def test_an_empty_run_exports_the_header_and_no_cells():
    assert list(export_csv([])) == [",".join(EXPORT_COLUMNS) + "\r\n"]
    head = {"study": {"slug": "s"}, "run": {"run_number": 1}, "definition": {}}
    assert json.loads("".join(export_json(head, []))) == {**head, "cells": []}


def test_a_cell_without_metrics_has_empty_values():
    cell = {
        "id": "c", "problem": "p", "revision": 2, "engine": {"namespace": "n", "name": "e", "version": "1"},
        "parameters": {"b": 1, "a": [1, 2]}, "seed": 0, "state": "queued", "metrics": {},
    }

    rows = list(csv.reader(io.StringIO("".join(export_csv([cell])))))

    assert rows == [list(EXPORT_COLUMNS), ["c", "p", "2", "n", "e", "1", "", '{"a":[1,2],"b":1}', "0", "queued", "", ""]]
