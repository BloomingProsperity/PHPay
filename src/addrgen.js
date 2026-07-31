// 美国免税州地址生成器（移植自 Adress 项目 js/generate.js，数据 vendored 在 data/ 下）
// L3：真实门牌池（开放数据）；池为空时回退 L2 合成街名
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'data');
const regions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'taxfree-regions.json'), 'utf-8'));
const l3Pack = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'l3-addresses.json'), 'utf-8'));

export const STATE_ORDER = ['DE', 'OR', 'NH', 'MT', 'AK'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function resolveStateCode(selected) {
  if (selected === 'ALL' || !selected) {
    const keys = STATE_ORDER.filter(c => regions.states[c]);
    return pick(keys.length ? keys : Object.keys(regions.states));
  }
  if (regions.states[selected]) return selected;
  return STATE_ORDER.find(c => regions.states[c]) || Object.keys(regions.states)[0];
}

function generateStreet() {
  const { prefixes, names, suffixes } = regions.streets;
  const streetName = [pick(prefixes), pick(names), pick(suffixes)].filter(Boolean).join(' ');
  return `${randInt(10, 9999)} ${streetName}`;
}

function generatePhone(areaCodes) {
  return `(${pick(areaCodes)}) 555-${String(randInt(1000, 9999)).padStart(4, '0')}`;
}

export function generateAddress(selectedState = 'ALL') {
  const code = resolveStateCode(selectedState);
  const st = regions.states[code];
  if (!st) throw new Error(`Unknown state: ${code}`);
  const gender = Math.random() < 0.5 ? 'male' : 'female';
  const fullName = `${pick(regions.firstNames[gender])} ${pick(regions.lastNames)}`;
  const phone = generatePhone(st.areaCodes);
  const pool = l3Pack?.addresses?.[code];
  let street, city, zip, level = 'L2';
  if (Array.isArray(pool) && pool.length) {
    const real = pick(pool);
    street = real.street; city = real.city; zip = real.zip; level = 'L3';
  } else {
    const place = pick(st.cities);
    street = generateStreet(); city = place.city; zip = pick(place.zips);
  }
  // dipay 地址库字段 + 附加信息（姓名可用于持卡人，电话备用）
  return {
    line1: street, city, state: code, zip, country: 'US',
    name: fullName, phone, level
  };
}

export function generateBatch(count, selectedState = 'ALL') {
  const n = Math.max(1, Math.min(5000, Math.floor(count) || 1));
  return Array.from({ length: n }, () => generateAddress(selectedState));
}
