#!/bin/bash
# 初始化脚本：在宿主机上运行，准备配置目录
# 用法: ./init.sh

set -e

echo "=== 初始化 T3 Code Agent Hub ==="

# .env
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[✓] 已从 .env.example 创建 .env"
fi

mkdir -p \
  config/{codex,claude,opencode,pi,gemini,t3,multica,admin,logs,ssh,git} \
  config/cache config/npm \
  workspace/.tmp/var-tmp \
  workspace/.agents/skills \
  workspace/.multica-workspaces

# /tmp、/var/tmp 直接使用这两个目录，需要 world-writable + sticky
chmod 1777 workspace/.tmp workspace/.tmp/var-tmp
chmod 755 workspace/.agents workspace/.agents/skills

# Compose 挂载的是 config/git 目录，gitconfig 只是目录里的文件。
# 老部署可能已经被 Docker 建成了目录，这里尝试恢复；需要重启容器才会重新挂载。
if [ -d config/git/gitconfig ]; then
  if rmdir config/git/gitconfig 2>/dev/null; then
    echo "[!] config/git/gitconfig 曾是空目录（Docker 自动创建），已重建为文件；请重启容器让挂载生效"
  else
    echo "[x] config/git/gitconfig 是非空目录，请手动备份并删除后再运行" >&2
  fi
fi
[ -d config/git/gitconfig ] || { [ -f config/git/gitconfig ] || : > config/git/gitconfig; }
chmod 600 config/git/gitconfig 2>/dev/null || true

# Claude Code 2.x 使用 CLAUDE_CONFIG_DIR，全局状态落在 config/claude/.claude.json。
# 旧布局是 config/claude.json（文件级 bind mount），这里做一次性迁移。
if [ -s config/claude.json ] && [ ! -s config/claude/.claude.json ]; then
  cp config/claude.json config/claude/.claude.json
  echo "[✓] 已迁移 config/claude.json -> config/claude/.claude.json"
fi
[ -s config/claude/.claude.json ] || printf '{}\n' > config/claude/.claude.json
chmod 600 config/claude/.claude.json

# 管理后台令牌
if ! grep -qE '^ADMIN_TOKEN=.+' .env 2>/dev/null; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -hex 16)
  else
    TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  if grep -q '^ADMIN_TOKEN=' .env 2>/dev/null; then
    sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=${TOKEN}|" .env
  else
    printf '\nADMIN_TOKEN=%s\n' "${TOKEN}" >> .env
  fi
  echo "[✓] 已生成管理后台令牌（见 .env 的 ADMIN_TOKEN）"
fi

chmod 700 config/admin 2>/dev/null || true

# 把各 agent 原有的全局 skills 合并到共享目录
# （Claude/OpenCode/Pi 的原生路径都在 config/ 下，启用共享后会被覆盖）
for dir in \
  config/claude/skills \
  config/opencode/skills \
  config/opencode/skill \
  config/pi/agent/skills \
  config/codex/skills; do
  [ -d "$dir" ] || continue
  [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ] || continue
  if cp -a -n "$dir"/. workspace/.agents/skills/ 2>/dev/null; then
    echo "[✓] 已合并 $dir 到 workspace/.agents/skills"
  else
    echo "[!] 合并 $dir 失败，请手动复制到 workspace/.agents/skills"
  fi
done

# Git 全局配置
if [ -f ~/.gitconfig ] && [ ! -s config/git/gitconfig ]; then
  cp ~/.gitconfig config/git/gitconfig
  echo "[✓] 已复制 Git 全局配置"
fi

# SSH 密钥
for f in id_ed25519 id_ed25519.pub id_rsa id_rsa.pub known_hosts; do
  if [ -f ~/.ssh/$f ] && [ ! -f config/ssh/$f ]; then
    cp ~/.ssh/$f config/ssh/
    echo "[✓] 已复制 $f"
  fi
done

# Codex 配置
for f in config.toml models.json auth.json; do
  if [ -f ~/.codex/$f ] && [ ! -f config/codex/$f ]; then
    cp ~/.codex/$f config/codex/
    echo "[✓] 已复制 Codex $f"
  fi
done

# 在容器内 Codex 需要关闭自身沙箱（由 Docker 隔离）
if [ -f config/codex/config.toml ]; then
  if ! grep -q "danger-full-access" config/codex/config.toml; then
    cat >> config/codex/config.toml <<'EOF'

# Docker 容器内禁用 Codex 自身沙箱（由容器边界保证隔离）
sandbox_mode = "danger-full-access"
approval_policy = "never"
EOF
    echo "[✓] 已为容器环境追加 Codex 沙箱配置"
  fi
fi

# Claude Code 配置
for f in settings.json credentials.json; do
  if [ -f ~/.claude/$f ] && [ ! -f config/claude/$f ]; then
    cp ~/.claude/$f config/claude/
    echo "[✓] 已复制 Claude Code $f"
  fi
done

echo ""
echo "=== 初始化完成 ==="
echo "启动: docker compose up -d --build"
echo ""
echo "访问:"
echo "  T3 Code:  http://localhost:${T3_PORT:-3773}"
echo "  管理后台: http://localhost:${ADMIN_PORT:-3774}"
echo "  用户名随意，密码为 .env 中的 ADMIN_TOKEN"
echo ""