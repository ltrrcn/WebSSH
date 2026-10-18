#!/bin/bash
# 构建通用 Docker 镜像（tag: webssh:<version> + webssh:latest）
# 用法：npm run docker:build [-- <platform>]，如 npm run docker:build -- linux/amd64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -p "require('$ROOT/package.json').version")

ARGS=(--tag "webssh:$VERSION" --tag "webssh:latest")
if [ -n "${1:-}" ]; then
  ARGS+=(--platform "$1")
fi

echo "构建 webssh:$VERSION …"
docker build "${ARGS[@]}" "$ROOT"
echo "完成：webssh:$VERSION / webssh:latest"
