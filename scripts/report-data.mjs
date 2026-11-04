function scalar(v) {
  if (v == null) return '';
  if (['string', 'number', 'boolean'].includes(typeof v)) return String(v);
  if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    for (const k of ['formatted_value','formattedValue','display_value','displayValue','string_value','stringValue','number_value','numberValue','bool_value','boolValue','text','content','value','v']) {
      if (v[k] != null) return scalar(v[k]);
    }
  }
  return '';
}

function normalizeColor(raw) {
  let s = String(raw || '').trim().replace(/^#/, '').toUpperCase();
  if (!s) return '';
  if (s.length === 8) {
    const alpha = s.slice(0, 2);
    if (alpha === '00') return '';
    s = s.slice(2);
  }
  if (!/^[0-9A-F]{6}$/.test(s)) return '';
  if (s === 'FFFFFF') return '';
  return '#' + s;
}

export function normalizeWeeks(values, styleMap = new Map()) {
  if (!Array.isArray(values)) return [];
  let lastMonth = '';
  const weeks = [];
  for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
    const input = values[rowIndex];
    if (!Array.isArray(input)) continue;
    const row = input.map(scalar);
    while (row.length < 22) row.push('');
    const year = readYear(row[0]);
    const month = row[2].trim() || lastMonth;
    const week = row[3].trim();
    if (!week || /具体周|周次|week/i.test(week)) continue;
    if (month) lastMonth = month;

    const attendance = row.slice(4, 18).map(v => v.trim());
    const attendanceColors = Array.from({ length: 14 }, (_, i) =>
      normalizeColor(styleMap.get(`${rowIndex}:${i + 4}`)?.background_color)
    );
    const monthlyPlan = row[18].trim();
    const completed = row[19].trim();
    const problems = row[20].trim();
    const nextPlan = row[21].trim();
    if (!/[0-9]/.test(week) && !attendance.some(Boolean) && !attendanceColors.some(Boolean) && !monthlyPlan && !completed && !problems && !nextPlan) continue;
    weeks.push({ year, month, week, attendance, attendanceColors, monthlyPlan, completed, problems, nextPlan });
  }
  return weeks;
}


function parseWeekStart(week) {
  const m = String(week || '').trim().match(/^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  return { sm: Number(m[1]), sd: Number(m[2]), em: Number(m[3]), ed: Number(m[4]) };
}

function readYear(value) {
  const match = String(value ?? '').trim().match(/^([1-9]\d{3})(?:年)?$/);
  return match ? match[1] : '';
}

// Dates identify the order of years; explicit sheet years or a fixed starting year identify the calendar.
export function fillYears(weeks, firstWeekYear) {
  if (!weeks.length) return [];
  const offsets = [];
  let offset = 0, previous = null;
  for (const week of weeks) {
    const current = parseWeekStart(week.week);
    if (previous && current && current.sm < previous.sm) offset++;
    offsets.push(offset);
    if (current) previous = current;
  }

  let baseYear;
  for (let i = 0; i < weeks.length; i++) {
    const explicitYear = readYear(weeks[i].year);
    if (!explicitYear) continue;
    const candidate = Number(explicitYear) - offsets[i];
    if (baseYear != null && candidate !== baseYear) {
      throw new Error(`表格年份与周次顺序不一致：${weeks[i].week}（${explicitYear}年）。请检查 A 列年份。`);
    }
    baseYear = candidate;
  }
  if (baseYear == null) {
    const configured = readYear(firstWeekYear);
    if (!configured) throw new Error('缺少确定的年份：请填写表格 A 列，或设置 config.json 的 firstWeekYear。');
    baseYear = Number(configured);
  }
  return weeks.map((week, i) => ({ ...week, year: String(baseYear + offsets[i]) }));
}

// A monthly merged cell supplies one value for the weeks in that month block.
export function fillMonthlyPlans(weeks) {
  const result = weeks.map(week => ({ ...week }));
  let start = 0;
  while (start < result.length) {
    let end = start + 1;
    const first = result[start];
    while (end < result.length && result[end].year === first.year && result[end].month === first.month) end++;
    const plan = first.month && result.slice(start, end).find(week => String(week.monthlyPlan || '').trim())?.monthlyPlan;
    if (plan) {
      for (let i = start; i < end; i++) {
        if (!String(result[i].monthlyPlan || '').trim()) result[i].monthlyPlan = plan;
      }
    }
    start = end;
  }
  return result;
}

export function normalizeReports(values, styleMap, firstWeekYear) {
  return fillMonthlyPlans(fillYears(normalizeWeeks(values, styleMap), firstWeekYear));
}

