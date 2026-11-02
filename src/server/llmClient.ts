import { filterWhisperHallucinations } from '../utils/speakingMetrics';
import { resolveModelChains, isModelGone, markModelDead } from './modelRoles';

export type ModelPurpose = 'generation' | 'evaluation' | 'transcription' | 'tts';

export interface LlmCallOptions {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  purpose?: ModelPurpose;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  responseJson?: boolean;
}

export function resolveProviderDefaults(
  provider: string = 'gemini',
  baseUrl?: string,
  model?: string,
  purpose: ModelPurpose = 'generation'
) {
  let resolvedBaseUrl = baseUrl?.trim();
  let resolvedModel = model?.trim();

  switch (provider.toLowerCase()) {
    case 'nvidia':
      resolvedBaseUrl = resolvedBaseUrl || 'https://integrate.api.nvidia.com/v1';
      resolvedModel = resolvedModel || 'meta/llama-3.3-70b-instruct';
      break;

    case 'groq':
      resolvedBaseUrl = resolvedBaseUrl || 'https://api.groq.com/openai/v1';
      if (purpose === 'tts') {
        resolvedModel = resolvedModel || 'playai-tts';
      } else if (purpose === 'transcription') {
        resolvedModel = resolvedModel || 'whisper-large-v3-turbo';
      } else {
        resolvedModel = resolvedModel || 'llama-3.3-70b-versatile';
      }
      break;

    case 'openrouter':
      resolvedBaseUrl = resolvedBaseUrl || 'https://openrouter.ai/api/v1';
      if (purpose === 'tts') {
        resolvedModel = resolvedModel || 'openai/tts-1';
      } else if (purpose === 'transcription') {
        resolvedModel = resolvedModel || 'openai/whisper-large-v3';
      } else {
        resolvedModel = resolvedModel || 'meta-llama/llama-3.3-70b-instruct:free';
      }
      break;

    case 'openai':
      resolvedBaseUrl = resolvedBaseUrl || 'https://api.openai.com/v1';
      if (purpose === 'evaluation') {
        resolvedModel = resolvedModel || 'gpt-4o';
      } else if (purpose === 'transcription') {
        resolvedModel = resolvedModel || 'whisper-1';
      } else if (purpose === 'tts') {
        resolvedModel = resolvedModel || 'tts-1';
      } else {
        resolvedModel = resolvedModel || 'gpt-4o-mini';
      }
      break;

    case 'deepseek':
      resolvedBaseUrl = resolvedBaseUrl || 'https://api.deepseek.com/v1';
      resolvedModel = resolvedModel || 'deepseek-chat';
      break;

    case 'xai':
      resolvedBaseUrl = resolvedBaseUrl || 'https://api.x.ai/v1';
      resolvedModel = resolvedModel || 'grok-2-latest';
      break;

    case 'anthropic':
      resolvedBaseUrl = resolvedBaseUrl || 'https://api.anthropic.com/v1';
      resolvedModel = resolvedModel || (purpose === 'evaluation' ? 'claude-3-5-sonnet-latest' : 'claude-3-5-haiku-latest');
      break;

    case 'custom':
      resolvedBaseUrl = resolvedBaseUrl || 'http://localhost:11434/v1';
      resolvedModel = resolvedModel || 'llama3';
      break;

    case 'gemini':
    default:
      resolvedBaseUrl = resolvedBaseUrl || '';
      resolvedModel = resolvedModel || 'gemini-1.5-flash';
      break;
  }

  return { baseUrl: resolvedBaseUrl, model: resolvedModel };
}

export async function callOpenAiCompatibleChat(options: LlmCallOptions & { requireJson?: boolean }): Promise<{ text: string; modelUsed: string }> {
  const { provider = 'custom', apiKey, baseUrl, model, purpose = 'generation', prompt, systemInstruction, temperature = 0.7, responseJson = true, requireJson } = options;
  const shouldRequireJson = requireJson !== undefined ? requireJson : responseJson;
  const resolved = resolveProviderDefaults(provider, baseUrl, model, purpose);

  if (!resolved.baseUrl) {
    throw new Error(`Base URL is missing for provider ${provider}`);
  }

  const endpoint = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  if (resolved.baseUrl.includes('anthropic.com') || endpoint.includes('anthropic.com')) {
    if (apiKey && apiKey.trim()) {
      headers['x-api-key'] = apiKey.trim();
    }
    headers['anthropic-version'] = '2023-06-01';
  }

  if (endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://toeflprepstudio.com';
    headers['X-Title'] = 'TOEFL Prep Studio';
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemInstruction && systemInstruction.trim()) {
    messages.push({ role: 'system', content: systemInstruction.trim() });
  }
  messages.push({ role: 'user', content: prompt });

  const bodyPayload: any = {
    model: resolved.model,
    messages,
    temperature,
  };

  if (shouldRequireJson) {
    bodyPayload.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);

  try {
    let res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: controller.signal,
    });

    if (res.status === 400 && shouldRequireJson) {
      delete bodyPayload.response_format;
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });
    }

    if (!res.ok) {
      const errorText = await res.text();
      let parsedErr = errorText;
      try {
        const j = JSON.parse(errorText);
        parsedErr = j.error?.message || j.message || errorText;
      } catch {}

      if (isModelGone(res.status, parsedErr)) {
        markModelDead(resolved.model);
      }

      const errObj = new Error(`${provider.toUpperCase()} API Error (${res.status}): ${parsedErr}`);
      (errObj as any).status = res.status;
      throw errObj;
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      throw new Error(`Empty response received from ${provider} (${resolved.model})`);
    }

    return {
      text: content,
      modelUsed: `${provider}:${resolved.model}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const callOpenAICompatible = callOpenAiCompatibleChat;

// Native Speech Synthesis for OpenAI TTS (/v1/audio/speech)
export async function callOpenAiTts(options: {
  apiKey: string;
  text: string;
  voiceName?: string;
  model?: string;
  baseUrl?: string;
}): Promise<{ audioBase64: string; mimeType: string; modelUsed: string }> {
  const { apiKey, text, voiceName = 'alloy', model = 'tts-1', baseUrl } = options;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('OpenAI API key missing for TTS');
  }

  const lowerVoice = (voiceName || '').toLowerCase();
  let selectedVoice = 'alloy';
  if (lowerVoice.includes('female') || ['kore', 'aoede', 'despina', 'leda', 'sarah', 'emily'].some(v => lowerVoice.includes(v))) {
    selectedVoice = 'nova';
  } else if (lowerVoice.includes('male') || ['fenrir', 'iapetus', 'orus', 'puck', 'lee', 'john'].some(v => lowerVoice.includes(v))) {
    selectedVoice = 'onyx';
  } else if (['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(lowerVoice)) {
    selectedVoice = lowerVoice;
  }

  const rawBase = (baseUrl || '').trim().replace(/\/+$/, '');
  const endpoint = rawBase
    ? (rawBase.endsWith('/audio/speech') ? rawBase : (rawBase.endsWith('/v1') ? `${rawBase}/audio/speech` : `${rawBase}/v1/audio/speech`))
    : 'https://api.openai.com/v1/audio/speech';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: selectedVoice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS Error (${res.status}): ${err}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
  return {
    audioBase64,
    mimeType: 'audio/mpeg',
    modelUsed: `openai:tts-1 (${selectedVoice})`,
  };
}

// Native Speech Synthesis for OpenRouter TTS (/api/v1/audio/speech)
export async function callOpenRouterTts(options: {
  apiKey: string;
  text: string;
  voiceName?: string;
  model?: string;
}): Promise<{ audioBase64: string; mimeType: string; modelUsed: string }> {
  const { apiKey, text, voiceName = 'alloy', model = 'openai/tts-1' } = options;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('OpenRouter API key missing for TTS');
  }

  const lowerVoice = (voiceName || '').toLowerCase();
  let selectedVoice = 'alloy';
  if (lowerVoice.includes('female') || ['kore', 'aoede', 'despina', 'leda', 'sarah', 'emily'].some(v => lowerVoice.includes(v))) {
    selectedVoice = 'nova';
  } else if (lowerVoice.includes('male') || ['fenrir', 'iapetus', 'orus', 'puck', 'lee', 'john'].some(v => lowerVoice.includes(v))) {
    selectedVoice = 'onyx';
  } else if (['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(lowerVoice)) {
    selectedVoice = lowerVoice;
  }

  const ttsModel = model || 'openai/tts-1';
  const endpoint = 'https://openrouter.ai/api/v1/audio/speech';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://toeflprepstudio.com',
      'X-Title': 'TOEFL Prep Studio',
    },
    body: JSON.stringify({
      model: ttsModel,
      input: text,
      voice: selectedVoice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter TTS Error (${res.status}): ${err}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
  return {
    audioBase64,
    mimeType: 'audio/mpeg',
    modelUsed: `openrouter:${ttsModel} (${selectedVoice})`,
  };
}

// Native Audio Transcription for Groq / OpenRouter / OpenAI Whisper
export async function callWhisperTranscription(options: {
  provider: 'groq' | 'openai' | 'openrouter';
  apiKey: string;
  audioBase64: string;
  mimeType?: string;
  sttModel?: string;
  prompt?: string;
}): Promise<{ transcript: string; modelUsed: string }> {
  const { provider, apiKey, audioBase64, mimeType = 'audio/webm', sttModel, prompt } = options;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`${provider.toUpperCase()} API key missing for transcription`);
  }

  const endpoint = provider === 'groq'
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';

  let model = (sttModel || '').trim();
  if (!model && provider === 'groq') {
    try {
      const chains = await resolveModelChains('groq', apiKey);
      model = chains.stt[0] || 'whisper-large-v3-turbo';
    } catch {
      model = 'whisper-large-v3-turbo';
    }
  }
  if (!model) {
    model = provider === 'groq' ? 'whisper-large-v3-turbo'
      : provider === 'openrouter' ? 'openai/whisper-large-v3'
      : 'whisper-1';
  }

  const buffer = Buffer.from(audioBase64, 'base64');
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'mp3';
  const fileBlob = new Blob([buffer], { type: mimeType });

  const formData = new FormData();
  formData.append('file', fileBlob, `speech.${ext}`);
  formData.append('model', model);
  formData.append('language', 'en');
  formData.append('temperature', '0');
  if (prompt && prompt.trim()) {
    formData.append('prompt', prompt.trim());
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.trim()}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://toeflprepstudio.com';
    headers['X-Title'] = 'TOEFL Prep Studio';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      if (isModelGone(res.status, errText)) {
        markModelDead(model);
      }
      throw new Error(`${provider.toUpperCase()} Whisper Error (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const rawTranscript = data.text || '';
    const { transcript } = filterWhisperHallucinations(rawTranscript);
    return { transcript, modelUsed: `${provider}:${model}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function testOpenAiCompatible(options: {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<{
  success: true;
  message: string;
  model: string;
  provider: string;
  providerName: string;
  generationModel?: string;
  evaluationModel?: string;
}> {
  const { provider, apiKey, baseUrl, model } = options;
  const p = (provider || 'custom').toLowerCase();
  const cleanKey = (apiKey || '').trim();

  let chains = { generation: [] as string[], evaluation: [] as string[], tts: [] as string[], stt: [] as string[], all: [] as string[] };
  if (cleanKey) {
    try {
      chains = await resolveModelChains(p, cleanKey, true);
    } catch {}
  }

  const pName = p === 'groq' ? 'Groq'
    : p === 'nvidia' ? 'NVIDIA NIM'
    : p === 'openrouter' ? 'OpenRouter'
    : p === 'openai' ? 'OpenAI'
    : p === 'deepseek' ? 'DeepSeek'
    : p === 'xai' ? 'xAI Grok'
    : p.toUpperCase();

  const customModel = model && model.trim() && model !== 'Auto-Routed by Purpose' && model !== 'Auto-Optimized' ? model.trim() : null;
  let candidates = customModel ? [customModel, ...chains.generation] : chains.generation;

  if (candidates.length === 0) {
    const fallback = resolveProviderDefaults(p, baseUrl, model, 'generation');
    if (fallback.model) candidates = [fallback.model];
  }

  const maxTries = p === 'openrouter' ? Math.min(3, candidates.length) : Math.min(5, candidates.length);
  const resolvedBase = baseUrl || resolveProviderDefaults(p, baseUrl, model, 'generation').baseUrl;
  const endpoint = `${resolvedBase.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cleanKey) {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }
  if (resolvedBase.includes('anthropic.com') || endpoint.includes('anthropic.com')) {
    if (cleanKey) {
      headers['x-api-key'] = cleanKey;
    }
    headers['anthropic-version'] = '2023-06-01';
  }
  if (endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://toeflprepstudio.com';
    headers['X-Title'] = 'TOEFL Prep Studio';
  }

  let lastErrorText = 'Connection failed';
  let lastStatus = 500;

  for (let i = 0; i < maxTries; i++) {
    const candidate = candidates[i];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: candidate,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        lastErrorText = errorText;
        lastStatus = res.status;
        if (isModelGone(res.status, errorText)) {
          markModelDead(candidate);
        }
        if (res.status === 401 || res.status === 403) {
          let parsedErr = errorText;
          try {
            const j = JSON.parse(errorText);
            parsedErr = j.error?.message || j.message || errorText;
          } catch {}
          const errObj = new Error(`${p.toUpperCase()} Connection Error (${res.status}): ${parsedErr}`);
          (errObj as any).status = res.status;
          throw errObj;
        }
        continue;
      }

      // Success
      const genModel = chains.generation[0] || candidate;
      const evalModel = chains.evaluation[0] || genModel;
      return {
        success: true,
        provider: p,
        providerName: pName,
        message: `Connected to ${pName}. Generation model: ${genModel}, Evaluation model: ${evalModel}.`,
        model: `${p}:${candidate}`,
        generationModel: genModel,
        evaluationModel: evalModel,
      };
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403) throw err;
      const status = err?.status || 500;
      const msg = err?.message || String(err);
      if (isModelGone(status, msg)) {
        markModelDead(candidate);
      }
      lastErrorText = msg;
      lastStatus = status;
      continue;
    }
  }

  let parsedErr = lastErrorText;
  try {
    const j = JSON.parse(lastErrorText);
    parsedErr = j.error?.message || j.message || lastErrorText;
  } catch {}
  const errObj = new Error(`${p.toUpperCase()} Connection Error (${lastStatus}): ${parsedErr}`);
  (errObj as any).status = lastStatus;
  throw errObj;
}
