# SimpleAISite (Multi AI Proxy)

一个轻量级的多 AI 平台统一代理服务。通过一个 OpenAI 兼容的 API 端点，将请求路由到多个 AI 服务商（如 DeepSeek、OpenCode 等），并提供一个可视化的中文管理后台用于平台配置、模型管理与 Token 用量统计。

## ✨ 功能特性

- **多平台代理**：统一暴露 OpenAI 兼容的 `/v1/*` 接口，自动将请求路由到配置好的多个 AI 平台。
- **模型自动刷新**：启动时自动拉取各平台可用模型列表并缓存，可配置定时刷新间隔。
- **模型白名单**：可为每个平台配置允许调用的模型列表（白名单），未在列表内的模型会被拒绝。
- **Token 用量统计**：自动解析响应中的 `usage` 信息（含流式 SSE 响应），按模型维度汇总 Token 消耗。
- **流式响应**：完整支持 `stream: true` 的 SSE 流式转发。
- **调试模型**：内置 `debug__/model-api` 虚拟模型，可回显收到的原始请求数据，方便调试客户端。
- **访问认证**：通过 `accessKey`（Bearer Token）保护 API 端点。
- **可视化管理后台**：内置中文 Web 界面，支持总览、Token 明细、平台管理、设置等模块。
- **深色 / 浅色主题**：管理后台支持主题切换。

## 📁 项目结构

```
SimpleAISite/
├── index.js               # 服务端主程序（Express + 代理 + 管理 API）
├── index.html             # 管理后台前端页面（单文件，无构建步骤）
├── package.json           # 项目依赖与启动脚本
├── Config/
│   ├── config.json        # 服务配置（端口、访问密钥、平台配置）
│   └── models.json        # 模型列表缓存（自动生成）
└── Data/
    └── models.json        # Token 用量统计数据（自动生成）
```

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) ≥ 18（支持 ES Module）

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 配置 Config/config.json（首次会自动生成默认配置）

# 3. 启动服务
npm start

# 或者
node index.js
```

启动成功后控制台会输出：

```
=== 服务已启动 ===
- 管理后台: http://localhost:3000
- AI 端点: http://localhost:3000/v1/
- Key: sk-xxxxxxxx
================
```

## ⚙️ 配置说明

配置文件位于 `Config/config.json`，首次启动时若文件不存在会自动创建默认配置。

```json
{
  "port": 3000,
  "accessKey": "sk-your-keys",
  "platforms": {
    "opencode": {
      "url": "https://opencode.ai/zen/v1",
      "key": "sk-opencode-xxxxxxxx",
      "defaultHeaders": {},
      "enable": true,
      "models": []
    },
    "deepseek": {
      "url": "https://api.deepseek.com/v1",
      "key": "sk-deepseek-xxxxxxxx",
      "defaultHeaders": {},
      "enable": true,
      "models": []
    }
  },
  "modelsRefreshInterval": 3600000
}
```

| 字段 | 说明 |
| --- | --- |
| `port` | 服务监听端口，默认 `3000` |
| `accessKey` | 访问密钥，客户端通过 `Authorization: Bearer <accessKey>` 调用 API；页面访问无需认证 |
| `platforms` | 平台配置对象，键为平台名称（如 `deepseek`） |
| `platforms.<name>.url` | 该平台的 API 基础地址（OpenAI 兼容格式，如 `https://api.deepseek.com/v1`） |
| `platforms.<name>.key` | 该平台的 API Key |
| `platforms.<name>.defaultHeaders` | 附加的默认请求头 |
| `platforms.<name>.enable` | 是否启用该平台，`false` 时禁用（默认 `true`） |
| `platforms.<name>.models` | 模型白名单，为空数组表示允许全部模型 |
| `modelsRefreshInterval` | 模型列表自动刷新间隔（毫秒），默认 `3600000`（1 小时） |

> **安全提示**：`accessKey` 和平台 `key` 为敏感信息，请勿提交到公开仓库。

## 🔌 API 使用

### 调用 AI 接口

所有代理接口均为 OpenAI 兼容格式，根地址为 `http://localhost:3000/v1/`。

**内部模型命名规则**：`平台名__模型标识`（中间为两个下划线）。

- 平台名与 `config.json` 中 `platforms` 的键一致（如 `deepseek`）
- 模型标识即该平台返回的模型 ID
- 模型 ID 中若包含 `/` 直接拼接；否则会在 `models` 列表中展示为 `平台名__/模型ID` 的形式，两种写法均可调用

**示例**（调用 deepseek 平台的 `deepseek-chat`）：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-keys" \
  -d '{
    "model": "deepseek__deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

**获取模型列表**：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-your-keys"
```

**调试模型**：使用 `debug__/model-api` 作为 `model`，服务会原样返回收到的请求参数，便于排查客户端问题（无需真实平台配置）。

### 管理 API

管理 API 位于 `/ai-api/*`，以下端点均需要 `accessKey` 认证（页面除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/ai-api/health` | 健康检查（`status` 与运行时长） |
| `GET` | `/ai-api/usage` | Token 用量统计 |
| `GET` | `/ai-api/models` | 所有平台模型及调用统计（含 `call_id`） |
| `GET` | `/ai-api/platforms` | 平台状态（URL、模型数量、启用状态，不含密钥） |
| `GET` | `/ai-api/config/platforms` | 完整平台配置（**含密钥**） |
| `PUT` | `/ai-api/config/platforms` | 更新平台配置，更新后自动刷新模型列表 |

## 🖥️ 管理后台

浏览器访问 `http://localhost:3000/` 即可打开管理后台，包含以下模块：

- **总览（Overview）**：服务状态、健康信息等概览。
- **Token 明细（Tokens）**：按模型维度展示 Token 用量明细表。
- **平台管理（Platforms）**：可视化添加 / 编辑 / 删除平台，展示各平台模型数量与启用状态。
- **设置（Settings）**：调整服务相关设置。

管理后台采用单文件 HTML 实现，无构建步骤，可直接修改 `index.html` 定制界面。

## 🔑 认证

- `/v1/*` 与 `/ai-api/*`（除根页面外）均需认证。
- 认证方式：请求头 `Authorization: Bearer <accessKey>`。
- 当 `accessKey` 为空或未设置时，认证将被跳过。
- 未认证请求返回 `401`。

## 🛠️ 技术栈

- **后端**：Node.js + [Express](https://expressjs.com/) + [Axios](https://axios-http.com/)
- **前端**：原生 HTML / CSS / JavaScript + [Lucide](https://lucide.dev/) 图标（CDN 引入）
- **数据存储**：JSON 文件（`Config/config.json`、`Config/models.json`、`Data/models.json`）

## 📝 License

MIT
