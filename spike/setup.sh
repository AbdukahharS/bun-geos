#!/usr/bin/env bash
# Phase 0 spike: reproduce the native build from scratch.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. GEOS 3.14.1 from source (RPATH-baked install tree, mirroring Phase 4 packaging)
git clone --depth 1 --branch 3.14.1 https://github.com/libgeos/geos.git vendor/geos
cmake -S vendor/geos -B spike/build/geos -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ \
  -DCMAKE_INSTALL_PREFIX="$PWD/spike/build/geos-install" \
  -DCMAKE_INSTALL_RPATH='$ORIGIN' -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=FALSE
ninja -C spike/build/geos -j "$(nproc)"
ninja -C spike/build/geos install

# 2. The shim (DT_RPATH — not RUNPATH! — so the chain resolves transitively)
gcc -O2 -fPIC -shared -Wall -Wextra native/shim.c -o spike/build/shim.so \
  -Lspike/build/geos-install/lib -lgeos_c \
  -Wl,--disable-new-dtags -Wl,-rpath,'$ORIGIN/geos-install/lib'

# 3. The FFI value-roundtrip echo lib
gcc -O2 -fPIC -shared -Wall -Wextra spike/values.c -o spike/build/values.so

# 4. Optional: standalone C proof of the shim slice
gcc -O2 -I spike/build/geos-install/include spike/shim-driver.c \
  -o spike/build/shim-driver -Lspike/build/geos-install/lib -lgeos_c \
  -Wl,-rpath-link,spike/build/geos-install/lib \
  -Wl,--disable-new-dtags -Wl,-rpath,'$ORIGIN/geos-install/lib'

echo "done — bun test spike/"
