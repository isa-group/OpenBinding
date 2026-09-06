#!/usr/bin/env sh
# Prepare the exact SPACE source revision used by Docker Compose.
set -eu

repository=https://github.com/isa-group/space.git
tag=v1.5.0
commit=79aea10c9acff1d85e4931d09aa21d3a253d1ce1
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
checkout=${SPACE_SOURCE_DIR:-"$root/space-src"}

if [ ! -d "$checkout/.git" ]; then
  git clone --branch "$tag" --depth 1 "$repository" "$checkout"
fi

actual=$(git -C "$checkout" rev-parse HEAD)
if [ "$actual" != "$commit" ]; then
  if [ -n "$(git -C "$checkout" status --porcelain)" ]; then
    printf '%s\n' "SPACE checkout is dirty; refusing to replace $actual with $commit." >&2
    exit 1
  fi
  git -C "$checkout" fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  git -C "$checkout" checkout --detach "$commit"
fi

test "$(git -C "$checkout" rev-parse HEAD)" = "$commit"
printf 'SPACE %s ready at %s (%s).\n' "$tag" "$checkout" "$commit"
