#!/bin/bash
# 构建 fnOS 应用包（T068）
# 同步 src/web/package.json → packaging/fnos/app/，安装生产依赖（纯 JS 校验），fnpack build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packaging/fnos"
APP_DIR="$PKG_DIR/app"

# 版本唯一真相源：package.json → manifest，产物带版本号重命名
VERSION=$(node -p "require('$ROOT/package.json').version")
sed -i.bak "s/^version=.*/version=$VERSION/" "$PKG_DIR/manifest" && rm -f "$PKG_DIR/manifest.bak"
echo "  版本：$VERSION"

echo "[1/5] 同步应用文件到打包目录…"
# 尾部斜杠：同步目录【内容】，避免 src/src 嵌套；--delete 清理陈旧文件
rsync -a --delete "$ROOT/src/" "$APP_DIR/src/"
rsync -a --delete "$ROOT/web/" "$APP_DIR/web/"
cp "$ROOT/package.json" "$APP_DIR/package.json"
cp "$ROOT/.npmrc" "$APP_DIR/.npmrc" 2>/dev/null || true  # 固定公网 registry（私有镜像 403）

echo "[2/5] 生成图标…"
node "$ROOT/scripts/gen-icons.mjs"

echo "[3/5] 安装生产依赖（纯 JS）…"
cd "$APP_DIR"
npm install --omit=dev --no-optional --silent
if find node_modules -name "*.node" | grep -q .; then
  echo "ERROR: 存在原生编译模块（宪法第 II 条禁止）" >&2
  exit 1
fi

echo "[4/5] fnpack build…"
chmod +x "$PKG_DIR/cmd/main"
mkdir -p "$PKG_DIR/wizard"
cd "$PKG_DIR"
fnpack build --directory "$PKG_DIR"

echo "[5/5] 产物带版本号重命名…"
mv -f webssh.fpk "webssh-$VERSION.fpk"
echo "完成：$PKG_DIR/webssh-$VERSION.fpk"
