import { callOpenAiCompatibleChat } from './llmClient';
import type { LlmCallOptions } from './llmClient';
import { resolveModelChains, isModelGone, markModelDead } from './modelRoles';

const FALLBACK_MODELS_BY_PROVIDER: Record<string, string[]> = {
  openrouter: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'deepseek/deepseek-chat:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-8b-instruct',
    'qwen/qwen2.5-72b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct',
  ],
};

export async function callChatWithHealing(
  options: LlmCallOptions & { forceRefreshRoles?: boolean }
): Promise<{ text: string; modelUsed: string }> {
  const provider = (options.provider || 'custom').toLowerCase();
  const isRecoverableProvider = provider === 'nvidia' || provider === 'groq' || provider === 'openrouter';

  try {
    return await callOpenAiCompatibleChat(options);
  } catch (err: any) {
    if (!isRecoverableProvider || !options.apiKey) {
      throw err;
    }

    const errMessage = String(err?.message || '').toLowerCase();
    const isGone = isModelGone(err?.status, errMessage);

    const isQuotaOr429 =
      err?.status === 429 ||
      errMessage.includes('429') ||
      errMessage.includes('rate limit') ||
      errMessage.includes('quota') ||
      errMessage.includes('resource_exhausted');

    // If neither model gone nor quota/429, don't retry
    if (!isGone && !isQuotaOr429) {
      throw err;
    }

    const defaultModel =
      provider === 'openrouter'
        ? 'meta-llama/llama-3.3-70b-instruct:free'
        : provider === 'groq'
        ? 'llama-3.3-70b-versatile'
        : 'meta/llama-3.3-70b-instruct';
    const attemptedModel = options.model || defaultModel;

    if (isGone) {
      markModelDead(attemptedModel);
    }

    // Determine alternative candidates
    let candidatesToTry: string[] = [];

    if (isQuotaOr429) {
      const predefined = FALLBACK_MODELS_BY_PROVIDER[provider] || [];
      candidatesToTry = predefined.filter((m) => m !== attemptedModel);
    } else {
      // Model gone: fetch fresh models from provider discovery
      try {
        const chains = await resolveModelChains(provider, options.apiKey, true);
        const fresh = chains.generation || [];
        candidatesToTry = fresh.filter((m) => m !== attemptedModel).slice(0, 3);
      } catch {
        candidatesToTry = (FALLBACK_MODELS_BY_PROVIDER[provider] || []).filter((m) => m !== attemptedModel);
      }
    }

    let lastError = err;
    for (const altModel of candidatesToTry) {
      try {
        console.warn(`[Auto-Fallback] Trying fallback model ${altModel} for ${provider} due to ${isQuotaOr429 ? 'quota/rate limit' : 'model gone'}...`);
        const res = await callOpenAiCompatibleChat({
          ...options,
          model: altModel,
        });
        return res;
      } catch (retryErr: any) {
        lastError = retryErr;
        if (isModelGone(retryErr?.status, retryErr?.message)) {
          markModelDead(altModel);
        }
      }
    }

    if (isQuotaOr429) {
      throw new Error(
        `Rate limit reached for ${provider}. Fallback models were attempted. Please wait a moment for limits to reset or switch to another provider.`
      );
    }

    throw lastError;
  }
}
