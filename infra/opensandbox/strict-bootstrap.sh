#!/bin/sh
# Keep the execd credential out of Docker Config.Env and the native Runner.
set -eu
EXECD_ACCESS_TOKEN=$(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')
export EXECD_ACCESS_TOKEN
exec /opt/opensandbox/upstream-bootstrap.sh "$@"
