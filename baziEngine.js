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

function pad(n) { return String(n).padStart(2, '0'); }

// === 真太阳时 ===
function trueSolarTime(year, month, day, hour, minute, lng) {
  const diffMin = Math.round((lng - 120) * 4);
  let total = hour * 60 + minute + diffMin;
  let y = year, mo = month, d = day;
  while (total < 0) { total += 24 * 60; d -= 1; }
  while (total >= 24 * 60) { total -= 24 * 60; d += 1; }
  const h = Math.floor(total / 60);
  const mi = Math.round(total % 60);
  return { year: y, month: mo, day: d, hour: h, minute: mi, diffMin };
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

  return {
    input: { date: opts.date, time: opts.time, gender: opts.gender, city: opts.city || null, lng, lat },
    trueSolarTime: {
      ...tst,
      corrected: `${tst.year}-${pad(tst.month)}-${pad(tst.day)} ${pad(tst.hour)}:${pad(tst.minute)}`,
      note: `相对北京时（120E）${tst.diffMin >= 0 ? '+' : ''}${tst.diffMin} 分钟`
    },
    dayMaster: ec.getDayGan(),
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

module.exports = { computeBazi };
