"""Planner of the PR previews: the rules of the lab's `labctl preview`, with no side effects.

It reads a state document and the facts passed as flags, and prints one JSON object (the plan or a refusal).
It never reads the clock, Git, Docker, the network or the environment. The contract (flags, output keys,
exit codes, check order) is section 1 of openspec/changes/m05-pr-previews/design.md, and its tests are
lab/tests/test_previews.py.

    python lab/previews/previews.py plan <request|refresh|open|stop|expire|activity|destroy-check> --state FILE ...
"""

from __future__ import annotations

import argparse
import base64
import json
import random
import re
import secrets
import string
import sys
from datetime import datetime, timedelta

EX_USAGE = 64
REPO = "isa-group/OpenBinding"
COMPOSE = "compose.lab-process.json"
PORTS = range(18101, 18200)  # 18100 belongs to the develop lab
CAP_MIB = 9216
IDLE = timedelta(hours=168)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
KINDS = ("request", "refresh", "open", "g12", "screenshot")
SECRETS = ("DEMO_PG_PASSWORD", "DEMO_JWT_SECRET", "DEMO_FERNET_KEY", "DEMO_BIM_TOKEN", "DEMO_SEED_PASSWORD")
EMPTY_ENV = ("SPACE_API_KEY", "SPACE_URL", "SPACE_ORGANIZATION_ID", "SPHERE_API_KEY")
VOLUMES = ("lab-pg-3", "lab-redis", "lab-artifacts-2", "lab-e2e")
NOT_RUNNING = ("stopped", "failed")
NOT_SWEPT = ("requested", "starting", "seeding", "destroying", "destroyed")
START = ("state", "pr", "now", "pr_info", "tracked", "head_mem_mib")
REQUIRED = {
    "request": START, "refresh": START, "open": START, "stop": ("state", "pr"), "expire": ("state", "now"),
    "activity": ("state", "pr", "now", "kind"), "destroy-check": ("state", "pr"),
}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f"previews.py: {message}", file=sys.stderr)
        sys.exit(EX_USAGE)


def state_arg(path: str) -> list[dict]:
    try:
        with open(path, encoding="utf-8") as handle:
            return list(json.load(handle)["records"])
    except (OSError, KeyError) as error:
        raise ValueError(str(error)) from error


def pr_arg(text: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", text):
        raise ValueError(text)
    return int(text)


def when(text: str) -> datetime:
    return datetime.strptime(text, TIME_FORMAT)


def time_arg(text: str) -> str:
    when(text)
    return text


def json_arg(check):
    def load(text: str):
        value = json.loads(text)
        if not check(value):
            raise ValueError(f"unexpected shape: {text}")
        return value

    return load


def list_of(kind: type):
    return lambda value: isinstance(value, list) and all(type(item) is kind for item in value)


def is_stack(value) -> bool:
    return isinstance(value, dict) and type(value.get("project")) is str and type(value.get("mem_mib")) is int \
        and value["mem_mib"] >= 0


def build_parser() -> argparse.ArgumentParser:
    parser = Parser(prog="previews.py", allow_abbrev=False, add_help=False)
    parser.add_argument("command", choices=["plan"])
    parser.add_argument("name", choices=sorted(REQUIRED))
    parser.add_argument("--state", type=state_arg)
    parser.add_argument("--pr", type=pr_arg)
    parser.add_argument("--head")
    parser.add_argument("--now", type=time_arg)
    parser.add_argument("--tracked", type=json_arg(list_of(str)))
    parser.add_argument("--running", type=json_arg(lambda value: isinstance(value, list) and all(map(is_stack, value))),
                        default=[])
    parser.add_argument("--pr-info", type=json.loads)
    parser.add_argument("--kind", choices=KINDS)
    parser.add_argument("--head-mem-mib", type=json_arg(lambda value: type(value) is int and value >= 0))
    parser.add_argument("--listening", type=json_arg(list_of(int)), default=[])
    parser.add_argument("--tags", type=json_arg(lambda v: isinstance(v, dict) and list_of(str)(list(v.values()))),
                        default={})
    parser.add_argument("--seed-rng", type=int)
    return parser


def result(args, **fields) -> dict:
    return {"action": args.name, "refusal": None, "port": None, "project": None, "env": {}, "commands": [],
            "record": None, **fields}


def existing(args) -> dict | None:
    """The record of the PR; a destroyed one counts as none."""
    return next((r for r in args.state if r["pr"] == args.pr and r["status"] != "destroyed"), None)


def touched(rec: dict, now: str, kind: str) -> dict:
    return {**rec, "last_active_at": now, "last_activity": kind}


# [impl->req~lab-deployment-preview-port-range~1]
# [impl->req~lab-deployment-preview-ports-exhausted~1]
def free_port(records: list[dict], listening: list[int]) -> int | None:
    held = {r["port"] for r in records if r["status"] != "destroyed"}
    return next((port for port in PORTS if port not in held and port not in listening), None)


# [impl->req~lab-deployment-preview-synthetic-only~1]
def environment(args, port: int, keep: bool) -> dict:
    env = {"DEMO_LAB_PORT": str(port), "DEMO_PUBLIC_ORIGIN": f"http://localhost:{port}",
           "DEMO_SPACE_ENABLED": "false", "DEMO_E2E": "0", **dict.fromkeys(EMPTY_ENV, "")}
    if keep:
        return {**env, **{name: {"keep": True} for name in SECRETS}}
    seeded = args.seed_rng is not None
    rng = random.Random(f"{args.seed_rng}:{args.pr}") if seeded else secrets.SystemRandom()

    def word(length: int) -> str:
        return "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(length))

    values = {"DEMO_PG_PASSWORD": word(24), "DEMO_JWT_SECRET": word(48),
              "DEMO_FERNET_KEY": base64.urlsafe_b64encode(rng.randbytes(32)).decode(),
              "DEMO_BIM_TOKEN": word(48), "DEMO_SEED_PASSWORD": word(16)}
    return {**env, **{name: {"generate": True, **({"value": values[name]} if seeded else {})} for name in SECRETS}}


# [impl->req~lab-deployment-preview-running-cap~1]
def admit(args, rec: dict | None) -> tuple[str | None, int | None]:
    """The checks of design.md section 1 in order: (refusal, port)."""
    info = args.pr_info
    if info["state"] != "open" or info["head_repo"] != REPO:
        return "preview_pr_not_eligible", None
    if COMPOSE not in args.tracked:
        return "preview_untracked_compose", None
    port = rec["port"] if rec else None
    if port is None:
        port = free_port(args.state, args.listening)
        if port is None:
            return "preview_ports_exhausted", None
    if rec is None or rec["status"] in NOT_RUNNING:
        if sum(stack["mem_mib"] for stack in args.running) + args.head_mem_mib > CAP_MIB:
            return "preview_capacity_reached", None
    return None, port


# [impl->req~lab-deployment-preview-isolation~1]
def started(args, rec: dict | None, head: str, port: int) -> dict:
    project = f"openbinding-pr-{args.pr}"
    fresh = {
        "pr": args.pr, "head_sha": head, "pending_head_sha": None, "previous_head_sha": None, "port": port,
        "project": project, "compose_file": COMPOSE, "volumes": [f"{project}_{name}" for name in VOLUMES],
        "images": [], "created_at": args.now,
    }
    new = {**(rec or fresh), "port": port, "mem_mib": args.head_mem_mib, "status": "starting", "error": None,
           "last_active_at": args.now, "last_activity": args.name}
    new["pending_head_sha"] = head if head != new["head_sha"] else None  # head_sha moves only when `up` succeeds
    return new


# [impl->req~lab-deployment-preview-on-demand~1]
# [impl->req~lab-deployment-preview-refresh~1]
def start(args) -> dict:
    rec = existing(args)
    if rec is None and args.name == "open":
        return result(args)
    head = rec["head_sha"] if rec and args.name == "open" else args.head or args.pr_info["head_sha"]
    if rec and rec["status"] not in NOT_RUNNING and head == rec["head_sha"]:
        return result(args, port=rec["port"], project=rec["project"], env=environment(args, rec["port"], True),
                      record=touched(rec, args.now, args.name))
    refusal, port = admit(args, rec)
    if refusal:
        return result(args, refusal=refusal)
    record = started(args, rec, head, port)
    build = ["--build"] if rec is None or head != rec["head_sha"] else []
    return result(args, port=port, project=record["project"], env=environment(args, port, rec is not None),
                  commands=[["lab_compose", "up", "--project", record["project"], *build]], record=record)


def stop(args) -> dict:
    rec = existing(args)
    if rec is None:
        return result(args)
    return result(args, port=rec["port"], project=rec["project"],
                  commands=[["lab_compose", "down", "--project", rec["project"]]], record={**rec, "status": "stopped"})


# [impl->req~lab-deployment-preview-idle-expiry~1]
def expire(args) -> dict:
    now = when(args.now)
    due = [r for r in args.state if r["status"] not in NOT_SWEPT and now - when(r["last_active_at"]) >= IDLE]
    return result(args, commands=[["labctl", "destroy", "preview", str(r["pr"])] for r in due])


def activity(args) -> dict:
    rec = existing(args)
    if rec is None:
        return result(args)
    if args.kind in ("g12", "screenshot") and rec["head_sha"] != args.pr_info["head_sha"]:
        return result(args, refusal="preview_head_stale")
    return result(args, port=rec["port"], project=rec["project"], record=touched(rec, args.now, args.kind))


# [impl->req~lab-deployment-preview-destroy-maintenance~1]
def destroy_check(args) -> dict:
    rec = existing(args)
    if rec is None:
        return result(args)
    images = rec["images"]
    own_tags = {image["tag"] for image in images}
    elsewhere = [image for r in args.state if r is not rec and r["status"] != "destroyed" for image in r["images"]]
    held = {image["tag"] for image in elsewhere}  # a tag another record lists is not this record's to remove
    shared = {image["id"] for image in elsewhere} | {i for t, i in args.tags.items() if t not in own_tags or t in held}
    own_ids = list(dict.fromkeys(image["id"] for image in images))
    tags = list(dict.fromkeys(i["tag"] for i in images
                              if args.tags.get(i["tag"]) in own_ids and i["tag"] not in held))
    ids = [i for i in own_ids if i not in shared]
    commands = [["lab_compose", "destroy", "--project", rec["project"]]]
    commands += [["docker", "image", "rm", target] for target in (*tags, *ids)]
    return result(args, port=rec["port"], project=rec["project"], commands=commands,
                  record={**rec, "status": "destroyed", "port": None})


PLANS = {"request": start, "refresh": start, "open": start, "stop": stop, "expire": expire, "activity": activity,
         "destroy-check": destroy_check}


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    needed = REQUIRED[args.name]
    if args.name == "activity" and args.kind in ("g12", "screenshot"):
        needed += ("pr_info",)
    missing = [name for name in needed if getattr(args, name) is None]
    if missing:
        parser.error("missing " + ", ".join("--" + name.replace("_", "-") for name in missing))
    try:
        if args.head and args.pr_info and args.head != args.pr_info["head_sha"]:
            parser.error("--head differs from the head of --pr-info")
        plan = PLANS[args.name](args)
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        parser.error(f"malformed input: {error!r}")
    print(json.dumps(plan))
    return 0


if __name__ == "__main__":
    sys.exit(main())
