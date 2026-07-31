const CARD_HEADER_ALIASES = {
  number: ['number', 'card_number', 'cardnumber'],
  exp: ['exp', 'expiry'],
  expMonth: ['exp_month', 'expmonth'],
  expYear: ['exp_year', 'expyear'],
  cvc: ['cvc', 'cvv'],
  name: ['name', 'holder', 'cardholder']
};
const ADDRESS_HEADER_ALIASES = {
  line1: ['line1', 'address1', 'address', 'street'],
  city: ['city'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'postal', 'postal_code', 'postalcode'],
  country: ['country', 'country_code', 'countrycode']
};

const supported = {
  accounts: new Set(['json', 'txt']),
  cards: new Set(['json', 'csv', 'txt']),
  addresses: new Set(['json', 'csv', 'txt'])
};

export function parseResourceFile(kind, file) {
  const extension = extensionOf(file?.name || '');
  const text = String(file?.text || '');
  if (kind === 'accounts') {
    if (text.includes('\0')) return failure('binary account files are not supported');
    try { return validateRows(kind, parseAccountText(text)); }
    catch (error) { return failure(error.message || 'invalid file'); }
  }
  if (!supported[kind]?.has(extension)) return failure(`unsupported file type: ${extension || 'none'}`);
  try {
    const rows = parseRows(kind, extension, text);
    return validateRows(kind, rows);
  } catch (error) {
    return failure(error.message || 'invalid file');
  }
}

function extensionOf(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function failure(reason) {
  return { records: [], lines: [], errors: [{ line: null, reason }] };
}

function parseRows(kind, extension, text) {
  if (extension === 'json') return parseJsonRows(text);
  if (kind === 'accounts') return parseAccountText(text);
  if (extension === 'csv') return parseCsvRows(kind, text);
  return parsePipeRows(kind, text);
}

function parseJsonRows(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('expected JSON object or array');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((value, index) => ({ line: index + 1, value }));
}

function parseAccountText(text) {
  const jsonCandidates = extractJsonCandidates(text);
  const candidates = [
    ...jsonCandidates,
    ...extractNamedTokenCandidates(text, jsonCandidates),
    ...extractBearerCandidates(text, jsonCandidates),
    ...extractCookieCandidates(text, jsonCandidates),
    ...extractStandaloneTokenCandidates(text, jsonCandidates)
  ];
  const seen = new Set();
  const rows = [];
  for (const candidate of candidates.sort((a, b) => a.line - b.line)) {
    const token = candidate.value.accessToken || candidate.value.sessionToken;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    rows.push(candidate);
  }
  return rows.length ? rows : [{ line: 1, error: 'no recognizable account credential' }];
}

function extractJsonCandidates(text) {
  return jsonObjectSegments(text).flatMap(({ index, source }) => {
    try {
      const value = JSON.parse(source);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const accessToken = String(value.accessToken || '').trim();
      const sessionToken = String(value.sessionToken || '').trim();
      if (!accessToken && !sessionToken) return [];
      return [{
        line: lineOf(text, index),
        value: accountValue(
          accessToken || sessionToken,
          String(value.user?.email || value.email || '').trim(),
          Boolean(sessionToken && !accessToken),
          accessToken ? sessionToken : ''
        ),
        sourceStart: index,
        sourceEnd: index + source.length
      }];
    } catch {
      const accessToken = looseQuotedField(source, 'accessToken');
      const sessionToken = looseQuotedField(source, 'sessionToken');
      if (!accessToken && !sessionToken) return [];
      return [{
        line: lineOf(text, index),
        value: accountValue(
          accessToken || sessionToken,
          looseQuotedField(source, 'email').trim(),
          Boolean(sessionToken && !accessToken),
          accessToken ? sessionToken : ''
        ),
        sourceStart: index,
        sourceEnd: index + source.length
      }];
    }
  });
}

function extractNamedTokenCandidates(text, jsonCandidates = []) {
  const rows = [];
  const expression = /(?:^|[\s,{;])(?:["']?)(accessToken|sessionToken|__Secure-next-auth\.session-token)(?:["']?)\s*[:=]\s*(?:["']([\s\S]*?)["']|([^\s,;}]+))/gim;
  for (const match of text.matchAll(expression)) {
    if (insideParsedJson(match.index, jsonCandidates)) continue;
    const token = String(match[2] || match[3] || '').trim();
    if (!token) continue;
    const name = match[1].toLowerCase();
    const nameOffset = match[0].indexOf(match[1]);
    rows.push({ line: lineOf(text, match.index + nameOffset), value: accountValue(token, '', name !== 'accesstoken') });
  }
  return rows;
}

function extractBearerCandidates(text, jsonCandidates = []) {
  const rows = [];
  const expression = /authorization\s*:\s*bearer\s+([A-Za-z0-9._~-]+)/gi;
  for (const match of text.matchAll(expression)) {
    if (!insideParsedJson(match.index, jsonCandidates)) rows.push({ line: lineOf(text, match.index), value: accountValue(match[1]) });
  }
  return rows;
}

function extractCookieCandidates(text, jsonCandidates = []) {
  const rows = [];
  const expression = /__Secure-next-auth\.session-token\s*=\s*([A-Za-z0-9._~-]+)/gi;
  for (const match of text.matchAll(expression)) {
    if (!insideParsedJson(match.index, jsonCandidates)) rows.push({ line: lineOf(text, match.index), value: accountValue(match[1], '', true) });
  }
  return rows;
}

function extractStandaloneTokenCandidates(text, jsonCandidates = []) {
  const rows = [];
  const expression = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){2,4})(?![A-Za-z0-9_-])/g;
  for (const match of text.matchAll(expression)) {
    if (!insideParsedJson(match.index, jsonCandidates)) rows.push({ line: lineOf(text, match.index), value: accountValue(match[1], '', match[1].split('.').length - 1 === 4) });
  }
  return rows;
}

function insideParsedJson(index, candidates) {
  return candidates.some(candidate => index >= candidate.sourceStart && index < candidate.sourceEnd);
}

function looseQuotedField(source, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`["']${escaped}["']\\s*:\\s*["']([\\s\\S]*?)["']`, 'i').exec(source);
  return String(match?.[1] || '');
}

function jsonObjectSegments(text) {
  const segments = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === -1) { if (char === '{') { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { segments.push({ index: start, source: text.slice(start, index + 1) }); start = -1; }
  }
  return segments;
}

function accountValue(token, email = '', session = false, fallbackSessionToken = '') {
  if (session) return { sessionToken: token, user: { email } };
  return {
    accessToken: token,
    ...(fallbackSessionToken ? { sessionToken: fallbackSessionToken } : {}),
    user: { email }
  };
}

function lineOf(text, index) { return text.slice(0, index).split(/\r?\n/).length; }

function parsePipeRows(kind, text) {
  const rows = [];
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    if (!source.trim()) continue;
    const delimiter = kind === 'cards' && !source.includes('|')
      ? (source.includes('，') ? '，' : ',')
      : '|';
    const parts = source.split(delimiter).map(value => value.trim());
    if (kind === 'cards') {
      if (parts.length !== 3 && parts.length !== 4) rows.push({ line: index + 1, error: 'expected number|MM/YY|CVC|name' });
      else {
        const exp = /^\d{4}$/.test(parts[1]) ? `${parts[1].slice(0, 2)}/${parts[1].slice(2)}` : parts[1];
        rows.push({ line: index + 1, value: { number: parts[0], exp, cvc: parts[2], name: parts[3] || '' } });
      }
    } else if (parts.length !== 5) {
      rows.push({ line: index + 1, error: 'expected five fields' });
    } else {
      rows.push({ line: index + 1, value: { line1: parts[0], city: parts[1], state: parts[2], zip: parts[3], country: parts[4] } });
    }
  }
  return rows;
}

function parseCsvRows(kind, text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV must include a header and one data row');
  const mapping = headerMapping(rows[0], kind === 'cards' ? CARD_HEADER_ALIASES : ADDRESS_HEADER_ALIASES);
  const required = kind === 'cards' ? ['number', 'cvc'] : ['line1', 'city', 'state', 'zip', 'country'];
  if (kind === 'cards' && mapping.exp === undefined && !(mapping.expMonth !== undefined && mapping.expYear !== undefined)) required.push('exp');
  if (required.some(field => mapping[field] === undefined)) throw new Error('CSV header is missing required fields');
  return rows.slice(1).map((cells, index) => {
    const value = {};
    for (const [field, column] of Object.entries(mapping)) value[field] = cells[column] || '';
    if (kind === 'cards' && !value.exp) value.exp = `${value.expMonth || ''}/${value.expYear || ''}`;
    return { line: index + 2, value };
  });
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell.trim()); cell = ''; }
    else if (char === '\n') { row.push(cell.trim().replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell.length || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(rowValue => rowValue.some(Boolean));
}

function headerMapping(headers, aliases) {
  const map = {};
  headers.forEach((header, index) => {
    const normalized = String(header).trim().toLowerCase().replace(/[\s-]/g, '_');
    for (const [field, names] of Object.entries(aliases)) {
      if (names.includes(normalized) && map[field] === undefined) map[field] = index;
    }
  });
  return map;
}

function validateRows(kind, rows) {
  const records = []; const lines = []; const errors = [];
  for (const row of rows) {
    if (row.error) { errors.push({ line: row.line, reason: row.error }); continue; }
    try { records.push(normalize(kind, row.value)); lines.push(row.line); }
    catch (error) { errors.push({ line: row.line, reason: error.message || 'invalid record' }); }
  }
  return { records, lines, errors };
}

function normalize(kind, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('expected an object record');
  if (kind === 'accounts') return normalizeAccount(raw);
  if (kind === 'cards') return normalizeCard(raw);
  return normalizeAddress(raw);
}

function normalizeAccount(raw) {
  const accessToken = String(raw.accessToken || '').replace(/\s+/g, '').trim();
  const sessionToken = String(raw.sessionToken || '').replace(/\s+/g, '').trim();
  if (!accessToken && !sessionToken) throw new Error('missing supported account token');
  const email = String(raw.user?.email || raw.email || '').trim();
  const token = accessToken || sessionToken;
  if (!isRecognizableAccountToken(token, Boolean(sessionToken && !accessToken))) throw new Error('invalid account credential');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid account email');
  return accessToken
    ? { accessToken, ...(sessionToken ? { sessionToken } : {}), user: { email } }
    : { sessionToken, user: { email } };
}

function isRecognizableAccountToken(token, session) {
  const segments = token.split('.');
  if (
    segments.length >= 3
    && segments.length <= 5
    && /^eyJ[A-Za-z0-9_-]*$/.test(segments[0])
    && segments.slice(1).every(segment => /^[A-Za-z0-9_-]*$/.test(segment))
    && segments.at(-1).length > 0
  ) return true;
  return session && /^[A-Za-z0-9._~-]{24,4096}$/.test(token);
}

function normalizeCard(raw) {
  const rawNumber = String(raw.number || '').trim();
  const number = rawNumber.replace(/[ -]/g, '');
  const [month = '', rawYear = ''] = String(raw.exp || '').trim().split('/').map(value => value.trim());
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const cvc = String(raw.cvc || '').trim();
  if (!/^[0-9 -]+$/.test(rawNumber) || !/^\d{13,19}$/.test(number) || !isLuhnValid(number)) throw new Error('invalid card number');
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}(\d{2})?$/.test(rawYear)) throw new Error('invalid expiration');
  const current = new Date();
  if (year < current.getUTCFullYear() || (year === current.getUTCFullYear() && Number(month) < current.getUTCMonth() + 1)) throw new Error('expired card');
  if (!/^\d{3,4}$/.test(cvc)) throw new Error('invalid security code');
  return { number, exp: `${month}/${rawYear}`, cvc, name: String(raw.name || '').trim() };
}

function isLuhnValid(number) {
  let sum = 0; let doubleDigit = false;
  for (let index = number.length - 1; index >= 0; index--) {
    let digit = Number(number[index]);
    if (doubleDigit) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function normalizeAddress(raw) {
  const line1 = String(raw.line1 || '').trim();
  const city = String(raw.city || '').trim();
  const state = String(raw.state || '').trim();
  const zip = String(raw.zip || '').trim();
  const country = String(raw.country || '').trim().toUpperCase();
  if (!line1 || !city || !state || !zip || !country) throw new Error('missing required address fields');
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('invalid country');
  if (country === 'US' && !/^[A-Z]{2}$/.test(state)) throw new Error('invalid US state');
  return { line1, city, state, zip, country };
}
