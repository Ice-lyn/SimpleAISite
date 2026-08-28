import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './Config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(__dirname, 'Config');
const DATA_DIR = path.join(__dirname, 'Data');
const MODELS_CACHE_FILE = path.join(CONFIG_DIR, 'models.json');
const USAGE_FILE = path.join(DATA_DIR, 'models.json');

// 确保 Data 目录存在
await fs.mkdir(DATA_DIR, { recursive: true });

// === 内存状态 ===
let modelsCache = {};               // 缓存各平台模型列表 { platform: [ids] }
let usageStats = {};                // Token 统计 { internalModel: { total_xxx: number, last_used } }

// === 初始化加载 ===
async function loadInitialData() {
    try {
        const cacheData = await fs.readFile(MODELS_CACHE_FILE, 'utf8');
        modelsCache = JSON.parse(cacheData);
    } catch {
        modelsCache = {};
    }

    try {
        const usageData = await fs.readFile(USAGE_FILE, 'utf8');
        usageStats = JSON.parse(usageData);
    } catch {
        usageStats = {};
    }
}

// === 模型列表自动刷新 ===
async function refreshModels() {
    const newCache = {};
    for (const [platformName, platformConf] of Object.entries(config.platforms)) {
        try {
            const url = `${platformConf.url.replace(/\/$/, '')}/models`;
            const headers = {
                'Authorization': `Bearer ${platformConf.key}`,
                ...platformConf.defaultHeaders
            };
            const resp = await axios.get(url, { headers, timeout: 10000 });
            newCache[platformName] = resp.data?.data?.map(m => m.id) || [];
        } catch (err) {
            console.error(`平台 ${platformName} 模型列表获取失败:`, err.message);
            // 保留旧缓存
            if (modelsCache[platformName])
                newCache[platformName] = modelsCache[platformName];
        }
    }
    modelsCache = newCache;
    await fs.writeFile(MODELS_CACHE_FILE, JSON.stringify(modelsCache, null, 2), 'utf8');
}

// 定期刷新
if (config.modelsRefreshInterval > 0)
    setInterval(refreshModels, config.modelsRefreshInterval || 3600000);
refreshModels(); // 启动时刷新

// === Token 使用量持久化 ===
let saveTimer = null;
function scheduleSaveUsage() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await fs.writeFile(USAGE_FILE, JSON.stringify(usageStats, null, 2), 'utf8');
        } catch (err) {
            console.error('保存用量数据失败:', err);
        }
    }, 5000); // 5 秒后保存（合并快速连续更新）
}

// 扁平化 usage 对象并累加到统计
function updateUsageStats(internalModel, usageObj) {
    if (!usageObj || typeof usageObj !== 'object') return;
    const entry = usageStats[internalModel] || (usageStats[internalModel] = {});
    const flatten = (obj, prefix = 'total_') => {
        for (const [key, val] of Object.entries(obj)) {
            const newKey = prefix + key;
            if (typeof val === 'number') {
                entry[newKey] = (entry[newKey] || 0) + val;
            } else if (val && typeof val === 'object') {
                flatten(val, newKey + '_');
            }
        }
    };
    flatten(usageObj);
    entry.last_used = new Date().toISOString();
    scheduleSaveUsage();
}

// === 解析内部模型名称 ===
// 格式: platform__prefix/model 或 platform__/model
function parseInternalModel(internalModel) {
    const idx = internalModel.indexOf('__');
    if (idx === -1) {
        throw new Error(`模型名称格式错误，应为 "平台名__模型标识"，收到: ${internalModel}`);
    }
    const platform = internalModel.slice(0, idx);
    let rest = internalModel.slice(idx + 2); // 可能包含前缀和模型
    if (!config.platforms[platform]) {
        throw new Error(`未知平台: ${platform}`);
    }
    // 分离前缀和真实模型
    let prefix = '';
    let model = rest;
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) {
        prefix = rest.slice(0, slashIdx);
        model = rest.slice(slashIdx + 1);
    } else {
        // 没有斜杠，说明格式错误（应该始终有斜杠，至少应为 "/model"）
        // 但为兼容，如果 rest 不以 / 开头，则视为前缀为空，模型=rest，内部实际为 platform__/rest
        // 按照规范应报错，但这里宽松处理
        if (rest.startsWith('/')) {
            prefix = '';
            model = rest.slice(1);
        } else {
            // 不符合规范，报错
            throw new Error(`模型格式应为 "平台名__[前缀/]模型"，收到: ${internalModel}`);
        }
    }
    // 外部实际模型：前缀非空则 prefix/model，否则 model
    const upstreamModel = prefix ? `${prefix}/${model}` : model;
    return { platform, upstreamModel };
}

// === Express 应用 ===
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS 跨域
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 认证中间件
app.use((req, res, next) => {
    if (config.accessKey) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (token !== config.accessKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    next();
});

// === 聚合模型列表接口 ===
app.get('/v1/models', (req, res) => {
    const combined = [];
    for (const [platform, ids] of Object.entries(modelsCache)) {
        for (const id of ids) {
            const internal = `${platform}__${id.includes('/') ? id : '/' + id}`;
            combined.push({ id: internal, object: 'model', owned_by: platform });
        }
    }
    res.json({ object: 'list', data: combined });
});

// === 代理转发核心 ===
async function proxyRequest(req, res) {
    const apiPath = req.path.replace(/^\/v1/, ''); // 例如 /chat/completions
    const { model: internalModel, ...restBody } = req.body || {};

    if (!internalModel) {
        return res.status(400).json({ error: '缺少 model 字段' });
    }

    let platformName, upstreamModel;
    try {
        const parsed = parseInternalModel(internalModel);
        platformName = parsed.platform;
        upstreamModel = parsed.upstreamModel;
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const platformConf = config.platforms[platformName];
    const upstreamUrl = platformConf.url.replace(/\/$/, '') + apiPath;

    // 准备请求头
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length']; // 让 axios 自动设置
    headers['authorization'] = `Bearer ${platformConf.key}`;
    Object.assign(headers, platformConf.defaultHeaders || {});

    const requestBody = { ...restBody, model: upstreamModel };
    const isStream = requestBody.stream === true;

    // 记录请求开始
    try {
        if (!isStream) {
            // 非流式
            const response = await axios.post(upstreamUrl, requestBody, {
                headers,
                responseType: 'json',
                timeout: 300000,
                validateStatus: () => true // 手动处理状态码
            });

            // 提取 usage 并更新统计
            if (response.data?.usage) {
                updateUsageStats(internalModel, response.data.usage);
            }

            res.status(response.status).json(response.data);
        } else {
            // 流式
            const upstreamResp = await axios.post(upstreamUrl, requestBody, {
                headers,
                responseType: 'stream',
                timeout: 300000,
                validateStatus: () => true
            });

            if (upstreamResp.status !== 200) {
                // 非 200 错误，尝试读取错误内容
                let errorBody = '';
                upstreamResp.data.on('data', chunk => errorBody += chunk);
                upstreamResp.data.on('end', () => {
                    try {
                        const errJson = JSON.parse(errorBody);
                        res.status(upstreamResp.status).json(errJson);
                    } catch {
                        res.status(upstreamResp.status).send(errorBody);
                    }
                });
                return;
            }

            // 设置 SSE 响应头
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // 用于累积流式数据以提取 usage
            let streamData = '';

            upstreamResp.data.on('data', (chunk) => {
                // 转发给客户端
                res.write(chunk);
                // 累积
                streamData += chunk.toString('utf8');
            });

            upstreamResp.data.on('end', () => {
                res.end();
                // 从累积的 SSE 数据中提取最后一个包含 usage 的 data
                const usage = extractUsageFromSSE(streamData);
                if (usage) {
                    updateUsageStats(internalModel, usage);
                }
            });

            upstreamResp.data.on('error', (err) => {
                console.error('上游流错误:', err);
                res.end();
            });

            // 客户端断开时中断上游
            req.on('close', () => {
                upstreamResp.data.destroy();
            });
        }
    } catch (err) {
        console.error(`代理请求失败: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: '上游请求失败', details: err.message });
        } else {
            res.end();
        }
    }
}

// 从 SSE 字符串中提取 usage（查找最后一个包含 "usage" 的 data: 行）
function extractUsageFromSSE(sseString) {
    const lines = sseString.split('\n');
    let usage = null;
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
                const parsed = JSON.parse(dataStr);
                if (parsed.usage) {
                    usage = parsed.usage;
                }
            } catch { }
        }
    }
    return usage;
}

// 挂载所有 /v1/* 请求（排除 /v1/models）
app.all('/v1/*', (req, res) => {
    if (req.path === '/v1/models' && req.method === 'GET') {
        // 已经处理过了，不会到这里
        return;
    }
    proxyRequest(req, res);
});

// === 站点 API ===
// GET /ai-api/usage - 获取 Token 使用统计
app.get('/ai-api/usage', (req, res) => {
    res.json(usageStats);
});

// GET /ai-api/models - 获取模型列表及使用概览
app.get('/ai-api/models', (req, res) => {
    const combined = [];
    for (const [platform, ids] of Object.entries(modelsCache)) {
        for (const id of ids) {
            const internal = `${platform}__${id.includes('/') ? id : '/' + id}`;
            combined.push({
                id: internal,
                platform,
                upstream_id: id,
                stats: usageStats[internal] || null
            });
        }
    }
    res.json(combined);
});

// GET /ai-api/platforms - 平台状态（不含密钥）
app.get('/ai-api/platforms', (req, res) => {
    const info = {};
    for (const [name, conf] of Object.entries(config.platforms)) {
        info[name] = {
            url: conf.url,
            model_count: (modelsCache[name] || []).length
        };
    }
    res.json(info);
});

// GET /ai-api/health - 健康检查
app.get('/ai-api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// === 启动服务器 ===
await loadInitialData();
app.listen(config.port, () => {
    console.log(`多平台 AI 代理已启动: http://localhost:${config.port}/v1`);
    console.log(`认证密钥: ${config.accessKey ? '已启用' : '未启用'}`);
});