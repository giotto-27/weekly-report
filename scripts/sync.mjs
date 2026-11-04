import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeReports } from './report-data.mjs';
import { writeSnapshotIfChanged } from './sync-output.mjs';

const ROOT = process.cwd();
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const TOKEN = process.env.TENCENT_DOCS_TOKEN;
const MCP_URL = process.env.TENCENT_DOCS_MCP_URL || 'https://docs.qq.com/api/v6/sheet/mcp';

if (!TOKEN) {
  throw new Error('缺少 TENCENT_DOCS_TOKEN。请在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加。');
}

const DEADLINE = Date.now() + 180_000;
function remainingTime() {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) throw new Error('同步超过 3 分钟总时限，停止本次更新。');
  return Math.min(20_000, remaining);
}
function redacted(message) {
  return String(message).split(TOKEN).join('[redacted]').slice(0, 600);
}

let rpcId = 1;
let sessionId = '';
let protocolVersion = '2025-06-18';

function parseRpcPayload(raw, contentType, expectedId) {
  if (!raw.trim()) return null;
  if ((contentType || '').includes('text/event-stream') || raw.includes('\ndata:')) {
    const events = raw.split(/\r?\n\r?\n/);
    const payloads = [];
    for (const event of events) {
      const data = event.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try { payloads.push(JSON.parse(data)); } catch {}
    }
    if (expectedId != null) {
      const reply = payloads.find(x => x?.id === expectedId);
      if (!reply) throw new Error('MCP 事件流缺少对应请求的响应。');
      return reply;
    }
    return payloads.at(-1) || null;
  }
  const reply = JSON.parse(raw);
  if (expectedId != null && reply?.id !== expectedId) throw new Error('MCP 响应 ID 不匹配。');
  return reply;
}

async function postRpc(message, { allowEmpty = false } = {}) {
  const headers = {
    'Authorization': TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(remainingTime()),
  });

  const newSession = r.headers.get('mcp-session-id');
  if (newSession) sessionId = newSession;
  if (!r.ok) throw new Error(`腾讯文档 MCP HTTP ${r.status}：本次停止，不自动重试。`);
  const raw = await r.text();
  if (!raw.trim() && allowEmpty) return null;
  let payload;
  try {
    payload = parseRpcPayload(raw, r.headers.get('content-type'), message.id);
  } catch {
    throw new Error('MCP 响应格式异常或 ID 不匹配，本次停止。');
  }
  if (payload?.error) throw new Error(`腾讯文档 MCP 错误 ${payload.error.code ?? ''}: ${redacted(payload.error.message || JSON.stringify(payload.error))}`);
  if (message.id != null && (!payload || !Object.hasOwn(payload, 'result'))) throw new Error('MCP 响应缺少 result。');
  return payload;
}

async function initialize() {
  const id = rpcId++;
  const reply = await postRpc({
    jsonrpc: '2.0', id, method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'github-weekly-dashboard-sync', version: '1.1.0' }
    }
  });
  protocolVersion = reply.result?.protocolVersion || protocolVersion;
  await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, { allowEmpty: true });
}

async function rpc(method, params = {}) {
  const id = rpcId++;
  const reply = await postRpc({ jsonrpc: '2.0', id, method, params });
  return reply?.result;
}

async function listTools() {
  const all = [];
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    const result = await rpc('tools/list', cursor ? { cursor } : {});
    all.push(...(result?.tools || []));
    const next = result?.nextCursor ?? result?.next_cursor ?? '';
    if (!next || next === cursor) break;
    cursor = next;
  }
  return all;
}

function chooseTool(tools, kind) {
  const exactNames = kind === 'info'
    ? ['sheet.get_sheet_info', 'get_sheet_info', 'sheet.getsheetinfo', 'getsheetinfo']
    : ['sheet.get_cell_data', 'get_cell_data', 'sheet.get_sheet_range', 'get_sheet_range', 'sheet.getsheetrange', 'getsheetrange'];

  for (const wanted of exactNames) {
    const hit = tools.find(t => String(t.name).toLowerCase() === wanted);
    if (hit) return hit.name;
  }

  const available = tools.map(t => t.name).filter(n => /sheet/i.test(String(n))).join(', ');
  throw new Error(`没有识别到腾讯文档 ${kind === 'info' ? 'GetSheetInfo' : 'GetCellData'} 读取工具。当前与 sheet 相关工具：${available || '无'}`);
}

function unpackToolResult(result) {
  if (result == null) return result;
  if (result.structuredContent != null) return result.structuredContent;
  const texts = (result.content || []).filter(x => x?.type === 'text' && x.text).map(x => x.text.trim());
  for (const text of texts) {
    try { return JSON.parse(text); } catch {}
  }
  return texts.length === 1 ? texts[0] : result;
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`${name} 读取失败：${redacted(JSON.stringify(unpackToolResult(result)))}`);
  const payload = unpackToolResult(result);
  if (payload?.error) throw new Error(`${name}: ${redacted(JSON.stringify(payload.error))}`);
  return payload;
}

function getStyleMap(payload) {
  const cells = payload?.cells || payload?.data?.cells || payload?.styles || payload?.data?.styles || [];
  const map = new Map();
  if (!Array.isArray(cells)) return map;
  for (const cell of cells) {
    const row = Number(cell?.row);
    const col = Number(cell?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    map.set(`${row}:${col}`, {
      background_color: cell?.background_color ?? cell?.backgroundColor ?? ''
    });
  }
  return map;
}

function getSheets(payload) {
  const sheets = payload?.sheet_info?.sheets || payload?.sheetInfo?.sheets || payload?.sheets || [];
  if (!Array.isArray(sheets)) return [];
  return sheets.map(s => ({
    id: String(s.sheet_id ?? s.sheetId ?? s.id ?? ''),
    name: String(s.title ?? s.name ?? s.sheet_name ?? s.sheetName ?? '')
  })).filter(s => s.id && s.name);
}

function getValues(payload) {
  const candidates = [
    payload?.range_data?.values,
    payload?.rangeData?.values,
    payload?.values,
    payload?.data?.values,
  ];
  const matrix = candidates.find(Array.isArray);
  if (matrix) return matrix;

  const cells = payload?.cells || payload?.data?.cells || payload?.cell_data?.cells || payload?.cellData?.cells;
  if (!Array.isArray(cells)) return [];

  let maxRow = -1, maxCol = -1;
  for (const cell of cells) {
    maxRow = Math.max(maxRow, Number(cell?.row ?? -1));
    maxCol = Math.max(maxCol, Number(cell?.col ?? -1));
  }
  if (maxRow < 0 || maxCol < 0) return [];

  const rows = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(''));
  for (const cell of cells) {
    const r = Number(cell?.row);
    const col = Number(cell?.col);
    if (!Number.isInteger(r) || !Number.isInteger(col) || r < 0 || col < 0) continue;
    let value = '';
    if (cell?.string_value != null) value = cell.string_value;
    else if (cell?.stringValue != null) value = cell.stringValue;
    else if (cell?.number_value != null) value = cell.number_value;
    else if (cell?.numberValue != null) value = cell.numberValue;
    else if (cell?.bool_value != null) value = cell.bool_value;
    else if (cell?.boolValue != null) value = cell.boolValue;
    else if (cell?.value != null) value = cell.value;
    else if (cell?.formula != null) value = cell.formula;
    rows[r][col] = value;
  }
  return rows;
}

function columnToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function parseA1Range(range) {
  const m = String(range || 'A1:V450').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return { start_row: 0, start_col: 0, end_row: 449, end_col: 21 };
  return {
    start_row: Number(m[2]) - 1,
    start_col: columnToIndex(m[1]),
    end_row: Number(m[4]) - 1,
    end_col: columnToIndex(m[3]),
  };
}

function selectedSheet(sheet) {
  const include = Array.isArray(config.includeSheets) ? config.includeSheets : [];
  const exclude = Array.isArray(config.excludeSheets) ? config.excludeSheets : [];
  if (include.length && !include.includes(sheet.name) && !include.includes(sheet.id)) return false;
  if (exclude.includes(sheet.name) || exclude.includes(sheet.id)) return false;
  return true;
}

await initialize();
const tools = await listTools();
console.log('腾讯文档 sheet 工具：\n' + tools.filter(t => /sheet/i.test(String(t.name || ''))).map(t => `- ${t.name}: ${String(t.description || '').replace(/\\s+/g, ' ').slice(0, 160)}`).join('\\n'));
const infoTool = chooseTool(tools, 'info');
const rangeTool = chooseTool(tools, 'range');
const styleTool = tools.find(t => ['sheet.get_cell_style','get_cell_style'].includes(String(t.name).toLowerCase()))?.name || '';
if (!styleTool) throw new Error('没有发现考勤颜色读取工具，停止更新以保留现有考勤数据。');

console.log(`使用腾讯文档工具：${infoTool} / ${rangeTool}${styleTool ? ` / ${styleTool}` : ' / 未发现颜色读取工具'}`);
const info = await callTool(infoTool, { file_id: config.fileId });
const sheets = getSheets(info).filter(selectedSheet);
if (!sheets.length) throw new Error('没有读取到任何工作表。请检查文档权限，或检查 config.json 的 includeSheets/excludeSheets。');

const people = [];
for (const sheet of sheets) {
  console.log(`读取：${sheet.name} (${sheet.id})`);
  const payload = ['sheet.get_cell_data','get_cell_data'].includes(String(rangeTool).toLowerCase())
    ? await callTool(rangeTool, {
        file_id: config.fileId,
        sheet_id: sheet.id,
        ...parseA1Range(config.range || 'A1:V450'),
        return_csv: false
      })
    : await callTool(rangeTool, {
        file_id: config.fileId,
        sheet_id: sheet.id,
        range: config.range || 'A1:V450'
      });
  let styleMap = new Map();
  if (styleTool) {
    try {
      const full = parseA1Range(config.range || 'A1:V450');
      const stylePayload = await callTool(styleTool, {
        file_id: config.fileId,
        sheet_id: sheet.id,
        start_row: full.start_row,
        start_col: 4,
        end_row: full.end_row,
        end_col: 17
      });
      styleMap = getStyleMap(stylePayload);
    } catch (err) {
      throw new Error(`读取 ${sheet.name} 考勤颜色失败，停止更新并保留原数据：${redacted(err.message || err)}`);
    }
  }
  const weeks = normalizeReports(getValues(payload), styleMap, config.firstWeekYear);
  if (!weeks.length) throw new Error(`工作表 ${sheet.name} 没有有效周记录，停止更新并保留现有数据。`);
  people.push({ id: sheet.id, name: sheet.name, weeks });
}

const output = {
  source: 'Tencent Docs online spreadsheet',
  fileId: config.fileId,
  people
};

const changed = await writeSnapshotIfChanged(path.join(ROOT, 'data', 'data.json'), output);
console.log(changed
  ? `数据已更新：${people.length} 个工作表，${people.reduce((n,p)=>n+p.weeks.length,0)} 条周记录。`
  : '数据内容未变化：不写文件、不更新时间、不产生提交。');
