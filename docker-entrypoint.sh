#!/bin/sh
# WebSSH 容器入口：目录准备 → 默认配置 → 降权执行
# PUID/PGID：容器内运行身份（飞牛部署时由 TRIM_UID/TRIM_GID 透传，默认 1000）
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p /data/etc /data/var/log /data/tmp
chmod 700 /data/etc

# 卷属主与容器运行用户不一致时收敛（首启或迁移后；数据目录小，开销可忽略）
chown -R "$PUID:$PGID" /data 2>/dev/null || true

# 首启默认配置：容器内必须监听 0.0.0.0 才能被端口映射；其余字段由 defaults.js 合并
if [ ! -f /data/etc/config.json ]; then
  printf '{\n  "version": 1,\n  "standalone": { "bind": "0.0.0.0", "port": 8080 }\n}\n' \
    > /data/etc/config.json
fi
chown "$PUID:$PGID" /data/etc/config.json
chmod 600 /data/etc/config.json

# exec + su-exec：node 即 PID1，SIGTERM 直达现有优雅退出逻辑
exec su-exec "$PUID:$PGID" node src/index.js
