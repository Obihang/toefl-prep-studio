import type { Request as ExpressReq, Response as ExpressRes } from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { head, put } from '@vercel/blob';
import { getApiConfig } from './apiConfig';
import { handleGenerateTask, handleTestApiKey, handleSynthesizeSpeech, synthesizeGeminiTts } from './geminiHandler';
import { handleEvaluateResponse } from './evaluationHandler';
import { callOpenAiTts } from './llmClient';
import { getRoleModels } from './modelRoles';
import { extractErrorMessage, isKeyError, isTransientError, getStatus, redactSensitiveInfo } from './geminiErrors';
import { STT_MODEL } from '../config/models';
import { filterWhisperHallucinations } from '../utils/speakingMetrics';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseDialogueLine, detectSpeakerGender, inferGender } from '../utils/voices';
import { firebasePublicConfig } from './firebasePublicConfig';
import os from 'os';
import WebSocket from 'ws';
import { synthesizeEdge, EdgeTtsError } from './edgeTts';

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: any): string {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }
  const realIp = req?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req?.socket?.remoteAddress || req?.ip || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  if (ipRateLimitMap.size > 2000) {
    for (const [k, v] of ipRateLimitMap.entries()) {
      if (now >= v.resetAt) ipRateLimitMap.delete(k);
    }
  }
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

export function wrapApiHandler<TReq = any, TRes = any>(
  handler: (req: TReq, res: TRes) => Promise<any> | any
): (req: TReq, res: TRes) => Promise<any> {
  return async (req: any, res: any) => {
    const requestId =
      (req?.headers?.['x-request-id'] as string) ||
      ('req-' + crypto.randomBytes(4).toString('hex'));
    const route = req?.url || req?.originalUrl || (req?.headers?.['x-forwarded-uri'] as string) || 'unknown';

    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
      return res.status(429).json({
        error: 'Too many requests, please try again later.',
        requestId,
      });
    }

    try {
      return await handler(req, res);
    } catch (rawError: any) {
      const status = getStatus(rawError) || 500;
      const rawMsg = extractErrorMessage(rawError) || rawError?.message || String(rawError);
      const redactedMsg = redactSensitiveInfo(rawMsg);

      // Log one structured line: route, status, requestId, redacted message (never headers or bodies)
      console.error(
        JSON.stringify({
          route,
          status,
          requestId,
          error: redactedMsg,
        })
      );

      if (!res.headersSent) {
        return res.status(status).json({
          error: redactedMsg,
          requestId,
        });
      }
    }
  };
}

export const FEMALE_VOICES = [
  "en-US-AvaNeural",
  "en-US-EmmaNeural",
  "en-US-AriaNeural",
  "en-US-JennyNeural",
  "en-US-MichelleNeural",
  "en-GB-SoniaNeural",
  "en-GB-LibbyNeural",
  "en-AU-NatashaNeural"
];

export const MALE_VOICES = [
  "en-US-AndrewNeural",
  "en-US-GuyNeural",
  "en-US-BrianNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
  "en-US-RogerNeural",
  "en-US-SteffanNeural",
  "en-GB-RyanNeural",
  "en-GB-ThomasNeural",
  "en-AU-WilliamNeural"
];

export const ALL_EDGE_VOICES = [...FEMALE_VOICES, ...MALE_VOICES];

type Req = ExpressReq | VercelRequest;
type Res = ExpressRes | VercelResponse;

interface CacheEntry {
  uid: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

async function verifyFirebaseToken(req: Req): Promise<string | null> {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || typeof authHeader !== 'string') return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const token = parts[1].trim();
  if (!token) return null;

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();

  const cached = tokenCache.get(tokenHash);
  if (cached && now < cached.expiresAt) {
    return cached.uid;
  }

  const apiKey = firebasePublicConfig.apiKey;
  if (!apiKey) return null;

  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idToken: token }),
    });

    if (!res.ok) {
      return null;
    }

    const data: any = await res.json();
    const localId = data?.users?.[0]?.localId;
    if (localId && typeof localId === 'string') {
      if (tokenCache.size >= 500) {
        const firstKey = tokenCache.keys().next().value;
        if (firstKey) tokenCache.delete(firstKey);
      }
      tokenCache.set(tokenHash, {
        uid: localId,
        expiresAt: now + 5 * 60 * 1000,
      });
      return localId;
    }
    return null;
  } catch {
    return null;
  }
}

// Allowed Edge voices allowlist including natural multi-speaker & professor voices
const ALLOWED_EDGE_VOICES = new Set([
  ...ALL_EDGE_VOICES,
  'en-US-AriaNeural',
  'en-US-JennyNeural',
  'en-US-MichelleNeural',
  'en-US-AnaNeural',
  'en-US-EmmaNeural',
  'en-US-GuyNeural',
  'en-US-ChristopherNeural',
  'en-US-EricNeural',
  'en-US-RogerNeural',
  'en-US-SteffanNeural',
  'en-US-AndrewNeural',
  'en-US-BrianNeural',
  'en-US-AvaNeural',
  'en-GB-SoniaNeural',
  'en-GB-LibbyNeural',
  'en-GB-RyanNeural',
  'en-GB-ThomasNeural',
]);

export function stripSpeakerAndFormatting(text: string): string {
  if (!text) return '';
  let cleaned = text.trim();

  // 1. Strip explicit speaker label prefixes (e.g. Speaker A, Student 1, Professor, Narrator, Woman, Man)
  cleaned = cleaned.replace(
    /^\s*(?:\*\*|__)?\[?\s*(?:Speaker\s*[A-Z0-9]*|Student\s*[A-Z0-9]*|Professor|Prof\.?\s*\w*|Doctor\s*\w*|Dr\.?\s*\w*|Narrator|Man|Woman|Male|Female|Interviewer|Participant|Person\s*[A-Z0-9]*|Faculty|Instructor|Advisor)\s*\]?(?:\s*\([^)]*\))?(?:\*\*|__)?\s*:\s*/gim,
    ''
  );

  // 2. Strip generic [Role]: or **Role**: if colon exists near start
  cleaned = cleaned.replace(/^\s*(?:\*\*|__)?\[?[A-Za-z0-9\s.]{1,30}\]?(?:\*\*|__)?\s*:\s*/, (match) => {
    if (
      /speaker|student|professor|prof|narrator|man|woman|male|female|interviewer|participant|advisor|instructor|dr\.|doctor|person/i.test(match) ||
      /^[A-Z0-9\s.]+:\s*$/.test(match)
    ) {
      return '';
    }
    return match;
  });

  // 3. Strip bracketed stage directions e.g. [laughs], [sighs], [applause], [pauses]
  cleaned = cleaned.replace(/\[[^\]]*\]/g, ' ');

  // 4. Strip parenthesized stage directions e.g. (pauses), (laughs), (clears throat)
  cleaned = cleaned.replace(/\((?:pauses?|sighs?|laughs?|chuckles?|clears throat|applause|cheering|coughing|sound|music|gasp|whispering|shouting|silence|interrupted)\)/gi, ' ');

  // 5. Strip markdown formatting and prosody chunking bars (*, **, _, __, #, `, >, |)
  cleaned = cleaned.replace(/[*_#`>|]+/g, ' ');

  // 6. Clean up whitespace
  return cleaned.replace(/\s+/g, ' ').trim();
}

const BLOB_DOMAIN_SUFFIX = 'blob.vercel-storage.com';

export async function handleHealth(req: Req, res: Res) {
  return res.status(200).json({
    status: 'ok',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    version: process.env.npm_package_version || '1.0.0',
  });
}

export async function handleModelsEndpoint(req: Req, res: Res) {
  const apiKey = (
    req.headers['x-gemini-key'] ||
    req.headers['x-gemini-api-key'] ||
    req.headers['x-api-key'] ||
    req.headers['authorization'] ||
    ''
  )
    .toString()
    .replace('Bearer ', '')
    .trim();
  const provider = (req.headers['x-api-provider'] || 'gemini').toString();
  const roleData = await getRoleModels(provider, apiKey);
  return res.status(200).json({
    success: true,
    models: roleData.all,
    generationModel: roleData.generationModel,
    evaluationModel: roleData.evaluationModel,
  });
}

export async function handleTestKeyEndpoint(req: Req, res: Res) {
  try {
    const config = getApiConfig(req.headers, req.body);
    const result = await handleTestApiKey(config);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Test key error:', redactSensitiveInfo(error));
    const status = getStatus(error) || 400;
    return res.status(status).json({ success: false, error: redactSensitiveInfo(extractErrorMessage(error)) });
  }
}

export async function handleGenerateTaskEndpoint(req: Req, res: Res) {
  try {
    const config = getApiConfig(req.headers, req.body) as any;
    const isStrict = Boolean(config.strictProvider || req.body?.strictProvider);
    const groqKey =
      isStrict && config.provider !== 'groq'
        ? ''
        : (req.headers['x-groq-key'] as string) ||
          (config.provider === 'groq' ? config.apiKey : '') ||
          process.env.GROQ_API_KEY ||
          '';
    const { taskType, level, topic, promptData, coachMode } = req.body || {};
    const mergedConfig = {
      ...config,
      ...(groqKey ? { groqKey } : {}),
      strictProvider: isStrict,
      coachMode: Boolean(coachMode || promptData?.coachMode),
    };
    const result = await handleGenerateTask(taskType, level, topic, mergedConfig, promptData);
    const providerUsed = (result as any)?.providerUsed || config.provider;
    return res.status(200).json({
      success: true,
      providerUsed,
      data: { ...result, providerUsed },
    });
  } catch (error: any) {
    console.error('Generate task error:', redactSensitiveInfo(error));
    const status = getStatus(error) || 500;
    return res.status(status).json({ success: false, error: redactSensitiveInfo(extractErrorMessage(error)) });
  }
}

export async function handleEvaluateResponseEndpoint(req: Req, res: Res) {
  try {
    const config = getApiConfig(req.headers, req.body) as any;
    const isStrict = Boolean(config.strictProvider || req.body?.strictProvider);
    const groqKey =
      isStrict && config.provider !== 'groq'
        ? ''
        : (req.headers['x-groq-key'] as string) ||
          (config.provider === 'groq' ? config.apiKey : '') ||
          process.env.GROQ_API_KEY ||
          '';
    const mergedConfig = {
      ...config,
      ...(groqKey ? { groqKey } : {}),
      strictProvider: isStrict,
    };
    const { taskType, promptData, studentResponse } = req.body || {};
    const result = await handleEvaluateResponse(taskType, promptData, studentResponse, mergedConfig);
    const providerUsed = (result as any)?.providerUsed || config.provider;
    return res.status(200).json({
      success: true,
      providerUsed,
      data: { ...result, providerUsed },
    });
  } catch (error: any) {
    console.error('Evaluate response error:', redactSensitiveInfo(error));
    const status = getStatus(error) || 500;
    return res.status(status).json({ success: false, error: redactSensitiveInfo(extractErrorMessage(error)) });
  }
}

export async function handleSttEndpoint(req: Req, res: Res) {
  const apiConfig = getApiConfig(req.headers, req.body);
  const groqKey = (req.headers['x-groq-key'] as string) || (apiConfig.provider === 'groq' ? apiConfig.apiKey : '');

  if (!groqKey || !groqKey.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Groq API key required for Whisper speech-to-text. Paste your Groq key in Dashboard > Settings.',
    });
  }

  try {
    const { audioBase64, mimeType = 'audio/webm', prompt } = req.body || {};
    if (!audioBase64) {
      return res.status(400).json({ success: false, error: 'No audio data provided' });
    }

    // Server-side size check (max 4.5 MB for Vercel / serverless limits)
    const approxBytes = (audioBase64.length * 3) / 4;
    if (approxBytes > 4.5 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Audio recording exceeds 4.5 MB limit (approx 90 seconds max)' });
    }

    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const fileBlob = new Blob([buffer], { type: mimeType });

    const formData = new FormData();
    formData.append('file', fileBlob, `recording.${ext}`);
    formData.append('model', STT_MODEL);
    formData.append('language', 'en');
    formData.append('temperature', '0');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    if (prompt && typeof prompt === 'string') {
      formData.append('prompt', prompt.trim());
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey.trim()}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        console.error('Groq Whisper STT error:', redactSensitiveInfo(errText));
        return res.status(groqRes.status).json({
          success: false,
          error: redactSensitiveInfo(`Groq Whisper STT error (${groqRes.status}): ${errText}`),
        });
      }

      const data: any = await groqRes.json();
      const rawWords = Array.isArray(data.words)
        ? data.words.map((w: any) => ({
            word: String(w.word || '').trim(),
            start: Number(w.start || 0),
            end: Number(w.end || 0),
          }))
        : [];

      const rawTranscript = String(data.text || '').trim();
      const { transcript, words } = filterWhisperHallucinations(rawTranscript, rawWords);

      return res.status(200).json({
        success: true,
        transcript,
        words,
        duration: Number(data.duration || 0),
        modelUsed: `Groq ${STT_MODEL}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    console.error('STT endpoint error:', redactSensitiveInfo(error));
    const msg = redactSensitiveInfo(error?.message || 'Speech-to-text processing failed');
    return res.status(500).json({ success: false, error: msg });
  }
}

function splitTextIntoSentences(text: string, maxLen = 180): string[] {
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];

  for (const raw of sentences) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLen) {
      chunks.push(trimmed);
    } else {
      const words = trimmed.split(/\s+/);
      let current = '';
      for (const word of words) {
        if ((current + ' ' + word).trim().length <= maxLen) {
          current = (current + ' ' + word).trim();
        } else {
          if (current) chunks.push(current);
          current = word;
        }
      }
      if (current) chunks.push(current);
    }
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

async function synthesizeWithZeroKeyFetch(
  text: string,
  speakerNameOrGender: string,
  genderOrSelectedVoice?: string,
  voiceNameArg?: string
): Promise<{ buffer: Buffer; modelUsed: string } | null> {
  // Support both 3-arg (text, gender, selectedVoice) and 4-arg (text, speakerName, gender, selectedVoice) signatures
  let speakerName = '';
  let gender = '';
  let voiceName = '';

  if (
    voiceNameArg !== undefined ||
    genderOrSelectedVoice === 'male' ||
    genderOrSelectedVoice === 'female'
  ) {
    speakerName = speakerNameOrGender || '';
    gender = (genderOrSelectedVoice || '').toLowerCase();
    voiceName = (voiceNameArg || '').trim();
  } else {
    gender = (speakerNameOrGender || '').toLowerCase();
    voiceName = (genderOrSelectedVoice || '').trim();
  }

  let selectedVoice = '';
  if (voiceName && ALLOWED_EDGE_VOICES.has(voiceName)) {
    selectedVoice = voiceName;
  } else {
    const isMale =
      gender === 'male' ||
      (voiceName ? MALE_VOICES.includes(voiceName) : false) ||
      (gender !== 'female' && Boolean(speakerName && detectSpeakerGender(speakerName) === 'male'));
    const pool = isMale ? MALE_VOICES : FEMALE_VOICES;
    const absHash = Math.abs(
      text.split('').reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0)
    );
    selectedVoice = pool[absHash % pool.length] || (isMale ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural');
  }

  try {
    const buffer = await synthesizeEdge(text, selectedVoice);
    if (buffer && buffer.length > 500) {
      return {
        buffer,
        modelUsed: `Edge TTS (${selectedVoice})`,
      };
    }
  } catch (err) {
    console.error('Edge TTS synthesis failed:', err instanceof EdgeTtsError ? `${err.step}: ${err.message} (status: ${err.status})` : String(err));
    throw err;
  }

  return null;
}

export async function handleTtsEndpoint(req: Req, res: Res) {
  try {
    // Verify token if present, but do NOT block guests practicing tasks without login
    let uid: string | null = null;
    try {
      uid = await verifyFirebaseToken(req);
    } catch {
      // Ignored for guest mode
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const text = body.text || '';
    const customVoice = (body.voice || body.voiceName || '').toString().trim();
    const voiceName = customVoice;
    const speaker = body.speaker || '';
    const rate = body.rate || 1.0;

    if (!text || typeof text !== 'string' || text.trim().length === 0 || text.length > 3000) {
      return res.status(400).json({ success: false, error: 'Text must be between 1 and 3000 characters for TTS synthesis' });
    }

    const numRate = Number(rate);
    if (isNaN(numRate) || numRate < 0.7 || numRate > 1.3) {
      return res.status(400).json({ success: false, error: 'Speech rate must be between 0.7 and 1.3' });
    }

    // TTS Provider headers:
    const ttsProvider = (req.headers['x-tts-provider'] || '').toString().trim().toLowerCase();
    const ttsApiKey = (req.headers['x-tts-api-key'] || '').toString().trim();
    const ttsBaseUrl = (req.headers['x-tts-base-url'] || '').toString().trim();

    // Legacy headers fallback
    const userApiKey = (req.headers['x-api-key'] || req.headers['x-gemini-api-key'] || '').toString().trim();
    const voiceApiKey = (req.headers['x-voice-api-key'] || '').toString().trim();
    const provider = (req.headers['x-api-provider'] || '').toString().trim().toLowerCase();

    const isTest = req.headers['x-tts-test'] === 'true';

    const reqGender = (body.gender || (body.isMale === true ? 'male' : body.isMale === false ? 'female' : '')).toString().toLowerCase();
    const isMaleExplicit = body.isMale === true || reqGender === 'male';
    const isFemaleExplicit = body.isMale === false || reqGender === 'female';
    let isMale =
      isMaleExplicit ||
      (!isFemaleExplicit &&
        (MALE_VOICES.includes(customVoice) ||
          /Male|Guy|Christopher|Eric|Andrew|Brian|Ryan|Thomas|William|Roger|Steffan|onyx|alloy|Puck/i.test(voiceName || speaker)));
    let cleanText = text;
    const prefixMatch = text.match(/^\s*(?:\*\*|__)?([A-Z][a-zA-Z0-9.\s'-]{0,28}?)(?:\s*\(([^)]+)\))?(?:\*\*|__)?\s*:/i);
    if (prefixMatch) {
      const pSpeakerName = prefixMatch[1].trim();
      const pSpeakerHint = prefixMatch[2] ? prefixMatch[2].trim() : '';
      if (!isFemaleExplicit && (detectSpeakerGender(pSpeakerName, pSpeakerHint) === 'male' || /\bmale\b/i.test(pSpeakerHint))) {
        isMale = true;
      } else if (detectSpeakerGender(pSpeakerName, pSpeakerHint) === 'female' || /\bfemale\b/i.test(pSpeakerHint)) {
        if (!isMaleExplicit) isMale = false;
      }
      cleanText = text.replace(/^\s*(?:\*\*|__)?(?:[A-Z][a-zA-Z0-9.\s'-]{0,28}?)(?:\s*\([^)]+\))?(?:\*\*|__)?\s*:\s*/i, '').trim();
    }
    const speakerName = speaker || (prefixMatch ? prefixMatch[1].trim() : '');
    const speakerHint = body.speakerHint || (prefixMatch ? (prefixMatch[2] || '') : '');
    if (!isMale && !isFemaleExplicit && (detectSpeakerGender(speakerName, speakerHint) === 'male' || /\bmale\b/i.test(speakerHint))) {
      isMale = true;
    }

    if (!cleanText) {
      return res.status(200).json({
        success: true,
        audioBase64: '',
        audioUrl: undefined,
        mimeType: 'audio/mpeg',
        modelUsed: 'Empty text',
      });
    }

    const reqVoice = customVoice;

    let selectedVoice = '';
    if (
      reqVoice &&
      (ALLOWED_EDGE_VOICES.has(reqVoice) ||
        FEMALE_VOICES.includes(reqVoice) ||
        MALE_VOICES.includes(reqVoice) ||
        /^en-[A-Z]{2}-[A-Za-z]+Neural$/.test(reqVoice))
    ) {
      selectedVoice = reqVoice;
    } else if (reqGender === 'male' || reqGender === 'female') {
      const pool = reqGender === 'male' ? MALE_VOICES : FEMALE_VOICES;
      selectedVoice = pool[0];
    } else {
      const gender = isMale ? 'male' : detectSpeakerGender(speakerName, prefixMatch ? (prefixMatch[2] || '') : '');
      const pool = gender === 'male' ? MALE_VOICES : FEMALE_VOICES;
      selectedVoice = pool[0];
    }

    isMale = MALE_VOICES.includes(selectedVoice) || (reqGender === 'male' && !FEMALE_VOICES.includes(selectedVoice));

    const pitch = (body.pitch || '0Hz').toString().trim();
    const ratePercent = Math.round((numRate - 1.0) * 100);
    const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

    const hash = crypto
      .createHash('sha256')
      .update(`${cleanText}:::${selectedVoice}:::${pitch}:::${rateStr}`)
      .digest('hex');

    const blobPath = `toefl-tts/${hash}.mp3`;
    let audioUrl: string | undefined;

    // Check Vercel Blob existence via head() if BLOB_READ_WRITE_TOKEN is configured (strictly bypass cache during tests)
    if (!isTest && process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blobInfo = await head(blobPath);
        if (blobInfo && blobInfo.url && blobInfo.url.includes(BLOB_DOMAIN_SUFFIX)) {
          audioUrl = blobInfo.url;
        }
      } catch {}
    }

    if (!isTest && audioUrl) {
      return res.status(200).json({
        success: true,
        audioUrl,
        mimeType: 'audio/mpeg',
        modelUsed: `Cached Voice (${selectedVoice})`,
        providerUsed: 'cached',
        hash,
        cached: true,
        isMale,
      });
    }

    let audioBuffer: Buffer | null = null;
    let mimeType = 'audio/mpeg';
    let modelUsed = `Neural Stream (${selectedVoice})`;
    let providerUsed = 'fallback';

    const requestedProvider = ttsProvider || provider;
    const customKey = ttsApiKey || voiceApiKey || (requestedProvider === 'openai' ? userApiKey : '');
    const gender = isMale ? 'male' : 'female';

    // Stage 1: Explicit custom OpenAI TTS when requestedProvider === 'openai' and customKey is provided
    if (requestedProvider === 'openai' && customKey) {
      try {
        const openaiVoice = gender === 'male' ? 'onyx' : 'nova';
        const openaiUrl = ttsBaseUrl
          ? `${ttsBaseUrl.replace(/\/+$/, '')}/audio/speech`
          : 'https://api.openai.com/v1/audio/speech';
        const openaiRes = await fetch(openaiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${customKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1',
            voice: openaiVoice,
            input: cleanText,
          }),
        });
        if (openaiRes.ok) {
          const arrayBuffer = await openaiRes.arrayBuffer();
          if (arrayBuffer && arrayBuffer.byteLength > 0) {
            audioBuffer = Buffer.from(arrayBuffer);
            mimeType = 'audio/mpeg';
            modelUsed = `OpenAI tts-1 (${openaiVoice})`;
            providerUsed = 'openai';
          }
        }
      } catch (openaiErr) {
        console.warn('Custom OpenAI TTS failed, falling back to Edge TTS:', redactSensitiveInfo(openaiErr));
      }
    }

    // Stage 2: Guaranteed Zero-Dependency Node fetch MP3 stream (Zero-key synthesis)
    if (!audioBuffer || audioBuffer.length === 0) {
      const zeroKeyRes = await synthesizeWithZeroKeyFetch(cleanText, speakerName, gender, selectedVoice || customVoice);
      if (zeroKeyRes) {
        audioBuffer = zeroKeyRes.buffer;
        mimeType = 'audio/mpeg';
        modelUsed = zeroKeyRes.modelUsed;
      }
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(502).json({
        success: false,
        error: 'EDGE_TTS_FAILED',
        detail: 'Speech synthesis temporarily unavailable.'
      });
    }

    const audioBase64 = audioBuffer.toString('base64');

    // Try uploading to Vercel Blob
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blob = await put(blobPath, audioBuffer, {
          access: 'public',
          addRandomSuffix: false,
        });
        if (blob && blob.url && blob.url.includes(BLOB_DOMAIN_SUFFIX)) {
          audioUrl = blob.url;
        }
      } catch (uploadErr) {
        console.warn('Vercel Blob upload failed:', redactSensitiveInfo(uploadErr));
      }
    }

    return res.status(200).json({
      success: true,
      audioBase64: audioUrl ? undefined : audioBase64,
      audioUrl: audioUrl,
      mimeType,
      modelUsed,
      providerUsed,
      hash,
      cached: false,
      isMale,
    });
  } catch (error: any) {
    const isEdgeError = error instanceof EdgeTtsError;
    console.error('TTS endpoint error:', isEdgeError ? error : redactSensitiveInfo(error));
    return res.status(502).json({ 
      success: false, 
      error: 'EDGE_TTS_FAILED', 
      detail: isEdgeError ? `${error.step}: ${error.message} (status: ${error.status})` : redactSensitiveInfo(error?.message || 'TTS synthesis failed')
    });
  }
}
export { handleTtsCheckEndpoint } from './api/tts-check';

function getDictionaryCandidates(rawWord: string): string[] {
  const w = rawWord.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (!w) return [];
  const candidates: string[] = [w];

  // 1. If ending in 'ies' -> w.slice(0, -3) + 'y' (e.g. cavities -> cavity)
  if (w.endsWith('ies') && w.length > 4) {
    candidates.push(w.slice(0, -3) + 'y');
  }
  // 2. If ending in 'es' -> w.slice(0, -2) and w.slice(0, -1) (e.g. classes -> class, boxes -> box, juices -> juice)
  if (w.endsWith('es') && w.length > 3) {
    candidates.push(w.slice(0, -2));
    candidates.push(w.slice(0, -1));
  }
  // 3. If ending in 's' (and not 'ss', 'us', 'is') -> w.slice(0, -1) (e.g. fosters -> foster)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3) {
    candidates.push(w.slice(0, -1));
  }
  // 4. If ending in 'ed' -> w.slice(0, -2) and w.slice(0, -1) (e.g. juxtaposed -> juxtapose, mitigated -> mitigate)
  if (w.endsWith('ed') && w.length > 4) {
    candidates.push(w.slice(0, -2));
    candidates.push(w.slice(0, -1));
    if (w.length > 5 && w[w.length - 3] === w[w.length - 4]) {
      candidates.push(w.slice(0, -3)); // stopped -> stop
    }
  }
  // 5. If ending in 'ing' -> w.slice(0, -3) and w.slice(0, -3) + 'e' (e.g. fostering -> foster, making -> make)
  if (w.endsWith('ing') && w.length > 5) {
    candidates.push(w.slice(0, -3));
    candidates.push(w.slice(0, -3) + 'e');
    if (w.length > 6 && w[w.length - 4] === w[w.length - 5]) {
      candidates.push(w.slice(0, -4)); // running -> run
    }
  }
  // 6. If ending in 'ly' -> w.slice(0, -2) (e.g. empirically -> empirical)
  if (w.endsWith('ly') && w.length > 4) {
    candidates.push(w.slice(0, -2));
  }

  return Array.from(new Set(candidates.filter((c) => c && c.length >= 2)));
}

function cleanHtmlAndEntities(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>?/gm, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&[a-z]+;/gi, '')
    .replace(/^\([^)]+\)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function handleDictionaryEndpoint(req: Req, res: Res) {
  const { word } = req.query;
  if (!word || typeof word !== 'string') return res.status(400).json({ success: false, error: 'Word required' });
  const rawClean = word.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (!rawClean) return res.status(400).json({ success: false, error: 'Valid word required' });

  const candidates = getDictionaryCandidates(rawClean);

  const isArchaicOrPlato = (def: string) =>
    /\b(plato|platonist|sect|obsolete|archaic|historical|dated|rare|misspelling of|alternative form of|urine)\b/i.test(def);
  const scoreDefinition = (definition: string): number => {
    if (!definition) return -100;
    const d = definition.toLowerCase();
    let score = 0;
    const penaltyRegex = /\b(slang|music|hip-hop|african american|informal|derogatory|obsolete|archaic|historical|dated|rare|vulgar|offensive|colloquial|jargon|surname|given name|christian|bible|sect|plato|platonist|misspelling of|alternative form of|urine)\b/gi;
    const penalties = d.match(penaltyRegex);
    if (penalties) score -= 50 * penalties.length;
    const rewardKeywords = [
      'city', 'town', 'relating to', 'characteristic of', 'study of',
      'process', 'system', 'science', 'art', 'education', 'learning',
      'school', 'university', 'pertaining to', 'denoting', 'constituting',
      'scholarly', 'institution', 'principle', 'method', 'theory',
      'living in', 'inhabitant'
    ];
    for (const kw of rewardKeywords) {
      if (d.includes(kw)) score += 10;
    }
    return score;
  };

  // Step 1: Try dictionaryapi.dev for the exact word first, then stem/lemma candidates
  for (const cand of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cand)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data[0] && Array.isArray(data[0].meanings)) {
          const meanings: Array<{ partOfSpeech: string; definition: string; example: string }> = [];
          for (const m of data[0].meanings) {
            const pos = String(m.partOfSpeech || 'noun').toLowerCase();
            for (const d of (m.definitions || [])) {
              if (!d.definition) continue;
              const cleanDef = cleanHtmlAndEntities(String(d.definition));
              if (cleanDef.split(/\s+/).length <= 1) continue;
              if (/(obsolete|archaic|dated|rare|misspelling of|alternative form of|urine)/i.test(cleanDef)) continue;
              meanings.push({
                partOfSpeech: pos,
                definition: cleanDef,
                example: typeof d.example === 'string' ? cleanHtmlAndEntities(d.example) : '',
              });
            }
          }

          if (meanings.length > 0) {
            const modernMeanings = meanings.filter((m) => !isArchaicOrPlato(m.definition));
            const finalMeanings = (modernMeanings.length > 0 ? modernMeanings : meanings).sort((a, b) => {
              const aScore = scoreDefinition(a.definition);
              const bScore = scoreDefinition(b.definition);
              if (aScore !== bScore) return bScore - aScore;
              if (a.example && !b.example) return -1;
              if (!a.example && b.example) return 1;
              return 0;
            });

            return res.json({
              word: cand,
              lookupWord: rawClean,
              meanings: finalMeanings.slice(0, 4),
              phonetic: data[0].phonetic || data[0].phonetics?.find((p: any) => p.text)?.text || '',
              source: 'dictionaryapi',
            });
          }
        }
      }
    } catch {
      // continue to next candidate
    }
  }

  // Step 2: Fallback to Wikimedia Wiktionary REST for candidate words
  for (const cand of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(cand)}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TOEFLPrepStudio/1.0 (educational app)' }
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        const enEntries = data.en || [];
        const meanings: Array<{ partOfSpeech: string; definition: string; example: string }> = [];
        for (const entry of enEntries) {
          const pos = String(entry.partOfSpeech || 'noun').toLowerCase();
          for (const defObj of (entry.definitions || [])) {
            const defHtml = defObj.definition || '';
            const cleanDef = cleanHtmlAndEntities(defHtml);
            // Skip 1-word stub lines and empty lines
            if (!cleanDef || cleanDef.split(/\s+/).length <= 1) continue;
            if (/(obsolete|archaic|dated|rare|misspelling of|alternative form of)/i.test(cleanDef)) continue;
            meanings.push({
              partOfSpeech: pos,
              definition: cleanDef,
              example: '',
            });
          }
        }
        if (meanings.length > 0) {
          return res.json({
            word: cand,
            lookupWord: rawClean,
            meanings: meanings.slice(0, 3),
            source: 'wiktionary_rest',
          });
        }
      }
    } catch {
      // continue
    }
  }

  // Step 3: Datamuse fallback
  for (const cand of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(cand)}&md=dprs&max=5`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          const meanings: Array<{ partOfSpeech: string; definition: string; example: string }> = [];
          for (const item of data) {
            if (!item.word || item.word.toLowerCase() !== cand) continue;
            if (!Array.isArray(item.defs)) continue;

            for (const defStr of item.defs) {
              const parts = defStr.split('\t');
              if (parts.length < 2) continue;
              const posCode = parts[0].trim().toLowerCase();
              const defText = cleanHtmlAndEntities(parts[1]);
              if (!defText || defText.split(/\s+/).length <= 1) continue;
              if (/(obsolete|archaic|dated|rare|misspelling of|alternative form of|urine)/i.test(defText)) continue;

              const posMap: Record<string, string> = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'noun' };
              meanings.push({
                partOfSpeech: posMap[posCode] || posCode || 'noun',
                definition: defText,
                example: '',
              });
            }
          }
          if (meanings.length > 0) {
            return res.json({
              word: cand,
              lookupWord: rawClean,
              meanings: meanings.slice(0, 3),
              source: 'datamuse',
            });
          }
        }
      }
    } catch {
      // continue
    }
  }

  return res.status(404).json({ success: false, error: 'Word not found' });
}
