export default {
    port: 3000, // 代理服务监听端口

    // 访问代理所需的密钥
    // 留空或 null 表示不启用验证，即使收到了key
    accessKey: "sk-KFCcrazyDay4Vme50quickly",

    // 平台定义
    platforms: {
        "opencode": { // 平台名称
            url: "https://opencode.com/go/v1", // 平台 API 基础地址
            key: "sk-000000000000000000000000000000000000000000000000", // 平台 API 密钥
            defaultHeaders: {} // 可选的额外请求头
        },
        "deepseek": {
            url: "https://api.deepseek.com/v1",
            key: "sk-000000000000000000000000000000000000000000000000",
            defaultHeaders: {}
        }
        // 可添加更多平台...
    },

    // 模型列表刷新间隔（毫秒），默认 1 小时
    // 设置 -1 不自动刷新，仅在启动时刷新
    modelsRefreshInterval: 3600000
};