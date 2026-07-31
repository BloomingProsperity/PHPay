// 批量地址解析，自动识别格式：
//   JSON 数组 / 单个 JSON 对象 / JSONL
//   地址|城市|州/省|邮编|国家（| 或制表符分隔，州/邮编可省略）
//   逗号分隔：地址, 城市, 州, 邮编, 国家（地址本身可含逗号，从右侧锚定解析）
//   带表头的 CSV（如 fullName,gender,phone,street,city,state,zip,…），列名自动映射，
//   州为两位代码且邮编为 5 位数字时国家自动补 US
const COL_MAP = [
  ['line1', /^(line1|address1?|addr1?|street|street_?address)$/i],
  ['city', /^city$/i],
  ['state', /^(state|province|region)$/i],
  ['zip', /^(zip|zip_?code|postal|postal_?code)$/i],
  ['country', /^(country|country_?code)$/i]
];

// CSV 字段切分（处理引号包裹、转义引号）
function splitCsv(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// 带表头 CSV：首行全是可识别列名（至少含地址与城市列）时按列映射解析
function tryParseCsv(lines) {
  if (lines.length < 2 || !lines[0].includes(',')) return null;
  const header = splitCsv(lines[0]);
  const map = new Map(); // 列号 -> 字段名
  header.forEach((h, idx) => {
    for (const [field, re] of COL_MAP) {
      if (re.test(h) && ![...map.values()].includes(field)) { map.set(idx, field); break; }
    }
  });
  const fields = [...map.values()];
  if (!fields.includes('line1') || !fields.includes('city')) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsv(lines[i]);
    const a = { line1: '', city: '', state: '', zip: '', country: '' };
    for (const [idx, field] of map) a[field] = cells[idx] || '';
    if (!a.country && /^[A-Z]{2}$/.test(a.state) && /^\d{5}(-\d{4})?$/.test(a.zip)) a.country = 'US';
    out.push(a);
  }
  return out;
}

function fromObj(j) {
  if (!j || typeof j !== 'object') return null;
  return {
    line1: String(j.line1 || j.address1 || j.street || '').trim(),
    city: String(j.city || '').trim(),
    state: String(j.state || j.province || j.region || '').trim(),
    zip: String(j.zip || j.postal || j.postal_code || j.postalCode || '').trim(),
    country: String(j.country || '').trim()
  };
}

// 从右侧锚定：国家 → 邮编（纯数字）→ [州] → 城市 → 剩余为地址
function parseDelimited(line, sep) {
  const parts = line.split(sep).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const country = parts.pop() || '';
  let zip = '', state = '', city = '';
  if (parts.length && /^\d{3,10}$/.test(parts[parts.length - 1])) zip = parts.pop();
  if (parts.length >= 3) { state = parts.pop(); city = parts.pop(); }
  else if (parts.length === 2) { city = parts.pop(); }
  const line1 = parts.join(sep === ',' ? ', ' : ' ').trim();
  return { line1, city, state, zip, country };
}

function parseLine(line) {
  line = line.trim();
  if (!line) return null;
  if (line.startsWith('{')) {
    try { return fromObj(JSON.parse(line)); } catch { /* 继续按分隔格式解析 */ }
  }
  for (const sep of ['|', '\t', ',']) {
    if (line.includes(sep)) return parseDelimited(line, sep);
  }
  return null;
}

export function validateAddress(addr) {
  if (!addr.line1) throw new Error('缺少地址（line1）');
  if (!addr.city) throw new Error('缺少城市');
  if (!addr.country) throw new Error('缺少国家');
  return { line1: addr.line1, city: addr.city, state: addr.state || '', zip: addr.zip || '', country: addr.country };
}

export function parseAddresses(text) {
  text = String(text || '').trim();
  if (!text) return [];
  // 整段 JSON（数组或单个对象）
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      return (Array.isArray(j) ? j : [j]).map(fromObj).filter(a => a && a.line1);
    } catch { /* 逐行解析 */ }
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  // 带表头的 CSV 文件
  const csv = tryParseCsv(lines);
  if (csv) return csv;
  return lines.map(parseLine).filter(a => a && (a.line1 || a.city));
}
