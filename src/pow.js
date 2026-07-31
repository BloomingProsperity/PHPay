// OpenAI Sentinel proof-of-work 求解（SHA3-512，参照 g4f proofofwork 公开实现）
// sentinel/req 返回 proofofwork: { required, seed, difficulty } 时本地求解，
// 以 openai-sentinel-proof-token 头随 approve 提交
import crypto from 'node:crypto';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

export function solvePow(seed, difficulty, userAgent) {
  const screen = pick([3008, 4010, 6000]) * pick([1, 2, 4]);
  const parseTime = new Date().toUTCString(); // 'Mon, 01 Jan 2026 00:00:00 GMT'
  const cfg = [
    screen,
    parseTime,
    null, 0, userAgent,
    'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js',
    'dpl=1440a687921de39ff5ee56b92807faaadce73f13',
    'en', 'en-US',
    null,
    '[object PluginArray]',
    pick(['_reactListeningcfilawjnerp', '_reactListening9ne2dfo1i47', '_reactListening410nzwhan2a']),
    pick(['alert', 'ontransitionend', 'onprogress'])
  ];
  const diffLen = difficulty.length;
  for (let i = 0; i < 1000000; i++) {
    cfg[3] = i;
    const base = Buffer.from(JSON.stringify(cfg)).toString('base64');
    const h = crypto.createHash('sha3-512').update(seed + base).digest('hex');
    if (h.slice(0, diffLen) <= difficulty) return 'gAAAAAB' + base;
  }
  return null;
}
