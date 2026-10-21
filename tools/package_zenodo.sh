#!/bin/sh
# Build the two Zenodo deposits of QACOBench from this checkout.
#
#   output/zenodo/qacobench-software-<version>.tar.xz
#       the repository (code, schemas, engines, Docker configuration, original
#       source inputs, transformation scripts, documentation, notebooks) and the
#       recorded campaign outputs under .artifacts/qacobench/, WITHOUT the seven
#       BIM instance directories datasets/0*_*/ (they are too large for the
#       software record);
#   output/zenodo/qacobench-bim-dataset-<version>.tar.xz
#       only the seven instance directories plus the dataset notices
#       (README, attribution, third-party licenses), rooted at datasets/ so that
#       extracting both archives in the same directory restores the layout the
#       experiment scripts expect.
#
# Usage: tools/package_zenodo.sh [version]      (default: 1.1.1)
# Requirements: tar with xz support (macOS and GNU tar both qualify).
# Secrets (.env, credentials) and system residue (.DS_Store, __MACOSX, ._*,
# Thumbs.db, desktop.ini) are never included; the .env.example templates are.
set -eu

VERSION=${1:-1.1.1}
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/output/zenodo"
STAGE="$OUT/stage-$VERSION"
SOFTWARE="$OUT/qacobench-software-$VERSION.tar.xz"
DATASET="$OUT/qacobench-bim-dataset-$VERSION.tar.xz"
# Archives are written outside the tree being read, then moved into place.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/qacobench-zenodo.XXXXXX")
trap 'rm -rf "$WORK" "$STAGE"' EXIT INT TERM

cd "$ROOT"
mkdir -p "$OUT"
rm -rf "$STAGE"
mkdir -p "$STAGE/datasets"

suites=$(ls -d datasets/0[0-9]_* 2>/dev/null || true)
if [ -z "$suites" ]; then
    echo "no datasets/0*_* instance directories found; run the transformers and run.sh generate first" >&2
    exit 1
fi
for suite in $suites; do
    count=$(find "$suite" -name instance.json | wc -l | tr -d ' ')
    echo "$suite: $count instances"
done

# ---------------------------------------------------------------- dataset
# Notices travel with the instances: the dataset README/attribution prepared in
# output/zenodo/dataset/ and the upstream licenses of reused material.
cp "$OUT/dataset/README.md" "$STAGE/datasets/README.md"
cp "$OUT/dataset/ATTRIBUTION.md" "$STAGE/datasets/ATTRIBUTION.md"
mkdir -p "$STAGE/datasets/licenses"
if [ -f datasets/sources/bws_scp/BWS-SCP-main/LICENSE ]; then
    cp datasets/sources/bws_scp/BWS-SCP-main/LICENSE "$STAGE/datasets/licenses/BWS-SCP-LICENSE"
fi
cp "$ROOT/LICENSE" "$STAGE/datasets/licenses/OPENBINDING-LICENSE"

# shellcheck disable=SC2086
tar -cJf "$WORK/dataset.tar.xz" \
    --exclude '.DS_Store' --exclude '__MACOSX' --exclude '._*' --exclude 'Thumbs.db' --exclude 'desktop.ini' \
    -C "$STAGE" datasets \
    -C "$ROOT" $suites
mv "$WORK/dataset.tar.xz" "$DATASET"
echo "wrote $DATASET ($(du -h "$DATASET" | cut -f1))"

# ---------------------------------------------------------------- software
# Everything else: the checkout minus the instance directories, the build and
# dependency trees, caches, secrets and the Zenodo archives themselves.
# Top-level entries are listed explicitly so that archive paths start at the
# checkout root (extracting both archives in one directory restores the layout).
set --
for entry in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$entry" ] || continue
    name=${entry##*/}
    case "$name" in
        .git|.venv|node_modules|.pnpm-store|.env|.claude|.codex|.agents|.DS_Store|.artifacts) continue ;;
    esac
    set -- "$@" "$name"
done
tar -cJf "$WORK/software.tar.xz" \
    --exclude '.git' --exclude '.venv' --exclude 'node_modules' --exclude '.pnpm-store' \
    --exclude '__pycache__' --exclude '.pytest_cache' --exclude '.ruff_cache' --exclude '.mypy_cache' \
    --exclude '.ipynb_checkpoints' --exclude '.claude' \
    --exclude '.env' --exclude '*/.env' \
    --exclude 'datasets/0[0-9]_*' \
    --exclude 'output/zenodo/*.tar.xz' --exclude 'output/zenodo/stage-*' \
    --exclude 'output/zenodo/*.tar.gz' --exclude 'output/zenodo/*.zip' --exclude 'output/zenodo/*.part*' \
    --exclude 'experimentation/icsoc/out' --exclude 'experimentation/icsoc/original_dataset' \
    --exclude '.artifacts/qacobench/smoke-datasets' \
    --exclude '.DS_Store' --exclude '__MACOSX' --exclude '._*' --exclude 'Thumbs.db' --exclude 'desktop.ini' \
    -C "$ROOT" "$@" .artifacts/qacobench
mv "$WORK/software.tar.xz" "$SOFTWARE"
echo "wrote $SOFTWARE ($(du -h "$SOFTWARE" | cut -f1))"

echo "checksums:"
(cd "$OUT" && shasum -a 256 "$(basename "$SOFTWARE")" "$(basename "$DATASET")") 2>/dev/null \
    || (cd "$OUT" && sha256sum "$(basename "$SOFTWARE")" "$(basename "$DATASET")")
