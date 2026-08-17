#!/usr/bin/env bash
#
# Restores ./postman/collections/PostFinanceCo API from a restore_points/collectionvX.zip
# snapshot, overwriting whatever is currently there.
#
# Usage: restore-collection.sh -v <1|1.5|2>

set -euo pipefail

usage() {
  echo "Usage: $0 -v <1|1.5|2>" >&2
  exit 1
}

VERSION=""
while getopts ":v:" opt; do
  case "$opt" in
    v) VERSION="$OPTARG" ;;
    *) usage ;;
  esac
done

case "$VERSION" in
  1|1.5|2) ;;
  *) usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ZIP_PATH="$REPO_ROOT/restore_points/collectionv${VERSION}.zip"
DEST_PARENT="$REPO_ROOT/postman/collections"
DEST_DIR="$DEST_PARENT/PostFinanceCo API"

if [ ! -f "$ZIP_PATH" ]; then
  echo "Error: restore point not found at $ZIP_PATH" >&2
  exit 1
fi

rm -rf "$DEST_DIR"
mkdir -p "$DEST_PARENT"
unzip -q "$ZIP_PATH" -d "$DEST_PARENT"

echo "Restored (v$VERSION): $DEST_DIR"
