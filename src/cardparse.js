// 批量卡信息解析，自动识别格式：
//   JSON 数组 / 单个 JSON 对象 / JSONL
//   卡号|MM|YY|CVC|姓名      卡号|MM/YY|CVC|姓名
//   卡号:MM:YY:CVC(:姓名)     卡号,MM/YY,CVC(,姓名)
//   卡号 MM/YY CVC 姓名（卡号本身可带空格）
const FIRST_NAMES = ['James', 'John', 'Robert', 'Michael', 'David', 'Daniel', 'Chris', 'Kevin', 'Brian', 'Mark',
  'Maria', 'Anna', 'Julia', 'Sarah', 'Laura', 'Emma', 'Sofia', 'Lucia', 'Carmen', 'Rosa'];
const LAST_NAMES = ['Smith', 'Johnson', 'Brown', 'Garcia', 'Martinez', 'Lopez', 'Santos', 'Reyes', 'Cruz', 'Torres',
  'Ramos', 'Flores', 'Mendoza', 'Castillo', 'Morales', 'Aquino', 'Diaz', 'Navarro', 'Salazar', 'Mercado'];
export function randomName() {
  return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] + ' ' +
    LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
}

function fromObj(j) {
  if (!j || typeof j !== 'object') return null;
  const number = String(j.number || j.card_number || j.cardNumber || '').replace(/\D/g, '');
  let exp = String(j.exp || j.expiry || '').trim();
  if (!exp && (j.exp_month || j.expMonth)) exp = String(j.exp_month || j.expMonth) + '/' + String(j.exp_year || j.expYear || '');
  const cvc = String(j.cvc || j.cvv || '').replace(/\D/g, '');
  const name = String(j.name || j.holder || j.cardholder || '').trim();
  return { number, exp, cvc, name };
}

function parseLine(line) {
  line = line.trim();
  if (!line) return null;
  if (line.startsWith('{')) {
    try { return fromObj(JSON.parse(line)); } catch { /* 继续按分隔格式解析 */ }
  }
  // 显式分隔符格式：| : , 制表符
  for (const sep of ['|', ':', ',', '\t']) {
    if (!line.includes(sep)) continue;
    const parts = line.split(sep).map(s => s.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const number = parts[0].replace(/\D/g, '');
    let exp, cvc, name;
    if (/[\/\-]/.test(parts[1])) {
      exp = parts[1].replace('-', '/'); cvc = parts[2] || ''; name = parts.slice(3).join(' ');
    } else {
      exp = (parts[1] || '') + '/' + (parts[2] || ''); cvc = parts[3] || ''; name = parts.slice(4).join(' ');
    }
    return { number, exp, cvc: String(cvc).replace(/\D/g, ''), name };
  }
  // 空格格式：卡号（可含空格） MM/YY CVC 姓名
  // 先定位有效期，避免卡号正则将有效期数字吞入
  const em = line.match(/(\d{1,2})\s*[\/\-]\s*(\d{2,4})/);
  if (!em) return null;
  const number = line.slice(0, em.index).replace(/\D/g, '');
  if (number.length < 13 || number.length > 19) return null;
  const exp = em[1] + '/' + em[2];
  let rest = line.slice(em.index + em[0].length).trim();
  const cm = rest.match(/\d{3,4}/);
  const cvc = cm ? cm[0] : '';
  const name = (cm ? rest.replace(cm[0], ' ') : rest).replace(/\s+/g, ' ').trim();
  return { number, exp, cvc, name };
}

export function parseCards(text) {
  text = String(text || '').trim();
  if (!text) return [];
  // 整段 JSON（数组或单个对象）
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      return (Array.isArray(j) ? j : [j]).map(fromObj).filter(c => c && c.number);
    } catch { /* 逐行解析 */ }
  }
  return text.split(/\r?\n/).map(parseLine).filter(c => c && c.number);
}
