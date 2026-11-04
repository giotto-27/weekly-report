import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.people) || !snapshot.people.length) {
    throw new Error('同步结果没有人员数据，保留现有文件。');
  }
  const ids = new Set();
  for (const person of snapshot.people) {
    if (!person || typeof person.id !== 'string' || !person.id || ids.has(person.id) ||
        typeof person.name !== 'string' || !person.name.trim() ||
        !Array.isArray(person.weeks) || !person.weeks.length) {
      throw new Error('同步结果包含无效、重复或没有周记录的人员，保留现有文件。');
    }
    ids.add(person.id);
    for (const week of person.weeks) {
      if (!/^\d{4}$/.test(week.year) || typeof week.week !== 'string' || !week.week ||
          !Array.isArray(week.attendance) || week.attendance.length !== 14 ||
          !Array.isArray(week.attendanceColors) || week.attendanceColors.length !== 14) {
        throw new Error('同步结果包含无效周记录，保留现有文件。');
      }
    }
  }
}

// syncedAt records when the published content last changed, not each polling attempt.
export async function writeSnapshotIfChanged(filePath, content, now = () => new Date().toISOString()) {
  validateSnapshot(content);
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('现有 data.json 无法读取或解析，保留文件并停止更新。');
  }
  if (previous) {
    const { syncedAt, ...previousContent } = previous;
    if (isDeepStrictEqual(previousContent, content)) return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  let created = false;
  try {
    const handle = await fs.open(temporaryPath, 'wx');
    created = true;
    try {
      await handle.writeFile(JSON.stringify({ ...content, syncedAt: now() }, null, 2) + '\n', 'utf8');
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
    return true;
  } finally {
    if (created) await fs.unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
