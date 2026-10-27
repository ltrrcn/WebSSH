#!/bin/bash
# 同步公开镜像到 GitHub（github 远端 = github.com/ltrrcn/WebSSH）
# CNB（origin）为全量内部仓；本脚本维护 github-sync 分支，剔除内部目录后推送 GitHub。
# 用法：npm run sync:github
# 注意：
#   - 剔除仅作用于推送内容，GitHub 历史提交中已存在的文件仍可追溯；
#     如需彻底抹除历史需 git filter-repo 重写（破坏性操作，需人工确认）
#   - 剔除 tests 后 GitHub 公开版 npm test 不可用；README 中 specs/.specify 引用为死链
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 公开镜像剔除清单（CNB 保留、GitHub 移除）
STRIP=(specs .codebuddy .specify docs tests)

# github-sync 分支：首次创建则基于 main
git rev-parse --verify github-sync >/dev/null 2>&1 || git branch github-sync main
git checkout -q github-sync

# 合并 main 最新进度（删除 vs 修改冲突时需人工处理）
git merge -q main

# 剔除内部目录（仅索引；--ignore-unmatch 容忍已剔除的路径）
git rm -r -q --cached --ignore-unmatch "${STRIP[@]}"

if ! git diff --cached --quiet; then
  git commit -qm "chore(sync): 公开镜像剔除内部目录（${STRIP[*]}）"
fi

git push github github-sync:main
echo "完成：github-sync → github:main（已剔除 ${STRIP[*]}）"

git checkout -q main
