#!/bin/sh
# Run on a Mac with the nipogi-dev SSH alias to follow the remote campaign.
set -u

host=${NIPOGI_SSH_HOST:-nipogi-dev}
remote=/srv/lab/projects/qacobench/.artifacts/qacobench

while :; do
    if ! snapshot=$(ssh -o BatchMode=yes "$host" "root=$remote; \
        instances=0; runs=0; \
        if test -f \"\$root/../../datasets/07_qfbs/manifest.jsonl\"; then \
            instances=\$(wc -l < \"\$root/../../datasets/07_qfbs/manifest.jsonl\"); \
        fi; \
        if test -f \"\$root/results.jsonl\"; then \
            runs=\$(wc -l < \"\$root/results.jsonl\"); \
        fi; \
        stage=pending; \
        if test -f \"\$root/campaign.stage\"; then stage=\$(cat \"\$root/campaign.stage\"); fi; \
        printf 'fase %s | QFBS %s/5200 instancias | campaña %s/46350 ejecuciones\\n' \"\$stage\" \"\$instances\" \"\$runs\"; \
        if test -f \"\$root/CAMPAIGN_DONE\"; then \
            printf 'CAMPAIGN_DONE\\n'; \
        elif test -f \"\$root/campaign.exit\"; then \
            printf 'CAMPAIGN_EXIT=%s\\n' \"\$(cat \"\$root/campaign.exit\")\"; \
        else \
            tail -n 1 \"\$root/campaign.log\" 2>/dev/null || true; \
        fi"); then
        printf '%s: conexión SSH fallida; reintentando\n' "$(date '+%F %T')" >&2
    else
        printf '%s | %s\n' "$(date '+%F %T')" "$snapshot"
        case "$snapshot" in
            *CAMPAIGN_DONE*)
                printf '\aCampaña completa. Avísame para iniciar la evaluación.\n'
                exit 0
                ;;
            *CAMPAIGN_EXIT=*)
                printf '\aLa campaña se detuvo. Envíame este estado y el final de campaign.log.\n' >&2
                exit 2
                ;;
        esac
    fi
    sleep 30
done
