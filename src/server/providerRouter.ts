import { type ApiCallOptions } from './geminiHandler';

export interface ProviderCandidate {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  isPrimary?: boolean;
}

// Runtime Health & Load Tracker per Provider (server-side)
export const inFlightCount: Record<string, number> = {};
export const cooldownUntil: Record<string, number> = {};
let generationCounter = 0;

export function incrementProviderInFlight(provider: string): void {
  const p = provider.toLowerCase();
  inFlightCount[p] = (inFlightCount[p] || 0) + 1;
}

export function decrementProviderInFlight(provider: string): void {
  const p = provider.toLowerCase();
  inFlightCount[p] = Math.max(0, (inFlightCount[p] || 1) - 1);
}

export function recordProviderErrorCooldown(provider: string, statusOrError: any): void {
  const p = provider.toLowerCase();
  const status =
    typeof statusOrError === 'number'
      ? statusOrError
      : statusOrError?.status || statusOrError?.statusCode || 0;
  const msg = String(statusOrError?.message || statusOrError || '').toLowerCase();

  if (
    status === 429 ||
    status === 503 ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('overloaded') ||
    msg.includes('resource_exhausted')
  ) {
    cooldownUntil[p] = Date.now() + 60_000;
  } else if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    msg.includes('invalid key') ||
    msg.includes('unauthorized') ||
    msg.includes('billing') ||
    msg.includes('insufficient')
  ) {
    cooldownUntil[p] = Date.now() + 10 * 60_000;
  }
}

export function clearProviderCooldown(provider: string): void {
  const p = provider.toLowerCase();
  cooldownUntil[p] = 0;
}

/**
 * Collects all configured provider API keys from headers, request options, and environment.
 */
export function collectAvailableProviders(options?: ApiCallOptions): ProviderCandidate[] {
  const opts = typeof options === 'string' ? { apiKey: options } : options || {};
  const map: Map<string, string> = new Map();

  // Check if client explicitly requested a single target provider (strictProvider or single-entry providerKeys)
  const explicitProvider = (opts.provider || '').trim().toLowerCase();
  const passedProviderKeys = (opts as any).providerKeys || (opts as any).availableKeys || {};
  const passedKeysEntries = Object.entries(passedProviderKeys).filter(
    ([_, v]) => typeof v === 'string' && v.trim().length > 0
  );
  const isStrictSingleProvider =
    Boolean((opts as any).strictProvider) ||
    (explicitProvider &&
      explicitProvider !== 'auto' &&
      passedKeysEntries.length === 1 &&
      passedKeysEntries[0][0].toLowerCase() === explicitProvider);

  if (isStrictSingleProvider && explicitProvider && explicitProvider !== 'auto') {
    const singleKey = (
      opts.apiKey ||
      (opts as any).customApiKey ||
      passedProviderKeys[explicitProvider] ||
      ''
    ).trim();
    if (singleKey) {
      return [
        {
          provider: explicitProvider,
          apiKey: singleKey,
          baseUrl: (opts as any).baseUrl,
          model: (opts as any).model,
          isPrimary: true,
        },
      ];
    }
  }

  // 1. Available keys dictionary from headers / config
  const availableKeys = { ...((opts as any).providerKeys || {}), ...((opts as any).availableKeys || {}) };
  for (const [p, k] of Object.entries(availableKeys)) {
    if (typeof k === 'string' && k.trim()) {
      map.set(p.toLowerCase(), k.trim());
    }
  }

  // 2. Specific keys passed in options
  const KNOWN = ['gemini', 'groq', 'openai', 'anthropic', 'openrouter', 'nvidia', 'deepseek', 'xai'];
  for (const p of KNOWN) {
    const k = (opts as any)[`${p}Key`] || (opts as any)[`${p}ApiKey`];
    if (typeof k === 'string' && k.trim() && !map.has(p)) {
      map.set(p, k.trim());
    }
  }

  // 3. Primary apiKey in options (infer provider if auto/gemini)
  const customApiKey = (opts.apiKey || '').trim();
  let primaryProvider = (opts.provider || 'auto').toLowerCase();
  if (customApiKey) {
    let p = primaryProvider;
    if (p === 'auto' || p === 'gemini') {
      if (/^(AIza|AQ)/i.test(customApiKey)) p = 'gemini';
      else if (/^gsk_/.test(customApiKey)) p = 'groq';
      else if (/^sk-or-/i.test(customApiKey)) p = 'openrouter';
      else if (/^nvapi-/i.test(customApiKey)) p = 'nvidia';
      else if (/^sk-ant-/i.test(customApiKey)) p = 'anthropic';
      else if (/^sk-/.test(customApiKey)) p = 'openai';
      else if (/^xai-/.test(customApiKey)) p = 'xai';
      else if (/^ds-/.test(customApiKey)) p = 'deepseek';
      else p = 'gemini';
    }
    primaryProvider = p;
    if (!map.has(p)) {
      map.set(p, customApiKey);
    }
  }

  // 4. Server environment variables (only when client did not pass any explicit BYOK keys)
  if (
    map.size === 0 &&
    (process.env.ALLOW_SERVER_ENV_KEYS === 'true' || process.env.NODE_ENV !== 'production')
  ) {
    if (!map.has('gemini') && process.env.GEMINI_API_KEY) {
      map.set('gemini', process.env.GEMINI_API_KEY.trim());
    }
    if (!map.has('groq') && process.env.GROQ_API_KEY) {
      map.set('groq', process.env.GROQ_API_KEY.trim());
    }
    if (!map.has('openai') && process.env.OPENAI_API_KEY) {
      map.set('openai', process.env.OPENAI_API_KEY.trim());
    }
    if (!map.has('anthropic') && process.env.ANTHROPIC_API_KEY) {
      map.set('anthropic', process.env.ANTHROPIC_API_KEY.trim());
    }
    if (!map.has('openrouter') && process.env.OPENROUTER_API_KEY) {
      map.set('openrouter', process.env.OPENROUTER_API_KEY.trim());
    }
    if (!map.has('nvidia') && process.env.NVIDIA_API_KEY) {
      map.set('nvidia', process.env.NVIDIA_API_KEY.trim());
    }
    if (!map.has('deepseek') && process.env.DEEPSEEK_API_KEY) {
      map.set('deepseek', process.env.DEEPSEEK_API_KEY.trim());
    }
    if (!map.has('xai') && process.env.XAI_API_KEY) {
      map.set('xai', process.env.XAI_API_KEY.trim());
    }
  }

  const isAutoSingle = map.size === 1 && (!opts.provider || opts.provider.toLowerCase() === 'auto');

  return Array.from(map.entries()).map(([provider, apiKey]) => {
    const isPrimary = provider === primaryProvider || isAutoSingle;
    return {
      provider,
      apiKey,
      baseUrl: isPrimary ? (opts as any).baseUrl : undefined,
      model: isPrimary ? (opts as any).model : undefined,
      isPrimary,
    };
  });
}

function partitionByCooldown(candidates: ProviderCandidate[]): {
  healthy: ProviderCandidate[];
  cooledDown: ProviderCandidate[];
} {
  const now = Date.now();
  const allInCooldown = candidates.length > 0 && candidates.every((c) => now < (cooldownUntil[c.provider] || 0));
  if (allInCooldown) {
    let minC = candidates[0];
    let minUntil = cooldownUntil[minC.provider] || Infinity;
    for (const c of candidates) {
      if ((cooldownUntil[c.provider] || 0) < minUntil) {
        minUntil = cooldownUntil[c.provider] || 0;
        minC = c;
      }
    }
    cooldownUntil[minC.provider] = 0;
  }

  const healthy = candidates.filter((c) => Date.now() >= (cooldownUntil[c.provider] || 0));
  const cooledDown = candidates.filter((c) => Date.now() < (cooldownUntil[c.provider] || 0));
  return { healthy, cooledDown };
}

/**
 * Task Specialization for Evaluation (Grading): Needs high reasoning first, respecting cooldowns & idle load.
 */
export function prioritizeForEvaluation(candidates: ProviderCandidate[]): ProviderCandidate[] {
  if (candidates.length <= 1) return candidates;
  const EVAL_ORDER = ['gemini', 'openai', 'anthropic', 'openrouter', 'groq', 'nvidia', 'deepseek', 'xai'];
  const { healthy, cooledDown } = partitionByCooldown(candidates);

  const sortFn = (a: ProviderCandidate, b: ProviderCandidate) => {
    const loadA = inFlightCount[a.provider] || 0;
    const loadB = inFlightCount[b.provider] || 0;
    if (loadA !== loadB) return loadA - loadB;
    const idxA = EVAL_ORDER.indexOf(a.provider);
    const idxB = EVAL_ORDER.indexOf(b.provider);
    const scoreA = idxA === -1 ? 99 : idxA;
    const scoreB = idxB === -1 ? 99 : idxB;
    return scoreA - scoreB;
  };

  return [...healthy.sort(sortFn), ...cooledDown.sort(sortFn)];
}

/**
 * Task Specialization for Question Generation:
 * - Healthy providers first (cooled-down keys placed at the end as last resort).
 * - Lowest inFlightCount first (idle keys with 0 in-flight requests always picked immediately).
 * - Explicit primary provider (if idle) prioritized, with round-robin tie-breaking across equally idle keys.
 */
export function prioritizeForGeneration(candidates: ProviderCandidate[]): ProviderCandidate[] {
  if (candidates.length <= 1) return candidates;
  const { healthy, cooledDown } = partitionByCooldown(candidates);
  const n = candidates.length;
  const startIdx = generationCounter % n;
  generationCounter = (generationCounter + 1) % 10000;

  const sortHealthy = (a: ProviderCandidate, b: ProviderCandidate) => {
    const loadA = inFlightCount[a.provider] || 0;
    const loadB = inFlightCount[b.provider] || 0;
    if (loadA !== loadB) return loadA - loadB;

    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;

    const idxA = (candidates.indexOf(a) - startIdx + n) % n;
    const idxB = (candidates.indexOf(b) - startIdx + n) % n;
    return idxA - idxB;
  };

  return [...healthy.sort(sortHealthy), ...cooledDown];
}
