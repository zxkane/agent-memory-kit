#!/bin/bash
# The kit's tests (npm test). No test may reach a real instance metadata service or real AWS
# credentials: every AWS_* variable is removed, and the SDK's instance metadata endpoint is a
# closed loopback port. The tests' own child environments carry the same endpoint (helpers.mjs).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for name in $(compgen -e); do
    if [[ $name == AWS_* ]]; then unset "$name"; fi
done
export AWS_EC2_METADATA_SERVICE_ENDPOINT=http://127.0.0.1:9
node --test workstation/test/*.test.mjs
bash test/setup.test.sh
