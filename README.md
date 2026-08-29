# SimpleAISite (multi-ai-proxy)

一个轻量的多平台 AI 代理服务。它将多个 AI 平台（如 OpenCode、DeepSeek 等）的 API 聚合为统一的、兼容 OpenAI 格式的接口，并自动维护模型列表、统计 Token 用量。

## 功能特性

- **多平台聚合**：在 `Config/config.js` 中配置任意数量的平台，统一通过 `/v1` 接口访问。
- **OpenAI 兼容**：对外暴露 `/v1/models` 与 `/v1/chat/completions` 等标准接口，可直接对接现有 OpenAI 客户端。
- **流式 / 非流式支持**：完整转发 SSE 流式响应，并从流中提取 `usage` 进行统计。
- **模型列表自动刷新**：按配置间隔定时拉取各平台 `/models`，缓存至 `Config/models.json`。
- **Token 用量统计**：自动累加每次请求的 `usage`（含嵌套字段），持久化到 `Data/models.json`。
- **访问密钥认证**：可配置 `accessKey` 对代理接口进行 Bearer 鉴权。
- **站点管理 API**：提供用量、模型、平台状态、健康检查等只读接口。
- **CORS 跨域**：默认允许所有来源，方便前端直接调用。

## 目录结构

```
SimpleAISite/
├── index.js            # 服务主入口
├── package.json        # 依赖与启动脚本
├── Config/
│   ├── config.js       # 平台与运行配置
│   └── models.json     # 自动生成的模型缓存（运行时）
└── Data/
    └── models.json     # 自动生成的 Token 用量统计（运行时）
```

## 安装

需要 Node.js 18+（使用了顶层 `await` 与 ESM）。

```bash
npm install
```

## 配置

编辑 `Config/config.js`：

```js
export default {
    port: 3000,                 // 代理服务监听端口

    // 访问代理所需的密钥，留空或 null 表示不启用验证
    accessKey: "sk-xxxxxxxx",

    // 平台定义
    platforms: {
        "opencode": {
            url: "https://opencode.com/go/v1",   // 平台 API 基础地址
            key: "sk-xxxxxxxx",                  // 平台 API 密钥
            defaultHeaders: {}                   // 可选的额外请求头
        },
        "deepseek": {
            url: "https://api.deepseek.com/v1",
            key: "sk-xxxxxxxx",
            defaultHeaders: {}
        }
        // 可添加更多平台...
    },

    // 模型列表刷新间隔（毫秒），默认 1 小时
    // 设置 -1 不自动刷新，仅在启动时刷新
    modelsRefreshInterval: 3600000
};
```

## 启动

```bash
npm start
```

启动后日志示例：

```
多平台 AI 代理已启动: http://localhost:3000/v1
认证密钥: 已启用
```

## 内部模型命名规则

代理使用统一的内部模型名来路由到不同平台，格式为：

```
平台名__[前缀/]模型
```

- `平台名`：对应 `config.platforms` 中的键（如 `opencode`、`deepseek`）。
- `__`：双下划线分隔符。
- `[前缀/]`：可选的路径前缀（部分平台模型 ID 含 `/`）。
- `模型`：上游平台实际的模型标识。

示例：

| 内部模型名                  | 路由平台   | 上游模型            |
| --------------------------- | ---------- | ------------------- |
| `opencode__/gpt-4o`         | opencode   | `gpt-4o`            |
| `deepseek__/deepseek-chat`  | deepseek   | `deepseek-chat`     |
| `opencode__v1/claude-3`     | opencode   | `v1/claude-3`       |

`/v1/models` 接口返回的所有 `id` 均遵循此格式，可直接作为请求体中的 `model` 字段使用。

## API 接口

### 代理接口（需鉴权）

| 方法 | 路径                | 说明                                   |
| ---- | ------------------- | -------------------------------------- |
| GET  | `/v1/models`        | 返回聚合后的模型列表（OpenAI 格式）    |
| ANY  | `/v1/*`             | 转发至对应平台的 API（如对话补全）     |

请求示例（使用 OpenAI SDK）：

```js
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'http://localhost:3000/v1',
    apiKey: 'sk-xxxxxxxx'   // 对应 config.accessKey
});

const resp = await client.chat.completions.create({
    model: 'deepseek__/deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    stream: true
});
```

### 站点管理接口（需鉴权）

| 方法 | 路径                 | 说明                                 |
| ---- | -------------------- | ------------------------------------ |
| GET  | `/ai-api/usage`      | 获取各内部模型的 Token 用量统计      |
| GET  | `/ai-api/models`     | 获取模型列表及各自使用概览           |
| GET  | `/ai-api/platforms`  | 获取各平台状态（不含密钥）           |
| GET  | `/ai-api/health`     | 健康检查，返回运行状态与运行时长     |

## 数据持久化

- `Config/models.json`：各平台模型 ID 缓存，由服务自动写入。
- `Data/models.json`：Token 用量统计，按内部模型名聚合，包含 `total_prompt_tokens`、`total_completion_tokens`、`total_total_tokens`、`last_used` 等字段，快速连续更新会合并保存（5 秒防抖）。

## 注意事项

- 密钥与平台配置请妥善保管，避免泄露到公开仓库。
- 上游请求超时设为 300 秒（5 分钟），适用于长文本生成与流式场景。
- 服务默认开启 CORS 全开，生产环境建议按需收紧。
- 修改 `Config/config.js` 后需重启服务生效（模型列表与用量会在启动时自动加载）。
