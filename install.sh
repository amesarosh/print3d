#!/bin/bash
# Build the Print3D Studio .deb and install it. Works from any directory.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/app"
npm run dist
version=$(node -p "require('./package.json').version")
sudo apt install --reinstall "./release/print3d-studio_${version}_amd64.deb"
