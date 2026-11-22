#!/bin/bash
# 所有前台进程由 Node supervisor 管理；这里只做目录和权限准备。
set -u

echo "=== T3 Code Agent Hub 启动 ==="

mkdir -p \
  /root/.codex /root/.claude /root/.config/opencode /root/.pi/agent \
  /root/.gemini /root/.t3 /root/.multica /root/.agent-hub \
  /root/.local/bin /var/log/agent-hub \
  /root/.agents /workspace/.agents/skills \
  /workspace/.tmp /workspace/.tmp/var-tmp \
  /workspace/.multica-workspaces \
  "${DATA_DIR:-/root/.agent-hub}"

# /tmp 和 /var/tmp 挂在 workspace 下，保持临时目录语义
chmod 1777 /tmp /var/tmp 2>/dev/null || true

# git 全局配置挂的是目录，GIT_CONFIG_GLOBAL 指向其中的文件；
# 文件缺失时 git 仍可运行，但先补一个方便用户直接 git config --global
mkdir -p /root/.config/git
[ -f /root/.config/git/gitconfig ] || : > /root/.config/git/gitconfig 2>/dev/null || true
chmod 600 /root/.config/git/gitconfig 2>/dev/null || true

# CLAUDE_CONFIG_DIR=/root/.claude：全局状态在持久化目录内，避免文件级挂载导致原子写入失败
# 如果是从旧布局升级，容器里可能还残留 /root/.claude.json，复制过来
if [ -s /root/.claude.json ] && [ ! -s /root/.claude/.claude.json ]; then
  cp /root/.claude.json /root/.claude/.claude.json
fi
[ -s /root/.claude/.claude.json ] || printf '{}\n' > /root/.claude/.claude.json
chmod 600 /root/.claude/.claude.json 2>/dev/null || true

# Claude 的用户技能目录：compose 把 /root/.claude/skills 挂成 tmpfs（容器内视图），
# 这里把 Claude 专有技能（/root/.claude-local-skills）和全局共享技能
# （/root/.agents/skills）用符号链接合并进去。Claude 官方支持技能目录内的符号链接，
# 会读取目标目录的 SKILL.md。专有技能先处理，同名时 Claude 专有版本优先。
sync_claude_skills() {
  mkdir -p /root/.claude/skills
  local source entry name
  for source in /root/.claude-local-skills /root/.agents/skills; do
    [ -d "$source" ] || continue
    for entry in "$source"/*; do
      [ -d "$entry" ] || continue
      name=${entry##*/}
      [ -e "/root/.claude/skills/$name" ] && continue
      ln -s "$entry" "/root/.claude/skills/$name" 2>/dev/null || true
    done
  done
  # 源目录里已删除的技能：清掉悬空链接
  for entry in /root/.claude/skills/*; do
    [ -L "$entry" ] || continue
    [ -e "$entry" ] || rm -f "$entry"
  done
}
sync_claude_skills
# 运行期间新增/删除技能时，30 秒内同步到 Claude 的视图；新会话启动时会重新扫描。
( while sleep 30; do sync_claude_skills; done ) &

# 已有配置目录的权限修正（.ssh 必须是 700）
if [ -d /root/.ssh ]; then
  chmod 700 /root/.ssh 2>/dev/null || true
  find /root/.ssh -maxdepth 1 -type f -exec chmod 600 {} \; 2>/dev/null || true
fi
chmod 700 /root/.agent-hub 2>/dev/null || true

# T3 的配对码、Multica 的登录态都依赖稳定的 HOME；这里固定为 root
export HOME=/root

exec node /opt/agent-hub/server.js