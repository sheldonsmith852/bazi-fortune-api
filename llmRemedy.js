/**
 * llmRemedy.js — 保证命理解读带"算命先生胆色"的安全网。
 *
 * 问题背景：GLM-4-Flash 在 temperature 偏高时，经常"听懂了结构、却丢掉趋避建议"——
 * 流年/各路只写优势、不点隐忧、不给出"宜…忌…"的破解之道，读起来像温吞水报表。
 * 光靠 prompt 里的范例与自查清单，模型仍会偶尔漏掉。
 *
 * 这里做一道硬性兜底：首调用后统计正文里「宜/忌/不宜/守」出现的次数，
 * 若低于阈值（说明胆色不足），追加一条明确的纠正指令再调一次（最多 1 次重试，
 * 避免无限循环与额外成本）。绝大多数合规输出不会触发重试。
 */

// 统计正文里"趋避建议"字眼的出现次数
function countRemedy(text) {
  if (!text) return 0;
  const m = text.match(/宜|忌|不宜|守/g);
  return m ? m.length : 0;
}

/**
 * @param {object} llmClient OpenAI 兼容客户端
 * @param {string} model     模型名
 * @param {Array}  messages  首轮 messages（[{role,content}...]）
 * @param {number} threshold 「宜/忌/不宜/守」最少出现次数，低于则触发重试
 * @param {object} opts      { maxTokens, temperature, correction }
 * @returns {Promise<{text:string, retried:boolean, remedyCount:number}>}
 */
async function enforceRemedy(llmClient, model, messages, threshold, opts = {}) {
  const maxTokens = opts.maxTokens || 2048;
  const temperature = opts.temperature != null ? opts.temperature : 0.2;
  const correction =
    opts.correction ||
    '你的上一版解读缺少「宜/忌」类的趋避建议，算命先生的胆色不够。请严格按系统提示词的格式重写：每一段流年、每一路（事业/情感/健康/财运/感情/性格等）都必须是「第1句优势 → 第2句隐忧(点名具体数据特征) → 第3句破解」三步，且第3句必须以「宜……忌……」或「宜……不宜……」或「宜守……」这类字眼收尾。只输出重写的全文，不要任何解释或前后缀。';

  const resp = await llmClient.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  });
  let text = resp.choices[0].message.content;
  let retried = false;

  if (countRemedy(text) < threshold) {
    retried = true;
    try {
      const r2 = await llmClient.chat.completions.create({
        model,
        messages: [
          ...messages,
          { role: 'assistant', content: text },
          { role: 'user', content: correction }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      });
      const t2 = r2.choices[0].message.content;
      // 只有重试版也达标才采纳；否则保留首版（best effort）
      if (countRemedy(t2) >= threshold) text = t2;
    } catch (e) {
      // 重试失败则回退到首版，不影响主流程
    }
  }

  return { text, retried, remedyCount: countRemedy(text) };
}

module.exports = { enforceRemedy, countRemedy };
