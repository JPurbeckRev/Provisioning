#!/bin/bash
# Platez deploy — stamps version timestamp and pushes to remote
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="jonathan@192.168.0.12:~/fc-project/web/html/Platez"
SSH_KEY="$HOME/.ssh/id_ed25519"
SCP="scp -o StrictHostKeyChecking=no -i $SSH_KEY"

# Stamp build timestamp into index.html (replace placeholder)
TS=$(date '+%Y-%m-%d %H:%M')
sed -i '' "s|v__BUILD_TS__|v${TS}|" "$SRC_DIR/index.html"

# Deploy
$SCP "$SRC_DIR/index.html" "$DEST/index.html"
$SCP "$SRC_DIR/admin.html" "$DEST/admin.html"
$SCP "$SRC_DIR/pipeline.html" "$DEST/pipeline.html"
$SCP "$SRC_DIR/benchmark.html" "$DEST/benchmark.html"
$SCP "$SRC_DIR/review.html" "$DEST/review.html"
$SCP "$SRC_DIR/data/plate-types.json" "$DEST/data/plate-types.json"

# Reset placeholder in local file so next deploy can re-stamp
sed -i '' "s|v${TS}|v__BUILD_TS__|" "$SRC_DIR/index.html"

echo "Deployed Platez v${TS}"
