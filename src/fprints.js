// TLS 指纹库：全部为对 chatgpt.com checkout 接口实测可通过 Cloudflare 的指纹
// （chrome119+ 系在 CF 严格期必被拦，chrome131 不进主轮换，仅作 curl_cffi 兜底）
export const IMPS = [
  'edge99', 'edge101',
  'safari15_3', 'safari15_5', 'safari17_0', 'safari18_0',
  'safari17_2_ios', 'safari18_0_ios',
  'chrome99_android',
  'chrome99', 'chrome100', 'chrome101', 'chrome104', 'chrome107', 'chrome110', 'chrome116'
];
// 默认指纹：实测通过率最高的 edge99
export const DEFAULT_IMPERSONATION = IMPS[0];
// curl_cffi 不支持或异常时的最后兜底
export const FALLBACK_IMPERSONATION = 'chrome131';
