#!/bin/bash
# 构建飞牛 Docker 版 fpk（docker-project 形态，与 native 版 webssh 共存）
# 用法：npm run pack:fnos:docker [-- --image | --clean]
#   --image  额外在本地构建双架构镜像并导出 tar.gz（NAS Docker Hub 不通时离线导入用）
#   --clean  打包前清理历史构建缓存（旧版本 fpk、构建上下文、离线镜像导出）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packaging/fnos-docker"
APP_DIR="$PKG_DIR/app"
BUILD_CTX="$APP_DIR/docker/app"

# 版本唯一真相源：package.json → manifest + compose 镜像 tag，产物带版本号重命名
VERSION=$(node -p "require('$ROOT/package.json').version")
sed -i.bak "s/^version=.*/version=$VERSION/" "$PKG_DIR/manifest" && rm -f "$PKG_DIR/manifest.bak"
sed -i.bak "s#^image:.*#image: docker.cnb.cool/ltrr/webssh:$VERSION#" "$APP_DIR/docker/docker-compose.yaml" \
  && rm -f "$APP_DIR/docker/docker-compose.yaml.bak"
echo "  版本：$VERSION"

if [ "${1:-}" = "--clean" ]; then
  echo "[0/6] 清理历史构建缓存…"
  # 历代 fpk 产物（清理后由本次构建重新生成当前版本）
  find "$PKG_DIR" -maxdepth 1 -name "webssh-docker-*.fpk" -delete
  # rsync 构建上下文 + 复制的图标暂存 + 离线镜像导出（均由后续步骤重建）
  rm -rf "$BUILD_CTX" "$APP_DIR/ui/images"
  rm -f "$PKG_DIR"/webssh-*-image-*.tar.gz
  echo "  已清理历史 fpk、构建上下文与离线镜像导出"
fi

echo "[1/6] 同步构建上下文（源码 + Dockerfile + 入口脚本）…"
# 容器内 npm ci 由 Dockerfile 完成，上下文不带 node_modules → fpk 体积最小
mkdir -p "$BUILD_CTX"
rsync -a --delete "$ROOT/src/" "$BUILD_CTX/src/"
rsync -a --delete "$ROOT/web/" "$BUILD_CTX/web/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$BUILD_CTX/"
cp "$ROOT/Dockerfile" "$ROOT/docker-entrypoint.sh" "$BUILD_CTX/"

echo "[2/6] 生成图标…"
# gen-icons 输出固定落 packaging/fnos（唯一真源 web/assets/logo.svg），此处复用产物
node "$ROOT/scripts/gen-icons.mjs"
mkdir -p "$APP_DIR/ui/images"
cp -f "$ROOT/packaging/fnos/app/ui/images/"icon_*.png "$APP_DIR/ui/images/"
cp -f "$ROOT/packaging/fnos/ICON.PNG" "$ROOT/packaging/fnos/ICON_256.PNG" "$PKG_DIR/"

echo "[3/6] fnpack build…"
chmod +x "$PKG_DIR/cmd/main"
mkdir -p "$PKG_DIR/wizard"
cd "$PKG_DIR"
fnpack build --directory "$PKG_DIR"

echo "[4/6] 产物带版本号重命名…"
mv -f webssh-docker.fpk "webssh-docker-$VERSION.fpk"

if [ "${1:-}" = "--image" ]; then
  echo "[5/6] 构建并导出离线镜像（amd64 + arm64）…"
  # 双架构分别构建导出：docker save 只能存单架构镜像，arm/x86 NAS 各导入对应文件
  for ARCH in amd64 arm64; do
    docker build --platform "linux/$ARCH" -t "webssh:$VERSION-$ARCH" "$BUILD_CTX"
    docker save "webssh:$VERSION-$ARCH" | gzip > "$PKG_DIR/webssh-$VERSION-image-$ARCH.tar.gz"
    echo "  离线镜像（$ARCH）：$PKG_DIR/webssh-$VERSION-image-$ARCH.tar.gz"
  done
  echo "  NAS 导入（按架构选文件）：gunzip -c webssh-$VERSION-image-<amd64|arm64>.tar.gz | docker load"
  echo "  导入后需重打 tag：docker tag webssh:$VERSION-<arch> docker.cnb.cool/ltrr/webssh:$VERSION"
fi

echo "[6/6] 完成：$PKG_DIR/webssh-docker-$VERSION.fpk"
