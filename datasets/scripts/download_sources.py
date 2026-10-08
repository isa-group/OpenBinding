#!/usr/bin/env python3
"""Download and verify external benchmark sources for QACOBench."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES_DIR = ROOT / "datasets" / "sources"

SOURCES = {
    "rprsr15": {
        "url": "https://www.uco.es/grupos/kdis/sbse/RPRSR15/rprsr15-problemInstances.zip",
        "dir": SOURCES_DIR / "rprsr15",
        "indicator": SOURCES_DIR / "rprsr15" / "experiment1",
        "description": "RPRSR15 many-objective QoS-aware service composition benchmark (Ramirez et al., 2017)",
    },
    "iots": {
        "url": "https://zenodo.org/api/records/10440967/files/IoTS_Dataset.zip/content",
        "dir": SOURCES_DIR / "iots",
        "indicator": SOURCES_DIR / "iots" / "IoTS_Dataset",
        "description": "IoTS IoT service composition dataset (Tang et al., 2024 / Zenodo 10440967)",
    },
    "bws_scp": {
        "url": "https://codeload.github.com/FMahroo/BWS-SCP/zip/refs/heads/main",
        "dir": SOURCES_DIR / "bws_scp",
        "indicator": SOURCES_DIR / "bws_scp" / "BWS-SCP-main",
        "description": "BWS-SCP cloud-manufacturing benchmark (Mahroo et al., 2025 / GitHub FMahroo/BWS-SCP)",
    },
}


def download_and_unpack(key: str, info: dict, force: bool = False) -> bool:
    target_dir = info["dir"]
    check_indicator = info["indicator"]
    if check_indicator.exists() and not force:
        print(f"Source '{key}' already present and uncompressed in {target_dir}")
        return True

    temp_zip = target_dir / "_temp_download.zip"
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {key} from {info['url']}...")
    try:
        subprocess.run(["curl", "-sL", "-A", "Mozilla/5.0", info["url"], "-o", str(temp_zip)], check=True)
        if temp_zip.stat().st_size < 1000:
            print(f"  [FAIL] Downloaded file too small ({temp_zip.stat().st_size} bytes)")
            temp_zip.unlink(missing_ok=True)
            return False

        print(f"  [OK] Unpacking into {target_dir}...")
        import zipfile
        with zipfile.ZipFile(temp_zip) as zf:
            zf.extractall(target_dir)
        temp_zip.unlink()
        print(f"  [OK] {key} ready and uncompressed.")
        return True
    except Exception as e:
        print(f"  [ERROR] {e}")
        temp_zip.unlink(missing_ok=True)
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Force re-download and unpack")
    args = parser.parse_args()

    for key, info in SOURCES.items():
        download_and_unpack(key, info, force=args.force)

    print("\nSource verification complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
