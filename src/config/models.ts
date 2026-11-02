/**
 * Configuration for TOEFL Prep Studio BYOK (Bring-Your-Own-Key) models.
 * Standardized on Gemini (Primary generation/grading) & Groq (Primary STT, fallback generation),
 * plus OpenAI, Anthropic, OpenRouter, NVIDIA, DeepSeek, and xAI failover support.
 */

export type ModelProvider =
  | 'gemini'
  | 'groq'
  | 'nvidia'
  | 'openrouter'
  | 'openai'
  | 'deepseek'
  | 'xai'
  | 'anthropic';

export const GENERATION_MODELS: Record<ModelProvider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'], // also discovered dynamically via /models endpoint
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
  openrouter: [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  deepseek: ['deepseek-chat'],
  xai: ['grok-2-latest'],
  anthropic: ['claude-3-5-sonnet-latest'],
};

export const EVALUATION_MODELS: Record<ModelProvider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'], // also discovered dynamically via /models endpoint
  groq: [
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'meta/llama-3.1-70b-instruct',
  ],
  openrouter: [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  deepseek: ['deepseek-chat'],
  xai: ['grok-2-latest'],
  anthropic: ['claude-3-5-sonnet-latest'],
};

export const STT_MODEL = 'whisper-large-v3-turbo';

export const PROVIDER_ORDER: ModelProvider[] = [
  'gemini',
  'groq',
  'openai',
  'anthropic',
  'openrouter',
  'nvidia',
  'deepseek',
  'xai',
];

export interface ProviderStatus {
  provider: ModelProvider;
  isAvailable: boolean;
  rateLimitedUntil: number | null;
  lastError: string | null;
}
