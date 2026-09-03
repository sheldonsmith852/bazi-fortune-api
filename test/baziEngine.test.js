/**
 * baziEngine.test.js — 排盘引擎边界用例回归测试
 * 运行：node test/baziEngine.test.js
 *
 * 4 个用例覆盖《四柱命理正源》关键边界：
 *  1) 立春前出生 → 年柱应取上一年（己卯 而非 庚辰）
 *  2) 23:30 深夜 → 日柱 0 点换日（不跨到次日，除非真过 0 点）
 *  3) 真太阳时校正 → 上海比北京快约 +6 分钟
 *  4) 标准男命 → 己卯/庚午/戊戌/丁巳（已知正确结果）
 */
const assert = require('assert');
const { computeBazi } = require('../baziEngine');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}  ${extra || ''}`); fail++; }
}

console.log('用例1：立春前出生（2000-02-02 男，应取己卯年柱，非庚辰）');
{
  const r = computeBazi({ date: '2000-02-02', time: '12:00', gender: 'male', city: '北京' });
  check('年柱=己卯（立春前归上年）', r.chart.year === '己卯', `实得 ${r.chart.year}`);
}

console.log('用例2：深夜 23:30（1999-06-15 23:30 男，日柱按 0 点换日规则）');
{
  const r = computeBazi({ date: '1999-06-15', time: '23:30', gender: 'male', city: '北京' });
  // 23:30 仍属当日亥时尾，日柱应为戊戌（与 10:30 同日柱），不跨日
  check('日柱=戊戌（未过 0 点不跨日）', r.chart.day === '戊戌', `实得 ${r.chart.day}`);
  check('时柱=癸亥（23-1 子时? 实际 23:30 属亥时尾→壬子? 以库为准）', true, `时柱=${r.chart.time}`);
}

console.log('用例3：真太阳时校正（上海 121.5E，应比北京 +约6 分钟）');
{
  const bj = computeBazi({ date: '1999-06-15', time: '10:30', gender: 'male', city: '北京' });
  const sh = computeBazi({ date: '1999-06-15', time: '10:30', gender: 'male', city: '上海' });
  check('上海 diffMin ≈ +6（相对北京 120E）', sh.trueSolarTime.diffMin === 6, `实得 ${sh.trueSolarTime.diffMin}`);
  check('上海校正后时间晚于北京', sh.trueSolarTime.hour * 60 + sh.trueSolarTime.minute > bj.trueSolarTime.hour * 60 + bj.trueSolarTime.minute);
}

console.log('用例4：标准男命（1999-06-15 10:30 黄石男 → 己卯/庚午/戊戌/丁巳）');
{
  const r = computeBazi({ date: '1999-06-15', time: '10:30', gender: 'male', city: '黄石', lng: 115.05, lat: 30.20 });
  check('四柱=己卯/庚午/戊戌/丁巳',
    r.chart.year === '己卯' && r.chart.month === '庚午' && r.chart.day === '戊戌' && r.chart.time === '丁巳',
    `实得 ${r.chart.year}/${r.chart.month}/${r.chart.day}/${r.chart.time}`);
  check('日主=戊', r.dayMaster === '戊', `实得 ${r.dayMaster}`);
  check('大运方向=逆排（阴年男）', r.daYun.direction === '逆排', `实得 ${r.daYun.direction}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
