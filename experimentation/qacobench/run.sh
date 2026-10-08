#!/bin/sh
# Single entry point for the isolated, versioned Docker experiment.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/experimentation/qacobench/compose.yaml"
cd "$ROOT"
mkdir -p datasets .artifacts/qacobench

compose() { docker compose -f "$COMPOSE" "$@"; }
runner() {
    script=$1
    shift
    compose run --rm --no-deps runner python "experimentation/qacobench/$script" "$@"
}

ensure_stack() {
    if ! docker image inspect \
        "qacobench/gateway:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/runner:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/minizinc:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/random-search:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/evolutionary-heuristics:${QACOBENCH_REVISION:-qfbs-v2}" \
        >/dev/null 2>&1; then
        compose build --quiet
    fi
    compose up -d gateway worker seed-engines
}

manifest() {
    docker image inspect \
        "qacobench/gateway:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/runner:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/minizinc:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/random-search:${QACOBENCH_REVISION:-qfbs-v2}" \
        "qacobench/evolutionary-heuristics:${QACOBENCH_REVISION:-qfbs-v2}" \
        > .artifacts/qacobench/image_inspect.json
    uname -a > .artifacts/qacobench/host.txt
    if command -v git >/dev/null 2>&1; then
        git describe --always --dirty > .artifacts/qacobench/source_revision.txt 2>/dev/null || true
    fi
    test -f .artifacts/qacobench/source_revision.txt || echo unavailable > .artifacts/qacobench/source_revision.txt
    runner capture_run_manifest.py \
        --images-json .artifacts/qacobench/image_inspect.json \
        --host-text .artifacts/qacobench/host.txt \
        --revision-file .artifacts/qacobench/source_revision.txt
}

pilot() {
    runner generate_qfbs.py --pilot --target .artifacts/qacobench/smoke-datasets/07_qfbs
    runner preflight.py --package .artifacts/qacobench/smoke-datasets/07_qfbs/guaranteed/cell_00/qfbs_guaranteed_00_000
    runner run_smoke.py --datasets-root .artifacts/qacobench/smoke-datasets
}

stage=${1:-help}
shift || true
case "$stage" in
    build) compose build --quiet; compose up -d gateway worker seed-engines ;;
    pilot|smoke) ensure_stack; pilot ;;
    generate) ensure_stack; runner generate_qfbs.py "$@" ;;
    campaign) ensure_stack; runner campaign.py --all --timeout-ms 5000 "$@" ;;
    evaluate) ensure_stack; runner evaluate_results.py .artifacts/qacobench/results.jsonl --require-release-counts "$@" ;;
    figures) ensure_stack; runner plot_results.py --qfbs-manifest datasets/07_qfbs/manifest.jsonl --outcomes-csv .artifacts/qacobench/evaluation/outcomes_by_suite_engine.csv --out-dir .artifacts/qacobench/figures "$@" ;;
    notebooks) ensure_stack; runner execute_notebooks.py "$@" ;;
    manifest) ensure_stack; manifest ;;
    all)
        ensure_stack
        pilot
        runner generate_qfbs.py
        manifest
        runner campaign.py --all --timeout-ms 5000
        runner evaluate_results.py .artifacts/qacobench/results.jsonl --require-release-counts
        runner plot_results.py --qfbs-manifest datasets/07_qfbs/manifest.jsonl --outcomes-csv .artifacts/qacobench/evaluation/outcomes_by_suite_engine.csv --out-dir .artifacts/qacobench/figures
        runner execute_notebooks.py
        ;;
    jupyter) ensure_stack; compose --profile jupyter up -d jupyter ;;
    help|*)
        printf '%s\n' 'Usage: experimentation/qacobench/run.sh {build|pilot|generate|manifest|campaign|evaluate|figures|notebooks|all|jupyter}'
        ;;
esac
