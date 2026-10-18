# syntax=docker/dockerfile:1
# WebSSH 容器镜像：standalone 模式（无 TRIM_APPNAME 由 src/runtime/profile.js 自动探测）
# 数据卷 /data（= WEBSSH_HOME），首启配置由 docker-entrypoint.sh 生成
# 构建：npm run docker:build
# 本文件是通用镜像与飞牛 Docker 版（packaging/fnos-docker）的唯一真相源

# —— deps：安装生产依赖（纯 JS，宪法第 II 条：禁止原生编译模块）——
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-optional --silent \
 && if find node_modules -name '*.node' | grep -q .; then \
      echo 'ERROR: 存在原生编译模块（宪法第 II 条禁止）' >&2; exit 1; \
    fi

# —— runtime：最小最终层（无 dev 依赖、无构建缓存、无 shell 工具链）——
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production \
    WEBSSH_HOME=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
