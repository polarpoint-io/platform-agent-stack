#!/usr/bin/env bash
set -euo pipefail
# Renders every .puml here to SVG. Run after editing a diagram — the SVGs
# are committed because GitHub cannot render PlantUML in markdown.
#
#   ./render.sh
#
# Needs java and graphviz. plantuml.jar is downloaded on first run to
# .cache/ (git-ignored); set PLANTUML_JAR to use your own copy.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLANTUML_VERSION="${PLANTUML_VERSION:-1.2026.6}"
JAR="${PLANTUML_JAR:-$HERE/.cache/plantuml-${PLANTUML_VERSION}.jar}"

command -v java >/dev/null || { echo "ERROR: java not found" >&2; exit 1; }
command -v dot  >/dev/null || { echo "ERROR: graphviz (dot) not found" >&2; exit 1; }

if [ ! -f "$JAR" ]; then
  mkdir -p "$(dirname "$JAR")"
  echo "fetching plantuml ${PLANTUML_VERSION}"
  curl -sSL -o "$JAR" \
    "https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar"
fi

# C4-PlantUML is vendored in c4-plantuml/ so rendering works offline and
# a change to the upstream library can't silently redraw your diagrams.
cd "$HERE"
for f in *.puml; do
  java -jar "$JAR" -tsvg -nbthread auto "$f"
  echo "  $f -> ${f%.puml}.svg"
done
echo "done"
