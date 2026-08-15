#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
glib-compile-schemas schemas
out="${1:-$HOME/Pulpit}"
mkdir -p "$out"
gnome-extensions pack \
  --extra-source=eq.conf \
  --extra-source=presets.js \
  --extra-source=LICENSE \
  --force \
  -o "$out"
echo "Packed: $out/sstuner@gorian.github.io.shell-extension.zip"
