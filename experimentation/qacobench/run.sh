#!/bin/sh
# Single entry point for the isolated, versioned Docker experiment.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/experimentation/qacobench/compose.yaml"
REVISION=${QACOBENCH_REVISION:-qfbs-v3}
export QACOBENCH_REVISION="$REVISION"
cd "$ROOT"
mkdir -p datasets .artifacts/qacobench

compose() { docker compose -f "$COMPOSE" "$@"; }
runner() {
    script=$1
    shift
    compose run --rm --no-deps runner python "experimentation/qacobench/$script" "$@"
}
transformer() {
    script=$1
    shift
    compose run --rm --no-deps runner python "transformations/scripts/$script" "$@"
}

images() {
    printf '%s\n' \
        "qacobench/gateway:$REVISION" \
        "qacobench/runner:$REVISION" \
        "qacobench/minizinc:$REVISION" \
        "qacobench/random-search:$REVISION" \
        "qacobench/evolutionary-heuristics:$REVISION"
}

ensure_stack() {
    # shellcheck disable=SC2046
    if ! docker image inspect $(images) >/dev/null 2>&1; then
        compose build --quiet
    fi
    compose up -d gateway worker seed-engines
}

manifest() {
    # shellcheck disable=SC2046
    docker image inspect $(images) > .artifacts/qacobench/image_inspect.json
    uname -a > .artifacts/qacobench/host.txt
    if command -v git >/dev/null 2>&1; then
        git describe --always --dirty > .artifacts/qacobench/source_revision.txt 2>/dev/null || true
    fi
    test -f .artifacts/qacobench/source_revision.txt || echo unavailable > .artifacts/qacobench/source_revision.txt
    # Solver identities inside the exact engine image (MiniZinc and Gecode versions).
    docker run --rm "qacobench/minizinc:$REVISION" sh -c 'minizinc --version; minizinc --solvers' \
        > .artifacts/qacobench/minizinc_versions.txt 2>&1 || echo unavailable > .artifacts/qacobench/minizinc_versions.txt
    runner capture_run_manifest.py \
        --images-json .artifacts/qacobench/image_inspect.json \
        --host-text .artifacts/qacobench/host.txt \
        --revision-file .artifacts/qacobench/source_revision.txt \
        --solver-versions .artifacts/qacobench/minizinc_versions.txt
}

pilot() {
    runner generate_qfbs.py --pilot --target .artifacts/qacobench/smoke-datasets/07_qfbs
    runner preflight.py --package .artifacts/qacobench/smoke-datasets/07_qfbs/guaranteed/cell_00/qfbs_guaranteed_00_000
    runner run_smoke.py --datasets-root .artifacts/qacobench/smoke-datasets
}

transform() {
    # Regenerate the three source suites whose transformation changed (BWS-SCP, HSC-LLM, RPRSR15).
    # Inputs: datasets/sources/<suite>/ on the host (mounted at /workspace/datasets).
    transformer transform_bws_scp.py
    transformer transform_rprsr15.py
    transformer transform_hsc.py
    # benchmark-metadata.json of the six recovered suites: corrected provenance, file hashes and
    # the campaign's package digest (informational; excluded from the digest itself).
    transformer write_benchmark_metadata.py
}

analyze() {
    # Secondary analyses (optimality gaps, reconciliation, timing, capability matrix, figures, tables).
    runner secondary/run_all.py "$@"
}

stage=${1:-help}
shift || true
case "$stage" in
    reset)
        # Drop the Compose volumes: the gateway database keeps every registered engine revision,
        # so a changed engine manifest must start from an empty registry (campaign.py refuses stale ones).
        compose down -v --remove-orphans ;;
    build) compose build --quiet; compose up -d gateway worker seed-engines ;;
    pilot|smoke) ensure_stack; pilot ;;
    transform) ensure_stack; transform ;;
    generate) ensure_stack; runner generate_qfbs.py "$@" ;;
    campaign) ensure_stack; runner campaign.py --all --timeout-ms 5000 "$@" ;;
    evaluate) ensure_stack; runner evaluate_results.py .artifacts/qacobench/results.jsonl --require-release-counts "$@" ;;
    analyze) ensure_stack; analyze "$@" ;;
    figures) ensure_stack; runner plot_results.py --qfbs-manifest datasets/07_qfbs/manifest.jsonl --outcomes-csv .artifacts/qacobench/evaluation/outcomes_by_suite_engine.csv --out-dir .artifacts/qacobench/figures "$@" ;;
    notebooks) ensure_stack; runner execute_notebooks.py "$@" ;;
    manifest) ensure_stack; manifest ;;
    all)
        ensure_stack
        pilot
        transform
        runner generate_qfbs.py
        manifest
        runner campaign.py --all --timeout-ms 5000
        runner evaluate_results.py .artifacts/qacobench/results.jsonl --require-release-counts
        runner plot_results.py --qfbs-manifest datasets/07_qfbs/manifest.jsonl --outcomes-csv .artifacts/qacobench/evaluation/outcomes_by_suite_engine.csv --out-dir .artifacts/qacobench/figures
        analyze
        runner execute_notebooks.py
        ;;
    jupyter) ensure_stack; compose --profile jupyter up -d jupyter ;;
    help|*)
        printf '%s\n' 'Usage: experimentation/qacobench/run.sh {reset|build|pilot|transform|generate|manifest|campaign|evaluate|analyze|figures|notebooks|all|jupyter}'
        printf '%s\n' "Images are tagged qacobench/*:$REVISION (override with QACOBENCH_REVISION)."
        ;;
esac
