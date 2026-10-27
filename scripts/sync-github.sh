#!/bin/bash
# 同步公开镜像到 GitHub（github 远端 = github.com/ltrrcn/WebSSH）
# CNB（origin）为全量内部仓；本脚本维护 github-sync 分支，剔除内部目录后推送 GitHub。
# 用法：npm run sync:github
#
# 实现说明：用临时索引（GIT_INDEX_FILE）直接从 main 的树构造剔除后的提交，
# 全程不切换分支、不触碰工作区文件；github-sync 保持线性历史（parent 链），
# 推送始终快进，无需 force。
#
# 注意：
#   - 剔除仅作用于推送内容，GitHub 历史提交中已存在的文件仍可追溯；
#     如需彻底抹除历史需 git filter-repo 重写（破坏性操作，需人工确认）
#   - 剔除 tests 后 GitHub 公开版 npm test 不可用；README 中 specs/.specify 引用为死链
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 公开镜像剔除清单（CNB 保留、GitHub 移除）
STRIP=(specs .codebuddy .specify docs tests)

MAIN_HEAD=$(git rev-parse main)
PARENT=$(git rev-parse --verify -q github-sync || echo "$MAIN_HEAD")

# 临时索引：main 的树 → 剔除内部目录 → 新树
TMP_INDEX=$(mktemp)
trap 'rm -f "$TMP_INDEX"' EXIT
GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$MAIN_HEAD"
for DIR in "${STRIP[@]}"; do
  # 逐顶层路径移除索引条目（ls-files 匹配索引，--cached 语义，不动工作区）
  if GIT_INDEX_FILE="$TMP_INDEX" git ls-files -- "$DIR" | grep -q .; then
    GIT_INDEX_FILE="$TMP_INDEX" git rm -r -q --cached -- "$DIR"
  fi
done
TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)

# 与上次同步结果相同则跳过（幂等）
LAST_TREE=$(git rev-parse "${PARENT}^{tree}" 2>/dev/null || echo "")
if [ "$TREE" = "$LAST_TREE" ]; then
  echo "无变化：github-sync 已是最新（$(git rev-parse --short github-sync)）"
  exit 0
fi

COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "chore(sync): 公开镜像剔除内部目录（${STRIP[*]}）")
git update-ref refs/heads/github-sync "$COMMIT"
git push github github-sync:main
echo "完成：github-sync → github:main（已剔除 ${STRIP[*]}，$(git rev-parse --short "$COMMIT")）"
