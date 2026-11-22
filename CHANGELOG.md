# Changelog

按时间倒序记录本项目的改动、部署方式和踩过的坑。改完代码请在这里追加一条，
并同步更新 `README.md` / `AGENTS.md`，避免后续 agent 从旧文档得出错误结论。

## 2026-11-22

### Claude 额外模型、Pi 思考等级、中文字体

- **Claude Code 在 T3 里只显示主模型**：T3 的 Claude 选择器只从 Claude CLI 探测结果和
  `providerInstances.claudeAgent.config.customModels` 取模型，`ANTHROPIC_MODEL` 只决定主模型。
  新增 `admin/lib/t3-models.js`，把后台里分配给 Claude 的 `models[]` 写进
  `$T3CODE_HOME/userdata/settings.json`（默认 `~/.t3/userdata/settings.json`）。
  - 该字段由 Agent Hub 整体替换管理；取消 Claude 分配会清空。
  - T3 会在下次 provider 状态刷新时读取（实测约 20 秒后出现在缓存）；保存模型配置时后台仍会重启 T3。
  - T3 的 `hiddenModels`、其他 provider 实例和设置项保持不变。
- **Pi 不能选思考等级**：T3 的 Pi 驱动只有在 Pi 模型声明 `reasoning: true` 时才显示思考等级。
  模型列表新增“推理”勾选，写 `~/.pi/agent/models.json` 的 `reasoning: true`。
- **Claude 的思考等级**：勾选“推理”的 Claude 模型会在 `customModels` 里生成 `effort`
  选项；等级优先取网关 `/v1/models` 返回的 `reasoning_efforts`，取不到时用
  `low/high/max` 兜底。网关明确返回 `supports_reasoning: false` 时不生成选项。
- **中文/emoji 乱码**：镜像补装 `fonts-noto-cjk`、`fonts-noto-color-emoji`。T3 预览浏览器
  使用容器系统字体，缺字体时中文网页显示为方块；这是字体问题，不是 CDP/T3 配置问题。
- 后台模型列表新增第二个勾选项，`modelsSignature` 纳入 `reasoning`，改动后会触发 T3 重启。
- 文档：同步 `README.md` / `AGENTS.md`，新增本文件。

验证方式：

```bash
node --check admin/server.js
for f in admin/lib/*.js; do node --check "$f"; done
# 内联脚本语法检查见 AGENTS.md
# 用临时 HOME + 假网关 /v1/models 测 t3-models.js 的 customModels 写入
```

### `a2b59c3` feat: 单配置支持多模型与视觉能力，Anthropic 转发并入后台端口

- 模型配置新增 `models[]`：默认 / 快速模型之外的任意多个模型都会写进
  OpenCode、Pi（以及 Codex 的 `model_catalog_json`）的模型列表。
- 每个模型可单独标记 `vision`：OpenCode `capabilities.input`、Pi `input`、
  Codex `input_modalities`。
- Anthropic 转发不再单独监听 3775，改为挂在管理后台同端口的 `/anthropic-proxy`；
  该路径不走 Basic Auth，但会校验调用方 key 是否等于分配给 Claude 的配置。
- 模型变更签名纳入额外模型与视觉标记，保存后仍会重启 T3 刷新列表。
- 注意：旧配置只有 `defaultModel` / `fastModel`，`normalizeModels` 会自动补进 `models[]`。

### `b73448b` fix: 修复 Claude Code 400，支持单配置双协议与 Codex 自定义模型

- Claude Code 请求里的 `x-anthropic-billing-header:` 块会被部分网关（`llms.zj-qq.cn`）拒绝，
  新增 `admin/lib/anthropic-proxy.js` 去掉该块后转发。
- `protocol: "both"`：同一配置同时给 OpenAI（Codex/OpenCode/Pi）和 Anthropic（Claude）使用，
  不用为同一个网关建两份配置。
- Codex 自定义模型写入 `~/.codex/agenthub-models.json` 并设置 `model_catalog_json`，
  条目以 `codex debug models --bundled` 为模板（需要完整 `base_instructions`）。
- 注意：`ANTHROPIC_BASE_URL` 不能带末尾 `/v1`，Claude SDK 会自己追加 `/v1/messages`。

### `9ea5c07` 及更早

- 统一镜像命名 `agent-hub/t3-agents`、Compose 服务名 `t3code`。
- 配对码解析、快速模型写入 OpenCode/Pi、后台保存后重启 T3 等修复。
