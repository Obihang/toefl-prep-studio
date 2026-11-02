import { callOpenAiCompatibleChat } from './llmClient';
import type { LlmCallOptions } from './llmClient';
import { resolveModelChains, isModelGone, markModelDead } from './modelRoles';

const FALLBACK_MODELS_BY_PROVIDER: Record<string, string[]> = {
  openrouter: [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
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
        ? 'openrouter/free'
        : provider === 'groq'
        ? 'llama-3.3-70b-versatile'
        : 'meta/llama-3.3-70b-instruct';
    const attemptedModel = options.model || defaultModel;

    if (isGone) {
      markModelDead(attemptedModel);
    }

    // Cap fallback candidates to at most 1 alternative so total time stays within 8s
    const predefined = FALLBACK_MODELS_BY_PROVIDER[provider] || [];
    const candidatesToTry = predefined.filter((m) => m !== attemptedModel).slice(0, 1);

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
