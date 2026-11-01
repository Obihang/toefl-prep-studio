import {
  GENERATION_MODELS,
  EVALUATION_MODELS,
  PROVIDER_ORDER,
  ModelProvider,
} from '../config/models';
import {
  getAllProviderKeys,
  getApiHeaders,
  getStoredApiKey,
  getStoredProvider,
  hasAnyProviderKey,
  ApiProvider,
} from '../utils/apiKey';
import { safeFetchJson } from '../utils/apiHelper';
import { evaluateResponseLocally, mergeAiAndLocalEvaluation } from '../utils/localEvaluator';
import { normalizeTaskData } from '../utils/taskNormalizer';

// Runtime Health & Load State per Provider
const inFlightCount: Record<string, number> = {};
const cooldownUntil: Record<string, number> = {};
const requestsServedCount: Record<string, number> = {};
let roundRobinCounter = 0;

export interface ProviderPoolStatusItem {
  provider: string;
  name: string;
  configured: boolean;
  maskedKey: string;
  state: 'Idle' | 'Busy' | 'Cooldown' | 'Unconfigured';
  inFlightCount: number;
  remainingCooldownSeconds: number;
  requestsServed: number;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: 'Google Gemini',
  groq: 'Groq LPU',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA NIM',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  xai: 'xAI Grok',
  anthropic: 'Anthropic Claude',
};

export function getInFlightCount(provider: string): number {
  return inFlightCount[provider] || 0;
}

export function getCooldownUntil(provider: string): number {
  return cooldownUntil[provider] || 0;
}

export function markProviderCooldown(provider: string, durationMs: number): void {
  cooldownUntil[provider] = Date.now() + durationMs;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));
  }
}

export function resetAllProviderCooldowns(): void {
  for (const key of Object.keys(cooldownUntil)) {
    cooldownUntil[key] = 0;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));
  }
}

export function getProviderPoolStatus(): ProviderPoolStatusItem[] {
  const allProviders = [
    'gemini',
    'groq',
    'openrouter',
    'nvidia',
    'openai',
    'deepseek',
    'xai',
    'anthropic',
  ];
  const keysMap = getAllProviderKeys();
  const now = Date.now();

  return allProviders.map((p) => {
    const rawKey = (keysMap[p] || getStoredApiKey(p as ApiProvider) || '').trim();
    const configured = Boolean(rawKey);
    const maskedKey = configured
      ? rawKey.length > 10
        ? `${rawKey.slice(0, 5)}•••${rawKey.slice(-4)}`
        : '••••••'
      : 'Not set';
    const inFlight = inFlightCount[p] || 0;
    const until = cooldownUntil[p] || 0;
    const remainingCooldownSeconds = configured && until > now ? Math.ceil((until - now) / 1000) : 0;

    let state: 'Idle' | 'Busy' | 'Cooldown' | 'Unconfigured' = 'Unconfigured';
    if (configured) {
      if (remainingCooldownSeconds > 0) {
        state = 'Cooldown';
      } else if (inFlight > 0) {
        state = 'Busy';
      } else {
        state = 'Idle';
      }
    }

    return {
      provider: p,
      name: PROVIDER_DISPLAY_NAMES[p] || p.toUpperCase(),
      configured,
      maskedKey,
      state,
      inFlightCount: inFlight,
      remainingCooldownSeconds,
      requestsServed: requestsServedCount[p] || 0,
    };
  });
}

export function getHealthyProviderCount(): number {
  const keys = getAllProviderKeys();
  const configured = Object.entries(keys).filter(([_, k]) => Boolean(k && k.trim()));
  if (configured.length === 0) {
    return hasAnyProviderKey() ? 1 : 1;
  }
  const now = Date.now();
  const healthy = configured.filter(([p]) => now >= (cooldownUntil[p] || 0));
  return Math.max(1, healthy.length > 0 ? healthy.length : 1);
}

/**
 * Executes an array of async job functions across available healthy provider keys.
 * Concurrency worker count is dynamically Math.max(1, getHealthyProviderCount()).
 */
export async function runWithDynamicKeyPool<T>(
  jobs: Array<() => Promise<T>>,
  onJobComplete?: (result: T, completedCount: number, totalJobs: number) => void
): Promise<T[]> {
  if (jobs.length === 0) return [];
  const results: T[] = new Array(jobs.length);
  let nextJobIdx = 0;
  let completedCount = 0;

  const workerCount = Math.max(1, getHealthyProviderCount());

  const worker = async () => {
    while (nextJobIdx < jobs.length) {
      const currentIdx = nextJobIdx++;
      try {
        const res = await jobs[currentIdx]();
        results[currentIdx] = res;
      } catch (err) {
        console.warn(`[runWithDynamicKeyPool] Job ${currentIdx} failed:`, err);
        results[currentIdx] = null as any;
      } finally {
        completedCount++;
        if (onJobComplete) {
          onJobComplete(results[currentIdx], completedCount, jobs.length);
        }
      }
    }
  };

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function fetchDynamicModels(provider: ModelProvider, apiKey: string): Promise<string[]> {
  if (provider !== 'gemini') return GENERATION_MODELS[provider] || [];

  const trimmedKey = (apiKey || '').trim();
  if (!trimmedKey) {
    return GENERATION_MODELS.gemini;
  }

  try {
    const res = await fetch('/api/models', {
      headers: {
        'x-gemini-key': trimmedKey,
        'x-api-key': trimmedKey,
        'x-api-provider': 'gemini',
      },
    });
    if (!res.ok) {
      return GENERATION_MODELS.gemini;
    }
    const json = await res.json();
    if (json && Array.isArray(json.models) && json.models.length > 0) {
      return json.models;
    }
  } catch {
    // Fallback to static configured Gemini models
  }

  return GENERATION_MODELS.gemini;
}

export async function executeWithFallback<T>(
  operation: (provider: ModelProvider, model: string, apiKey: string) => Promise<T>,
  role: 'generator' | 'evaluator' = 'generator'
): Promise<T> {
  const providerKeys = getAllProviderKeys();
  const preferred = getStoredProvider();

  const configuredProviders = (PROVIDER_ORDER as ModelProvider[]).filter(
    (p) => Boolean((providerKeys[p] || getStoredApiKey(p as ApiProvider) || '').trim())
  );

  if (configuredProviders.length === 0) {
    const primaryKey = getStoredApiKey();
    if (primaryKey) {
      const prov = (preferred && preferred !== 'auto' && preferred !== 'custom' ? preferred : 'gemini') as ModelProvider;
      inFlightCount[prov] = (inFlightCount[prov] || 0) + 1;
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));
      try {
        const models = GENERATION_MODELS[prov] || ['gemini-2.5-flash'];
        const res = await operation(prov, models[0], primaryKey);
        const actualProv = ((res as any)?.data?.providerUsed || (res as any)?.providerUsed || prov) as ModelProvider;
        requestsServedCount[actualProv] = (requestsServedCount[actualProv] || 0) + 1;
        return res;
      } finally {
        inFlightCount[prov] = Math.max(0, (inFlightCount[prov] || 1) - 1);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));
      }
    }
    throw new Error('No API key is configured.');
  }

  const now = Date.now();

  // If ALL configured providers are in cooldown, un-sideline the one with min cooldown
  const allInCooldown = configuredProviders.every((p) => now < (cooldownUntil[p] || 0));
  if (allInCooldown) {
    let minP = configuredProviders[0];
    let minUntil = cooldownUntil[minP] || Infinity;
    for (const p of configuredProviders) {
      if ((cooldownUntil[p] || 0) < minUntil) {
        minUntil = cooldownUntil[p] || 0;
        minP = p;
      }
    }
    cooldownUntil[minP] = 0;
  }

  const healthyProviders = configuredProviders.filter((p) => Date.now() >= (cooldownUntil[p] || 0));
  const cooledDownProviders = configuredProviders.filter((p) => Date.now() < (cooldownUntil[p] || 0));

  // Advance round-robin cursor synchronously before any await
  const baseHealthyOrder = [...healthyProviders];
  const cursor =
    baseHealthyOrder.length > 0 ? roundRobinCounter % baseHealthyOrder.length : 0;
  roundRobinCounter =
    baseHealthyOrder.length > 0
      ? (roundRobinCounter + 1) % baseHealthyOrder.length
      : 0;

  healthyProviders.sort((a, b) => {
    const loadA = inFlightCount[a] || 0;
    const loadB = inFlightCount[b] || 0;
    if (loadA !== loadB) return loadA - loadB;

    const idxA =
      (baseHealthyOrder.indexOf(a) - cursor + baseHealthyOrder.length) %
      baseHealthyOrder.length;
    const idxB =
      (baseHealthyOrder.indexOf(b) - cursor + baseHealthyOrder.length) %
      baseHealthyOrder.length;
    return idxA - idxB;
  });

  const orderedCandidates = [...healthyProviders, ...cooledDownProviders];
  let lastError: any = null;

  for (const provider of orderedCandidates) {
    // Synchronously reserve this provider on the VERY FIRST LINE before any await (including fetchDynamicModels)
    // so concurrent workers starting at t=0ms see inFlightCount[provider] === 1 immediately!
    inFlightCount[provider] = (inFlightCount[provider] || 0) + 1;
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));

    try {
      const apiKey = (providerKeys[provider] || getStoredApiKey(provider as ApiProvider) || '').trim();
      if (!apiKey) continue;

      const models =
        role === 'generator'
          ? await fetchDynamicModels(provider, apiKey)
          : EVALUATION_MODELS[provider] || GENERATION_MODELS[provider] || [];

      for (const model of models) {
        try {
          const res = await operation(provider, model, apiKey);
          const actualProvider = (
            (res as any)?.data?.providerUsed ||
            (res as any)?.providerUsed ||
            provider
          ) as ModelProvider;
          cooldownUntil[actualProvider] = 0;
          requestsServedCount[actualProvider] = (requestsServedCount[actualProvider] || 0) + 1;
          return res;
        } catch (err: any) {
          lastError = err;
          const status = err?.status || err?.statusCode || 0;
          const msg = (err?.message || String(err)).toLowerCase();

          if (
            status === 429 ||
            status === 503 ||
            msg.includes('rate limit') ||
            msg.includes('quota') ||
            msg.includes('overloaded') ||
            msg.includes('resource_exhausted')
          ) {
            cooldownUntil[provider] = Date.now() + 60_000;
            break;
          } else if (
            status === 401 ||
            status === 402 ||
            status === 403 ||
            msg.includes('invalid key') ||
            msg.includes('unauthorized') ||
            msg.includes('billing')
          ) {
            cooldownUntil[provider] = Date.now() + 10 * 60_000;
            break;
          } else if (err?.providerChainExhausted) {
            break;
          }
        }
      }
    } finally {
      inFlightCount[provider] = Math.max(0, (inFlightCount[provider] || 1) - 1);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('toefl_pool_status_updated'));
    }
  }

  throw lastError || new Error('All configured provider keys failed or are unavailable.');
}

function resolveActiveProviderAndKey(): {
  provider: string;
  apiKey: string;
  providerKeys: Record<string, string>;
} {
  const providerKeys = getAllProviderKeys();
  let provider: string = getStoredProvider();
  let apiKey = getStoredApiKey(provider as ApiProvider) || providerKeys[provider] || '';

  if (!apiKey) {
    for (const candidate of PROVIDER_ORDER) {
      if (providerKeys[candidate]) {
        provider = candidate;
        apiKey = providerKeys[candidate];
        break;
      }
    }
  }

  return { provider, apiKey, providerKeys };
}

function buildSingleProviderHeaders(provider: string, apiKey: string): Record<string, string> {
  const baseHeaders = getApiHeaders();
  const headers: Record<string, string> = {
    ...baseHeaders,
    'x-api-provider': provider,
    'x-api-key': apiKey,
  };
  for (const p of PROVIDER_ORDER) {
    delete headers[`x-api-key-${p}`];
  }
  headers[`x-api-key-${provider}`] = apiKey;
  if (provider === 'gemini') {
    headers['x-gemini-api-key'] = apiKey;
  } else {
    delete headers['x-gemini-api-key'];
  }
  if (provider === 'groq') {
    headers['x-groq-key'] = apiKey;
  } else {
    delete headers['x-groq-key'];
  }
  return headers;
}

export const OFFICIAL_COMPLETE_WORDS_SPEC = {
  headSentenceWords: '12-18 words (1 introductory head sentence, 100% intact)',
  examMiddleWords: '22-28 words (1-2 middle sentences holding 10 blanks)',
  coachMiddleWords: '55-65 words (1-2 middle sentences holding 25 blanks)',
  tailSentenceWords: '12-18 words (1 concluding tail sentence, 100% intact)',
  instruction:
    'Write a concise academic paragraph consisting of: (1) ONE introductory head sentence (~12–18 words), (2) ONE or TWO middle sentences (~22–28 words total in Exam Mode; ~55–65 words in Coach Mode) that will hold the blanks, and (3) ONE concluding tail sentence (~12–18 words). Write 100% plain English with ZERO brackets [ ] or underscores.',
} as const;

export const OFFICIAL_5_READING_QUESTION_TYPES = [
  'Factual Detail ("According to paragraph X...")',
  'Negative Factual (EXCEPT / NOT) ("According to the passage, all of the following are true EXCEPT:" or "Which of the following is NOT mentioned in paragraph X?")',
  'Vocabulary in Context ("The word \'X\' in paragraph Y is closest in meaning to:")',
  'Inference ("What can be inferred from paragraph X about...?" or "Which of the following does the passage imply about...?")',
  'Rhetorical Purpose / Relationship ("Why does the author mention \'X\' in paragraph Y?" or "How do the ideas in paragraph 2 relate to the ideas in paragraph 1?")',
] as const;

export const OFFICIAL_LISTENING_CONVERSATION_SPECS = {
  minWords: 75,
  maxWords: 110,
  minTurns: 8,
  maxTurns: 10,
  wordsPerTurn: '5-15 words',
  questionsCount: 2,
  requiresAudioExcerpt: true,
} as const;

export const OFFICIAL_LISTENING_ACADEMIC_TALK_SPECS = {
  minWords: 140,
  maxWords: 200,
  questionsCount: 4,
  requiresAudioExcerpt: true,
} as const;

export const OFFICIAL_BUILD_SENTENCE_SPEC = {
  itemsPerSet: 5,
  lowercaseTilesOnly: true,
  frameTypes: ['prefix_and_suffix', 'prefix_only', 'suffix_only', 'all_blanks'],
  includesInterrogativeQuestions: true,
  includesMultiWordPhraseChunks: true,
  minSingleWordTilesPerItem: 4,
  maxMultiWordPhraseTilesPerItem: 2,
  maxWordsPerPhraseTile: 3,
  includesGrammaticalDistractors: true,
} as const;

export const OFFICIAL_LISTEN_REPEAT_SPEC = {
  sentencesPerSet: 7,
  cohesiveSingleSpeakerScenario: true,
  directListenerAddress: true,
  wordCountProgression: '6-7 words (Sentence 1) up to 14-16 words (Sentence 7)',
} as const;

export async function callBackendGenerate(
  taskType: string,
  level: string = 'intermediate',
  topic: string = 'science-tech',
  promptData?: any,
  extraOptions?: Record<string, any> | boolean
): Promise<any> {
  const optionsObj = typeof extraOptions === 'boolean' ? { coachMode: extraOptions } : extraOptions;
  const isCoachMode = Boolean(
    promptData === true ||
      promptData?.coachMode === true ||
      promptData?.mode === 'coach' ||
      optionsObj?.coachMode === true ||
      optionsObj?.mode === 'coach'
  );
  const basePromptData =
    typeof promptData === 'object' && promptData !== null
      ? { ...promptData, ...(isCoachMode ? { coachMode: true, mode: 'coach' } : {}) }
      : isCoachMode
      ? { coachMode: true, mode: 'coach' }
      : undefined;

  const isCompleteWords =
    taskType === 'complete-words' || taskType === 'complete_words';
  const isReadingAcademic =
    taskType === 'reading-academic' || taskType === 'reading_academic' || taskType === 'reading-passage';
  const isListeningWithExcerpt =
    taskType === 'listening-dialogue' ||
    taskType === 'listening_dialogue' ||
    taskType === 'listening-conversation' ||
    taskType === 'listening_conversation' ||
    taskType === 'listening-academic-talk' ||
    taskType === 'listening_academic_talk' ||
    taskType === 'listening-lecture' ||
    taskType === 'listening_lecture';
  const isBuildSentence =
    taskType === 'build-sentence' ||
    taskType === 'writing_build_sentence' ||
    taskType === 'writing-build-sentence';
  const isListenRepeat =
    taskType === 'listen-repeat' ||
    taskType === 'speaking_listen_repeat' ||
    taskType === 'speaking-listen-repeat';
  const readingQuestionFocus =
    basePromptData?.questionSkillFocus || basePromptData?.readingQuestionFocus || 'all';
  const enrichedPromptData = isCompleteWords
    ? {
        ...(basePromptData || {}),
        ...OFFICIAL_COMPLETE_WORDS_SPEC,
      }
    : isReadingAcademic
    ? {
        ...(basePromptData || {}),
        questionSkillFocus: readingQuestionFocus,
        readingQuestionFocus,
        requiredQuestionTypes:
          readingQuestionFocus === 'all' ? OFFICIAL_5_READING_QUESTION_TYPES : undefined,
      }
    : isListeningWithExcerpt
    ? {
        ...(basePromptData || {}),
        requiresAudioExcerpt: true,
      }
    : isBuildSentence
    ? {
        ...(basePromptData || {}),
        ...OFFICIAL_BUILD_SENTENCE_SPEC,
        itemsPerSet: isCoachMode ? 8 : OFFICIAL_BUILD_SENTENCE_SPEC.itemsPerSet,
      }
    : isListenRepeat
    ? {
        ...(basePromptData || {}),
        ...OFFICIAL_LISTEN_REPEAT_SPEC,
        sentencesPerSet: isCoachMode ? 12 : OFFICIAL_LISTEN_REPEAT_SPEC.sentencesPerSet,
      }
    : basePromptData;

  try {
    return await executeWithFallback(async (provider, _model, apiKey) => {
      const singleProviderMap = { [provider]: apiKey };
      const options = {
        provider,
        apiKey,
        customApiKey: apiKey,
        strictProvider: true,
        providerKeys: singleProviderMap,
        availableKeys: singleProviderMap,
        coachMode: isCoachMode,
        ...(optionsObj || {}),
      };

      const res = await safeFetchJson('/api/generate-task', {
        method: 'POST',
        headers: buildSingleProviderHeaders(provider, apiKey),
        body: JSON.stringify({
          taskType,
          level,
          topic,
          coachMode: isCoachMode,
          promptData: enrichedPromptData,
          customApiKey: apiKey,
          provider,
          apiKey,
          strictProvider: true,
          providerKeys: singleProviderMap,
          availableKeys: singleProviderMap,
          options,
        }),
      });

      if (!res || res.success === false) {
        const err: any = new Error(res?.error || `Failed to generate task with ${provider}`);
        if (res?.status) err.status = res.status;
        err.providerChainExhausted = true;
        throw err;
      }
      if (res.data?.isFallback) {
        const err: any = new Error(
          res.data.fallbackReason || `Provider ${provider} returned fallback`
        );
        err.status = res.data.isQuotaExhausted ? 429 : 500;
        err.fallbackData = res.data;
        err.providerChainExhausted = true;
        throw err;
      }
      if (res.data) {
        res.data = {
          ...normalizeTaskData(res.data, taskType, { coachMode: isCoachMode }),
          providerUsed: res.data.providerUsed || provider,
        };
      }
      return res;
    });
  } catch (err: any) {
    if (err?.fallbackData) {
      return {
        success: true,
        data: normalizeTaskData(err.fallbackData, taskType, { coachMode: isCoachMode }),
      };
    }
    throw err;
  }
}

export async function generateTaskContent(
  taskType: string,
  level: string = 'intermediate',
  topic: string = 'science-tech',
  promptData?: any,
  extraOptions?: Record<string, any> | boolean
): Promise<any> {
  const optionsObj = typeof extraOptions === 'boolean' ? { coachMode: extraOptions } : extraOptions;
  const isCoachMode = Boolean(
    promptData === true ||
      promptData?.coachMode === true ||
      promptData?.mode === 'coach' ||
      optionsObj?.coachMode === true ||
      optionsObj?.mode === 'coach'
  );
  const res = await callBackendGenerate(taskType, level, topic, promptData, optionsObj);
  const rawData = res?.data || res;
  return normalizeTaskData(rawData, taskType, { coachMode: isCoachMode });
}

export async function evaluateResponse(
  taskType: string,
  promptData: any,
  studentResponse: any,
  extraOptions?: Record<string, any>
): Promise<any> {
  const { apiKey } = resolveActiveProviderAndKey();
  const localBaseline = evaluateResponseLocally(promptData, studentResponse, taskType, extraOptions);

  if (extraOptions?.mode === 'local' || (!hasAnyProviderKey() && !apiKey)) {
    return localBaseline;
  }

  return executeWithFallback(async (prov, _model, key) => {
    const singleProviderMap = { [prov]: key };
    const options = {
      provider: prov,
      apiKey: key,
      customApiKey: key,
      strictProvider: true,
      providerKeys: singleProviderMap,
      availableKeys: singleProviderMap,
      ...(extraOptions || {}),
    };

    const res = await safeFetchJson('/api/evaluate-response', {
      method: 'POST',
      headers: buildSingleProviderHeaders(prov, key),
      body: JSON.stringify({
        taskType,
        promptData,
        studentResponse,
        customApiKey: key,
        provider: prov,
        apiKey: key,
        strictProvider: true,
        providerKeys: singleProviderMap,
        availableKeys: singleProviderMap,
        options,
      }),
    });

    if (!res || res.success === false || res.data?.isLocalEvaluation) {
      const err: any = new Error(res?.error || `Evaluation failed on ${prov}`);
      err.providerChainExhausted = true;
      throw err;
    }
    const rawEval = res?.data || res;
    return mergeAiAndLocalEvaluation(rawEval, localBaseline);
  }, 'evaluator').catch((err) => {
    console.warn('[geminiService] evaluateResponse AI failed, falling back to localBaseline:', err);
    return localBaseline;
  });
}
