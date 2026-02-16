#!/bin/sh
# Make ".env copy" the active .env (keeps "env partner" as history).
# Run from repo root: sh scripts/use-env-copy.sh

cd "$(dirname "$0")/.."
if [ -f ".env copy" ]; then
  cp ".env copy" .env
  echo "Done: .env now uses the contents of .env copy. (env partner unchanged.)"
else
  echo "Error: file \".env copy\" not found in project root."
  exit 1
fi
