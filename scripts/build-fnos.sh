#!/bin/bash
# 构建 fnOS 应用包（T068）
# 同步 src/web/package.json → packaging/fnos/app/，安装生产依赖（纯 JS 校验），fnpack build
# 用法：npm run pack:fnos [-- --clean]  --clean 打包前清理历史构建缓存（旧版本 fpk、rsync 暂存、node_modules）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packaging/fnos"
APP_DIR="$PKG_DIR/app"

# 版本唯一真相源：package.json → manifest，产物带版本号重命名
VERSION=$(node -p "require('$ROOT/package.json').version")
sed -i.bak "s/^version=.*/version=$VERSION/" "$PKG_DIR/manifest" && rm -f "$PKG_DIR/manifest.bak"
echo "  版本：$VERSION"

if [ "${1:-}" = "--clean" ]; then
  echo "[0/5] 清理历史构建缓存…"
  # 历代 fpk 产物（清理后由本次构建重新生成当前版本）
  find "$PKG_DIR" -maxdepth 1 -name "webssh-*.fpk" -delete
  # rsync 暂存 + npm 依赖缓存 + 生成图标（均由后续步骤重建）
  rm -rf "$APP_DIR/src" "$APP_DIR/web" "$APP_DIR/node_modules" \
         "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/.npmrc" \
         "$APP_DIR/ui/images"
  echo "  已清理历史 fpk 与 app/ 打包暂存"
fi

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

echo "[4/5] fnpack build（x86 + arm64 双产物，包内容相同仅 platform 声明不同）…"
chmod +x "$PKG_DIR/cmd/main"
mkdir -p "$PKG_DIR/wizard"
cd "$PKG_DIR"

build_fpk() { # $1=platform 值 $2=产物文件名后缀
  sed -i.bak "s/^platform=.*/platform=$1/" manifest && rm -f manifest.bak
  fnpack build --directory "$PKG_DIR"
  mv -f webssh.fpk "webssh-$VERSION$2.fpk"
  echo "  产物：webssh-$VERSION$2.fpk（platform=$1）"
}
build_fpk x86 ""
build_fpk arm "-arm64"

# 仓库默认态恢复 all（纯 JS 包本身双架构通用；分发按架构取专用包）
sed -i.bak "s/^platform=.*/platform=all/" manifest && rm -f manifest.bak

echo "[5/5] 完成："
echo "  $PKG_DIR/webssh-$VERSION.fpk（x86）"
echo "  $PKG_DIR/webssh-$VERSION-arm64.fpk（arm64）"
