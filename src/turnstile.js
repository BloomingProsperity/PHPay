// OpenAI Sentinel Turnstile 令牌求解（纯软件 VM，参照 reverse-chatgpt/tunsile.py 公开实现）
// sentinel 返回 turnstile: { required, dx } 时：
//   1. dx 经 base64 解码后用密钥 p 做 XOR 解密 → 指令表 JSON
//   2. 用小型 VM 执行指令（模拟 window/performance/localStorage 等）
//   3. 产出 base64 令牌 → openai-sentinel-turnstile-token 头
// 密钥 p 是客户端自造的 requirement token（'gAAAAAC'+b64(config)），
// 请求 sentinel 时以 body {"p": p} 提交，服务端用它加密 dx，故可逆。

const START_TIME = Date.now();

function toStr(v) {
  if (v === null || v === undefined) return 'undefined';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(16)));
  if (typeof v === 'string') {
    const special = {
      'window.Math': '[object Math]',
      'window.Reflect': '[object Reflect]',
      'window.performance': '[object Performance]',
      'window.localStorage': '[object Storage]',
      'window.Object': 'function Object() { [native code] }',
      'window.Reflect.set': 'function set() { [native code] }',
      'window.performance.now': 'function () { [native code] }',
      'window.Object.create': 'function create() { [native code] }',
      'window.Object.keys': 'function keys() { [native code] }',
      'window.Math.random': 'function random() { [native code] }'
    };
    return special[v] !== undefined ? special[v] : v;
  }
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v.join(',');
  return String(v);
}

class OrderedMap {
  constructor() { this.map = new Map(); }
  add(k, v) { this.map.set(k, v); }
  toJSON() { return pyJson(Object.fromEntries(this.map)); }
  toString() { return this.toJSON(); }
}

// python json.dumps 风格（分隔符 ', ' / ': '，ensure_ascii）
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => pyJson(String(k)) + ': ' + pyJson(x)).join(', ') + '}';
}

function xorCrypt(text, p) {
  if (!p) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(text.charCodeAt(i) ^ p.charCodeAt(i % p.length));
  return out;
}

let FUNC_NAMES = new Map();

function getFuncMap(res, holder) {
  const pm = new Map();
  const get = k => (pm.has(k) ? pm.get(k) : null);
  const set = (k, v) => pm.set(k, v);

  set(1, (e, t) => {
    // python 版守卫 is not None 恒真（to_str(None)='undefined' 字符串）→ 始终执行
    const es = toStr(get(e)), ts = toStr(get(t));
    set(e, xorCrypt(es, ts));
  });
  set(2, (e, t) => set(e, t));
  set(3, (e) => {
    if (process.env.TS_DEBUG) console.error('func3 CALLED argType=' + typeof e + ' len=' + String(e).length);
    holder.res = Buffer.from(String(e)).toString('base64');
  });
  set(5, (e, t) => {
    const n = get(e), tres = get(t);
    if (n === null) { set(e, tres); return; }
    if (Array.isArray(n)) { set(e, tres !== null && tres !== undefined ? [...n, tres] : n); return; }
    if (typeof n === 'string' || typeof tres === 'string') set(e, toStr(n) + toStr(tres));
    else if (typeof n === 'number' && typeof tres === 'number') set(e, n + tres);
    else set(e, 'NaN');
  });
  set(6, (e, t, n) => {
    const tv = get(t), nv = get(n);
    if (typeof tv === 'string' && typeof nv === 'string') {
      const r = tv + '.' + nv;
      set(e, r === 'window.document.location' ? 'https://chatgpt.com/' : r);
    }
  });
  set(24, (e, t, n) => {
    const tv = get(t), nv = get(n);
    if (typeof tv === 'string' && typeof nv === 'string') set(e, tv + '.' + nv);
  });
  set(7, (e, ...args) => {
    const n = args.map(get), ev = get(e);
    if (typeof ev === 'string') {
      if (ev === 'window.Reflect.set') { const obj = n[0]; obj.add(String(n[1]), n[2]); }
    } else if (typeof ev === 'function') ev(...n);
  });
  set(17, (e, t, ...args) => {
    const i = args.map(get), tv = get(t);
    let r = null;
    if (typeof tv === 'string') {
      if (tv === 'window.performance.now') r = (performance.now() + Math.random());
      else if (tv === 'window.Object.create') r = new OrderedMap();
      else if (tv === 'window.Object.keys') {
        if (i[0] === 'window.localStorage') r = [
          'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4', 'STATSIG_LOCAL_STORAGE_STABLE_ID',
          'client-correlated-secret', 'oai/apps/capExpiresAt', 'oai-did',
          'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST', 'UiState.isNavigationCollapsed.1'
        ];
      } else if (tv === 'window.Math.random') r = Math.random();
    } else if (typeof tv === 'function') r = tv(...i);
    set(e, r);
  });
  set(8, (e, t) => set(e, get(t)));
  set(14, (e, t) => {
    const tv = get(t);
    if (typeof tv === 'string') { try { set(e, JSON.parse(tv)); } catch { set(e, null); } }
    else set(e, null);
  });
  set(15, (e, t) => set(e, pyJson(get(t))));
  set(18, (e) => set(e, Buffer.from(toStr(get(e)), 'base64').toString('utf8')));
  set(19, (e) => set(e, Buffer.from(toStr(get(e))).toString('base64')));
  set(20, (e, t, n, ...args) => {
    const o = args.map(get), ev = get(e), tv = get(t);
    if (ev === tv) { const nv = get(n); if (typeof nv === 'function') nv(...o); }
  });
  set(21, () => {});
  set(23, (e, t, ...args) => {
    // 参照实现：func_23 传原始寄存器号（不解析内容），被调函数自行读寄存器
    const ev = get(e), tv = get(t);
    if (ev !== null && typeof tv === 'function') tv(...args);
  });
  set(10, 'window');
  FUNC_NAMES = new Map();
  for (const [k, v] of pm) if (typeof v === 'function') FUNC_NAMES.set(v, 'func_' + k);
  return pm;
}

// dx: sentinel 返回的 turnstile.dx；p: XOR 密钥（不同流程为 requirement token / sentinel token）
export function processTurnstile(dxB64, p) {
  const dxText = Buffer.from(dxB64, 'base64').toString('utf8');
  const decrypted = xorCrypt(dxText, p);
  const tokenList = JSON.parse(decrypted);
  if (!Array.isArray(tokenList)) throw new Error('turnstile 解密结果不是指令表');
  const holder = { res: '' };
  const pm = getFuncMap(holder.res, holder);
  pm.set(9, tokenList);
  pm.set(16, p);
  for (const token of tokenList) {
    const e = token[0], t = token.slice(1);
    const f = pm.get(e);
    if (process.env.TS_DEBUG) {
      const fname = FUNC_NAMES.get(f) || (typeof f === 'string' ? 'str:' + f.slice(0, 20) : String(f));
      console.error('op', e, '->', fname, JSON.stringify(t).slice(0, 60));
    }
    if (typeof f === 'function') f(...t);
  }
  return holder.res;
}

// ---------- requirement token（dx 的 XOR 密钥，客户端自造） ----------
import crypto from 'node:crypto';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const CFG_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0';
const NAV_PROPS = {
  javaEnabled: false, getGamepads: [], requestMIDIAccess: {}, requestMediaKeySystemAccess: {},
  taintEnabled: false, permissions: {}, mimeTypes: { 0: {}, 1: {} },
  plugins: { 0: { 0: {}, 1: {} } }, pdfViewerEnabled: true, doNotTrack: 'unspecified',
  maxTouchPoints: 0, mediaCapabilities: {}, oscpu: 'Linux x86_64', vendor: '', vendorSub: '',
  productSub: '20100101', cookieEnabled: true, buildID: '20181001000000', mediaDevices: {},
  serviceWorker: {}, credentials: {}, clipboard: {}, mediaSession: {}, userActivation: {},
  wakeLock: {}, login: {}, globalPrivacyControl: false, webdriver: false, hardwareConcurrency: 12,
  geolocation: {}, appCodeName: 'Mozilla', appName: 'Netscape', appVersion: '5.0 (X11; Ubuntu)',
  platform: 'Linux x86_64', userAgent: CFG_UA, product: 'Gecko', language: 'en-US',
  languages: ['en-US', 'en'], locks: {}, onLine: true, storage: {}
};
const DOC_PROPS = ['location', '__reactContainer$5ljhyc0v315', '_reactListeningswdpv9r81m'];
const WIN_PROPS = ['close', 'stop', 'focus', 'blur', 'open', 'alert', 'confirm', 'prompt', 'print',
  'postMessage', 'getSelection', 'getComputedStyle', 'matchMedia', 'scroll', 'fetch', 'self', 'name',
  'history', 'customElements', 'locationbar', 'status', 'frames', 'opener', 'parent', 'navigator',
  'performance', 'devicePixelRatio', 'fullScreen', 'crypto', 'localStorage', 'origin', 'indexedDB',
  'sessionStorage', 'window', 'document', 'location', 'top', 'btoa', 'atob'];

function pyStr(v) { // 仿 python str() 风格（参考实现对齐用，宽松即可）
  if (v === false) return 'False';
  if (v === true) return 'True';
  if (Array.isArray(v)) return '[]';
  if (v && typeof v === 'object') return '{}';
  return String(v);
}

function formatWatTime() {
  const d = new Date(Date.now() + 3600e3); // WAT = UTC+1
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${wd} ${mo} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0100 (West Africa Standard Time)`;
}

// 生成 requirement token（'gAAAAAC' + b64(config)），作为 sentinel 请求的 p
export function requirementsToken(buildNo) {
  const t = Math.floor(Date.now() / 1000);
  const propKey = pick(Object.keys(NAV_PROPS));
  const cfg = [
    1760 + 990,
    formatWatTime(),
    null,
    Math.random(),
    CFG_UA,
    null,
    buildNo,
    'en-US',
    'en-US,en',
    Math.random(),
    `${propKey}-${pyStr(NAV_PROPS[propKey])}`,
    pick(DOC_PROPS),
    pick(WIN_PROPS),
    Math.floor(performance.now()),
    crypto.randomUUID(),
    '',
    12,
    t
  ];
  return 'gAAAAAC' + Buffer.from(JSON.stringify(cfg)).toString('base64');
}

// 从 chatgpt.com HTML 提取 data-build
export function extractBuildNo(html) {
  const m = String(html).match(/data-build="([^"]+)"/);
  return m ? m[1] : null;
}
