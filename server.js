#!/usr/bin/env node
/**
 * server.js — 八字算命 Web 服务（Hono 版）
 *
 * 框架：Hono + @hono/node-server（轻量、跨运行时、Node 22 原生支持）
 * 链路：表单 → POST /api/bazi → 排盘(computeBazi) → 组装 prompt → 调 LLM → 返回报告
 * 缺 LLM key 时：仍返回排盘，interpretation=null（便于本地自测、部署后再补 key 出解读）
 *
 * 运行：node server.js   （端口读 PORT 或默认 3000；key 读 ZHIPU_API_KEY）
 */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) { /* dotenv 可选 */ }

const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { cors } = require('hono/cors');

const { computeBazi } = require('./baziEngine');
const { SYSTEM_PROMPT } = require('./interpretation_prompt');
const { registerPalm } = require('./palmRoute');

const app = new Hono();
const PORT = Number(process.env.PORT) || 3000;

// === 按 IP 简单限流（保护免费 LLM 额度，防刷） ===
const RATE_LIMIT = 10;          // 每窗口允许次数
const RATE_WINDOW = 60 * 1000;  // 1 分钟
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.ts > RATE_WINDOW) {
    hits.set(ip, { ts: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}

// === LLM 客户端（OpenAI 兼容，默认智谱 GLM-4-Flash） ===
let llmClient = null;
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_MODEL = process.env.ZHIPU_MODEL || 'glm-4-flash';
if (ZHIPU_API_KEY) {
  try {
    const OpenAI = require('openai');
    llmClient = new OpenAI({ apiKey: ZHIPU_API_KEY, baseURL: ZHIPU_BASE_URL });
  } catch (e) {
    console.warn('[warn] 未能初始化 LLM 客户端（openai 包缺失？）：', e.message);
  }
}

/**
 * 把结构化命盘组装成给 LLM 的 user 消息（自然语言摘要 + 原始 JSON）
 */
function buildUserMessage(chart) {
  const c = chart;
  const summary =
    `出生：${c.input.date} ${c.input.time}（性别${c.input.gender === 'male' ? '男' : '女'}` +
    `${c.input.city ? '，' + c.input.city : ''}）\n` +
    `真太阳时校正后：${c.trueSolarTime.corrected}（${c.trueSolarTime.note}）\n` +
    `四柱：年[${c.chart.year}] 月[${c.chart.month}] 日[${c.chart.day}] 时[${c.chart.time}]，日主=${c.dayMaster}\n` +
    `十神：年[${c.tenGods.year}] 月[${c.tenGods.month}] 日[${c.tenGods.day}] 时[${c.tenGods.time}]\n` +
    `★五行个数（引擎已算好，直接引用）：天干4+地支4 = ${JSON.stringify(c.wuXing.count)}；含藏干口径 = ${JSON.stringify(c.wuXing.countWithHidden)}\n` +
    `★配偶星（引擎已算好，直接引用，禁止自行另找星或改称）：${c.spouseStar.gender}｜${c.spouseStar.summary}\n` +
    `★日主旺衰（引擎已算好，直接引用，禁止自行另判）：结论=${c.strength.verdict}（评分${c.strength.score}）｜${c.strength.deLing.note}；${c.strength.deDi.note}；${c.strength.deShi.note}\n` +
    `★用神（引擎扶抑法已算好，直接引用，禁止自行推算或改写五行生克方向）：用神=${c.yongShen.yong.join('、')}｜喜神=${c.yongShen.xi.join('、')}｜忌神=${c.yongShen.ji.join('、')}｜${c.yongShen.reason}\n` +
    `纳音：年[${c.naYin.year}] 月[${c.naYin.month}] 日[${c.naYin.day}] 时[${c.naYin.time}]\n` +
    `大运：起运${c.daYun.startAge}，${c.daYun.direction}（${c.daYun.directionNote}），起运约${c.daYun.startSolar}\n` +
    `当前大运序列（前3步）：${c.daYun.list.slice(0, 3).map(d => `${d.ganZhi}(${d.startAge}-${d.endAge}岁)`).join('，')}\n` +
    (c.currentLiuNian ? `当前流年：${c.currentLiuNian.ganZhi}（${c.currentLiuNian.year}年，约${c.currentLiuNian.age}岁，处${c.currentLiuNian.inDayun || '大运外'}）` : '当前流年：未计算');
  return `以下是用户的八字命盘（已排好，请勿修改其中任何数字）。请严格依据你的系统提示词中【命理方法论参考资料】来撰写大白话解读报告，特别是取用神要走【参考资料·取用神】的法则、格局/十神/六亲/冲合均须引用对应篇章规则，不要凭通用知识发挥。\n【重要】摘要中标 ★ 的三个字段（五行个数、配偶星、日主旺衰）由排盘引擎确定性算好，属于既定事实：你必须直接引用其数值与结论，不得另行推算、不得改写、不得写出与之相反的判断；五行生克关系也不得写反。\n\n` +
    `【命盘摘要】\n${summary}\n\n【原始命盘 JSON】\n${JSON.stringify(chart, null, 2)}`;
}

async function getInterpretation(chart) {
  if (!llmClient) return null;
  const resp = await llmClient.chat.completions.create({
    model: ZHIPU_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(chart) }
    ],
    temperature: 0.25,
    max_tokens: 4095
  });
  return resp.choices[0].message.content;
}

// CORS（方便本地前端或未来跨域调用）
app.use('*', cors());

// === 接口 ===
app.get('/api/health', (c) => c.json({ ok: true, llmReady: !!llmClient, model: ZHIPU_MODEL }));

app.post('/api/bazi', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (rateLimited(ip)) {
    return c.json({ error: '请求过于频繁，请稍后再试（每分钟最多 10 次）。' }, 429);
  }

  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: '请求体需为 JSON' }, 400); }

  const { date, time, gender, city, lng, lat, now } = body || {};
  // 输入校验
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date 格式应为 YYYY-MM-DD' }, 400);
  }
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
    return c.json({ error: 'time 格式应为 HH:MM' }, 400);
  }
  if (!['male', 'female'].includes(gender)) {
    return c.json({ error: 'gender 必须是 male 或 female' }, 400);
  }

  let chart;
  try {
    chart = computeBazi({ date, time, gender, city, lng, lat, now });
  } catch (e) {
    return c.json({ error: '排盘失败：' + e.message }, 400);
  }

  let interpretation = null;
  let llmNote = null;
  if (llmClient) {
    try {
      interpretation = await getInterpretation(chart);
    } catch (e) {
      llmNote = 'LLM 解读调用失败：' + e.message;
    }
  } else {
    llmNote = '服务端未配置 ZHIPU_API_KEY，仅返回排盘结果。配置 key 后将自动生成解读。';
  }

  return c.json({ chart, interpretation, llmNote });
});

// 手掌分析接口（子进程调 Python 引擎，详见 palmRoute.js）
registerPalm(app, rateLimited);

// === 静态页（前端完全内联，这里直接读 index.html） ===
app.get('/', (c) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    return c.html(html);
  } catch (e) {
    return c.text('index.html 未找到', 500);
  }
});

// 静态资源兜底（未来若放 logo / 图片等）
app.use('/public/*', serveStatic({ root: './' }));

// === 启动 ===
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`八字服务已启动: http://localhost:${PORT}`);
  console.log(`LLM: ${llmClient ? '已接入 ' + ZHIPU_MODEL : '未配置（仅排盘）'}`);
});
