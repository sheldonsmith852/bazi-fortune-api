#!/usr/bin/env node
/**
 * baziEngine.js — 八字排盘引擎（对齐《四柱命理正源》）
 *
 * 本文件是「服务器独立部署版」的排盘内核，由原 bazi.js 重构而来：
 *   - 逻辑（真太阳时 / 立春年柱 / 0点换日 / 大运方向修正）100% 沿用已验证版本
 *   - 对外导出 computeBazi(input) 供 Express 服务调用
 *   - 同时保留 CLI 入口：node baziEngine.js --date=... --time=... --gender=...
 *
 * 硬规定：
 *   - 真太阳时校正（经度每度 4 分钟）
 *   - 年柱以立春为界（用库 getYearInGanZhiByLiChun）
 *   - 日柱 0 点换日（库默认）
 *   - 大运方向：阳男/阴女顺排，阴男/阳女逆排（用 EightChar.getYun + 年干重判）
 */
const { Solar, Lunar } = require('lunar-javascript');

// === 城市 → 经度表（东经，度） ===
const CITY_LNG = {
  '北京': 116.4, '上海': 121.5, '广州': 113.3, '深圳': 114.1,
  '西安': 108.9, '成都': 104.1, '武汉': 114.3, '杭州': 120.2,
  '南京': 118.8, '重庆': 106.5, '天津': 117.2, '苏州': 120.6,
  '长沙': 112.9, '青岛': 120.4, '沈阳': 123.4, '大连': 121.6,
  '哈尔滨': 126.6, '长春': 125.3, '昆明': 102.7, '拉萨': 91.1,
  '乌鲁木齐': 87.6, '兰州': 103.8, '西宁': 101.8, '银川': 106.2,
  '呼和浩特': 111.7, '太原': 112.6, '济南': 117.0, '郑州': 113.6,
  '合肥': 117.3, '南昌': 115.9, '福州': 119.3, '厦门': 118.1,
  '海口': 110.3, '南宁': 108.4, '贵阳': 106.7,
  '香港': 114.2, '澳门': 113.5, '台北': 121.5,
  '黄石': 115.05 // 用户实测地点补充
};

const YANG_GAN = new Set(['甲', '丙', '戊', '庚', '壬']);

// === 五行 / 十神 / 旺衰基础表 ===
// 目的：把「数五行、找配偶星、判旺衰」这些推理步骤前移到引擎做确定性计算，
// 让 LLM 只负责翻译成大白话，避免小模型自行推算时把财星叫成官星一类的错误。
const GAN_INFO = {
  '甲': ['木', '阳'], '乙': ['木', '阴'],
  '丙': ['火', '阳'], '丁': ['火', '阴'],
  '戊': ['土', '阳'], '己': ['土', '阴'],
  '庚': ['金', '阳'], '辛': ['金', '阴'],
  '壬': ['水', '阳'], '癸': ['水', '阴']
};
const ZHI_WX = {
  '寅': '木', '卯': '木', '巳': '火', '午': '火',
  '申': '金', '酉': '金', '亥': '水', '子': '水',
  '辰': '土', '戌': '土', '丑': '土', '未': '土'
};
const WX_SHENG = { '木': '火', '火': '土', '土': '金', '金': '水', '水': '木' };
const WX_KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };
const PILLAR_NAME = { year: '年', month: '月', day: '日', time: '时' };
const HIDDEN_LEVEL = ['本气', '中气', '余气'];

/** 十神：以日主天干 dm 看目标天干 t（口径与库的 getXxxShiShenGan 一致，已用多组样例校验） */
function shiShenOf(dm, t) {
  if (!GAN_INFO[dm] || !GAN_INFO[t]) return '';
  if (dm === t) return '比肩';
  const [wA, yA] = GAN_INFO[dm];
  const [wB, yB] = GAN_INFO[t];
  const same = (yA === yB);
  if (wA === wB) return same ? '比肩' : '劫财';
  if (WX_SHENG[wA] === wB) return same ? '食神' : '伤官';
  if (WX_KE[wA] === wB) return same ? '偏财' : '正财';
  if (WX_SHENG[wB] === wA) return same ? '偏印' : '正印';
  if (WX_KE[wB] === wA) return same ? '七杀' : '正官';
  return '';
}

/** 五行个数：count=天干4字+地支五行4字；countWithHidden 再加全部藏干 */
function buildWuXing(chart, hidden) {
  const zero = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  const count = { ...zero };
  const countWithHidden = { ...zero };
  const detail = { gan: [], zhi: [], zhiWx: [] };
  ['year', 'month', 'day', 'time'].forEach(k => {
    const gan = chart[k][0], zhi = chart[k][1];
    detail.gan.push(gan); detail.zhi.push(zhi);
    count[GAN_INFO[gan][0]] += 1;
    countWithHidden[GAN_INFO[gan][0]] += 1;
    const zw = ZHI_WX[zhi];
    detail.zhiWx.push(zw);
    count[zw] += 1;
    (hidden[k] || []).forEach(hg => { countWithHidden[GAN_INFO[hg][0]] += 1; });
  });
  return {
    count, countWithHidden, detail,
    note: 'count=天干4字+地支五行4字（共8）；countWithHidden=天干4字+全部藏干。两种口径都不含纳音与旬空。'
  };
}

/** 配偶星：男命取财星（我克者），女命取官杀（克我者），并标出四柱天干与藏干落点 */
function buildSpouseStar(dm, gender, chart, hidden) {
  const isMale = (gender === 1);
  const mainStar = isMale ? '正财' : '正官';
  const secStar = isMale ? '偏财' : '七杀';
  const ganList = Object.keys(GAN_INFO);
  const mainGan = ganList.filter(g => shiShenOf(dm, g) === mainStar);
  const secGan = ganList.filter(g => shiShenOf(dm, g) === secStar);
  const hits = [];
  ['year', 'month', 'day', 'time'].forEach(k => {
    const gan = chart[k][0], zhi = chart[k][1];
    const ss = shiShenOf(dm, gan);
    if (ss === mainStar || ss === secStar) {
      hits.push({ pillar: PILLAR_NAME[k] + '干', gan, star: ss, level: '天干' });
    }
    (hidden[k] || []).forEach((hg, i) => {
      const s2 = shiShenOf(dm, hg);
      if (s2 === mainStar || s2 === secStar) {
        hits.push({ pillar: PILLAR_NAME[k] + '支', zhi, gan: hg, star: s2, level: HIDDEN_LEVEL[i] || '余气' });
      }
    });
  });
  const cnt = {};
  cnt[mainStar] = 0; cnt[secStar] = 0;
  hits.forEach(h => { cnt[h.star] = (cnt[h.star] || 0) + 1; });
  const hasMix = cnt[mainStar] > 0 && cnt[secStar] > 0;
  const where = hits.map(h =>
    `${h.pillar}${h.zhi ? '(' + h.zhi + ')' : ''}${h.level === '天干' ? '' : h.level}${h.gan}${h.star}`).join('、');
  const mixNote = hasMix
    ? `【${isMale ? '财星' : '官杀'}混杂：${mainStar}与${secStar}同时出现】`
    : `【不构成${isMale ? '财星' : '官杀'}混杂：${cnt[mainStar] > 0 ? '仅见' + mainStar : cnt[secStar] > 0 ? '仅见' + secStar : '两者皆无'}】`;
  return {
    gender: isMale ? '男命' : '女命',
    rule: isMale
      ? '男命以财星为妻星（我克者）：正财为正妻，偏财为偏缘／异性缘'
      : '女命以官杀为夫星（克我者）：正官为正夫，七杀为压力／偏缘',
    mainStar, mainGan, secStar, secGan, hits, count: cnt, hasMix,
    summary: hits.length
      ? `${isMale ? '妻星' : '夫星'}落点：${mainStar}（${mainGan.join('')}）${cnt[mainStar]} 处、` +
        `${secStar}（${secGan.join('')}）${cnt[secStar]} 处；明细：${where}。${mixNote}`
      : `四柱天干与藏干中均未见${mainStar}（${mainGan.join('')}）与${secStar}（${secGan.join('')}）`,
    note: '由引擎按日主天干与性别确定性推算；解读时请直接引用，不得另找星或改称，且 hasMix=false 时不得说"混杂"'
  };
}

/** 日主旺衰：得令（月令）／得地（四支根气）／得势（天干生扶），附简化评分 */
function buildStrength(dm, chart, hidden) {
  const wA = GAN_INFO[dm][0];
  const monthZhi = chart.month[1];
  const mw = ZHI_WX[monthZhi];
  let lingState, lingScore;
  if (mw === wA) { lingState = '旺（月令同五行）'; lingScore = 3; }
  else if (WX_SHENG[mw] === wA) { lingState = '相（月令生我）'; lingScore = 2; }
  else if (WX_SHENG[wA] === mw) { lingState = '休（我生月令）'; lingScore = 0; }
  else if (WX_KE[wA] === mw) { lingState = '囚（我克月令）'; lingScore = 0; }
  else { lingState = '死（月令克我）'; lingScore = 0; }

  const roots = [];
  ['year', 'month', 'day', 'time'].forEach(k => {
    const zhi = chart[k][1];
    (hidden[k] || []).forEach((hg, i) => {
      if (GAN_INFO[hg][0] === wA) {
        roots.push({ pillar: PILLAR_NAME[k] + '支', zhi, gan: hg, level: HIDDEN_LEVEL[i] || '余气' });
      }
    });
  });
  const helpers = [];
  ['year', 'month', 'time'].forEach(k => {
    const gan = chart[k][0];
    const ss = shiShenOf(dm, gan);
    if (['比肩', '劫财', '正印', '偏印'].indexOf(ss) >= 0) {
      helpers.push({ pillar: PILLAR_NAME[k] + '干', gan, star: ss });
    }
  });
  const diScore = roots.reduce((s, r) => s + (r.level === '本气' ? 2 : 1), 0);
  const shiScore = helpers.length;
  const score = lingScore + diScore + shiScore;
  const verdict = score >= 6 ? '偏强' : (score <= 3 ? '偏弱' : '中和');
  return {
    dayMaster: dm, dayMasterWx: wA,
    deLing: {
      value: lingScore > 0, monthZhi, monthWx: mw, state: lingState,
      note: `月令${monthZhi}（${mw}），日主${dm}（${wA}）：${lingState}`
    },
    deDi: {
      value: roots.length > 0, roots,
      note: roots.length
        ? '四支藏干中的日主根气：' + roots.map(r => `${r.pillar}${r.zhi}·${r.level}${r.gan}`).join('、')
        : '四支藏干中无日主同五行根气'
    },
    deShi: {
      value: shiScore > 0, helpers,
      note: shiScore
        ? '年／月／时干中的生扶：' + helpers.map(h => `${h.pillar}${h.gan}（${h.star}）`).join('、')
        : '年／月／时干中无比劫印绶生扶'
    },
    score, verdict,
    note: `得令(${lingScore}) + 得地(${diScore}) + 得势(${shiScore}) = ${score}；判定阈值 ≥6 偏强、≤3 偏弱、其余中和。此评分为本引擎简化模型，各流派权重不同，仅供参考。`
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

// === 真太阳时 ===
function trueSolarTime(year, month, day, hour, minute, lng) {
  const diffMin = Math.round((lng - 120) * 4);
  // 用 UTC 时间戳做日期算术：让 JS Date 自动处理跨日/跨月/跨年借位（不受时区与夏令时影响）
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const t = new Date(baseMs + diffMin * 60000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    diffMin
  };
}

function resolveLng(opts) {
  if (opts.lng != null) return parseFloat(opts.lng);
  const cityRaw = opts.city || '';
  const city = cityRaw.replace(/市$/, '');
  if (CITY_LNG[city] != null) return CITY_LNG[city];
  if (CITY_LNG[cityRaw] != null) return CITY_LNG[cityRaw];
  console.error(`# 警告：未识别城市 "${cityRaw}"，按北京(116.4E)兜底；如需精确请用 --lng=经度`);
  return 116.4;
}

/**
 * 计算八字命盘（纯函数，确定性输出）
 * @param {Object} input
 * @param {string} input.date  YYYY-MM-DD
 * @param {string} input.time  HH:MM
 * @param {string|number} input.gender 'male'|'female' 或 1|0
 * @param {string} [input.city]
 * @param {number|string} [input.lng]
 * @param {number|string} [input.lat]
 * @param {number|string} [input.now]  当前年（流年计算，默认今年）
 * @returns {Object} 命盘 JSON
 */
function computeBazi(input) {
  const opts = input || {};
  if (!opts.date || !opts.time || opts.gender == null) {
    throw new Error('缺少必填参数：date / time / gender');
  }
  const [Y, M, D] = String(opts.date).split('-').map(Number);
  const [h, m] = String(opts.time).split(':').map(Number);
  let gender;
  if (opts.gender === 'male' || opts.gender === 1) gender = 1;
  else if (opts.gender === 'female' || opts.gender === 0) gender = 0;
  else throw new Error('gender 必须是 male 或 female');

  const lng = resolveLng(opts);
  const lat = opts.lat != null ? parseFloat(opts.lat) : null;
  const nowYear = opts.now ? parseInt(opts.now, 10) : new Date().getFullYear();

  // 1) 真太阳时
  const tst = trueSolarTime(Y, M, D, h, m, lng);
  // 2) 构造 Solar
  const solar = Solar.fromYmdHms(tst.year, tst.month, tst.day, tst.hour, tst.minute, 0);
  const lu = solar.getLunar();
  const ec = lu.getEightChar();

  // 3) 四柱（年柱用 ByLiChun）
  const yearGZ = ec.getYear();
  const monthGZ = ec.getMonth();
  const dayGZ = ec.getDay();
  const timeGZ = ec.getTime();

  // 4) 十神 / 纳音 / 藏干 / 旬空
  const tenGods = {
    year: ec.getYearShiShenGan(),
    month: ec.getMonthShiShenGan(),
    day: ec.getDayShiShenGan(),
    time: ec.getTimeShiShenGan()
  };
  const naYin = {
    year: ec.getYearNaYin(),
    month: ec.getMonthNaYin(),
    day: ec.getDayNaYin(),
    time: ec.getTimeNaYin()
  };
  const hidden = {
    year: ec.getYearHideGan(),
    month: ec.getMonthHideGan(),
    day: ec.getDayHideGan(),
    time: ec.getTimeHideGan()
  };
  const xunKong = {
    year: ec.getYearXunKong(),
    month: ec.getMonthXunKong(),
    day: ec.getDayXunKong(),
    time: ec.getTimeXunKong()
  };

  // 5) 大运
  const yun = ec.getYun(gender);
  const libForward = yun.isForward();
  const correctedYearGan = ec.getYearGan();
  const isYangYear = YANG_GAN.has(correctedYearGan);
  const correctedForward = (gender === 1) ? isYangYear : !isYangYear;
  const startAgeYears = yun.getStartYear();
  const startAgeMonths = yun.getStartMonth();
  const startSolar = yun.getStartSolar();
  const daYunArr = yun.getDaYun(10);
  let dayunList = daYunArr.map(da => ({
    startYear: da.getStartYear(),
    endYear: da.getEndYear(),
    startAge: da.getStartAge(),
    endAge: da.getEndAge(),
    ganZhi: da.getGanZhi() || '童限（起运前）'
  })).filter(d => !d.ganZhi.includes('童限'));
  if (libForward !== correctedForward) {
    const reversed = dayunList.slice().reverse().map(d => d.ganZhi);
    dayunList = dayunList.map((d, i) => ({ ...d, ganZhi: reversed[i] }));
  }

  // 6) 当前流年（立春版年柱）
  let currentLiuNian = null;
  try {
    const lnSolar = Solar.fromYmd(nowYear, 6, 15);
    const lnLu = lnSolar.getLunar();
    const lnGZ = lnLu.getYearInGanZhiByLiChun();
    const lnGan = lnGZ[0];
    for (const dy of dayunList) {
      if (nowYear >= dy.startYear && nowYear <= dy.endYear) {
        currentLiuNian = { year: nowYear, ganZhi: lnGZ, yearGan: lnGan, inDayun: dy.ganZhi, age: nowYear - solar.getYear() + 1 };
        break;
      }
    }
    if (!currentLiuNian) {
      currentLiuNian = { year: nowYear, ganZhi: lnGZ, yearGan: lnGan, inDayun: null, age: nowYear - solar.getYear() + 1 };
    }
  } catch (e) { currentLiuNian = null; }

  // 7) 确定性衍生字段（五行个数 / 配偶星 / 日主旺衰）：由引擎算好，不让 LLM 自行推算
  const chartGZ = { year: yearGZ, month: monthGZ, day: dayGZ, time: timeGZ };
  const dmGan = ec.getDayGan();

  return {
    input: { date: opts.date, time: opts.time, gender: opts.gender, city: opts.city || null, lng, lat },
    trueSolarTime: {
      ...tst,
      corrected: `${tst.year}-${pad(tst.month)}-${pad(tst.day)} ${pad(tst.hour)}:${pad(tst.minute)}`,
      note: `相对北京时（120E）${tst.diffMin >= 0 ? '+' : ''}${tst.diffMin} 分钟`
    },
    dayMaster: dmGan,
    wuXing: buildWuXing(chartGZ, hidden),
    spouseStar: buildSpouseStar(dmGan, gender, chartGZ, hidden),
    strength: buildStrength(dmGan, chartGZ, hidden),
    chart: {
      year: yearGZ,
      month: monthGZ,
      day: dayGZ,
      time: timeGZ,
      note: '年柱按立春修正；月柱以节起算；日柱 0 点换日；时柱按日干取子时'
    },
    tenGods, naYin, hiddenGan: hidden, xunKong,
    daYun: {
      startAge: `${startAgeYears}岁${startAgeMonths}个月`,
      startAgeYears, startAgeMonths,
      direction: correctedForward ? '顺排' : '逆排',
      directionLib: libForward ? '顺排' : '逆排',
      directionNote: correctedForward !== libForward
        ? '因年干取立春修正值，方向已按书重判'
        : '与库一致',
      startSolar: `${startSolar.getYear()}-${pad(startSolar.getMonth())}-${pad(startSolar.getDay())}`,
      list: dayunList
    },
    currentLiuNian,
    disclaimer: '基于《四柱命理正源》方法论的八字排盘工具，结果仅供娱乐与文化研究参考。'
  };
}

// === CLI 入口 ===
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (const a of argv) {
    const mm = a.match(/^--([^=]+)=(.+)$/);
    if (mm) opts[mm[1]] = mm[2];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

if (require.main === module) {
  const opts = parseArgs();
  if (opts.help || !opts.date || !opts.time || !opts.gender) {
    console.error('用法: node baziEngine.js --date=YYYY-MM-DD --time=HH:MM --gender=male|female --city=城市名 [--lng=经度 --lat=纬度 --now=年]');
    process.exit(1);
  }
  try {
    const result = computeBazi(opts);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('排盘失败:', e.message);
    process.exit(1);
  }
}

module.exports = { computeBazi, shiShenOf, buildWuXing, buildSpouseStar, buildStrength, GAN_INFO, ZHI_WX };
