#!/bin/sh
# Start the complete campaign on a Docker host without tying it to the SSH session.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
state="$root/.artifacts/qacobench"
mkdir -p "$state"
if test -f "$state/CAMPAIGN_DONE"; then
    echo "Campaign already complete: $state/CAMPAIGN_DONE"
    exit 0
fi
if test -f "$state/campaign.pid"; then
    old_pid=$(cat "$state/campaign.pid")
    if kill -0 "$old_pid" 2>/dev/null; then
        echo "Campaign already running as PID $old_pid"
        exit 0
    fi
fi
rm -f "$state/campaign.exit"
: > "$state/campaign.log"
nohup sh -c '
    cd "$1" || exit 1
    set +e
    code=0
    for stage in generate manifest campaign; do
        printf "%s\n" "$stage" > .artifacts/qacobench/campaign.stage
        printf "\n=== %s ===\n" "$stage" >> .artifacts/qacobench/campaign.log
        experimentation/qacobench/run.sh "$stage" >> .artifacts/qacobench/campaign.log 2>&1
        code=$?
        if test "$code" -ne 0; then
            break
        fi
    done
    printf "%s\n" "$code" > .artifacts/qacobench/campaign.exit
    exit "$code"
' sh "$root" </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$state/campaign.pid"
echo "Started campaign as PID $!; log: $state/campaign.log"
