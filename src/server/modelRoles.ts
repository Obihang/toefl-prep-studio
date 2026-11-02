import { GENERATION_MODELS, EVALUATION_MODELS } from '../config/models';

export interface ModelChainsResult {
  generation: string[];
  evaluation: string[];
  tts: string[];
  stt: string[];
  all: string[];
}

export interface RoleModelsResult {
  chat: string[];
  stt: string[];
  tts: string[];
  all: string[];
  generationModel: string;
  evaluationModel: string;
}

const DROP_PATTERN = /embed|whisper|tts|speech|guard|moderat|rerank|vision|image|audio|transcri|safety|ocr|parse|clip|diffusion|stable|flux|\bvl\b|-vl-|reward|retriev|orpheus|playai|moderation/i;
const REASONING_PATTERN = /r1\b|reason|thinking|qwq|o1|o3/i;
const CHAT_EXCLUDE_PATTERN = /deep-research|computer-use|robotics|omni|agent|argon|aqa|learnlm|thinking-exp|\bexp-/i;

// Dead model cache (24 hours)
const deadModelsCache = new Map<string, number>();

export function isModelDead(modelId: string): boolean {
  const expires = deadModelsCache.get(modelId);
  if (!expires) return false;
  if (Date.now() > expires) {
    deadModelsCache.delete(modelId);
    return false;
  }
  return true;
}

export function markModelDead(modelId: string): void {
  deadModelsCache.set(modelId, Date.now() + 24 * 3600 * 1000);
}

export function clearDeadModels(): void {
  deadModelsCache.clear();
}

/**
 * Universal helper to check if a model error indicates the model is retired, not found, or gone.
 * Returns true for HTTP 404, 410, and error messages matching dead model patterns.
 */
export function isModelGone(status?: number, message?: string): boolean {
  if (status === 404 || status === 410) {
    return true;
  }
  if (!message) return false;
  return /not found|does not exist|no access|retired|end of life|deprecated|gone|no endpoints/i.test(message);
}

// Track last list error per provider to report descriptive errors if chain is empty
const lastListErrors = new Map<string, { status: number; message: string }>();

export function getLastListError(provider: string): { status: number; message: string } | null {
  return lastListErrors.get(provider.toLowerCase()) || null;
}

export function setLastListError(provider: string, err: { status: number; message: string }): void {
  lastListErrors.set(provider.toLowerCase(), err);
}

function hashKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return `k${hash}_len${key.length}`;
}

const roleChainsCache = new Map<string, { data: ModelChainsResult; expiresAt: number }>();

export function clearModelChainsCache(): void {
  roleChainsCache.clear();
}

/**
 * Scoring for Gemini models:
 * Tier 1 = stable GA IDs matching /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)$/
 * Tier 2 = "-latest" aliases (gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest)
 * Tier 3 = preview models (matching /^gemini-(\d+(?:\.\d+)?)/ with "preview" or "exp")
 * Generation prefers flash-lite, then flash; evaluation prefers pro or newest non-lite flash.
 * Within a tier, pick the highest version.
 */
function scoreGeminiModel(id: string, role: 'generation' | 'evaluation'): number {
  const lower = id.toLowerCase();

  // Tier 1: Stable GA IDs matching /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)$/
  const gaMatch = lower.match(/^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)$/);
  if (gaMatch) {
    const version = parseFloat(gaMatch[1]);
    const kind = gaMatch[2];
    let score = 100000 + version * 1000;
    if (role === 'generation') {
      if (kind === 'flash-lite') score += 500;
      else if (kind === 'flash') score += 200;
      else if (kind === 'pro') score += 50;
    } else {
      // Evaluation prefers pro or the newest non-lite flash
      if (kind === 'pro') score += 500;
      else if (kind === 'flash') score += 300;
      else if (kind === 'flash-lite') score += 50;
    }
    return score;
  }

  // Tier 2: The "-latest" aliases (gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest)
  const latestMatch = lower.match(/^gemini-(?:(\d+(?:\.\d+)?)-)?(flash-lite|flash|pro)-latest$/);
  if (latestMatch) {
    const version = latestMatch[1] ? parseFloat(latestMatch[1]) : 2.5;
    const kind = latestMatch[2];
    let score = 50000 + version * 1000;
    if (role === 'generation') {
      if (kind === 'flash-lite') score += 500;
      else if (kind === 'flash') score += 200;
      else if (kind === 'pro') score += 50;
    } else {
      if (kind === 'pro') score += 500;
      else if (kind === 'flash') score += 300;
      else if (kind === 'flash-lite') score += 50;
    }
    return score;
  }

  // Tier 3: Preview models
  if (/preview|exp/i.test(lower) && /^gemini-/i.test(lower)) {
    const verMatch = lower.match(/^gemini-(\d+(?:\.\d+)?)/);
    const version = verMatch ? parseFloat(verMatch[1]) : 1.0;
    let score = 10000 + version * 1000;
    if (role === 'generation') {
      if (/flash-lite/i.test(lower)) score += 500;
      else if (/flash/i.test(lower)) score += 200;
      else if (/pro/i.test(lower)) score += 50;
    } else {
      if (/pro/i.test(lower)) score += 500;
      else if (/flash\b(?!-lite)/i.test(lower)) score += 300;
      else if (/flash-lite/i.test(lower)) score += 50;
    }
    return score;
  }

  // Any other valid gemini- prefixed model
  if (/^gemini-/i.test(lower)) {
    const verMatch = lower.match(/^gemini-(\d+(?:\.\d+)?)/);
    const version = verMatch ? parseFloat(verMatch[1]) : 1.0;
    return 1000 + version * 100;
  }

  return -10000;
}

export const MODEL_ROLES: Record<
  string,
  {
    generator: string[];
    evaluator: string[];
  }
> = {
  gemini: {
    generator: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    evaluator: ['gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  groq: {
    generator: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ],
    evaluator: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'llama-3.1-8b-instant',
    ],
  },
  nvidia: {
    generator: [
      'meta/llama-3.3-70b-instruct',
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'qwen/qwen2.5-72b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    ],
    evaluator: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'meta/llama-3.1-70b-instruct',
    ],
  },
  openrouter: {
    generator: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemini-2.0-flash-exp:free',
      'deepseek/deepseek-chat:free',
      'qwen/qwen-2.5-72b-instruct:free',
      'meta-llama/llama-3.1-8b-instruct:free',
    ],
    evaluator: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-chat:free',
      'google/gemini-2.0-flash-exp:free',
    ],
  },
  openai: {
    generator: GENERATION_MODELS.openai,
    evaluator: EVALUATION_MODELS.openai,
  },
  deepseek: {
    generator: GENERATION_MODELS.deepseek,
    evaluator: EVALUATION_MODELS.deepseek,
  },
  xai: {
    generator: GENERATION_MODELS.xai,
    evaluator: EVALUATION_MODELS.xai,
  },
  anthropic: {
    generator: GENERATION_MODELS.anthropic,
    evaluator: EVALUATION_MODELS.anthropic,
  },
};

function scoreNonGeminiModel(id: string, role: 'generation' | 'evaluation', provider: string = ''): number {
  const lower = id.toLowerCase();
  const p = provider.toLowerCase();

  // Prioritize verified production models in MODEL_ROLES in their exact configured order
  const configuredRoleList =
    role === 'generation' ? MODEL_ROLES[p]?.generator : MODEL_ROLES[p]?.evaluator;
  if (configuredRoleList) {
    const exactIdx = configuredRoleList.findIndex((m) => m.toLowerCase() === lower);
    if (exactIdx !== -1) {
      return 100000 - exactIdx * 1000;
    }
  }

  let familyScore = 0;

  if (/llama/i.test(lower) && !/nemotron/i.test(lower)) {
    familyScore = 70000;
    // Llama version order: 3.3, 3.1, 4, 3.2
    if (/llama-?3\.3/i.test(lower)) {
      familyScore += 5000;
    } else if (/llama-?3\.1/i.test(lower)) {
      familyScore += 3000;
    } else if (/llama-?4/i.test(lower)) {
      familyScore += 2000;
    } else if (/llama-?3\.2/i.test(lower)) {
      familyScore += 1000;
    }
  } else if (/gpt-oss/i.test(lower)) {
    familyScore = 60000;
  } else if (/qwen/i.test(lower)) {
    familyScore = 50000;
    if (/qwen-?2\.5/i.test(lower)) familyScore += 2000;
    else if (/qwen-?3(?:\.6)?/i.test(lower)) familyScore += 1000;
  } else if (/deepseek/i.test(lower)) {
    familyScore = 40000;
    if (REASONING_PATTERN.test(lower)) {
      familyScore -= 10000; // Reasoning models rank last among chat models
    }
  } else if (/nemotron/i.test(lower)) {
    familyScore = 35000;
  } else if (/mistral|mixtral/i.test(lower)) {
    familyScore = 20000;
  } else if (/gemma/i.test(lower)) {
    familyScore = 10000;
  } else {
    familyScore = 1000;
  }

  if (role === 'generation') {
    if (/70b-versatile|70b-instruct/i.test(lower)) {
      familyScore += 600;
    } else if (/8b|20b|mini|small|3b|7b/i.test(lower)) {
      familyScore += 400;
    } else if (/70b|120b|large/i.test(lower)) {
      familyScore += 200;
    }
  } else {
    if (/120b|70b|72b|large|pro/i.test(lower)) {
      familyScore += 500;
    } else if (/8b|20b|mini|small|3b|7b/i.test(lower)) {
      familyScore += 100;
    }
  }

  return familyScore;
}

export function scoreModelForRole(id: string, role: 'generation' | 'evaluation', provider: string): number {
  if (isModelDead(id)) return -99999;
  const p = (provider || '').toLowerCase();
  const lower = id.toLowerCase();

  // Exclude audio / embedding models
  if (DROP_PATTERN.test(lower)) return -10000;

  // Exclude non-chat / codenames
  if (CHAT_EXCLUDE_PATTERN.test(lower)) {
    return -10000;
  }

  if (p === 'gemini') {
    // On Gemini, gemma models and non-gemini codenames are excluded from chat
    if (/gemma/i.test(lower) || !/^gemini-/i.test(lower)) {
      return -10000;
    }
    return scoreGeminiModel(id, role);
  }

  return scoreNonGeminiModel(id, role, p);
}

export function rankModelsForRole(
  provider: string,
  ids: string[],
  role: 'generation' | 'evaluation',
  preferredModel?: string
): string[] {
  const p = (provider || '').toLowerCase();
  let filtered = ids.filter((id) => !DROP_PATTERN.test(id) && !isModelDead(id));

  // Chat exclusions:
  filtered = filtered.filter((id) => !CHAT_EXCLUDE_PATTERN.test(id));

  if (p === 'gemini') {
    filtered = filtered.filter((id) => /^gemini-/i.test(id) && !/gemma/i.test(id));
  } else if (p === 'openrouter') {
    filtered = filtered.filter((id) => id.endsWith(':free'));
  }

  const sorted = filtered.sort((a, b) => scoreModelForRole(b, role, p) - scoreModelForRole(a, role, p));

  if (preferredModel && sorted.includes(preferredModel)) {
    return [preferredModel, ...sorted.filter((m) => m !== preferredModel)];
  }

  return sorted;
}

export function rankModels(provider: string, ids: string[], preferredModel?: string): string[] {
  return rankModelsForRole(provider, ids, 'generation', preferredModel);
}

export function classifyAudioModels(ids: string[]): { stt: string[]; tts: string[] } {
  const sttCandidates = ids.filter((id) => /whisper|transcri|parakeet|canary/i.test(id));
  const ttsCandidates = ids.filter(
    (id) => /tts|orpheus|playai|text-to-speech|voxtral/i.test(id) && !/guard|whisper|transcri/i.test(id)
  );
  return { stt: sttCandidates, tts: ttsCandidates };
}

export function resolveModelName(
  typed: string | undefined | null,
  ids: string[]
): { model: string | null; exact: boolean } {
  if (!typed || !typed.trim()) {
    return { model: null, exact: false };
  }
  const trimmed = typed.trim();
  const lowerTyped = trimmed.toLowerCase();

  if (ids.includes(trimmed)) {
    return { model: trimmed, exact: true };
  }
  const caseMatch = ids.find((id) => id.toLowerCase() === lowerTyped);
  if (caseMatch) {
    return { model: caseMatch, exact: true };
  }
  const normTyped = lowerTyped.replace(/[^a-z0-9]/g, '');
  const normMatch = ids.find((id) => id.toLowerCase().replace(/[^a-z0-9]/g, '') === normTyped);
  if (normMatch) {
    return { model: normMatch, exact: false };
  }
  return { model: null, exact: false };
}

/**
 * Shared function to resolve ranked model chains { generation, evaluation, tts, stt }
 * from the provider's real /models endpoint, cached for 6 hours per provider and hashed key.
 */
export async function resolveModelChains(
  provider: string,
  apiKey: string,
  force = false
): Promise<ModelChainsResult> {
  const p = (provider || 'gemini').toLowerCase();
  const cleanKey = (apiKey || '').trim();

  const cacheKey = `${p}:${hashKey(cleanKey)}`;
  const now = Date.now();

  if (!force) {
    const cached = roleChainsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.data;
    }
  }

  const baseUrls: Record<string, string> = {
    nvidia: 'https://integrate.api.nvidia.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    xai: 'https://api.x.ai/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };

  let rawModels: any[] = [];
  let geminiTtsModels: string[] = [];
  let fetchFailed = false;

  if (!cleanKey) {
    setLastListError(p, { status: 401, message: 'No API key provided' });
    return getFallbackChains(p);
  }

  try {
    if (p === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': cleanKey,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        fetchFailed = true;
        const errText = await res.text();
        let errMsg = errText;
        try {
          const j = JSON.parse(errText);
          errMsg = j.error?.message || j.message || errText;
        } catch {}
        setLastListError('gemini', { status: res.status, message: redactKeyInText(errMsg, cleanKey) });
      } else {
        const json = await res.json();
        const list = Array.isArray(json?.models) ? json.models : [];
        if (list.length === 0) {
          setLastListError('gemini', { status: 200, message: 'No models found in Gemini /models response' });
        }

        // Gemini models supporting generateContent
        const contentModels = list.filter((m: any) => {
          const methods = m?.supportedGenerationMethods || [];
          return methods.includes('generateContent');
        });

        // Chat models: exclude image, tts, live, audio, embedding, imagen, veo, lyria, robotics, native-audio
        rawModels = contentModels.filter((m: any) => {
          const name = String(m?.name || '');
          return !/image|tts|live|audio|embedding|imagen|veo|lyria|robotics|native-audio/i.test(name);
        });

        // TTS models: keep only models whose name contains "tts" (never 'tts-1')
        geminiTtsModels = list
          .map((m: any) => String(m?.name || '').replace(/^models\//, ''))
          .filter((name: string) => /tts/i.test(name) && !/tts-1/i.test(name));
      }
    } else {
      const baseUrl = baseUrls[p];
      if (baseUrl) {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${cleanKey}`,
          'Content-Type': 'application/json',
        };
        if (p === 'openrouter') {
          headers['HTTP-Referer'] = 'https://toeflprepstudio.com';
          headers['X-Title'] = 'TOEFL Prep Studio';
        }
        const res = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers,
        });

        if (!res.ok) {
          fetchFailed = true;
          const errText = await res.text();
          let errMsg = errText;
          try {
            const j = JSON.parse(errText);
            errMsg = j.error?.message || j.message || errText;
          } catch {}
          setLastListError(p, { status: res.status, message: redactKeyInText(errMsg, cleanKey) });
        } else {
          const json = await res.json();
          rawModels = Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json?.models)
            ? json.models
            : Array.isArray(json)
            ? json
            : [];
          if (rawModels.length === 0) {
            setLastListError(p, { status: 200, message: `No models returned from ${p} /models` });
          }
        }
      }
    }
  } catch (err: any) {
    fetchFailed = true;
    setLastListError(p, { status: 500, message: redactKeyInText(err?.message || String(err), cleanKey) });
  }

  // OpenRouter: keep only ':free' models with verified free pricing
  if (p === 'openrouter') {
    rawModels = rawModels.filter((m: any) => {
      const id = typeof m === 'string' ? m : String(m?.id || '');
      if (!id.endsWith(':free')) return false;
      if (typeof m === 'object' && m?.pricing) {
        const promptPrice = Number(m.pricing.prompt ?? 0);
        const completionPrice = Number(m.pricing.completion ?? 0);
        if (promptPrice > 0 || completionPrice > 0) return false;
      }
      return true;
    });
  }

  // Build model ID list:
  // Gemini -> m.name with "models/" removed (fallback to id)
  // Every other provider -> m.id (fallback to name only if id missing)
  const all = rawModels
    .map((m: any) => {
      if (p === 'gemini') {
        const name = typeof m === 'string' ? m : String(m?.name || '');
        const stripped = name.replace(/^models\//, '');
        return stripped || (typeof m === 'object' ? String(m?.id || '') : '');
      } else {
        const id = typeof m === 'string' ? m : String(m?.id || '');
        return id || (typeof m === 'object' ? String(m?.name || '') : '');
      }
    })
    .filter(Boolean);

  let sttCandidates: string[] = [];
  let ttsCandidates: string[] = [];

  if (p === 'gemini') {
    ttsCandidates = geminiTtsModels;
    sttCandidates = all; // Gemini multimodal audio transcription
  } else {
    const audio = classifyAudioModels(all);
    sttCandidates = audio.stt;
    ttsCandidates = audio.tts;
  }

  const sttTtsSet = new Set([...sttCandidates, ...ttsCandidates]);
  const verifiedRoleModels = MODEL_ROLES[p]
    ? Array.from(new Set([...MODEL_ROLES[p].generator, ...MODEL_ROLES[p].evaluator]))
    : [];
  const chatCandidateIds =
    p === 'gemini'
      ? all
      : Array.from(new Set([...verifiedRoleModels, ...all.filter((id) => !sttTtsSet.has(id))]));

  let genRanked = rankModelsForRole(p, chatCandidateIds, 'generation');
  let evalRanked = rankModelsForRole(p, chatCandidateIds, 'evaluation');

  // If live discovery failed or yielded 0 candidates (e.g. providers without /models discovery), use static fallback config
  if (genRanked.length === 0) {
    const fallbacks = getFallbackChains(p);
    genRanked = fallbacks.generation;
    evalRanked = fallbacks.evaluation;
    if (sttCandidates.length === 0) sttCandidates = fallbacks.stt;
    if (ttsCandidates.length === 0) ttsCandidates = fallbacks.tts;
  }

  const result: ModelChainsResult = {
    generation: genRanked,
    evaluation: evalRanked,
    tts: ttsCandidates,
    stt: sttCandidates,
    all: all.length > 0 ? all : Array.from(new Set([...genRanked, ...evalRanked])),
  };

  if (!fetchFailed && (genRanked.length > 0 || all.length > 0)) {
    roleChainsCache.set(cacheKey, {
      data: result,
      expiresAt: now + 6 * 3600 * 1000, // 6 hours
    });
  }

  return result;
}

export function getModelsForRole(
  role: 'generator' | 'evaluator' | 'generation' | 'evaluation',
  provider: string = 'gemini',
  dynamicModels: string[] = []
): string[] {
  const isGen = role === 'generator' || role === 'generation';
  const normalizedRole = isGen ? 'generation' : 'evaluation';
  const p = (provider || 'gemini').toLowerCase() as keyof typeof GENERATION_MODELS;

  const roleConfig = MODEL_ROLES[p];
  const baseVerified = roleConfig
    ? isGen
      ? roleConfig.generator
      : roleConfig.evaluator
    : isGen
    ? GENERATION_MODELS[p] || []
    : EVALUATION_MODELS[p] || [];

  if (dynamicModels && dynamicModels.length > 0) {
    const merged = p === 'gemini' ? dynamicModels : Array.from(new Set([...baseVerified, ...dynamicModels]));
    const ranked = rankModelsForRole(p, merged, normalizedRole);
    if (ranked.length > 0) return ranked;
  }

  switch (p) {
    case 'gemini': {
      const list = baseVerified && baseVerified.length > 0 ? baseVerified : ['gemini-2.5-flash', 'gemini-2.0-flash'];
      return list.filter((m) => !isModelDead(m));
    }
    case 'groq':
    case 'nvidia':
    case 'openrouter':
    case 'openai':
    case 'deepseek':
    case 'xai':
    case 'anthropic': {
      return (baseVerified || []).filter((m) => !isModelDead(m));
    }
    default: {
      return (baseVerified || []).filter((m: string) => !isModelDead(m));
    }
  }
}

function getFallbackChains(provider: string): ModelChainsResult {
  const gen = getModelsForRole('generator', provider);
  const ev = getModelsForRole('evaluator', provider);
  return {
    generation: gen,
    evaluation: ev.length > 0 ? ev : gen,
    tts: [],
    stt: [],
    all: Array.from(new Set([...gen, ...ev])),
  };
}

export async function getRoleModels(
  provider: string,
  apiKey: string,
  force = false
): Promise<RoleModelsResult> {
  const chains = await resolveModelChains(provider, apiKey, force);
  return {
    chat: chains.generation,
    stt: chains.stt,
    tts: chains.tts,
    all: chains.all,
    generationModel: chains.generation[0] || '',
    evaluationModel: chains.evaluation[0] || chains.generation[0] || '',
  };
}

export function redactKeyInText(text: string, apiKey?: string): string {
  let out = String(text || '');
  if (apiKey && apiKey.length > 5) {
    out = out.split(apiKey).join('[REDACTED]');
  }
  return out
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/gsk_[A-Za-z0-9]{10,}/g, '[REDACTED]')
    .replace(/sk-or-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/(AIza|AQ\.)[A-Za-z0-9_.-]{10,}/g, '[REDACTED]');
}

export function formatProviderError(provider: string, model: string, status: number, rawMessage: string, apiKey?: string) {
  const cleanMsg = redactKeyInText(rawMessage, apiKey);
  let humanExplanation = 'Provider error occurred';
  const lower = cleanMsg.toLowerCase();

  if (status === 401 || status === 403 || lower.includes('invalid api key') || lower.includes('unauthorized') || lower.includes('api key not valid')) {
    humanExplanation = 'Invalid API key or unauthorized access.';
  } else if (status === 404 || status === 410 || lower.includes('model not found') || lower.includes('does not exist') || lower.includes('no access') || lower.includes('retired') || lower.includes('gone')) {
    humanExplanation = 'Model retired, not found, or no access.';
  } else if (status === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    humanExplanation = 'Rate limited or quota exhausted.';
  } else if (status >= 500) {
    humanExplanation = 'Provider server error.';
  } else {
    humanExplanation = 'Request failed.';
  }

  return {
    success: false,
    provider,
    modelTried: model,
    httpStatus: status,
    providerErrorMessage: cleanMsg,
    humanExplanation,
    error: `${provider} (${model}) [HTTP ${status}]: ${cleanMsg} (${humanExplanation})`,
  };
}
