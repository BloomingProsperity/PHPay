const PLAN_TIERS = new Set([
  'chatgptfreeplan',
  'chatgptplusplan',
  'chatgptgoplan',
  'chatgptprolite',
  'chatgptpro',
  'chatgptteamplan'
]);

export const PLAN_ALIASES = Object.freeze({
  chatgptplus: 'chatgptplusplan'
});

export function normalizePlanTier(value) {
  const plan = String(value || '').trim().toLowerCase();
  return Object.hasOwn(PLAN_ALIASES, plan) ? PLAN_ALIASES[plan] : (PLAN_TIERS.has(plan) ? plan : '');
}
