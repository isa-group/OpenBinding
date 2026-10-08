#!/usr/bin/env python3
"""Fail-closed environment and gateway preflight for QACOBench."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import httpx

from _common import ENGINE_MODES, discover_project_root, install_gateway_import

ROOT = discover_project_root(Path(__file__))
install_gateway_import(ROOT)

from openbinding_gateway.v1.package import load_package  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default=os.environ.get("OPENBINDING_GATEWAY_URL", "http://localhost:8000"))
    parser.add_argument("--username", default=os.environ.get("OPENBINDING_USERNAME", "admin"))
    parser.add_argument("--password", default=os.environ.get("OPENBINDING_PASSWORD", "devpass123"))
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts/qacobench/preflight.json")
    args = parser.parse_args()
    report = {"ok": False, "gateway": args.gateway_url, "package": str(args.package), "engines": {}}
    try:
        package = load_package(args.package)
        with httpx.Client(timeout=30) as client:
            health = client.get(args.gateway_url.rstrip("/") + "/health")
            health.raise_for_status()
            login = client.post(args.gateway_url.rstrip("/") + "/v1/auth/login", json={"username_or_email": args.username, "password": args.password})
            login.raise_for_status()
            headers = {"Authorization": f"Bearer {login.json()['access_token']}", "Content-Type": "application/vnd.bim+zip"}
            validation = client.post(args.gateway_url.rstrip("/") + "/v1/validate", content=package.to_zip(), headers=headers)
            validation.raise_for_status()
            modes = validation.json().get("compatibleModes", [])
            for engine, mode in ENGINE_MODES.items():
                item = next((entry for entry in modes if entry.get("engine", {}).get("name") == engine and entry.get("mode") == mode), None)
                report["engines"][engine] = {"mode": mode, "installed": item is not None, "compatible": bool(item and item.get("compatible")), "diagnostics": item.get("diagnostics", []) if item else []}
            report["ok"] = all(value["installed"] and value["compatible"] for value in report["engines"].values())
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
