# AGENTS.md

本文件给接手本项目的 AI agent 使用。改代码前先读完，尤其是“关键约定”和“验证”两节。

## 项目是什么

T3 Code Agent Hub：在单个 Docker 容器里运行 T3 Code 控制面、多个 agent CLI（Claude Code / Codex / OpenCode / Pi）和可选的 Multica runtime，并附带一个无构建步骤的 Hono 管理后台。

- 仓库：<https://github.com/linyupark/t3-agents>
- 基础镜像：`node:24-bookworm-slim`
- 代码形态：纯 ESM JavaScript，没有 TypeScript、没有前端打包步骤
- 对外端口：T3 默认 `3773`，管理后台默认 `3774`，均可在 `.env` 改
- 容器使用 `network_mode: host`，容器内的 `127.0.0.1` 就是宿主机；没有 `ports:` 映射，`.env` 里的端口就是宿主机实际监听端口

## 目录速查

| 路径 | 作用 |
|---|---|
| `Dockerfile` | 安装系统依赖、agent CLI、`chrome-devtools-mcp`、后台依赖；创建 `/etc/gitconfig` |
| `docker-compose.yml` | 单服务定义、持久化挂载、环境变量、`shm_size`；宿主机路径和端口通过 `${VAR}` 从 `.env` 读取 |
| `entrypoint.sh` | 准备目录/权限/Claude 状态，然后 `exec node /opt/agent-hub/server.js` |
| `init.sh` | 宿主机初始化：建目录、生成 `.env` 的 `ADMIN_TOKEN`、迁移旧 Claude 状态、修复 gitconfig 路径 |
| `admin/server.js` | Hono 后台路由 + 子进程 supervisor（T3、Multica） |
| `admin/lib/store.js` | 设置读写、原子写入、Basic Auth token |
| `admin/lib/models.js` | 第三方模型配置生成/清理，返回需要注入的环境变量 |
| `admin/lib/anthropic-proxy.js` | 挂在管理后台同端口 `/anthropic-proxy` 的 Anthropic 转发：去掉 Claude Code 的 `x-anthropic-billing-header` 块，再转发到真实上游 |
| `admin/lib/browser.js` | CDP 探测、`chrome-devtools-mcp` 管理、四个 agent 的 MCP 配置写入/清理、T3 浏览器状态 |
| `admin/lib/agents.js` | Agent/工具版本查询与 npm 更新 |
| `admin/lib/multica.js` | Multica CLI 封装（config/login/daemon） |
| `admin/lib/procs.js` | 子进程管理、进程组终止、环形日志 |
| `admin/lib/t3.js` | `t3 pair` 解析 |
| `admin/public/index.html` | 单页 UI，所有 CSS/JS 内联 |

运行时目录（默认在宿主机 `CONFIG_DIR=./config` 或 `WORKSPACE_DIR=./workspace` 下，均已 gitignore）：

- `CONFIG_DIR/admin/settings.json`：后台设置（含 Multica token、模型 key），权限 0600
- `CONFIG_DIR/admin/admin-token`：未设置 `ADMIN_TOKEN` 时自动生成的密码
- `CONFIG_DIR/claude/.claude.json`：Claude 全局状态（`CLAUDE_CONFIG_DIR=/root/.claude`）
- `CONFIG_DIR/git/gitconfig`：git 全局配置（`GIT_CONFIG_GLOBAL`）
- `CONFIG_DIR/logs/{t3,multica,admin}.log`
- `WORKSPACE_DIR/`：agent 工作区，`/workspace` 挂载点

## 启动链路

1. `entrypoint.sh`：建目录、修复权限、确保 `.claude.json` 和 gitconfig 存在。
2. `server.js`：
   - `loadSettings()` 读取 `DATA_DIR/settings.json`；
   - `applyModelConfig()` 写入各 agent 模型配置，并把 Codex key 放进 `AGENT_HUB_CODEX_KEY`；
   - `applyBrowserConfig()` 异步写入/清理 `agenthub-cdp` MCP；
   - 启动 Hono，监听 `ADMIN_BIND:ADMIN_PORT`；
   - `ManagedProcess` 用 `t3 serve --host $T3_BIND --port $T3_PORT` 拉起 T3，按配置恢复 Multica。
3. 所有后台路由（除 `/healthz`）都经过 Basic Auth；用户名随意，密码是 `ADMIN_TOKEN`。

## 关键约定

### 1. 不要用文件级 bind mount 挂载会被原子写入的配置

Claude Code 写 `.claude.json` 的方式是“临时文件 + rename”。如果把它挂成单个文件，rename 会 `EBUSY`。因此：

- Compose 挂的是目录 `CONFIG_DIR/claude:/root/.claude`（默认 `./config/claude`）；
- 设置 `CLAUDE_CONFIG_DIR=/root/.claude`，状态文件落在目录内的 `.claude.json`；
- `init.sh` / `entrypoint.sh` 负责从旧布局迁移。

同样的坑也适用于 git 配置：现在挂载目录 `CONFIG_DIR/git:/root/.config/git`（默认 `./config/git`），由 `GIT_CONFIG_GLOBAL` 指向目录里的 `gitconfig`。

**新增任何会被程序写入的配置时，优先挂目录，不要挂单个文件。**

### 2. Git 配置与 safe.directory

- 镜像内 `/etc/gitconfig` 写入了 `[safe] directory = *`。原因是 workspace 来自 bind mount，宿主 uid 与容器 root 不一致时 git 会拒绝操作。这是单用户容器的有意设置，不要删除。
- git 全局配置在 `CONFIG_DIR/git/gitconfig`（默认 `config/git/gitconfig`），通过 `GIT_CONFIG_GLOBAL` 读取；`entrypoint.sh` 会保证目录和文件存在。
- 不要恢复 `./config/git/gitconfig:/root/.gitconfig` 这种文件挂载，Docker 在源文件不存在时会把它建成目录，容器内所有 git 命令都会报错。

### 3. MCP / CDP

- 统一 MCP 名称是 `agenthub-cdp`，命令等价于 `chrome-devtools-mcp --browser-url=<CDP_URL>`。
- 写入位置：
  - Claude：`$CLAUDE_CONFIG_DIR/.claude.json` 顶层 `mcpServers.agenthub-cdp`
  - Codex：`~/.codex/config.toml` 的 `[mcp_servers.agenthub-cdp]`
  - OpenCode：`~/.config/opencode/opencode.json` 的 `mcp.servers.agenthub-cdp`
  - Pi：`~/.pi/agent/mcp.json` 的 `mcpServers.agenthub-cdp`
- 清理时只删 `agenthub-cdp`，绝不能动用户已有的其他 MCP 条目。
- `chrome-devtools-mcp` 镜像内装在 `/usr/local`；后台更新会装进持久卷 `/opt/agents`，并优先使用卷里的版本。
- **T3 自带预览浏览器不能接外部 CDP**：它固定启动自己下载的 headless Chrome，用 `--remote-debugging-pipe` 控制。T3 内 agent 用 `preview_*` 工具；外部 CDP 是另一套给 agent 用的工具。
- root 容器必须保留 `T3CODE_SERVER_BROWSER_SANDBOX=0`，否则 Chrome sandbox 起不来；`shm_size: ${SHM_SIZE:-1g}` 的默认值也不要删。

### 4. 模型配置

- Claude Code 只能接 Anthropic 兼容端点。Claude 的 SDK 会自己追加 `/v1/messages`，所以 `ANTHROPIC_BASE_URL` 必须去掉末尾的 `/v1`；`anthropic-proxy.js` 里的 `resolveAnthropicBase()` 会自动处理，`applyModelConfig()` 会打警告，不要改回原样。
- 协议选 `both` 时，同一个配置同时给 OpenAI（Codex/OpenCode/Pi 默认）和 Anthropic（Claude）使用：OpenAI 用 `baseUrl`，Anthropic 用 `anthropicBaseUrl`，留空则自动把 `baseUrl` 末尾的 `/v1` 去掉。不要为同一个网关建两份配置。
- Claude Code 会在请求的 `system` 数组里塞一个 `x-anthropic-billing-header:` 块，值在第三方端点上为空；部分网关（如 `llms.zj-qq.cn`）会因此返回 400 `Illegal API invocation from an unapproved channel`。`admin/lib/anthropic-proxy.js` 把转发挂在管理后台**同一个端口**的 `/anthropic-proxy` 路径上（不单独监听端口），`ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:${ADMIN_PORT}/anthropic-proxy`；该路径不走 Basic Auth，但会校验调用方带的 key 与分配给 Claude 的配置一致。`CLAUDE_PROXY=0` 可关闭。
- 自定义模型 ID 不在 Claude Code 内置清单里时，用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 声明窗口（配置里的“上下文窗口”字段）；否则 Claude 会按 1M 猜测。
- Codex 只支持 OpenAI Responses（`wire_api = "responses"`）。
- OpenCode / Pi 两种协议都支持。
- **默认模型、快速模型和额外模型都要写进模型列表**：配置里的 `models[]` 是完整列表（`normalizeModels` 会把 `defaultModel` / `fastModel` 自动补进去）。OpenCode 用 `providers.agenthub.models` + 顶层 `model` / `small_model`，Pi 用 `models[]`，Codex 用 `model_catalog_json`。只写 `defaultModel` 会让快速模型和额外模型在 T3 里根本不出现。
- **视觉能力按模型声明**：勾选“视觉”时写 OpenCode `capabilities.input = ["text","image"]`、Pi `input = ["text","image"]`、Codex `input_modalities = ["text","image"]`。不勾选就不写，按纯文本处理；不要假设 agent 会自己探测网关模型的图片能力。Claude Code 没有对应配置项。
- Codex 的 key 通过环境变量 `AGENT_HUB_CODEX_KEY` 注入。**新增、替换或取消 Codex 分配后必须重启 T3**，否则旧 key 会残留；`server.js` 已有这段逻辑，改动时不要破坏。
- 保存模型配置后 `server.js` 会重启 T3 并等待就绪（`waitForT3Ready`）；T3 的模型列表在启动时读取，不重启不会刷新。
- **Codex 的模型选择器来自 app-server 的 `model/list`**。T3 不会从 `config.toml` 的 `model` 推断列表；后台会写 `~/.codex/agenthub-models.json` 并把 `model_catalog_json` 指向它，目录条目以 `codex debug models --bundled` 的输出为模板（`model_catalog_json` 要求完整的 `base_instructions`，手写容易缺字段导致整份目录被忽略）。不要改成只写 `models.json` 或只写 `model`。
- 给协议不兼容的 agent 分配配置时，要警告并清掉后台之前写入的配置，不能沿用旧端点。

### 5. 密钥与日志

- 仓库里绝不能出现真实 token、API key、私钥；`.env`、默认的 `config/`、`workspace/` 都已 gitignore。自定义 `CONFIG_DIR` / `WORKSPACE_DIR` 要自行加进 `.gitignore`。
- Multica token 只存在 `settings.json`（0600）；所有会返回给前端或写日志的 CLI 输出都要经过脱敏（参考 `redactSteps`）。
- 管理后台拒绝把 token 写进 URL 或外部请求。

### 6. Docker / 持久化

- 命名卷 `agent_npm`、`agent_local` 只在**首次创建**时从镜像初始化。给镜像新增 npm 包后，老卷不会自动出现；要么放到镜像内的 `/usr/local`，要么在后台提供安装按钮，并在 README 说明。
- Docker 命名统一为：镜像 `agent-hub/t3-agents`，Compose 服务/容器 `t3code`，命名卷 `agent_npm` / `agent_local`。不要重命名命名卷，改名会让容器挂到全新的空卷，已有安装数据会“消失”。
- 修改安装开关、想从镜像重新灌包：`docker compose down -v`（只删这两个命名卷，不影响 bind mount）。
- Compose 需要 ≥ 2.24（`env_file` 的 `required: false`）。
- 不要把宿主机的 `docker.sock` 挂进来。

### 7. `.env`、宿主机路径与端口

`.env` 是 Compose `${VAR}` 插值的来源；`.env.example` 同时作为 `env_file` 提供容器内默认值。`init.sh` 会从 `.env` 读取需要的键，**不要 source `.env`**（里面可能有任意内容）。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WORKSPACE_DIR` | `./workspace` | 宿主机工作区，挂到 `/workspace` |
| `CONFIG_DIR` | `./config` | 宿主机配置/缓存/日志根目录 |
| `T3_PORT` / `T3_BIND` | `3773` / `0.0.0.0` | `t3 serve --host/--port` |
| `ADMIN_PORT` / `ADMIN_BIND` | `3774` / `0.0.0.0` | Hono 监听地址 |
| `CDP_URL` | `http://127.0.0.1:16002` | 后台首次启动的默认 CDP 地址；保存过设置后以 `settings.json` 为准 |
| `SHM_SIZE` / `MEM_LIMIT` | `1g` / `6g` | `/dev/shm` 和容器内存上限 |
| `ADMIN_TOKEN` | 空 | 留空时由 `init.sh` 生成 |

约定：

- `WORKSPACE_DIR`、`CONFIG_DIR` 只在宿主机侧生效；容器内路径仍然是 `/workspace`、`/root/.codex` 等，不要在容器代码里读这两个变量当目录。
- `network_mode: host` 下没有端口映射；`T3_PORT`、`ADMIN_PORT` 就是宿主机实际监听端口。新增端口配置时直接加 `.env` 变量和 `environment:` 插值，不要加 `ports:`。
- 新增挂载或 `init.sh` 目录时，一律使用 `${CONFIG_DIR:-./config}` / `${WORKSPACE_DIR:-./workspace}`，不要再硬编码 `./config`、`./workspace`。
- `init.sh` 的 `env_get` 只解析简单的 `KEY=value`（支持引号和行尾注释），不支持变量嵌套；文档里不要鼓励写 `WORKSPACE_DIR=$HOME/...`。
- 改路径不会自动迁移数据；换目录前先停容器并手动拷贝旧 `config/`、`workspace/`。改完 `.env` 后重跑一次 `./init.sh`，让新目录和权限先就位，再 `docker compose up -d`。

## 常见改动

### 新增一个 agent CLI

1. `Dockerfile`：加 `ARG INSTALL_<NAME>` 和安装命令。
2. `admin/lib/agents.js`：加入 `AGENTS` 表（`key/name/pkg/bin/npm`）。
3. `admin/lib/models.js`：如果支持第三方模型，增加配置生成/清理逻辑。
4. `admin/lib/browser.js`：如果支持 MCP，增加 `writeX/removeX/configuredAgents` 分支。
5. `docker-compose.yml`：需要持久化的配置目录加挂载，路径用 `${CONFIG_DIR:-./config}/<name>:/root/...`。
6. `init.sh`：在 `CONFIG_DIR` 下建对应目录并设置权限。
7. 更新 `README.md`、本文件和后台 UI 的说明。

### 新增后台 API

- 路由写在 `admin/server.js`；Basic Auth 中间件会自动覆盖，不需要单独鉴权。
- 写设置用 `saveSettings()`，不要直接 `fs.writeFile`。
- 返回给前端的敏感字段必须先脱敏。
- 需要长时间运行的命令用 `ManagedProcess` 或 `updateAgent` 的串行锁，不要在请求里裸 `exec`。

### 修改前端

- 没有构建步骤，直接改 `admin/public/index.html` 的内联 `<script>`。
- 改完用下面的方法做语法检查：

```bash
python3 - <<'PY'
import re
html = open('admin/public/index.html', encoding='utf-8').read()
open('/tmp/admin-check.mjs','w').write('\n'.join(re.findall(r'<script[^>]*>(.*?)</script>', html, re.S)))
PY
node --check /tmp/admin-check.mjs
```

### 新增持久化目录

同时改三处：`docker-compose.yml` 挂载、`entrypoint.sh` 建目录/权限、`init.sh` 在宿主机建目录。只改 compose 会在首次启动时由 Docker 以 root 创建，权限可能不对。路径必须使用 `CONFIG_DIR` / `WORKSPACE_DIR`，不要硬编码默认目录。

## 验证

当前开发环境通常没有 Docker，按以下顺序验证：

```bash
# 1. JS / shell / compose 语法
node --check admin/server.js
for f in admin/lib/*.js; do node --check "$f"; done
bash -n entrypoint.sh init.sh
python3 -I -c "import yaml; yaml.safe_load(open('docker-compose.yml')); print('yaml ok')"

# 2. 后台依赖（改了 package.json 才需要）
cd admin && npm ci --omit=dev --no-fund --no-audit && cd ..

# 3. 用临时 HOME 测配置写入，避免污染真实配置
#    需要设置 HOME、CLAUDE_CONFIG_DIR、DATA_DIR、PATH，
#    并用假的 chrome-devtools-mcp 验证 write/remove 不覆盖其他 MCP。
#    参考 admin/lib/browser.js 的 applyBrowserConfig / configuredAgents。

# 4. 有真实 CDP 时，验证 MCP 握手
#    chrome-devtools-mcp --browser-url=http://127.0.0.1:16002
#    发 initialize + tools/list，应返回 30+ 个浏览器工具。

# 5. 后台 API 冒烟：用假的 t3/multica 二进制 + 临时 DATA_DIR/LOG_DIR
#    AUTOSTART_MULTICA=0 ADMIN_PORT=<free> ADMIN_TOKEN=<test> node admin/server.js
#    覆盖 GET/PUT /api/browser、POST /api/browser/test、401。

# 6. 自定义目录 / 端口：复制 init.sh 和 .env.example 到临时目录，
#    用临时 HOME 和自写的 .env（WORKSPACE_DIR/CONFIG_DIR/T3_PORT/ADMIN_PORT）
#    运行 bash init.sh，确认目录、权限、端口输出都指向自定义值。
#    另跑一次不带 .env 的默认场景，确认仍生成 ./workspace 和 ./config。

# 7. T3 监听参数：PATH 里放假 t3 记录参数，设置 T3_BIND=127.0.0.1 T3_PORT=4773，
#    启动 admin/server.js，确认子进程收到 --host 127.0.0.1 --port 4773。

# 8. CDP 默认值：CDP_URL=http://127.0.0.1:9222 node -e \
#    "import('./admin/lib/store.js').then(m => console.log(m.DEFAULT_CDP_URL))"
```

有 Docker 时再执行：

```bash
./init.sh
docker compose up -d --build
docker logs -f t3code
```

## 不要做的事

- 不要把 `node_modules`、默认的 `config/`、`workspace/`、`.env` 提交进仓库；自定义目录要自行加进 `.gitignore`。
- 不要删除 `T3CODE_SERVER_BROWSER_SANDBOX=0`、`shm_size: ${SHM_SIZE:-1g}` 的默认值、`/etc/gitconfig` 的 safe.directory。
- 不要在新增挂载或 `init.sh` 里硬编码 `./config`、`./workspace`；用 `.env` 的 `CONFIG_DIR` / `WORKSPACE_DIR`。
- 不要在 `network_mode: host` 下加 `ports:`，也不要把 `T3_PORT` / `ADMIN_PORT` 描述成端口映射。
- 不要把 T3 预览浏览器改成外部 CDP：上游没有这个能力，改了也不会生效。
- 不要在未重启 T3 的情况下声称 Codex key 已切换。
- 不要在没有实际运行验证的情况下声称功能可用；先跑“验证”一节的命令。
