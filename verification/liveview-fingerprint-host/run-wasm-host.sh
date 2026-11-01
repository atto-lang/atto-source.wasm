#!/usr/bin/env bash
set -euo pipefail
R=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
H="$R/verification/liveview-fingerprint-host"
python3 "$H/verify_tsv_against_fixture.py" "$R/contracts/v1/ores-liveview-event-fingerprint-v1.json" "$H/fingerprint-v1.tsv"
node --test "$H/liveview_fingerprint_webcrypto.test.mjs"
