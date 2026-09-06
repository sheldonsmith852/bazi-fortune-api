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

// 与引擎 palm_read.py 的 MARKCN 保持一致
const MARKCN = { chain: '锁链纹', island: '岛纹', break: '断口' };

// 中文线名 → key
const NAME_KEY = { '生命线': 'life', '智慧线': 'mind', '感情线': 'heart', '事业线': 'fate', '太阳线': 'sun' };

// 相书流年参照（各流派取中值的约定，非实测）：把非生命线按传统摊成一段人生年龄段，
// 供解读把线特征/标记落成"约XX岁前后"。起点=小岁数端，末端=大岁数端。仅生命线用引擎实测 0-78 岁轴。
const FLOW_YEARS = {
  mind:  { from: 8,  to: 50, span: '约8-50岁：拇指侧≈求学少年、末端小指侧≈50岁上下' },
  heart: { from: 18, to: 65, span: '约18-65岁：小指侧起点≈情窦初开、末端拇指侧≈中晚年' },
  fate:  { from: 25, to: 60, span: '约25-60岁：腕端≈而立前后起步、越向指端越晚近' },
  sun:   { from: 30, to: 65, span: '约30-65岁：成名/成果多偏中年以后' },
};

// 把 0-1 相对位置换算成该线（相书参照）的约年龄
function flowAge(key, frac) {
  const f = FLOW_YEARS[key];
  if (!f) return null;
  const c = Math.max(0, Math.min(1, Number(frac) || 0));
  return Math.round(f.from + c * (f.to - f.from));
}

// 生命线流年带状态的中文档位
const BANDCN = { good: '纹实', mid: '中等', low: '偏淡' };

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

  const lineTxt = lines.map(l => {
    const key = NAME_KEY[l.name];
    const dg = l.depthGradient || {};
    const dgTxt = dg.type ? `，起止深浅=${dg.type}（${dg.desc || ''}）` : '';
    const clrNote = l.clarity === '清晰' ? '' :
      `（讲述此线时须如实用「${l.clarity}清晰」表述，严禁拔高成"清晰"）`;
    const segs = l.segments || [];
    const flow = key && key !== 'life' ? FLOW_YEARS[key] : null;
    const segTxt = segs.length
      ? `，分段清晰度=[${segs.map(s => s.rel + s.st).join('→')}]`
      : '';
    // 非生命线：把 6 段按相书流年参照摊成年龄带（约数），供解读落"XX岁前后"
    const flowTxt = (flow && segs.length)
      ? `，流年参照（相书约定·非实测：${flow.span}）按段摊开=[${segs.map((s, i) => {
          const a0 = flowAge(key, i / segs.length), a1 = flowAge(key, (i + 1) / segs.length);
          return `${a0}-${a1}岁${s.st}`;
        }).join('→')}]`
      : '';
    const sh = l.shape || {};
    const shapeTxt = sh.note
      ? `，形态=${sh.note}${typeof sh.turningPoints === 'number' ? `（${sh.turningPoints}处弯折）` : ''}`
      : '';
    const ms = l.marks || [];
    const markTxt = ms.length
      ? `，标记=${ms.map(m => {
          const mkLoc = m.label || '';
          const mkAge = (flow && typeof m.pos === 'number') ? `·约${flowAge(key, m.pos)}岁（参照）` : '';
          return (MARKCN[m.type] || m.type) + (mkLoc || mkAge ? `(${mkLoc}${mkAge})` : '');
        }).join('、')}`
      : '，标记=无';
    return `- ${l.name}：清晰度=${l.clarity}，相对长度=${typeof l.length === 'number' ? l.length.toFixed(3) : l.length}` +
      `${markTxt}${dgTxt}${segTxt}${flowTxt}${shapeTxt}${clrNote}`;
  }).join('\n');

  const chuan = ef.chuan || {};
  const sun = ef.sunDouble || {};
  const fea = ef.heartFeather || {};
  const extraTxt =
    `- 川字掌：${chuan.isChuan ? '是' : '非典型'}（智慧线↔感情线间距 ${chuan.mindHeartGap}；生命线↔智慧线 ${chuan.lifeMindSeparate ? '分离' : '相连'}）\n` +
    `- 双太阳线：${sun.isDouble ? '有' : '无'}（检出主脊 ${sun.count} 条）\n` +
    `- 感情线羽毛纹：${fea.has ? '有' : '无'}（分叉 ${fea.forks} 处）`;

  const marks = report.wealthMarks || [];
  const hi = {}, lo = {};
  marks.forEach(m => {
    const t = m.type || '未分类';
    const c = m.confidence;
    const isLow = (typeof c === 'number' && c < 0.6) || c === '低';
    (isLow ? lo : hi)[t] = ((isLow ? lo : hi)[t] || 0) + 1;
  });
  const hiTxt = Object.keys(hi).length ? Object.keys(hi).map(t => `${t}×${hi[t]}`).join('，') : '无';
  const loTxt = Object.keys(lo).length ? Object.keys(lo).map(t => `${t}×${lo[t]}`).join('，') : '无';

  const lt = report.lifeTimeline || {};
  // 生命线实测 0-78 岁流年带：按年龄升序排，逐带讲纹路状态
  const bands = (lt.segments || [])
    .map(s => {
      const mm = String(s.age || '').split('-').map(x => parseInt(x, 10));
      return { lo: mm[0] || 0, hi: mm[1] != null ? mm[1] : mm[0] || 0, state: s.state };
    })
    .sort((a, b) => a.lo - b.lo);
  const bandTxt = bands.length
    ? `生命线流年带（实测 0-78 岁、按纹路状态分 ${bands.length} 段）：${bands.map(s => `${s.lo}-${s.hi}岁${BANDCN[s.state] || s.state}`).join('→')}`
    : '生命线流年带：无分段数据';
  const ltTxt = bandTxt +
    ((lt.breaks && lt.breaks.length)
      ? `；断口年龄区间：${lt.breaks.map(b => `${b.from}-${b.to}岁`).join('、')}`
      : '；无明显断口');

  const summary =
    `手掌：${hand.label === 'Left' ? '左手' : (hand.label === 'Right' ? '右手' : hand.label || '未知')}（识别置信 ${hand.confidence}%）\n` +
    `照片质量分：${qs.score}（${qs.label}）\n` +
    (report.heartEndTrend ? `感情线末端走向：${report.heartEndTrend}\n` : '') +
    (report.careerSpine ? `事业线（纵脊）：${report.careerSpine.label}\n` : '') +
    `${ltTxt}\n` +
    `\n【主线】\n${lineTxt}\n\n【进阶纹向】\n${extraTxt}\n\n` +
    `【掌中吉纹（高置信，传统视为吉兆，可轻描"主聚财/利积蓄"）】${hiTxt}\n` +
    `【低置信纹理（多属拓扑节点噪声，切勿视为吉纹或据此断运势，只可说"纹理交汇较密"）】${loTxt}`;

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
    temperature: 0.3,
    max_tokens: 2048
  });
  return resp.choices[0].message.content;
}

/**
 * 运行掌纹引擎：写临时目录 -> 子进程调 Python -> 读 palm.json + annotated.png
 * 并发保护由模块级 active / MAX_CONCURRENT 承担；处理完即删临时目录（零留存）。
 * 返回 { report, annotatedImage, originalImage }；失败抛错（e.code 可能为 503）。
 * 被 /api/palm 与 /api/consult 共用。
 */
async function runPalmEngine(buf) {
  if (active >= MAX_CONCURRENT) {
    const e = new Error('当前分析排队已满（服务器资源有限），请稍后再试。');
    e.code = 503;
    throw e;
  }
  active++;
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync('/tmp/palm-');
    const ext = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : 'jpg';
    const imgPath = path.join(tmpDir, 'hand.' + ext);
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
      throw new Error('引擎未产出 palm.json，可能照片无法识别手掌或图片过暗');
    }
    const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    let annotatedImage = null;
    if (fs.existsSync(pngPath)) {
      annotatedImage = 'data:image/png;base64,' + fs.readFileSync(pngPath).toString('base64');
    }
    // 原图也回传，方便前端做"划线 vs 原图"对照（仍在 tmpDir 内，finally 一并删除）
    const originalImage = 'data:image/' + ext + ';base64,' + buf.toString('base64');

    return { report, annotatedImage, originalImage };
  } finally {
    active--;
    // 零留存：处理完即删临时目录（含原图 + 引擎产物）
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
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

    let palm;
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      palm = await runPalmEngine(buf);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const code = e && e.code === 503 ? 503 : (/无法识别|过暗|palm\.json/.test(msg) ? 422 : 500);
      return c.json({ error: '掌纹分析失败：' + msg }, code);
    }

    // 解读层：复用 bazi 的 LLM 客户端，按 palm-reader 技能的口吻指令 + 知识库生成算命先生式解读
    let interpretation = null;
    let llmNote = null;
    if (llmClient) {
      try {
        interpretation = await getPalmInterpretation(llmClient, model, palm.report);
      } catch (e) {
        llmNote = '解读生成失败：' + (e && e.message);
      }
    } else {
      llmNote = '服务端未配置 ZHIPU_API_KEY，仅返回结构化数据，无文字解读。';
    }

    return c.json({ report: palm.report, interpretation, llmNote, annotatedImage: palm.annotatedImage, originalImage: palm.originalImage });
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

module.exports = { registerPalm, runPalmEngine };
