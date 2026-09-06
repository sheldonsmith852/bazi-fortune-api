/**
 * palmRoute.js — 手掌分析接口（POST /api/palm）
 *
 * 链路：multipart 图片 -> 写 /tmp -> 子进程调 Python 引擎(palm_read.py)
 *       -> 读 palm.json + annotated.png -> 返回 -> 删临时目录(零留存)
 * 复用 bazi 服务的 rateLimited 限流。
 *
 * 引擎为独立仓库（sheldonsmith852/palm-engine），部署在服务器 /opt/palm-engine，
 * 由 /opt/palm-venv（mediapipe==0.10.14 + opencv + numpy）运行。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { SYSTEM_PROMPT: PALM_SYSTEM_PROMPT } = require('./palm_interpretation_prompt');

const PYTHON = '/opt/palm-venv/bin/python';
const ENGINE = '/opt/palm-engine/palm_read.py';

// 并发保护：2C4G 还与 bazi、薅羊毛日报共用，限制同时进行的手掌分析数
const MAX_CONCURRENT = 2;
let active = 0;

/**
 * 把结构化掌纹数据组装成给 LLM 的 user 消息（自然语言摘要 + 原始 JSON）
 */
function buildPalmUserMessage(report) {
  const hand = report.hand || {};
  const qs = report.qualityScore || {};
  const lines = report.lines || [];
  const ef = report.extraFeatures || {};

  const lineTxt = lines.map(l =>
    `- ${l.name}：清晰度=${l.clarity}，相对长度=${typeof l.length === 'number' ? l.length.toFixed(3) : l.length}` +
    `，标记=${l.mark && l.mark !== 'none' ? l.mark : '无'}`
  ).join('\n');

  const chuan = ef.chuan || {};
  const sun = ef.sunDouble || {};
  const fea = ef.heartFeather || {};
  const extraTxt =
    `- 川字掌：${chuan.isChuan ? '是' : '非典型'}（智慧线↔感情线间距 ${chuan.mindHeartGap}；生命线↔智慧线 ${chuan.lifeMindSeparate ? '分离' : '相连'}）\n` +
    `- 双太阳线：${sun.isDouble ? '有' : '无'}（检出主脊 ${sun.count} 条）\n` +
    `- 感情线羽毛纹：${fea.has ? '有' : '无'}（分叉 ${fea.forks} 处）`;

  const marks = report.wealthMarks || [];
  const markCount = {};
  marks.forEach(m => { const t = m.type || '未分类'; markCount[t] = (markCount[t] || 0) + 1; });
  const markTxt = Object.keys(markCount).length
    ? Object.keys(markCount).map(t => `${t}×${markCount[t]}`).join('，')
    : '未检出';

  const summary =
    `手掌：${hand.label === 'Left' ? '左手' : (hand.label === 'Right' ? '右手' : hand.label || '未知')}（识别置信 ${hand.confidence}%）\n` +
    `照片质量分：${qs.score}（${qs.label}）\n` +
    (report.heartEndTrend ? `感情线末端走向：${report.heartEndTrend}\n` : '') +
    (report.careerSpine ? `事业线（纵脊）：${report.careerSpine.label}\n` : '') +
    `\n【主线】\n${lineTxt}\n\n【进阶纹向】\n${extraTxt}\n\n【掌中吉纹】共 ${marks.length} 处：${markTxt}`;

  return `以下是求问者手掌的结构化分析数据（由确定性算法提取，请勿修改其中任何数值）。\n` +
    `请严格依据系统提示词中的【手相权威知识库】撰写解读，只可用其中的传统说法，不得超纲编造。\n\n` +
    `【数据摘要】\n${summary}\n\n【原始数据 JSON】\n${JSON.stringify(report, null, 2)}`;
}

async function getPalmInterpretation(llmClient, model, report) {
  const resp = await llmClient.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: PALM_SYSTEM_PROMPT },
      { role: 'user', content: buildPalmUserMessage(report) }
    ],
    temperature: 0.75,
    max_tokens: 2048
  });
  return resp.choices[0].message.content;
}

function registerPalm(app, rateLimited, llmClient, model) {
  app.post('/api/palm', async (c) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    if (rateLimited(ip)) {
      return c.json({ error: '请求过于频繁，请稍后再试（每分钟最多 10 次）。' }, 429);
    }

    let body;
    try {
      body = await c.req.parseBody();
    } catch (e) {
      return c.json({ error: '请求需为 multipart/form-data，包含 image 字段' }, 400);
    }
    const file = body && body['image'];
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: '缺少 image 字段（multipart 文件）' }, 400);
    }

    // 并发保护：2C4G 与 bazi、薅羊毛日报共用；每个分析会单起一个 MediaPipe 进程
    if (active >= MAX_CONCURRENT) {
      return c.json({ error: '当前分析排队已满（服务器资源有限），请稍后再试。' }, 503);
    }
    active++;

    let tmpDir = null;
    try {
      tmpDir = fs.mkdtempSync('/tmp/palm-');
      const ext = (file.name && /\.png$/i.test(file.name)) ? 'png' : 'jpg';
      const imgPath = path.join(tmpDir, 'hand.' + ext);

      const buf = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(imgPath, buf);

      await new Promise((resolve, reject) => {
        execFile(
          PYTHON,
          [ENGINE, imgPath, '-o', tmpDir],
          { timeout: 120000, cwd: '/opt/palm-engine' },
          (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').toString().slice(0, 500)));
            resolve();
          }
        );
      });

      const jsonPath = path.join(tmpDir, 'palm.json');
      const pngPath = path.join(tmpDir, 'annotated.png');
      if (!fs.existsSync(jsonPath)) {
        return c.json({ error: '引擎未产出 palm.json，可能照片无法识别手掌或图片过暗' }, 422);
      }
      const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      let annotatedImage = null;
      if (fs.existsSync(pngPath)) {
        annotatedImage = 'data:image/png;base64,' + fs.readFileSync(pngPath).toString('base64');
      }
      // 原图也回传，方便前端做"划线 vs 原图"对照（仍在 tmpDir 内，finally 一并删除）
      const originalImage = 'data:image/' + ext + ';base64,' + fs.readFileSync(imgPath).toString('base64');

      // 解读层：复用 bazi 的 LLM 客户端，按 palm-reader 技能的口吻指令 + 知识库生成算命先生式解读
      let interpretation = null;
      let llmNote = null;
      if (llmClient) {
        try {
          interpretation = await getPalmInterpretation(llmClient, model, report);
        } catch (e) {
          llmNote = '解读生成失败：' + e.message;
        }
      } else {
        llmNote = '服务端未配置 ZHIPU_API_KEY，仅返回结构化数据，无文字解读。';
      }

      return c.json({ report, interpretation, llmNote, annotatedImage, originalImage });
    } catch (e) {
      return c.json({ error: '掌纹分析失败：' + e.message }, 500);
    } finally {
      active--;
      // 零留存：处理完即删临时目录（含原图 + 引擎产物）
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    }
  });
  // 手掌上传页（手机友好）
  app.get('/palm', (c) => {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'palm.html'), 'utf8');
      return c.html(html);
    } catch (e) {
      return c.text('palm.html 未找到', 500);
    }
  });
}

module.exports = { registerPalm };
