#!/usr/bin/env bash
# Copy the ledger fixture into the run's empty working directory. The eval sandbox denies git, so
# the fixture is a plain folder, and bug-hunt takes the path it uses outside a git repo.
set -euo pipefail
cp -r "$(dirname "${BASH_SOURCE[0]}")/../fixtures/ledger/." .
