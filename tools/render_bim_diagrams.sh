#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/docs/models/plantuml"
output_dir="$repo_root/docs/models/generated"
image="ghcr.io/plantuml/plantuml:1.2026.7@sha256:f2c8916a795483bf32ea61ca63b1c6726845c0085c997d86431e20b52ca1c257"
mode="${1:-render}"

if [[ "$mode" != "render" && "$mode" != "--check" ]]; then
  echo "usage: tools/render_bim_diagrams.sh [--check]" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to render BIM diagrams" >&2
  exit 1
fi

shopt -s nullglob
host_sources=("$source_dir"/*.puml)
if ((${#host_sources[@]} == 0)); then
  echo "no PlantUML sources found in $source_dir" >&2
  exit 1
fi
container_sources=()
for source in "${host_sources[@]}"; do
  container_sources+=("/src/${source##*/}")
done

rendered_dir="$(mktemp -d)"
trap 'rm -rf "$rendered_dir"' EXIT

docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  -e PLANTUML_SECURITY_PROFILE=SANDBOX \
  -v "$source_dir:/src:ro" \
  -v "$rendered_dir:/out" \
  "$image" \
  -tsvg -nometadata -failfast2 -o /out "${container_sources[@]}"

if [[ "$mode" == "--check" ]]; then
  if ! diff -ruN "$output_dir" "$rendered_dir"; then
    echo "BIM diagram SVGs are stale; run tools/render_bim_diagrams.sh" >&2
    exit 1
  fi
  echo "BIM diagram SVGs are current (${#host_sources[@]} diagrams)"
  exit 0
fi

mkdir -p "$output_dir"
find "$output_dir" -maxdepth 1 -type f -name '*.svg' -delete
cp "$rendered_dir"/*.svg "$output_dir"/
echo "Rendered ${#host_sources[@]} BIM diagram SVGs in $output_dir"
