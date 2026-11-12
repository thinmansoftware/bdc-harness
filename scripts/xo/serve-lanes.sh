#!/bin/sh
# Compares the SERVED lane YAMLs (/.archon/workflows, a volume that overrides baked defaults by filename)
# with the BAKED defaults in the running archon-app-1 image. --apply copies baked over served for lanes that differ.
# Reconstructed 2026-09-24 after the /tmp original was lost in the M-20260924 reboot.
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
for f in $(docker exec archon-app-1 sh -c 'ls /app/.archon/workflows/defaults/bdc-feature-development*.yaml'); do
  b=$(basename "$f")
  if docker exec archon-app-1 cmp -s "$f" "/.archon/workflows/$b"; then echo "$b SAME"
  else echo "$b DIFFERS"; [ $APPLY = 1 ] && docker exec archon-app-1 cp "$f" "/.archon/workflows/$b" && echo "  applied"; fi
done
