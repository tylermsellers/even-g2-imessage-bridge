#!/bin/sh
# Applies the 30-day MAP message history filter to the freshly-cloned tether
# source, before it is compiled. See README.md in this directory for why this
# exists and how the filter works. `patch -p1 --forward` bails loudly (via
# `set -e`) if upstream drifts far enough that a hunk no longer applies
# cleanly, rather than silently building unpatched code.
set -e

cd /src

for p in /tmp/tether-patch/*.patch; do
    echo "Applying $p"
    patch -p1 --forward < "$p"
done
