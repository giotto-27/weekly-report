import assert from 'node:assert/strict';
import test from 'node:test';
import { fillYears, fillMonthlyPlans, normalizeReports } from '../scripts/report-data.mjs';

function row(year, month, week, plan = '') {
  return [year, '', month, week, ...Array(14).fill(''), plan, '完成情况', '问题', '下周计划'];
}

test('fixed first year distinguishes the two October blocks and rolls over in January', () => {
  const weeks = normalizeReports([
    row('年份', '月份', '具体周', '月度计划'),
    row('', '十月', '10.06-10.12', '2025 十月计划'),
    row('', '', '10.13-10.19'),
    row('', '十二月', '12.29-01.04', '十二月计划'),
    row('', '一月', '01.05-01.11', '一月计划'),
    row('', '十月', '10.05-10.11', '2026 十月计划'),
    row('', '', '10.12-10.18'),
  ], new Map(), 2025);
  assert.deepEqual(weeks.map(w => w.year), ['2025', '2025', '2025', '2026', '2026', '2026']);
  assert.deepEqual(weeks.map(w => w.monthlyPlan), [
    '2025 十月计划', '2025 十月计划', '十二月计划', '一月计划', '2026 十月计划', '2026 十月计划',
  ]);
  assert.equal(weeks[1].completed, '完成情况');
  assert.equal(weeks[1].nextPlan, '下周计划');
});

test('explicit merged year overrides the configured fallback without leaking across New Year', () => {
  const weeks = normalizeReports([
    row('2025年', '十二月', '12.29-01.04'),
    row('', '一月', '01.05-01.11'),
    row('', '', '01.12-01.18'),
  ], new Map(), 2020);
  assert.deepEqual(weeks.map(w => w.year), ['2025', '2026', '2026']);
});

test('a later explicit year anchors preceding blank years', () => {
  assert.deepEqual(fillYears([
    {week:'12.29-01.04', year:''},
    {week:'01.05-01.11', year:'2026'},
  ], 2030).map(w => w.year), ['2025', '2026']);
});

test('missing and contradictory year anchors fail instead of guessing from today', () => {
  assert.throws(() => fillYears([{week:'10.06-10.12',year:''}]), /缺少确定的年份/);
  assert.throws(() => fillYears([
    {week:'12.29-01.04',year:'2025'},
    {week:'01.05-01.11',year:'2025'},
  ], 2025), /年份与周次顺序不一致/);
});

test('monthly filling never carries a previous month plan into an empty new month', () => {
  const input = [
    {year:'2025',month:'十月',monthlyPlan:'旧年计划'},
    {year:'2025',month:'十月',monthlyPlan:''},
    {year:'2025',month:'十一月',monthlyPlan:''},
    {year:'2026',month:'十月',monthlyPlan:''},
    {year:'2026',month:'十月',monthlyPlan:'新年计划'},
  ];
  const output = fillMonthlyPlans(input);
  assert.deepEqual(output.map(w => w.monthlyPlan), ['旧年计划','旧年计划','','新年计划','新年计划']);
  assert.equal(input[1].monthlyPlan, '');
});

test('cross-month weeks use the sheet month and preserve attendance and report fields', () => {
  const input = [row('', '十月', '10.06-10.12', '十月计划'), row('', '', '10.27-11.02')];
  input[1][4] = '出勤';
  const weeks = normalizeReports(input, new Map([['1:4',{background_color:'FF92D050'}]]), 2025);
  assert.equal(weeks[1].monthlyPlan, '十月计划');
  assert.equal(weeks[1].month, '十月');
  assert.equal(weeks[1].attendance[0], '出勤');
  assert.equal(weeks[1].attendanceColors[0], '#92D050');
  assert.equal(weeks[1].problems, '问题');
});
