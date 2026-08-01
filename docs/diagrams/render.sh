#!/usr/bin/env bash
set -euo pipefail
# Renders docs/diagrams/*.puml to PNG in images/external/.
#
# Same mechanism CI uses — the plantuml/plantuml container, so nothing
# needs installing beyond docker. Matching how markdown-pol-docs does it.
#
#   ./docs/diagrams/render.sh
#
# The output filename comes from the name on the @startuml line, falling
# back to the source filename.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

command -v docker >/dev/null || { echo "ERROR: docker not found" >&2; exit 1; }
mkdir -p images/external

shopt -s nullglob
for puml_file in docs/diagrams/*.puml; do
  diagram_name="$(grep -m1 '^@startuml' "$puml_file" | sed 's/@startuml[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$diagram_name" ] || diagram_name="$(basename "$puml_file" .puml)"

  docker run --rm -v "$(pwd):/work" -w /work plantuml/plantuml:latest \
    -o /work/images/external -tpng "$puml_file"

  original_name="$(basename "$puml_file" .puml)"
  if [ "$diagram_name" != "$original_name" ] && [ -f "images/external/${original_name}.png" ]; then
    mv "images/external/${original_name}.png" "images/external/${diagram_name}.png"
  fi
  echo "  $puml_file -> images/external/${diagram_name}.png"
done
echo "done"
