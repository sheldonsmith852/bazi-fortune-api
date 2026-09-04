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

const PYTHON = '/opt/palm-venv/bin/python';
const ENGINE = '/opt/palm-engine/palm_read.py';

// 并发保护：2C4G 还与 bazi、薅羊毛日报共用，限制同时进行的手掌分析数
const MAX_CONCURRENT = 2;
let active = 0;

function registerPalm(app, rateLimited) {
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

      return c.json({ report, annotatedImage, originalImage });
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
