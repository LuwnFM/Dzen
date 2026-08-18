#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install "playwright>=1.54,<2"
python -m playwright install chromium
python dzen_collect.py
echo "Done. See ./results"
