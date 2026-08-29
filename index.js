import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(__dirname, 'Config');
const DATA_DIR = path.join(__dirname, 'Data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MODELS_CACHE_FILE = path.join(CONFIG_DIR, 'models.json');
const USAGE_FILE = path.join(DATA_DIR, 'models.json');

// ---------- 全局状态 ----------
let currentConfig = null;          // 当前配置（动态）
let modelsCache = {};              // 缓存模型列表
let usageStats = {};               // Token 统计
let saveTimer = null;

// ---------- 初始化 ----------
async function initialize() {
    // 确保目录存在
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(DATA_DIR, { recursive: true });

    // 加载配置文件（不存在则创建默认）
    try {
        const raw = await fs.readFile(CONFIG_FILE, 'utf8');
        currentConfig = JSON.parse(raw);
    } catch {
        currentConfig = {
            port: 3000,
            accessKey: "sk-your-keys",
            platforms: {
                opencode: {
                    url: "https://opencode.ai/zen/v1",
                    key: "sk-opencode-xxxxxxxx",
                    defaultHeaders: {}
                },
                deepseek: {
                    url: "https://api.deepseek.com/v1",
                    key: "sk-deepseek-xxxxxxxx",
                    defaultHeaders: {}
                }
            },
            modelsRefreshInterval: 3600000
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
        console.log('已创建默认配置文件 Config/config.json');
    }

    // 在 currentConfig 加载完成后，补全平台默认字段
    if (currentConfig.platforms) {
        for (const [name, conf] of Object.entries(currentConfig.platforms)) {
            if (typeof conf.enable !== 'boolean') conf.enable = true;
            if (!Array.isArray(conf.models)) conf.models = [];
        }
    }

    // 加载模型缓存
    try {
        const cacheRaw = await fs.readFile(MODELS_CACHE_FILE, 'utf8');
        modelsCache = JSON.parse(cacheRaw);
    } catch {
        modelsCache = {};
    }

    // 加载用量统计
    try {
        const usageRaw = await fs.readFile(USAGE_FILE, 'utf8');
        usageStats = JSON.parse(usageRaw);
    } catch {
        usageStats = {};
    }
}

// ---------- 保存配置到文件 ----------
async function saveConfig() {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
}

// ---------- 模型列表刷新 ----------
async function refreshModels() {
    const platformEntries = Object.entries(currentConfig.platforms);
    const total = platformEntries.length;
    if (total === 0) {
        console.log('没有配置任何模型提供商，跳过刷新。');
        return;
    }

    console.log('开始刷新各平台模型列表...');
    const newCache = {};

    for (let i = 0; i < total; i++) {
        const [platformName, platformConf] = platformEntries[i];
        const percent = Math.floor((i / total) * 100);
        // 渲染进度条
        const barLength = 30;
        const filledLength = Math.floor((i / total) * barLength);
        const bar = '='.repeat(filledLength) + '>'.repeat(filledLength < barLength ? 1 : 0) + ' '.repeat(barLength - filledLength - 1);
        const progressText = `[${bar}] ${percent}% - 获取 ${platformName} 模型列表...`;
        process.stdout.write(`\r\x1b[K${progressText}`);

        try {
            const url = `${platformConf.url.replace(/\/$/, '')}/models`;
            const headers = {
                'Authorization': `Bearer ${platformConf.key}`,
                ...platformConf.defaultHeaders
            };
            const resp = await axios.get(url, { headers, timeout: 10000 });
            const ids = resp.data?.data?.map(m => m.id) || [];
            newCache[platformName] = ids;

            // 请求成功后覆盖当前行，显示成功结果
            const successText = `[${bar}] ${percent}% - ${platformName}: 获取到 ${ids.length} 个模型`;
            process.stdout.write(`\r\x1b[K${successText}`);
        } catch (err) {
            // 使用缓存或跳过
            if (modelsCache[platformName]) {
                newCache[platformName] = modelsCache[platformName];
            }
            // 请求失败后覆盖当前行，显示失败结果
            const failText = `[${bar}] ${percent}% - ${platformName}: 获取失败 (${err.message})`;
            process.stdout.write(`\r\x1b[K${failText}`);
        }
    }

    // 最后输出 100% 并保存
    const finalPercent = 100;
    const finalBar = '='.repeat(30);
    process.stdout.write(`\r\x1b[K[${finalBar}] ${finalPercent}% - 所有平台处理完毕\n`);

    modelsCache = newCache;
    await fs.writeFile(MODELS_CACHE_FILE, JSON.stringify(modelsCache, null, 2), 'utf8');
    console.log('模型列表刷新完成并已缓存');
}

// ---------- Token 用量持久化 ----------
function scheduleSaveUsage() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await fs.writeFile(USAGE_FILE, JSON.stringify(usageStats, null, 2), 'utf8');
        } catch (err) {
            console.error('保存用量数据失败:', err);
        }
    }, 5000);
}

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

// ---------- 解析内部模型名称 ----------
function parseInternalModel(internalModel) {
    const idx = internalModel.indexOf('__');
    if (idx === -1) {
        throw new Error(`模型名称格式错误，应为 "平台名__模型标识"，收到: ${internalModel}`);
    }
    const platform = internalModel.slice(0, idx);
    let rest = internalModel.slice(idx + 2);
    if (!currentConfig.platforms[platform]) {
        throw new Error(`未知平台: ${platform}`);
    }
    let prefix = '';
    let model = rest;
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) {
        prefix = rest.slice(0, slashIdx);
        model = rest.slice(slashIdx + 1);
    } else {
        if (rest.startsWith('/')) {
            prefix = '';
            model = rest.slice(1);
        } else {
            throw new Error(`模型格式应为 "平台名__[前缀/]模型"，收到: ${internalModel}`);
        }
    }
    const upstreamModel = prefix ? `${prefix}/${model}` : model;
    return { platform, upstreamModel };
}

// ---------- Express 应用 ----------
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 认证中间件（使用动态 currentConfig.accessKey）
app.use((req, res, next) => {
    // 认证中间件（使用动态 currentConfig.accessKey）

    // 排除根路径和静态资源（页面访问不需要认证）
    if (req.path === '/')
        return next();

    if (currentConfig.accessKey) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (token !== currentConfig.accessKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    next();
});

// ---------- OpenAI 格式接口 ----------
app.get('/v1/models', (req, res) => {
    const combined = [];
    for (const [platform, ids] of Object.entries(modelsCache)) {
        const platformConf = currentConfig.platforms[platform];
        // 平台被禁用或不存在配置时跳过
        if (!platformConf || platformConf.enable === false) continue;
        for (const id of ids) {
            const internal = `${platform}__${id.includes('/') ? id : '/' + id}`;
            combined.push({ id: internal, object: 'model', owned_by: platform });
        }
    }
    res.json({ object: 'list', data: combined });
});

async function proxyRequest(req, res) {
    const apiPath = req.path.replace(/^\/v1/, '');
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

    const platformConf = currentConfig.platforms[platformName];
    // 检查平台是否被禁用
    if (platformConf.enable === false) {
        return res.status(403).json({ error: `平台 ${platformName} 已被禁用` });
    }

    // 检查模型是否在自定义允许列表中（如果配置了 models 且非空）
    if (Array.isArray(platformConf.models) && platformConf.models.length > 0) {
        if (!platformConf.models.includes(upstreamModel)) {
            return res.status(400).json({ error: `模型 ${upstreamModel} 不在平台 ${platformName} 的允许列表中` });
        }
    }

    const upstreamUrl = platformConf.url.replace(/\/$/, '') + apiPath;

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    headers['authorization'] = `Bearer ${platformConf.key}`;
    Object.assign(headers, platformConf.defaultHeaders || {});

    const requestBody = { ...restBody, model: upstreamModel };
    const isStream = requestBody.stream === true;

    try {
        if (!isStream) {
            const response = await axios.post(upstreamUrl, requestBody, {
                headers,
                responseType: 'json',
                timeout: 300000,
                validateStatus: () => true
            });
            if (response.data?.usage) {
                updateUsageStats(internalModel, response.data.usage);
            }
            res.status(response.status).json(response.data);
        } else {
            const upstreamResp = await axios.post(upstreamUrl, requestBody, {
                headers,
                responseType: 'stream',
                timeout: 300000,
                validateStatus: () => true
            });

            if (upstreamResp.status !== 200) {
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

            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let streamData = '';
            upstreamResp.data.on('data', (chunk) => {
                res.write(chunk);
                streamData += chunk.toString('utf8');
            });
            upstreamResp.data.on('end', () => {
                res.end();
                const usage = extractUsageFromSSE(streamData);
                if (usage) updateUsageStats(internalModel, usage);
            });
            upstreamResp.data.on('error', (err) => {
                console.error('上游流错误:', err);
                res.end();
            });
            req.on('close', () => upstreamResp.data.destroy());
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.all('/v1/*', (req, res) => {
    if (req.path === '/v1/models' && req.method === 'GET') return;
    proxyRequest(req, res);
});

function extractUsageFromSSE(sseString) {
    const lines = sseString.split('\n');
    let usage = null;
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
                const parsed = JSON.parse(dataStr);
                if (parsed.usage) usage = parsed.usage;
            } catch { }
        }
    }
    return usage;
}

// ---------- 站点 API ----------
// 获取 Token 使用统计
app.get('/ai-api/usage', (req, res) => res.json(usageStats));

// 获取所有模型及统计
app.get('/ai-api/models', (req, res) => {
    const combined = [];
    for (const [platform, ids] of Object.entries(modelsCache)) {
        const platformConf = currentConfig.platforms[platform];
        if (!platformConf || platformConf.enable === false) continue;
        for (const id of ids) {
            const internal = `${platform}__${id.includes('/') ? id : '/' + id}`;
            combined.push({
                id: id,
                platform,
                call_id: internal,
                stats: usageStats[internal] || null
            });
        }
    }
    res.json(combined);
});

// 获取平台状态（不包含 key）
app.get('/ai-api/platforms', (req, res) => {
    const info = {};
    for (const [name, conf] of Object.entries(currentConfig.platforms)) {
        info[name] = {
            url: conf.url,
            model_count: (modelsCache[name] || []).length,
            enable: conf.enable !== false,   // 默认 true
            models: conf.models || []        // 返回自定义模型列表（可能为空数组）
        };
    }
    res.json(info);
});

// 健康检查
app.get('/ai-api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// 获取完整平台配置（包含密钥，需要认证）
app.get('/ai-api/config/platforms', (req, res) => {
    res.json(currentConfig.platforms);
});

// 更新平台配置
app.put('/ai-api/config/platforms', async (req, res) => {
    const newPlatforms = req.body;
    if (!newPlatforms || typeof newPlatforms !== 'object') {
        return res.status(400).json({ error: '请求体必须是 platforms 对象' });
    }

    // 基本格式验证
    for (const [name, conf] of Object.entries(newPlatforms)) {
        if (!conf.url || !conf.key) {
            return res.status(400).json({ error: `平台 ${name} 缺少 url 或 key` });
        }
    }

    for (const [name, conf] of Object.entries(newPlatforms)) {
        if (!conf.url || !conf.key) {
            return res.status(400).json({ error: `平台 ${name} 缺少 url 或 key` });
        }
        // 补全默认值
        if (typeof conf.enable !== 'boolean') conf.enable = true;
        if (!Array.isArray(conf.models)) conf.models = [];
    }

    // 更新内存配置
    currentConfig.platforms = newPlatforms;
    try {
        await saveConfig();
        // 立即刷新模型列表
        refreshModels();
        res.json({ success: true, platforms: newPlatforms });
    } catch (err) {
        console.error('保存配置失败:', err);
        res.status(500).json({ error: '保存配置失败', details: err.message });
    }
});

// ---------- 启动 ----------
await initialize();

app.listen(currentConfig.port, () => {
    const url = `http://localhost:${currentConfig.port}`;
    [
        "=== 服务已启动 ===",
        `- 管理后台: ${url}`,
        `- AI 端点: ${url}/v1/`,
        `- Key: ${currentConfig.accessKey ?? '未启用'}`,
        "================"
    ].forEach(msg => console.log(msg));

    // 刷新模型列表
    refreshModels();
    if (currentConfig.modelsRefreshInterval > 1)
        setInterval(refreshModels, currentConfig.modelsRefreshInterval || 3600000);
});



