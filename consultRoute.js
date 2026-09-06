/**
 * consultRoute.js — 八字 + 手相「合参」接口（POST /api/consult）
 *
 * 链路：multipart(image + 出生信息) -> 同进程 computeBazi() 拿八字
 *       -> 复用 palmRoute.runPalmEngine() 子进程调 Python 引擎拿掌纹
 *       -> 组装含「八字 + 手相」双知识库的合参 user 消息 -> 单次 LLM 出合并解读
 * 复用 bazi 服务的 rateLimited 限流；手相侧的并发保护由 runPalmEngine 内部共享的 active 计数器承担。
 */
const fs = require('fs');
const path = require('path');

const { computeBazi } = require('./baziEngine');
const { runPalmEngine, buildPalmSummary: buildPalmSummaryRich } = require('./palmRoute');
const { SYSTEM_PROMPT: CONSULT_SYSTEM_PROMPT } = require('./consult_interpretation_prompt');

// === 把结构化数据拼成给 LLM 的 user 消息（双份摘要 + 原始 JSON） ===
function buildBaziSummary(c) {
  return (
    `出生：${c.input.date} ${c.input.time}（性别${c.input.gender === 'male' ? '男' : '女'}` +
    `${c.input.city ? '，' + c.input.city : ''}）\n` +
    `真太阳时校正后：${c.trueSolarTime.corrected}（${c.trueSolarTime.note}）\n` +
    `四柱：年[${c.chart.year}] 月[${c.chart.month}] 日[${c.chart.day}] 时[${c.chart.time}]，日主=${c.dayMaster}\n` +
    `十神：年[${c.tenGods.year}] 月[${c.tenGods.month}] 日[${c.tenGods.day}] 时[${c.tenGods.time}]\n` +
    `★五行个数（引擎已算好）：天干4+地支4 = ${JSON.stringify(c.wuXing.count)}；含藏干 = ${JSON.stringify(c.wuXing.countWithHidden)}\n` +
    `★配偶星：${c.spouseStar.summary}\n` +
    `★日主旺衰：结论=${c.strength.verdict}（评分${c.strength.score}）｜${c.strength.deLing.note}；${c.strength.deDi.note}；${c.strength.deShi.note}\n` +
    `★用神：用=${c.yongShen.yong.join('、')}｜喜=${c.yongShen.xi.join('、')}｜忌=${c.yongShen.ji.join('、')}｜${c.yongShen.reason}\n` +
    `大运：起运${c.daYun.startAge}，${c.daYun.direction}；前3步：${c.daYun.list.slice(0, 3).map(d => `${d.ganZhi}(${d.startAge}-${d.endAge}岁)`).join('，')}\n` +
    (c.currentLiuNian ? `当前流年：${c.currentLiuNian.ganZhi}（${c.currentLiuNian.year}年，约${c.currentLiuNian.age}岁）` : '当前流年：未计算')
  );
}

function buildConsultUserMessage(chart, report) {
  return (
    `以下是求问者的【八字命盘】与【手掌结构化分析】两份数据（均由确定性算法提取 / 排好，请勿修改其中任何数字）。\n` +
    `请严格依据你的系统提示词，对八字与手相做一份「合参」解读：把两套信息相互印证、也温和指出张力，合成一篇有温度的讲述。\n\n` +
    `【八字命盘摘要】\n${buildBaziSummary(chart)}\n\n【八字原始 JSON】\n${JSON.stringify(chart, null, 2)}\n\n` +
    `【手掌分析摘要】\n${buildPalmSummaryRich(report)}\n\n【手掌原始 JSON】\n${JSON.stringify(report, null, 2)}`
  );
}

async function getConsultInterpretation(llmClient, model, chart, report) {
  const resp = await llmClient.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: CONSULT_SYSTEM_PROMPT },
      { role: 'user', content: buildConsultUserMessage(chart, report) }
    ],
    temperature: 0.5,
    max_tokens: 4095
  });
  return resp.choices[0].message.content;
}

function registerConsult(app, rateLimited, llmClient, model) {
  app.post('/api/consult', async (c) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    if (rateLimited(ip)) {
      return c.json({ error: '请求过于频繁，请稍后再试（每分钟最多 10 次）。' }, 429);
    }

    let body;
    try { body = await c.req.parseBody(); } catch (e) {
      return c.json({ error: '请求需为 multipart/form-data，包含 image 与出生信息字段' }, 400);
    }
    const file = body && body['image'];
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: '缺少 image 字段（multipart 文件）' }, 400);
    }
    const { birthDate, birthTime, gender, birthPlace } = body;
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return c.json({ error: 'birthDate 格式应为 YYYY-MM-DD' }, 400);
    }
    if (!birthTime || !/^\d{1,2}:\d{2}$/.test(birthTime)) {
      return c.json({ error: 'birthTime 格式应为 HH:MM' }, 400);
    }
    if (!['male', 'female'].includes(gender)) {
      return c.json({ error: 'gender 必须是 male 或 female' }, 400);
    }

    // 八字：同进程直接计算（纯函数，确定性）
    let chart;
    try {
      chart = computeBazi({ date: birthDate, time: birthTime, gender, city: birthPlace || undefined });
    } catch (e) {
      return c.json({ error: '排盘失败：' + e.message }, 400);
    }

    // 手相：子进程调 Python 引擎（复用 palmRoute 的并发保护与零留存）
    let palm;
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      palm = await runPalmEngine(buf);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const code = e && e.code === 503 ? 503 : (/无法识别|过暗|palm\.json/.test(msg) ? 422 : 500);
      return c.json({ error: '掌纹分析失败：' + msg }, code);
    }

    // 合参解读：单次 LLM 调用，system prompt 已注入八字 + 手相双知识库
    let interpretation = null, llmNote = null;
    if (llmClient) {
      try {
        interpretation = await getConsultInterpretation(llmClient, model, chart, palm.report);
      } catch (e) {
        llmNote = '合参解读生成失败：' + (e && e.message);
      }
    } else {
      llmNote = '服务端未配置 ZHIPU_API_KEY，仅返回八字与手相结构化数据，无合参文字解读。';
    }

    return c.json({
      bazi: chart,
      palm: palm.report,
      interpretation,
      llmNote,
      annotatedImage: palm.annotatedImage,
      originalImage: palm.originalImage
    });
  });

  // 合参上传页（手机友好）
  app.get('/consult', (c) => {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'consult.html'), 'utf8');
      return c.html(html);
    } catch (e) {
      return c.text('consult.html 未找到', 500);
    }
  });
}

module.exports = { registerConsult, buildConsultUserMessage };
