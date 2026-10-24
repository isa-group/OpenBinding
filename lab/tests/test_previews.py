"""Tests of the PR preview planner ``lab/previews/previews.py``, through its command line.

The planner is the reference of the rules the factory's ``labctl preview`` follows (design.md
section 1 of ``openspec/changes/m05-pr-previews``): port allocation, names, synthetic
environment, refresh, expiry, memory cap and refusals. It reads a state document and the facts
passed as flags, prints one JSON object and has no side effects. These tests are the contract it
must pass. They never import it: each one runs it as a subprocess, so a missing planner fails
the assertions on the exit code instead of failing at collection.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest -q ../lab/tests/test_previews.py

Two readings of the contract are fixed here: environment values are JSON strings (``"18101"``,
``"false"``, ``""``), and "long and random" for ``DEMO_JWT_SECRET`` means at least 32 characters.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

PLANNER = Path(__file__).resolve().parents[2] / "lab" / "previews" / "previews.py"
EX_USAGE = 64

PLAN_KEYS = {"action", "refusal", "port", "project", "env", "commands", "record"}
SECRETS = ("DEMO_PG_PASSWORD", "DEMO_JWT_SECRET", "DEMO_FERNET_KEY", "DEMO_BIM_TOKEN", "DEMO_SEED_PASSWORD")
EMPTY_ENV = ("SPACE_API_KEY", "SPACE_URL", "SPACE_ORGANIZATION_ID", "SPHERE_API_KEY")

REPO = "isa-group/OpenBinding"
COMPOSE = "compose.lab-process.json"
TRACKED = (COMPOSE, "README.md")
MEM = 4032  # declared mem_limit sum of one lab stack, MiB
NOW = "2026-11-08T10:00:00Z"
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def sha(prefix: str) -> str:
    return (prefix + "0" * 40)[:40]


def image_id(pair: str) -> str:
    return "sha256:" + pair * 32


HEAD = sha("3f2a")
NEW = sha("9c1d")
AA, BB, CC, DD, A1, B2 = (image_id(pair) for pair in ("aa", "bb", "cc", "dd", "a1", "b2"))


def ago(hours: int, minutes: int = 0) -> str:
    return (datetime.strptime(NOW, TIME_FORMAT) - timedelta(hours=hours, minutes=minutes)).strftime(TIME_FORMAT)


def run_planner(*args: str) -> tuple[int, dict | None]:
    """Run ``previews.py plan <args>``; return the exit code and the stdout object, None if it is not one."""
    try:
        done = subprocess.run(
            [sys.executable, str(PLANNER), "plan", *args], capture_output=True, text=True, errors="replace",
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return -1, None
    try:
        out = json.loads(done.stdout)
    except ValueError:
        return done.returncode, None
    return done.returncode, out if isinstance(out, dict) else None


def planned(*args: str) -> dict:
    """A plan or a refusal: exit code 0 and exactly the output keys of the contract."""
    code, plan = run_planner(*args)
    assert code == 0, f"planner exited {code} for {args[:1]}"
    assert plan is not None, "planner did not print a JSON object"
    assert set(plan) == PLAN_KEYS, f"unexpected keys {sorted(plan)}"
    return plan


def usage_error(*args: str) -> None:
    code, out = run_planner(*args)
    assert code == EX_USAGE, f"expected exit {EX_USAGE}, got {code}"
    assert out is None, f"a usage error printed {out}"


def record(pr: int, *, status: str = "ready", port: int | None = 18101, head: str = HEAD,
           last_active: str | None = None, last_activity: str = "request", images=(), mem: int = MEM) -> dict:
    project = f"openbinding-pr-{pr}"
    return {
        "pr": pr, "head_sha": head, "pending_head_sha": None, "previous_head_sha": None, "port": port,
        "project": project, "compose_file": COMPOSE,
        "volumes": [f"{project}_{name}" for name in ("lab-pg-3", "lab-redis", "lab-artifacts-2", "lab-e2e")],
        "images": [{"id": image, "tag": tag} for image, tag in images], "mem_mib": mem, "status": status,
        "created_at": ago(300), "last_active_at": last_active or ago(1), "last_activity": last_activity,
        "error": None,
    }


def held_ports(count: int) -> list[dict]:
    """Records of PR 1..count holding 18101.."""
    return [record(i + 1, port=18101 + i) for i in range(count)]


def stack(project: str, mib: int = MEM) -> dict:
    return {"project": project, "mem_mib": mib}


def write_state(tmp_path: Path, records) -> Path:
    path = tmp_path / f"state-{uuid.uuid4().hex}.json"
    path.write_text(json.dumps({"records": list(records)}))
    return path


def flags(state: Path, *, pr: int = 42, head: str = HEAD, pr_state: str = "open", repo: str = REPO,
          tracked=TRACKED, running=(), listening=(), mem: int = MEM, now: str = NOW, head_flag: str | None = None,
          kind: str | None = None, tags: dict | None = None, seed: int | None = None) -> dict[str, str]:
    """Every flag of the contract; ``head`` is the PR's current head (``pr-info.head_sha``)."""
    given = {
        "--state": str(state), "--pr": str(pr), "--now": now,
        "--pr-info": json.dumps({"state": pr_state, "head_repo": repo, "head_sha": head}),
        "--tracked": json.dumps(list(tracked)), "--running": json.dumps(list(running)),
        "--listening": json.dumps(list(listening)), "--head-mem-mib": str(mem),
    }
    for flag, value in (("--head", head_flag), ("--kind", kind), ("--seed-rng", seed)):
        if value is not None:
            given[flag] = str(value)
    if tags is not None:
        given["--tags"] = json.dumps(tags)
    return given


def argv(given: dict[str, str]) -> list[str]:
    return [part for item in given.items() for part in item]


def plan_for(tmp_path: Path, name: str, records=(), **kw) -> dict:
    return planned(name, *argv(flags(write_state(tmp_path, records), **kw)))


def up(pr: int, *extra: str) -> list[str]:
    return ["lab_compose", "up", "--project", f"openbinding-pr-{pr}", *extra]


def destroy(pr: int) -> list[str]:
    return ["labctl", "destroy", "preview", str(pr)]


def deletes(command: list[str]) -> bool:
    """The proxy of deletion, element by element (so ``--verbose`` is not ``-v``)."""
    pairs = list(zip(command, command[1:]))
    return bool({"-v", "--volumes", "--rmi", "rmi"} & set(command)) or ("volume", "rm") in pairs \
        or ("image", "rm") in pairs


def image_removals(plan: dict) -> list[list[str]]:
    return [command for command in plan["commands"] if command[:3] == ["docker", "image", "rm"]]


def non_secret_env(plan: dict) -> dict:
    return {name: value for name, value in plan["env"].items() if name not in SECRETS}


def assert_env_kept(tmp_path: Path, plan: dict) -> None:
    """The five secrets are kept and the rest equals the environment of a first start on the same port."""
    assert all(plan["env"][name] == {"keep": True} for name in SECRETS)
    first = plan_for(tmp_path, "request", listening=list(range(18101, plan["port"])))
    assert first["port"] == plan["port"]
    assert non_secret_env(plan) == non_secret_env(first)


# --- Preview on demand per PR head -------------------------------------------------------------


# [utest->req~lab-deployment-preview-on-demand~1]
def test_request_for_an_open_pr_plans_one_stack_at_its_head(tmp_path):
    plan = plan_for(tmp_path, "request")
    assert plan["action"] == "request"
    assert plan["refusal"] is None
    assert plan["project"] == "openbinding-pr-42"
    assert plan["port"] == 18101
    assert plan["commands"] == [up(42, "--build")]
    assert plan["record"] is not None
    assert plan["record"]["head_sha"] == HEAD


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize("pr_state", ["closed", "merged"])
def test_closed_or_merged_pr_is_refused_as_not_eligible(tmp_path, pr_state):
    plan = plan_for(tmp_path, "request", pr_state=pr_state)
    assert plan["refusal"] == "preview_pr_not_eligible"
    assert plan["record"] is None
    assert plan["port"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-on-demand~1]
def test_fork_pr_is_refused_as_not_eligible(tmp_path):
    plan = plan_for(tmp_path, "request", pr=57, repo="someone/OpenBinding")
    assert plan["refusal"] == "preview_pr_not_eligible"
    assert plan["record"] is None
    assert plan["port"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-on-demand~1]
def test_only_request_and_refresh_plan_an_up_without_a_record(tmp_path):
    other = record(7, port=18101)
    plans = {
        name: plan_for(tmp_path, name, [other], head=NEW, kind="open")
        for name in ("open", "expire", "activity", "stop", "destroy-check")
    }
    for name, plan in plans.items():
        assert plan["refusal"] is None, name
        assert plan["record"] is None, name
        assert plan["commands"] == [], name
        assert not any("up" in command for command in plan["commands"]), name
    # the other two start a stack for the same state
    for name in ("request", "refresh"):
        assert plan_for(tmp_path, name, [other], head=NEW)["commands"] == [up(42, "--build")]


# [utest->req~lab-deployment-preview-on-demand~1]
def test_refresh_without_a_record_acts_as_request(tmp_path):
    plan = plan_for(tmp_path, "refresh")
    assert plan["refusal"] is None
    assert plan["port"] == 18101
    assert plan["commands"] == [up(42, "--build")]
    assert plan["record"]["head_sha"] == HEAD


REQUIRED = {
    "request": ["--state", "--pr", "--now", "--pr-info", "--tracked", "--head-mem-mib"],
    "refresh": ["--state", "--pr", "--now", "--pr-info", "--tracked", "--head-mem-mib"],
    "open": ["--state", "--pr", "--now", "--pr-info", "--tracked", "--head-mem-mib"],
    "stop": ["--state", "--pr"],
    "expire": ["--state", "--now"],
    "activity": ["--state", "--pr", "--now", "--kind"],
    "destroy-check": ["--state", "--pr"],
}
MISSING = [(name, "open", flag) for name, needed in REQUIRED.items() for flag in needed]
MISSING += [("activity", kind, "--pr-info") for kind in ("g12", "screenshot")]
EXACT = [(name, "open") for name in REQUIRED] + [("activity", kind) for kind in ("request", "refresh", "g12", "screenshot")]


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize(("name", "kind"), EXACT)
def test_exactly_the_required_flags_are_enough(tmp_path, name, kind):
    given = flags(write_state(tmp_path, [record(42, status="stopped")]), kind=kind)
    needed = REQUIRED[name] + (["--pr-info"] if name == "activity" and kind in ("g12", "screenshot") else [])
    plan = planned(name, *argv({flag: value for flag, value in given.items() if flag in needed}))
    assert plan["action"] == name


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize(("name", "kind", "missing"), MISSING)
def test_missing_required_flag_is_a_usage_error(tmp_path, name, kind, missing):
    given = flags(write_state(tmp_path, [record(42)]), kind=kind)
    assert missing in given
    del given[missing]
    usage_error(name, *argv(given))


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize("name", ["health", "list"])
def test_unknown_plan_is_a_usage_error(tmp_path, name):
    usage_error(name, *argv(flags(write_state(tmp_path, []))))


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize(
    ("name", "flag"),
    [("request", "--pr-info"), ("request", "--tracked"), ("request", "--running"), ("request", "--listening"),
     ("destroy-check", "--tags")],
)
def test_malformed_json_flag_is_a_usage_error(tmp_path, name, flag):
    given = flags(write_state(tmp_path, []), tags={})
    given[flag] = "{not json"
    usage_error(name, *argv(given))


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize(("flag", "value"), [
    ("--tracked", json.dumps(COMPOSE)),  # a string would pass a substring check
    ("--tracked", json.dumps([COMPOSE, 7])),
    ("--tracked", json.dumps({COMPOSE: True})),
    ("--listening", json.dumps(["18101"])),
    ("--listening", json.dumps("18101")),
    ("--listening", json.dumps([True])),
    ("--running", json.dumps([{"project": "openbinding-lab", "mem_mib": -1}])),
    ("--running", json.dumps([{"project": "openbinding-lab", "mem_mib": "4032"}])),
    ("--running", json.dumps([{"mem_mib": MEM}])),
    ("--running", json.dumps(["openbinding-lab"])),
    ("--tags", json.dumps({"openbinding-lab-gateway:18101": 7})),
    ("--tags", json.dumps(["openbinding-lab-gateway:18101"])),
    ("--pr-info", json.dumps(["open", REPO, HEAD])),
    ("--pr-info", json.dumps({"state": "open", "head_repo": REPO})),
    ("--pr-info", json.dumps({"state": "open", "head_repo": REPO, "head_sha": 7})),
    ("--head-mem-mib", "-1"),
    ("--head-mem-mib", "lots"),
])
def test_wrongly_typed_flag_is_a_usage_error(tmp_path, flag, value):
    given = flags(write_state(tmp_path, []), tags={})
    given[flag] = value
    usage_error("request", *argv(given))


# [utest->req~lab-deployment-preview-on-demand~1]
def test_malformed_state_document_is_a_usage_error(tmp_path):
    state = tmp_path / "state.json"
    state.write_text("{not json")
    usage_error("request", *argv(flags(state)))


# [utest->req~lab-deployment-preview-on-demand~1]
def test_head_must_equal_the_head_of_the_pr_facts(tmp_path):
    usage_error("request", *argv(flags(write_state(tmp_path, []), head_flag=sha("beef"))))
    plan = plan_for(tmp_path, "request", head_flag=HEAD)
    assert plan["refusal"] is None
    assert plan["record"]["head_sha"] == HEAD


# [utest->req~lab-deployment-preview-on-demand~1]
@pytest.mark.parametrize("name", ["request", "open"])
@pytest.mark.parametrize(("status", "port", "commands"), [
    ("stopped", 18101, [up(42)]),
    ("failed", None, [up(42)]),
    ("ready", 18101, []),
])
def test_same_head_record_restarts_or_only_records_activity(tmp_path, name, status, port, commands):
    plan = plan_for(tmp_path, name, [record(42, status=status, port=port)])
    assert plan["refusal"] is None
    assert plan["commands"] == commands
    assert plan["record"]["port"] == 18101
    assert plan["record"]["last_activity"] == name
    assert plan["record"]["last_active_at"] == NOW


# --- Preview port range on loopback ------------------------------------------------------------


# [utest->req~lab-deployment-preview-port-range~1]
def test_first_preview_gets_18101(tmp_path):
    plan = plan_for(tmp_path, "request", running=[stack("openbinding-lab")])
    assert plan["refusal"] is None
    assert plan["port"] == 18101
    assert plan["env"]["DEMO_LAB_PORT"] == "18101"


# [utest->req~lab-deployment-preview-port-range~1]
@pytest.mark.parametrize(
    "status", ["requested", "starting", "seeding", "ready", "stopped", "failed", "destroying"],
)
def test_lowest_free_port_fills_gaps(tmp_path, status):
    records = [record(42, status=status, port=18101), record(43, port=18103)]
    assert plan_for(tmp_path, "request", records, pr=57)["port"] == 18102


# [utest->req~lab-deployment-preview-port-range~1]
def test_failed_record_with_a_port_keeps_it_on_restart(tmp_path):
    plan = plan_for(tmp_path, "request", [record(42, status="failed", port=18101)])
    assert plan["refusal"] is None
    assert plan["port"] == 18101
    assert plan["record"]["port"] == 18101
    assert plan["commands"] == [up(42)]
    assert_env_kept(tmp_path, plan)


# [utest->req~lab-deployment-preview-port-range~1]
def test_listened_on_port_is_skipped(tmp_path):
    assert plan_for(tmp_path, "request", listening=[18101])["port"] == 18102


# [utest->req~lab-deployment-preview-port-range~1]
def test_stopped_preview_keeps_its_port(tmp_path):
    plan = plan_for(tmp_path, "request", [record(42, status="stopped", port=18101)], pr=57)
    assert plan["refusal"] is None
    assert plan["port"] != 18101
    assert plan["port"] == 18102


# [utest->req~lab-deployment-preview-port-range~1]
# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_stop_keeps_port_volumes_and_images_and_runs_down_without_volumes(tmp_path):
    ready = record(42, port=18101, images=[(AA, "openbinding-lab-gateway:18101")])
    plan = planned("stop", "--state", str(write_state(tmp_path, [ready])), "--pr", "42")
    assert plan["refusal"] is None
    assert plan["commands"] == [["lab_compose", "down", "--project", "openbinding-pr-42"]]
    stopped = plan["record"]
    assert stopped["status"] == "stopped"
    assert stopped["port"] == 18101
    assert stopped["volumes"] == ready["volumes"]
    assert stopped["images"] == ready["images"]


# [utest->req~lab-deployment-preview-port-range~1]
def test_failed_record_without_a_port_gets_the_lowest_free_port(tmp_path):
    records = [record(42, status="failed", port=None), record(57, port=18101)]
    plan = plan_for(tmp_path, "request", records)
    assert plan["refusal"] is None
    assert plan["port"] == 18102
    assert plan["record"]["port"] == 18102
    assert plan["commands"] == [up(42)]
    assert_env_kept(tmp_path, plan)


# [utest->req~lab-deployment-preview-port-range~1]
def test_destroyed_record_frees_its_port(tmp_path):
    plan = plan_for(tmp_path, "request", [record(42, status="destroyed", port=18101)], pr=57)
    assert plan["refusal"] is None
    assert plan["port"] == 18101


# [utest->req~lab-deployment-preview-port-range~1]
def test_98_held_ports_allocate_18199(tmp_path):
    plan = plan_for(tmp_path, "request", held_ports(98), pr=200)
    assert plan["refusal"] is None
    assert plan["port"] == 18199


# [utest->req~lab-deployment-preview-port-range~1]
def test_18100_is_never_allocated(tmp_path):
    records, ports = [], []
    for pr in range(1, 100):
        plan = plan_for(tmp_path, "request", records, pr=pr)
        assert plan["refusal"] is None, pr
        assert plan["record"] is not None, pr
        records.append(plan["record"])
        ports.append(plan["port"])
    assert ports
    assert ports == list(range(18101, 18200))
    assert 18100 not in ports


# --- One project and private volumes per preview -----------------------------------------------


# [utest->req~lab-deployment-preview-isolation~1]
def test_names_derive_from_the_pr_number(tmp_path):
    for pr in (7, 42, 1234):
        plan = plan_for(tmp_path, "request", pr=pr)
        assert plan["project"] == f"openbinding-pr-{pr}"
        assert re.fullmatch(r"[a-z][a-z0-9-]{0,62}", plan["project"])
        assert plan["commands"] == [up(pr, "--build")]
        assert plan["record"]["project"] == f"openbinding-pr-{pr}"
        assert plan["record"]["compose_file"] == COMPOSE
        assert plan["record"]["volumes"] == [f"openbinding-pr-{pr}_{name}" for name in
                                             ("lab-pg-3", "lab-redis", "lab-artifacts-2", "lab-e2e")]
    # two previews, both PRs moved to a new head: every command and every volume stays its own
    records = [record(42, port=18101), record(57, port=18102)]
    for pr in (42, 57):
        plan = plan_for(tmp_path, "refresh", records, pr=pr, head=NEW)
        assert plan["refusal"] is None
        assert plan["commands"]
        assert plan["record"] is not None
        other = 57 if pr == 42 else 42
        for command in plan["commands"]:
            assert f"openbinding-pr-{pr}" in command
            assert f"openbinding-pr-{other}" not in command
        assert plan["record"]["volumes"]
        assert all(volume.startswith(f"openbinding-pr-{pr}_") for volume in plan["record"]["volumes"])


# [utest->req~lab-deployment-preview-isolation~1]
def test_a_planned_start_record_is_starting_with_the_head_memory(tmp_path):
    plan = plan_for(tmp_path, "request", mem=2048)
    assert plan["record"]["status"] == "starting"
    assert plan["record"]["mem_mib"] == 2048 != MEM


# [utest->req~lab-deployment-preview-isolation~1]
def test_restarting_a_failed_record_clears_its_error_and_keeps_its_creation_time(tmp_path):
    failed = {**record(42, status="failed", port=18101), "error": "x"}
    plan = plan_for(tmp_path, "request", [failed])
    assert plan["record"]["status"] == "starting"
    assert plan["record"]["error"] is None
    assert plan["record"]["created_at"] == failed["created_at"]


# --- Tracked Compose file and synthetic data only ----------------------------------------------


# [utest->req~lab-deployment-preview-synthetic-only~1]
@pytest.mark.parametrize("tracked", [
    [], ["README.md", "compose.lab.json"], ["docs/" + COMPOSE], [COMPOSE + ".bak"],
])
def test_untracked_compose_is_refused(tmp_path, tracked):
    plan = plan_for(tmp_path, "request", tracked=tracked)
    assert plan["refusal"] == "preview_untracked_compose"
    assert plan["record"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_first_request_plans_a_synthetic_environment(tmp_path):
    env = plan_for(tmp_path, "request")["env"]
    assert env["DEMO_LAB_PORT"] == "18101"
    assert env["DEMO_PUBLIC_ORIGIN"] == "http://localhost:18101"
    assert env["DEMO_SPACE_ENABLED"] == "false"
    for name in EMPTY_ENV:
        assert env[name] == "", name
    for name in SECRETS:
        assert env[name] == {"generate": True}, name  # no value is printed without --seed-rng


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_destroyed_record_counts_as_no_record(tmp_path):
    destroyed = record(42, status="destroyed", port=None)
    plan = plan_for(tmp_path, "request", [destroyed])
    assert plan["refusal"] is None
    assert plan["port"] == 18101
    assert plan["commands"] == [up(42, "--build")]
    assert all(plan["env"][name] == {"generate": True} for name in SECRETS)


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_generated_secrets_follow_the_demo_formats(tmp_path):
    for seed in (1, 7, 2026):
        for pr in (42, 57):
            env = plan_for(tmp_path, "request", pr=pr, seed=seed)["env"]
            assert all(env[name]["generate"] is True and env[name]["value"] for name in SECRETS)
            assert re.fullmatch(r"[A-Za-z0-9._-]+", env["DEMO_PG_PASSWORD"]["value"])
            fernet = env["DEMO_FERNET_KEY"]["value"]
            raw = base64.urlsafe_b64decode(fernet)
            assert len(raw) == 32
            assert base64.urlsafe_b64encode(raw).decode() == fernet
            token = env["DEMO_BIM_TOKEN"]["value"]
            assert 32 <= len(token) <= 127
            assert all(0x21 <= ord(char) <= 0x7E for char in token)
            assert len(env["DEMO_SEED_PASSWORD"]["value"]) >= 10
            assert len(env["DEMO_JWT_SECRET"]["value"]) >= 32


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_seeded_secret_values_stay_out_of_the_record_and_the_commands(tmp_path):
    plan = plan_for(tmp_path, "request", seed=7)
    values = [plan["env"][name]["value"] for name in SECRETS]
    printed = json.dumps(plan["record"]) + json.dumps(plan["commands"])
    assert all(value not in printed for value in values)


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_secrets_differ_between_prs_and_repeat_with_the_seed(tmp_path):
    def secrets_of(pr: int) -> dict:
        env = plan_for(tmp_path, "request", pr=pr, seed=7)["env"]
        return {name: env[name]["value"] for name in SECRETS}

    first, other, again = secrets_of(42), secrets_of(57), secrets_of(42)
    assert set(first) == set(SECRETS)
    for name in SECRETS:
        assert first[name] != other[name], name
    assert first == again


# [utest->req~lab-deployment-preview-synthetic-only~1]
def test_refresh_and_reopen_keep_the_environment_and_secrets(tmp_path):
    first_start = non_secret_env(plan_for(tmp_path, "request"))
    stopped = [record(42, status="stopped", port=18101)]
    for name, head in (("refresh", NEW), ("open", HEAD)):
        plan = plan_for(tmp_path, name, stopped, head=head)
        assert plan["refusal"] is None, name
        assert plan["commands"], name
        assert non_secret_env(plan) == first_start, name
        for secret in SECRETS:
            assert plan["env"][secret] == {"keep": True}, (name, secret)


# --- Refresh on a new head ---------------------------------------------------------------------


# [utest->req~lab-deployment-preview-refresh~1]
def test_new_head_refreshes_in_place(tmp_path):
    ready = record(42, port=18101)
    plan = plan_for(tmp_path, "request", [ready], head=NEW)
    assert plan["refusal"] is None
    assert plan["project"] == "openbinding-pr-42"
    assert plan["port"] == 18101
    assert plan["commands"] == [up(42, "--build")]
    assert plan["record"]["volumes"] == ready["volumes"]
    assert_env_kept(tmp_path, plan)


# [utest->req~lab-deployment-preview-refresh~1]
def test_same_running_head_only_records_activity(tmp_path):
    ready = record(42, port=18101, last_active=ago(5), last_activity="open")
    plan = plan_for(tmp_path, "request", [ready])
    assert plan["refusal"] is None
    assert plan["commands"] == []
    assert plan["record"] == {**ready, "last_active_at": NOW, "last_activity": "request"}
    assert_env_kept(tmp_path, plan)


# [utest->req~lab-deployment-preview-refresh~1]
@pytest.mark.parametrize("name", ["request", "refresh"])
def test_refresh_keeps_head_until_the_build_succeeds(tmp_path, name):
    plan = plan_for(tmp_path, name, [record(42, port=18101)], head=NEW)
    assert plan["record"]["head_sha"] == HEAD
    assert plan["record"]["pending_head_sha"] == NEW


# [utest->req~lab-deployment-preview-refresh~1]
def test_restart_at_the_recorded_head_clears_a_pending_head(tmp_path):
    failed = {**record(42, status="failed", port=18101), "pending_head_sha": NEW}
    plan = plan_for(tmp_path, "request", [failed])
    assert plan["record"]["head_sha"] == HEAD
    assert plan["record"]["pending_head_sha"] is None


# [utest->req~lab-deployment-preview-refresh~1]
@pytest.mark.parametrize("kind", ["g12", "screenshot"])
def test_g12_on_a_stale_head_is_refused(tmp_path, kind):
    plan = plan_for(tmp_path, "activity", [record(42)], kind=kind, head=NEW)
    assert plan["refusal"] == "preview_head_stale"
    assert plan["record"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-refresh~1]
@pytest.mark.parametrize("kind", ["request", "refresh", "open"])
def test_other_activity_kinds_on_a_moved_head_are_recorded(tmp_path, kind):
    held = record(42, last_active=ago(50))
    plan = plan_for(tmp_path, "activity", [held], kind=kind, head=NEW)
    assert plan["refusal"] is None
    assert plan["commands"] == []
    assert plan["record"] == {**held, "last_active_at": NOW, "last_activity": kind}


# --- Preview expiry after 7 idle days ----------------------------------------------------------


# [utest->req~lab-deployment-preview-idle-expiry~1]
def test_expiry_at_exactly_168_idle_hours(tmp_path):
    idle = record(42, port=18101, last_active="2026-11-01T10:00:00Z")
    plan = plan_for(tmp_path, "expire", [idle], now="2026-11-08T10:00:00Z")
    assert plan["refusal"] is None
    assert plan["commands"] == [destroy(42)]
    assert plan["record"] is None


# [utest->req~lab-deployment-preview-idle-expiry~1]
def test_kept_at_167_hours_59_minutes(tmp_path):
    idle = record(42, port=18101, last_active="2026-11-01T10:00:00Z")
    plan = plan_for(tmp_path, "expire", [idle], now="2026-11-08T09:59:00Z")
    assert plan["refusal"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-idle-expiry~1]
def test_transient_and_destroyed_records_are_skipped_by_the_sweep(tmp_path):
    skipped = [
        record(10 + i, status=status, port=18101 + i, last_active=ago(200))
        for i, status in enumerate(("requested", "starting", "seeding", "destroying", "destroyed"))
    ]
    control = record(99, status="ready", port=18110, last_active=ago(200))
    plan = plan_for(tmp_path, "expire", [*skipped, control])
    assert plan["commands"] == [destroy(99)]


# [utest->req~lab-deployment-preview-idle-expiry~1]
def test_stopped_and_failed_previews_age(tmp_path):
    records = [
        record(42, status="stopped", port=18101, last_active=ago(168)),
        record(57, status="failed", port=None, last_active=ago(168)),
    ]
    plan = plan_for(tmp_path, "expire", records)
    assert sorted(plan["commands"]) == [destroy(42), destroy(57)]


# [utest->req~lab-deployment-preview-idle-expiry~1]
@pytest.mark.parametrize("kind", ["health", "list"])
def test_unknown_activity_kind_is_a_usage_error(tmp_path, kind):
    usage_error("activity", *argv(flags(write_state(tmp_path, [record(42)]), kind=kind)))


# [utest->req~lab-deployment-preview-idle-expiry~1]
@pytest.mark.parametrize("kind", ["request", "refresh", "open", "g12", "screenshot"])
def test_activity_records_the_kind_and_the_time(tmp_path, kind):
    idle = record(42, port=18101, last_active=ago(50))
    plan = plan_for(tmp_path, "activity", [idle], kind=kind)
    assert plan["refusal"] is None
    assert plan["commands"] == []
    assert plan["record"] == {**idle, "last_active_at": NOW, "last_activity": kind}


# [utest->req~lab-deployment-preview-idle-expiry~1]
def test_g12_activity_resets_the_clock(tmp_path):
    idle = record(42, port=18101, last_active="2026-11-01T10:00:00Z")
    later = "2026-11-09T10:00:00Z"
    control = plan_for(tmp_path, "expire", [idle], now=later)
    assert control["commands"] == [destroy(42)]
    active = plan_for(tmp_path, "activity", [idle], kind="g12", now="2026-11-07T10:00:00Z")
    assert active["record"]["last_active_at"] == "2026-11-07T10:00:00Z"
    assert plan_for(tmp_path, "expire", [active["record"]], now=later)["commands"] == []


# --- Destroy only through the maintenance operation --------------------------------------------


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_only_labctl_destroy_deletes(tmp_path):
    images = [(AA, "openbinding-lab-gateway:18101"), (BB, "openbinding-pr-42-web")]
    idle = record(42, port=18101, images=images, last_active=ago(200))
    stopped = {**idle, "status": "stopped"}
    plans = {
        "request": plan_for(tmp_path, "request", [idle], head=NEW),
        "refresh": plan_for(tmp_path, "refresh", [idle], head=NEW),
        "open": plan_for(tmp_path, "open", [stopped]),
        "stop": plan_for(tmp_path, "stop", [idle]),
        "activity": plan_for(tmp_path, "activity", [idle], kind="open"),
        "expire": plan_for(tmp_path, "expire", [idle]),
    }
    for name in ("request", "refresh", "open", "stop", "expire"):
        assert plans[name]["commands"], name
    for name, plan in plans.items():
        assert not any(deletes(command) for command in plan["commands"]), name
        if name != "expire":
            assert not any("destroy" in command for command in plan["commands"]), name
    assert plans["expire"]["commands"] == [destroy(42)]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_expire_routes_every_deletion_to_labctl_destroy(tmp_path):
    records = [
        record(42, status="ready", port=18101, last_active=ago(169)),
        record(57, status="stopped", port=18102, last_active=ago(300)),
        record(60, status="failed", port=None, last_active=ago(168)),
        record(70, status="ready", port=18103, last_active=ago(1)),
    ]
    commands = plan_for(tmp_path, "expire", records)["commands"]
    assert sorted(commands) == [destroy(42), destroy(57), destroy(60)]
    assert all(command[:3] == ["labctl", "destroy", "preview"] and len(command) == 4 for command in commands)


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_check_destroys_the_project_and_marks_the_record(tmp_path):
    ready = record(42, port=18101, images=[(AA, "openbinding-pr-42-web")])
    plan = planned("destroy-check", "--state", str(write_state(tmp_path, [ready])), "--pr", "42")
    assert plan["refusal"] is None
    assert plan["commands"][0] == ["lab_compose", "destroy", "--project", "openbinding-pr-42"]
    assert plan["record"]["status"] == "destroyed"
    assert plan["record"]["port"] is None


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_removes_its_own_tag_and_unshared_image(tmp_path):
    own = "openbinding-lab-gateway:18101"
    plan = plan_for(tmp_path, "destroy-check", [record(42, port=18101, images=[(AA, own)])], tags={own: AA})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-42"],
        ["docker", "image", "rm", own],
        ["docker", "image", "rm", AA],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
@pytest.mark.parametrize("outside", ["openbinding-lab-gateway:18102", "openbinding-lab-gateway:latest"])
def test_destroy_keeps_an_image_an_outside_tag_resolves_to(tmp_path, outside):
    own = "openbinding-lab-gateway:18101"
    records = [record(42, port=18101, images=[(AA, own)])]
    plan = plan_for(tmp_path, "destroy-check", records, tags={own: AA, outside: AA})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-42"],
        ["docker", "image", "rm", own],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_after_port_reuse_with_the_same_image_id_keeps_the_tag(tmp_path):
    tag = "openbinding-lab-gateway:18101"
    records = [
        record(42, status="failed", port=None, images=[(AA, tag)]),
        record(57, port=18101, images=[(AA, tag)]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records, tags={tag: AA})
    assert plan["commands"] == [["lab_compose", "destroy", "--project", "openbinding-pr-42"]]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_removes_a_tag_that_resolves_to_its_own_unshared_image(tmp_path):
    tag = "openbinding-lab-gateway:18101"
    records = [
        record(42, status="failed", port=None, images=[(A1, tag)]),
        record(57, port=18101, images=[(B2, tag)]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records, tags={tag: A1})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-42"],
        ["docker", "image", "rm", tag],
        ["docker", "image", "rm", A1],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_of_the_port_holder_removes_its_tag_despite_an_older_label(tmp_path):
    tag = "openbinding-lab-gateway:18101"
    records = [
        record(42, status="failed", port=None, images=[(A1, tag)]),
        record(57, port=18101, images=[(B2, tag)]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records, pr=57, tags={tag: B2})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-57"],
        ["docker", "image", "rm", tag],
        ["docker", "image", "rm", B2],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_removes_each_tag_of_an_image_and_the_image_once(tmp_path):
    t1, t2 = "openbinding-lab-gateway:18101", "openbinding-lab-web:18101"
    plan = plan_for(tmp_path, "destroy-check", [record(42, port=18101, images=[(AA, t1), (AA, t2)])],
                    tags={t1: AA, t2: AA})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-42"],
        ["docker", "image", "rm", t1],
        ["docker", "image", "rm", t2],
        ["docker", "image", "rm", AA],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_keeps_an_image_another_record_references(tmp_path):
    records = [
        record(42, port=18101, images=[(AA, "openbinding-lab-gateway:18101")]),
        record(57, port=18102, images=[(AA, "openbinding-lab-gateway:18102")]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records)
    assert plan["commands"] == [["lab_compose", "destroy", "--project", "openbinding-pr-42"]]
    assert ["docker", "image", "rm", AA] not in plan["commands"]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_removes_an_image_only_a_destroyed_record_lists(tmp_path):
    records = [
        record(42, status="destroyed", port=None, images=[(DD, "openbinding-pr-42-web")]),
        record(57, port=18101, images=[(DD, "openbinding-pr-57-web")]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records, pr=57, tags={})
    assert plan["commands"] == [
        ["lab_compose", "destroy", "--project", "openbinding-pr-57"],
        ["docker", "image", "rm", DD],
    ]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_after_port_reuse_leaves_the_second_image(tmp_path):
    tag = "openbinding-lab-gateway:18101"
    records = [
        record(42, status="failed", port=None, images=[(A1, tag)]),
        record(57, port=18101, images=[(B2, tag)]),
    ]
    plan = plan_for(tmp_path, "destroy-check", records, tags={tag: B2})
    removals = image_removals(plan)
    assert removals == [["docker", "image", "rm", A1]]
    assert plan["commands"][0] == ["lab_compose", "destroy", "--project", "openbinding-pr-42"]


# [utest->req~lab-deployment-preview-destroy-maintenance~1]
def test_destroy_keeps_an_image_the_develop_tag_resolves_to(tmp_path):
    own, develop = "openbinding-lab-gateway:18101", "openbinding-lab-gateway:18100"
    plan = plan_for(
        tmp_path, "destroy-check", [record(42, port=18101, images=[(CC, own)])], tags={own: CC, develop: CC},
    )
    removals = image_removals(plan)
    assert removals == [["docker", "image", "rm", own]]
    assert ["docker", "image", "rm", CC] not in plan["commands"]
    assert not any(part in ("-f", "--force") for command in removals for part in command)


# --- Cap on running previews -------------------------------------------------------------------


# [utest->req~lab-deployment-preview-running-cap~1]
def test_start_refused_above_the_lab_cap(tmp_path):
    running = [stack("openbinding-lab"), stack("openbinding-pr-42")]
    plan = plan_for(tmp_path, "request", [record(42, port=18101)], pr=57, running=running)
    assert plan["refusal"] == "preview_capacity_reached"
    assert plan["commands"] == []
    assert plan["record"] is None
    assert plan["port"] is None


# [utest->req~lab-deployment-preview-running-cap~1]
@pytest.mark.parametrize(("others", "refusal"), [(5184, None), (5185, "preview_capacity_reached")])
def test_cap_boundary_9216_allowed_9217_refused(tmp_path, others, refusal):
    running = [stack("openbinding-lab"), stack("openbinding-pr-1", others - MEM)]
    plan = plan_for(tmp_path, "request", pr=57, running=running)
    assert plan["refusal"] == refusal
    assert plan["commands"] == ([up(57, "--build")] if refusal is None else [])


# [utest->req~lab-deployment-preview-running-cap~1]
def test_start_well_under_the_cap_is_allowed(tmp_path):
    plan = plan_for(tmp_path, "request", pr=57, running=[stack("openbinding-lab")])
    assert plan["refusal"] is None
    assert plan["commands"] == [up(57, "--build")]


# [utest->req~lab-deployment-preview-running-cap~1]
def test_stopped_previews_do_not_count(tmp_path):
    plan = plan_for(tmp_path, "request", [record(42, status="stopped", port=18101)], pr=57,
                    running=[stack("openbinding-lab")])
    assert plan["refusal"] is None
    assert plan["commands"] == [up(57, "--build")]


# [utest->req~lab-deployment-preview-running-cap~1]
def test_two_previews_fit_without_the_develop_lab(tmp_path):
    first = plan_for(tmp_path, "request", [record(42, status="stopped", port=18101)], pr=57)
    assert first["refusal"] is None
    records = [record(42, status="stopped", port=18101), first["record"]]
    second = plan_for(tmp_path, "request", records, pr=60, running=[stack("openbinding-pr-57")])
    assert second["refusal"] is None
    assert second["commands"] == [up(60, "--build")]


# [utest->req~lab-deployment-preview-running-cap~1]
@pytest.mark.parametrize("held", [
    record(42, status="stopped", port=18101),
    record(42, status="failed", port=None),
])
def test_refresh_of_a_stopped_or_failed_preview_runs_admission(tmp_path, held):
    running = [stack("openbinding-lab"), stack("openbinding-pr-57")]
    plan = plan_for(tmp_path, "refresh", [held], head=NEW, running=running)
    assert plan["refusal"] == "preview_capacity_reached"
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-running-cap~1]
@pytest.mark.parametrize("name", ["request", "open"])
@pytest.mark.parametrize("held", [
    record(42, status="stopped", port=18101),
    record(42, status="failed", port=None),
])
@pytest.mark.parametrize(("others", "refusal"), [
    (5184, None), (5185, "preview_capacity_reached"), (2 * MEM, "preview_capacity_reached"),
])
def test_restart_at_the_same_head_runs_admission(tmp_path, name, held, others, refusal):
    running = [stack("openbinding-lab"), stack("openbinding-pr-57", others - MEM)]
    plan = plan_for(tmp_path, name, [held], running=running)
    assert plan["refusal"] == refusal
    assert plan["commands"] == ([up(42)] if refusal is None else [])
    assert (plan["record"] is None) == (refusal is not None)
    assert (plan["port"] is None) == (refusal is not None)


# [utest->req~lab-deployment-preview-running-cap~1]
@pytest.mark.parametrize("name", ["request", "refresh"])
def test_refresh_of_a_running_preview_skips_admission(tmp_path, name):
    running = [stack("openbinding-lab"), stack("openbinding-pr-42")]
    plan = plan_for(tmp_path, name, [record(42, port=18101)], head=NEW, running=running, mem=MEM)
    assert plan["refusal"] is None
    assert plan["commands"] == [up(42, "--build")]


# --- Refusal when preview ports are exhausted --------------------------------------------------


# [utest->req~lab-deployment-preview-ports-exhausted~1]
def test_refusal_when_99_ports_are_held(tmp_path):
    plan = plan_for(tmp_path, "request", held_ports(99), pr=300)
    assert plan["refusal"] == "preview_ports_exhausted"
    assert plan["record"] is None
    assert plan["commands"] == []


# [utest->req~lab-deployment-preview-ports-exhausted~1]
def test_refusal_when_98_are_held_and_one_is_listened_on(tmp_path):
    plan = plan_for(tmp_path, "request", held_ports(98), pr=300, listening=[18199])
    assert plan["refusal"] == "preview_ports_exhausted"
    assert plan["record"] is None


# [utest->req~lab-deployment-preview-ports-exhausted~1]
def test_first_failing_check_wins_in_order(tmp_path):
    running = [stack("openbinding-lab"), stack("openbinding-pr-1")]
    steps = [
        {"pr_state": "closed", "tracked": [], "records": held_ports(99)},
        {"pr_state": "open", "tracked": [], "records": held_ports(99)},
        {"pr_state": "open", "tracked": [COMPOSE], "records": held_ports(99)},
        {"pr_state": "open", "tracked": [COMPOSE], "records": held_ports(98)},
    ]
    plans = [
        plan_for(tmp_path, "request", step["records"], pr=300, pr_state=step["pr_state"],
                 tracked=step["tracked"], running=running, mem=MEM)
        for step in steps
    ]
    assert [plan["refusal"] for plan in plans] == [
        "preview_pr_not_eligible", "preview_untracked_compose", "preview_ports_exhausted",
        "preview_capacity_reached",
    ]
    assert all(plan["record"] is None and plan["commands"] == [] for plan in plans)
