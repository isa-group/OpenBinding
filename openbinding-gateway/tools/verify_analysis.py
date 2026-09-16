"""Verify the populated application over HTTP. No fixtures or analysis response mocks."""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--manifest", type=Path, default=Path("tools/analysis-manifest.json"))
    parser.add_argument("--output", type=Path, default=Path("tools/analysis-verification.json"))
    parser.add_argument("--scale", action="store_true")
    parser.add_argument("--docker-memory", action="store_true", help="Record gateway process RSS from the development container")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    report = {"sourceManifest": str(args.manifest), "checks": [], "benchmarks": {}, "gaps": list(manifest["coverageGaps"])}
    def memory():
        if not args.docker_memory:
            return None
        status = subprocess.check_output(["docker", "compose", "exec", "-T", "gateway-dev", "cat", "/proc/1/status"], text=True)
        return {line.split(":")[0]: int(line.split()[1])*1024 for line in status.splitlines() if line.startswith(("VmRSS:", "VmHWM:"))}

    with httpx.Client(base_url=args.url, timeout=240) as client:
        login = client.post("/v1/auth/login", json={"username_or_email": "alice", "password": "devpass123"})
        login.raise_for_status()
        client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        def post(endpoint, payload):
            response = client.post(f"/v1/analysis/{endpoint}", json=payload)
            response.raise_for_status()
            return response
        for scenario, entry in manifest["scenarios"].items():
            if scenario.startswith("scale-") and not args.scale:
                continue
            try:
                query = {"sources": entry["jobIds"]}
                memory_before = memory() if scenario.startswith("scale-") else None
                start = time.perf_counter()
                response = post("query", query)
                result = response.json()
                assert result["revision"] == entry["revision"], "Source revision changed since population"
                assert result["counts"]["unique"] == entry["counts"]["unique"]
                if scenario.startswith("scale-"):
                    latency = [time.perf_counter() - start]
                    for page in (1, 2):
                        start = time.perf_counter()
                        next_page = post("query", {**query, "page": page}).json()
                        latency.append(time.perf_counter()-start)
                        assert len(next_page["rows"]) == 50 and next_page["page"] == page
                        assert next_page["winners"] == result["winners"]
                    report["benchmarks"][scenario] = {"httpSeconds": latency, "payloadBytes": len(response.content),
                        "count": result["counts"]["unique"], "paretoState": result["pareto"]["state"], "plotAggregated": result["plot"]["aggregated"],
                        "gatewayMemoryBytes": {"before": memory_before, "after": memory(), "peakMeaning": "VmHWM is the process lifetime high-water mark, not per-query allocation"}}
                else:
                    for view in ("decision", "budgets", "pareto", "preferences", "evidence"):
                        viewed = post("query", {**query, "view": view}).json()
                        assert viewed["counts"] == result["counts"], f"Counts changed in {view}"
                    if result["winners"]:
                        selected = result["winners"][0]["id"]
                        detail = post("candidate", {**query, "selected": selected}).json()
                        assert detail["row"]["score"] == result["winners"][0]["score"]
                        components = detail["explanation"]["components"]
                        weighted = [c["weight"]*c["normalized"] for c in components]
                        assert all(math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-10) for a, b in zip(detail["row"]["score"], [max(weighted), math.fsum(weighted)], strict=True)), f"Score arithmetic differs: {detail['row']['score']} vs {[max(weighted), sum(weighted)]}"
                        exported = post("export", {**query, "selected": selected, "format": "receipt"}).json()
                        assert exported["selected"][0]["binding"] == detail["binding"]
                    if entry["reportLink"]:
                        path = entry["reportLink"].split("/")
                        saved = client.get(f"/v1/organizations/{path[2]}/projects/{path[3]}/reports/{path[5]}")
                        saved.raise_for_status()
                        assert saved.json()["state"] == "draft", "Report is not a draft"
                        assert saved.json()["document"]["revision"] == result["revision"], "Saved report revision differs"
                if "task" in entry:
                    task_response = client.get(f"/v1/analysis/pareto/{entry['task']['id']}")
                    task_response.raise_for_status()
                    task = task_response.json()
                    assert task["state"] == entry["task"]["state"]
                    assert (task["result"] is not None) == (task["state"] == "completed")
                if scenario in ("decision-rules", "power-slice", "geometry-limit"):
                    axes = [d["key"] for d in result["dimensions"] if not d["constant"]][:3]
                    selected = result["winners"][0]["id"]
                    mapped = post("query", {**query, "view": "preferences", "geometry": "power", "rule": "weighted", "axes": axes, "selected": selected}).json()
                    geometry = mapped["geometry"]
                    assert geometry["state"] == "complete"
                    assert geometry["selectedOnly"] == (scenario == "geometry-limit")
                    assert geometry["competitors"] == result["counts"]["eligible"]
                    assert all(len(c["coefficients"]) == 3 for c in geometry["cells"])
                    if scenario == "power-slice":
                        assert geometry["mass"] < 1, "Hidden priorities must remain fixed"
                    if scenario == "decision-rules":
                        assert any(not cell["polygon"] for cell in geometry["cells"]), "Unsupported alternatives should have empty winner cells"
                        voronoi = post("query", {**query, "view": "pareto", "geometry": "voronoi"}).json()["geometry"]
                        assert voronoi["state"] == "complete"
                report["checks"].append({"scenario": scenario, "state": "passed"})
                print(f"PASS {scenario}", flush=True)
            except Exception as exc:
                report["checks"].append({"scenario": scenario, "state": "failed", "error": str(exc)})
                report["gaps"].append(f"{scenario}: {exc}")
                print(f"FAIL {scenario}: {exc}", flush=True)
        ids = manifest["scenarios"]["decision-rules"]["jobIds"]
        assert client.post("/v1/analysis/query", json={"sources": ids, "revision": "stale"}).status_code == 409
        mixed = ids + manifest["scenarios"]["constraints"]["jobIds"]
        assert client.post("/v1/analysis/query", json={"sources": mixed}).status_code == 422
        bob = client.post("/v1/auth/login", json={"username_or_email": "bob", "password": "devpass123"})
        bob.raise_for_status()
        assert client.post("/v1/analysis/query", json={"sources": ids}, headers={"Authorization": f"Bearer {bob.json()['access_token']}"}).status_code == 404
        saved_path = manifest["scenarios"]["decision-rules"]["reportLink"].split("/")
        saved_url = f"/v1/organizations/{saved_path[2]}/projects/{saved_path[3]}/reports/{saved_path[5]}"
        assert client.get(saved_url, headers={"Authorization": f"Bearer {bob.json()['access_token']}"}).status_code == 200, "Project members must be able to read saved snapshots"
        outsider = client.post("/v1/auth/login", json={"username_or_email": "elena", "password": "devpass123"})
        outsider.raise_for_status()
        assert client.get(saved_url, headers={"Authorization": f"Bearer {outsider.json()['access_token']}"}).status_code in (403, 404), "Draft snapshots must not be public"
        report["checks"].append({"scenario": "staleness-incompatible-pooling-ownership-report-visibility", "state": "passed"})
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    return bool(report["gaps"])


if __name__ == "__main__":
    raise SystemExit(main())
