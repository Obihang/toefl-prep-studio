import {
  getApiHeaders,
  getStoredProvider,
  getStoredApiKey,
  getStoredVoiceKey,
  getStoredTtsProvider,
  setStoredTtsProvider,
  getStoredTtsApiKey,
  setStoredTtsApiKey,
  getStoredTtsBaseUrl,
  setStoredTtsBaseUrl,
} from './apiKey';
export {
  getStoredTtsProvider,
  setStoredTtsProvider,
  getStoredTtsApiKey,
  setStoredTtsApiKey,
  getStoredTtsBaseUrl,
  setStoredTtsBaseUrl,
};
import { getAuthHeaders } from './apiKey';
import { isRiffWav, parseSampleRateFromMime, stitchTranscripts } from './audioHelpers';
import { parseDialogueLine, detectSpeakerGender, DialogueVoiceManager, inferGender, getBrowserSpeechPitchAndRate } from './voices';
import { filterWhisperHallucinations, calculateSpeakingMetrics, calculateWpm, detectFillerWords, calculatePauses } from './audio/fluencyMetrics';
import { mergeCompoundWords } from './phoneticMatcher';
import type { SpeakingMetrics, WordTimestamp } from './audio/fluencyMetrics';
import { calculateAudioLevel, calculateRms, calculateDbfs, trimPcmSilence, trimAudioSilence, applyNoiseGate } from './audio/audioProcessing';
export * from './audio/audioProcessing';
export * from './audio/fluencyMetrics';
import { isWhisperWorkerBusy, transcribeWithLocalWhisper } from './localWhisperStt';
import {
  recordVoiceEngineFailure,
  recordVoiceEngineSuccess,
  resetVoiceEngineFailureCounts,
} from './voiceDiagnostics';

export interface SpeechVoiceOption {
  name: string;
  lang: string;
  default: boolean;
}

export const MALE_NEURAL_VOICES = [
  'en-US-ChristopherNeural',
  'en-US-GuyNeural',
  'en-US-AndrewNeural',
  'en-US-BrianNeural',
  'en-GB-RyanNeural',
  'en-GB-ThomasNeural',
  'en-AU-WilliamNeural',
];

export const FEMALE_NEURAL_VOICES = [
  'en-US-AriaNeural',
  'en-US-JennyNeural',
  'en-US-AvaNeural',
  'en-US-EmmaNeural',
  'en-GB-SoniaNeural',
  'en-GB-LibbyNeural',
  'en-AU-NatashaNeural',
];

const COMMON_FEMALE_NAMES = new Set([
  'sarah', 'emily', 'jessica', 'rachel', 'hannah', 'olivia', 'sophia', 'emma', 'claire', 'chloe',
  'megan', 'lauren', 'amanda', 'samantha', 'ashley', 'nicole', 'elizabeth', 'stephanie', 'rebecca',
  'katherine', 'anna', 'maria', 'lisa', 'laura', 'michelle', 'kimberly', 'amy', 'angela', 'melissa',
  'brenda', 'elena', 'maya', 'priya', 'lin', 'zoe', 'nina', 'alice', 'diana', 'victoria', 'natalie',
  'grace', 'lily', 'haley', 'julia', 'jenny', 'aria', 'sonia', 'libby', 'ava', 'susan', 'karen',
  'nancy', 'betty', 'helen', 'sandra', 'donna', 'carol', 'ruth', 'sharon', 'cynthia', 'kathleen',
  'deborah', 'shirley', 'catherine', 'christine', 'janet', 'debra', 'carolyn', 'heather', 'diane',
  'julie', 'joyce', 'kelly', 'christina', 'joan', 'evelyn', 'judith', 'andrea', 'cheryl', 'marilyn',
]);

const COMMON_MALE_NAMES = new Set([
  'michael', 'david', 'john', 'james', 'robert', 'william', 'richard', 'thomas', 'charles', 'daniel',
  'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua', 'kenneth', 'kevin',
  'brian', 'george', 'timothy', 'ronald', 'edward', 'jason', 'jeffrey', 'ryan', 'jacob', 'gary',
  'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin', 'scott', 'brandon', 'benjamin',
  'samuel', 'gregory', 'alexander', 'patrick', 'frank', 'raymond', 'jack', 'dennis', 'jerry',
  'tyler', 'aaron', 'jose', 'adam', 'nathan', 'henry', 'douglas', 'zachary', 'peter', 'kyle',
  'ethan', 'walter', 'noah', 'jeremy', 'christian', 'keith', 'roger', 'terry', 'gerald', 'harold',
  'sean', 'austin', 'carl', 'arthur', 'lawrence', 'dylan', 'jesse', 'jordan', 'bryan', 'billy',
  'joe', 'bruce', 'gabriel', 'logan', 'albert', 'willie', 'alan', 'juan', 'wayne', 'elijah',
  'randy', 'roy', 'vincent', 'ralph', 'eugene', 'russell', 'bobby', 'mason', 'philip', 'louis',
  'marcus', 'leo', 'carlos', 'omar', 'chen', 'raj', 'liam', 'lucas', 'alex', 'sam', 'ben', 'tom',
  'dan', 'matt', 'chris', 'nick', 'mike', 'dave', 'steve', 'jim', 'bob', 'bill', 'ted', 'christopher',
  'guy', 'steffan',
]);

export function inferGenderFromSpeaker(speakerLabelOrName: string): 'male' | 'female' | null {
  if (!speakerLabelOrName) return null;
  const lower = speakerLabelOrName.toLowerCase();

  // Check explicit gender markers or titles first (check female before male)
  if (/\b(female|woman|girl|ms\.?|mrs\.?|miss|she|her|chairwoman|spokeswoman|actress|waitress|mother|sister|daughter|lady|madam)\b/i.test(lower)) {
    return 'female';
  }
  if (/\b(male|man|boy|mr\.?|he|him|his|chairman|spokesman|actor|waiter|father|brother|son|gentleman|sir)\b/i.test(lower)) {
    return 'male';
  }

  // Strip generic role words so names inside "Emma (Student)" or "Student: Emma" are matched cleanly
  const cleaned = lower.replace(
    /\b(student|professor|prof|doctor|dr|advisor|librarian|instructor|dean|staff|speaker|narrator|interviewer|participant|coach|assistant|receptionist|lecturer|undergraduate|classmate|peer)\b/gi,
    ' '
  );

  // Tokenize words and check against name sets (stripping optional 'neural' suffix)
  const tokens = cleaned.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/neural$/i, '');
    if (COMMON_FEMALE_NAMES.has(token)) return 'female';
    if (COMMON_MALE_NAMES.has(token)) return 'male';
  }

  const detected = detectSpeakerGender(speakerLabelOrName);
  if (detected === 'female' || detected === 'male') {
    return detected;
  }

  return null;
}

export function pickRandomVoice(
  gender?: 'male' | 'female',
  excludeVoice?: string,
  seed?: string
): { gender: 'male' | 'female'; voiceId: string } {
  const resolvedGender: 'male' | 'female' =
    gender === 'male' || gender === 'female' ? gender : 'female';

  const basePool = resolvedGender === 'male' ? MALE_NEURAL_VOICES : FEMALE_NEURAL_VOICES;
  const filteredPool =
    excludeVoice && basePool.length > 1
      ? basePool.filter((v) => v !== excludeVoice)
      : basePool;

  if (seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const voiceId = filteredPool[hash % filteredPool.length] || basePool[0];
    return { gender: resolvedGender, voiceId };
  }

  const voiceId = filteredPool[0] || basePool[0];
  return { gender: resolvedGender, voiceId };
}

export async function speakWithCloudTTS(
  text: string,
  gender?: 'male' | 'female',
  options?: PlaySpeechOptions,
  specificVoiceId?: string
): Promise<void> {
  const voice = specificVoiceId || options?.voice || options?.voiceName;
  return playSpeech(text, {
    ...options,
    gender: gender || options?.gender,
    voice,
    voiceName: voice,
  });
}

let cachedVoices: SpeechSynthesisVoice[] = [];
const activeUtterances = new Set<SpeechSynthesisUtterance>();
let activeHtmlAudio: HTMLAudioElement | null = null;
let activeAudioCancel: (() => void) | null = null;
let activeFallbackCancel: (() => void) | null = null;
let activeFetchController: AbortController | null = null;
let currentDialogueSessionId = 0;
let isAudioPlayingState = false;
import { openDB } from 'idb';

const DB_NAME = 'toefl_tts_audio_cache';
const DB_VERSION = 1;
const STORE_NAME = 'toefl_tts_audio_cache';
const MAX_IDB_AUDIO_CLIPS = 60;

// Immediately purge any stale cached audio blobs containing preambles
if (typeof window !== 'undefined' && 'indexedDB' in window) {
  try {
    indexedDB.deleteDatabase('toefl_tts_cache');
    indexedDB.deleteDatabase('toefl_tts_cache_v1');
    indexedDB.deleteDatabase('toefl_tts_cache_v2');
    indexedDB.deleteDatabase('toefl_tts_cache_v3');
    indexedDB.deleteDatabase('toefl_tts_cache_v4');
  } catch {}
}

const dbPromise =
  typeof window !== 'undefined' && 'indexedDB' in window
    ? openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        },
      })
    : Promise.resolve(null as any);

function base64ToAudioBlob(base64: string, mimeType: string = 'audio/mpeg'): Blob {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function blobToBase64String(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

async function persistAudioClipToIdb(
  key: string,
  entry: {
    blob: Blob;
    base64?: string;
    mimeType?: string;
    engine?: string;
    audioUrl?: string;
  }
): Promise<void> {
  try {
    const db = await dbPromise;
    if (!db) return;
    await db.put(
      STORE_NAME,
      {
        ...entry,
        updatedAt: Date.now(),
      },
      key
    );

    // Keep only the most recent 60 audio clips in IndexedDB
    const allKeys = await db.getAllKeys(STORE_NAME);
    if (allKeys.length > MAX_IDB_AUDIO_CLIPS) {
      const entriesWithTime: Array<{ key: IDBValidKey; updatedAt: number }> = [];
      for (const k of allKeys) {
        const val = await db.get(STORE_NAME, k);
        entriesWithTime.push({
          key: k,
          updatedAt: Number(val?.updatedAt || 0),
        });
      }
      entriesWithTime.sort((a, b) => a.updatedAt - b.updatedAt);
      const toDeleteCount = entriesWithTime.length - MAX_IDB_AUDIO_CLIPS;
      for (let i = 0; i < toDeleteCount; i++) {
        await db.delete(STORE_NAME, entriesWithTime[i].key);
      }
    }
  } catch {}
}

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

export const audioBlobCache = new Map<string, Blob>();
const audioBufferMemoryCache = new Map<string, AudioBuffer>();
const inFlightTtsPromises = new Map<
  string,
  Promise<{
    audioBuffer: AudioBuffer;
    engine: string;
    audioUrl?: string;
    base64?: string;
    mimeType?: string;
  } | null>
>();

/**
 * Splits text into sentence/clause chunks for fast TTS startup:
 * - First chunk is shorter (~110 chars max) so playback starts twice as fast.
 * - Subsequent chunks are up to ~220 chars and pre-fetched while chunk 0 plays.
 */
export function chunkTextForTTS(
  text: string,
  firstChunkMaxLen: number = 110,
  subsequentMaxLen: number = 220
): string[] {
  const cleaned = stripSpeakerAndFormatting(text);
  if (!cleaned) return [];
  if (cleaned.length <= firstChunkMaxLen) return [cleaned];

  // Split by sentence boundaries first
  const rawSentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flushSubChunks = (segment: string, maxLen: number) => {
    let rem = segment.trim();
    while (rem.length > maxLen) {
      // Try splitting at clause boundary (, ; : —) before maxLen
      let splitIdx = -1;
      const slice = rem.slice(0, maxLen);
      const clauseMatch = slice.match(/^.*[,;:—-]\s+/);
      if (clauseMatch && clauseMatch[0].length >= 35) {
        splitIdx = clauseMatch[0].length;
      } else {
        const lastSpace = slice.lastIndexOf(' ');
        splitIdx = lastSpace > 30 ? lastSpace : maxLen;
      }
      chunks.push(rem.slice(0, splitIdx).trim());
      rem = rem.slice(splitIdx).trim();
    }
    if (rem) chunks.push(rem);
  };

  for (const sentence of rawSentences) {
    const targetMax = chunks.length === 0 ? firstChunkMaxLen : subsequentMaxLen;
    if (!current) {
      if (sentence.length > targetMax) {
        flushSubChunks(sentence, targetMax);
      } else {
        current = sentence;
      }
    } else if (current.length + 1 + sentence.length <= targetMax) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      const nextTargetMax = subsequentMaxLen;
      if (sentence.length > nextTargetMax) {
        flushSubChunks(sentence, nextTargetMax);
        current = '';
      } else {
        current = sentence;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [cleaned];
}

export function getCanonicalTtsCacheKey(voiceId: string, cleanChunk: string): string {
  return `cache_v5_${voiceId || 'default'}_${cleanChunk}`;
}

/**
 * Fetches or retrieves from memory/IndexedDB cache a single TTS chunk with a strictly locked voiceId.
 * Checks in-memory Map (audioBufferMemoryCache & audioBlobCache) first, then IndexedDB (toefl_tts_audio_cache) second before calling /api/tts.
 */
export async function fetchCloudTtsAudio(
  chunk: string,
  gender?: 'male' | 'female',
  specificVoiceId?: string
): Promise<{
  audioBuffer: AudioBuffer;
  engine: string;
  audioUrl?: string;
  base64?: string;
  mimeType?: string;
} | null> {
  if (typeof window === 'undefined') return null;
  const cleanChunk = stripSpeakerAndFormatting(chunk);
  if (!cleanChunk) return null;

  const lockedVoice =
    specificVoiceId ||
    (gender === 'male' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural');
  const provider = getStoredProvider();
  const primaryKey = getCanonicalTtsCacheKey(lockedVoice, cleanChunk);
  const legacyKey = `cache_${provider}_${lockedVoice}_${cleanChunk}`;

  // 1. Check in-memory AudioBuffer cache first
  const memHit =
    audioBufferMemoryCache.get(primaryKey) || audioBufferMemoryCache.get(legacyKey);
  if (memHit) {
    return { audioBuffer: memHit, engine: 'Cached Neural TTS' };
  }

  // 1b. Check in-memory audioBlobCache Map
  const memBlobHit =
    audioBlobCache.get(primaryKey) || audioBlobCache.get(legacyKey);
  if (memBlobHit) {
    try {
      const b64 = await blobToBase64String(memBlobHit);
      const { audioBuffer } = await decodeSpeech(
        b64,
        memBlobHit.type || 'audio/mpeg'
      );
      audioBufferMemoryCache.set(primaryKey, audioBuffer);
      return {
        audioBuffer,
        engine: 'Cached Neural TTS (Memory Blob)',
        base64: b64,
        mimeType: memBlobHit.type || 'audio/mpeg',
      };
    } catch {}
  }

  const inflight = inFlightTtsPromises.get(primaryKey);
  if (inflight) {
    return inflight;
  }

  const taskPromise = (async () => {
    // 2. Check IndexedDB toefl_tts_audio_cache second before calling /api/tts
    try {
      const db = await dbPromise;
      if (db) {
        const cached =
          (await db.get(STORE_NAME, primaryKey)) ||
          (await db.get(STORE_NAME, legacyKey));
        if (cached) {
          let base64Str: string | undefined = cached.base64;
          let mimeTypeStr: string = cached.mimeType || 'audio/mpeg';
          let blobObj: Blob | undefined =
            cached.blob instanceof Blob
              ? cached.blob
              : cached instanceof Blob
              ? cached
              : undefined;

          if (!base64Str && blobObj) {
            base64Str = await blobToBase64String(blobObj);
            mimeTypeStr = blobObj.type || mimeTypeStr;
          } else if (base64Str && !blobObj) {
            blobObj = base64ToAudioBlob(base64Str, mimeTypeStr);
          }

          if (base64Str) {
            if (blobObj) {
              audioBlobCache.set(primaryKey, blobObj);
            }
            const { audioBuffer } = await decodeSpeech(base64Str, mimeTypeStr);
            audioBufferMemoryCache.set(primaryKey, audioBuffer);
            return {
              audioBuffer,
              engine: `Cached (${cached.engine || 'Neural TTS'})`,
              audioUrl: cached.audioUrl,
              base64: base64Str,
              mimeType: mimeTypeStr,
            };
          }
        }
      }
    } catch {}

    // 3. Network fallback: fetch from /api/tts and store in audioBlobCache + IndexedDB
    try {
      const authHdrs = await getAuthHeaders();
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { ...getApiHeaders(), ...authHdrs },
        body: JSON.stringify({
          text: cleanChunk,
          voice: lockedVoice,
          voiceName: lockedVoice,
          gender,
        }),
      });
      const json = await res.json();
      if (res.ok && json.success && json.audioBase64) {
        incrementTtsQuota();
        const engineName = json.modelUsed || 'Neural TTS';
        const mimeType = json.mimeType || 'audio/mpeg';
        const mp3Blob = base64ToAudioBlob(json.audioBase64, mimeType);
        audioBlobCache.set(primaryKey, mp3Blob);

        const { audioBuffer } = await decodeSpeech(json.audioBase64, mimeType);
        audioBufferMemoryCache.set(primaryKey, audioBuffer);

        await persistAudioClipToIdb(primaryKey, {
          blob: mp3Blob,
          base64: json.audioBase64,
          mimeType,
          engine: engineName,
          audioUrl: json.audioUrl,
        });

        return {
          audioBuffer,
          engine: engineName,
          audioUrl: json.audioUrl,
          base64: json.audioBase64,
          mimeType,
        };
      }
    } catch {}

    return null;
  })();

  inFlightTtsPromises.set(primaryKey, taskPromise);
  try {
    return await taskPromise;
  } finally {
    inFlightTtsPromises.delete(primaryKey);
  }
}

// Pre-fetch speech audio silently in the background (pre-warming the fast first chunk first!)
export async function prefetchSpeechAudio(
  text: string,
  voiceName?: string,
  gender?: string
): Promise<void> {
  if (typeof window === 'undefined') return;
  const cleanText = stripSpeakerAndFormatting(text);
  if (!cleanText) return;

  const inferredFromVoice = voiceName ? inferGender(voiceName) : undefined;
  const resolvedGender: 'male' | 'female' | undefined =
    gender === 'male' || gender === 'female'
      ? gender
      : inferredFromVoice === 'male' || inferredFromVoice === 'female'
      ? inferredFromVoice
      : undefined;
  const lockedVoice =
    voiceName ||
    (resolvedGender === 'male' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural');

  const chunks = chunkTextForTTS(cleanText);
  if (chunks.length === 0) return;

  // 1. Pre-warm the short first chunk immediately so clicking Play has 0ms latency
  await fetchCloudTtsAudio(chunks[0], resolvedGender, lockedVoice);

  // 2. Pre-warm remaining chunks in sequence with the exact same lockedVoice
  for (let i = 1; i < chunks.length; i++) {
    await fetchCloudTtsAudio(chunks[i], resolvedGender, lockedVoice);
  }
}

// Pre-cache available browser voices synchronously
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

export function getVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return [];
  }
  if (cachedVoices.length === 0) {
    cachedVoices = window.speechSynthesis.getVoices();
  }
  return cachedVoices;
}

export function stopSpeaking() {
  isAudioPlayingState = false;
  currentDialogueSessionId++; // Immediately invalidates any playing dialogue or async loops

  // 0. Abort any in-flight TTS API network fetch immediately
  if (activeFetchController) {
    try {
      activeFetchController.abort();
    } catch {}
    activeFetchController = null;
  }

  // 1. Immediately pause and silence HTML Audio element
  if (activeHtmlAudio) {
    const prevSrc = activeHtmlAudio.dataset.blobUrl || activeHtmlAudio.src || '';
    const prevIsBlob = activeHtmlAudio.dataset.isBlobUrl === 'true';
    try {
      activeHtmlAudio.pause();
      activeHtmlAudio.currentTime = 0;
      activeHtmlAudio.src = '';
    } catch {
      // Ignored
    }
    if (prevIsBlob && prevSrc) {
      try {
        URL.revokeObjectURL(prevSrc);
      } catch {}
    }
    activeHtmlAudio = null;
  }

  // 2. Safety measure: ensure any other audio tags in DOM are paused
  if (typeof document !== 'undefined') {
    try {
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach((el) => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch {}
      });
    } catch {}
  }

  // 3. Immediately unblock any awaiting audio playback promise
  if (activeAudioCancel) {
    const cancel = activeAudioCancel;
    activeAudioCancel = null;
    try {
      cancel();
    } catch {}
  }

  // 4. Immediately cancel any fallback browser synthesis promise
  if (activeFallbackCancel) {
    const cancel = activeFallbackCancel;
    activeFallbackCancel = null;
    try {
      cancel();
    } catch {}
  }

  // Stop active Web Audio source node if playing
  if (activeSourceNode) {
    try {
      activeSourceNode.stop();
      activeSourceNode.disconnect();
    } catch {}
    activeSourceNode = null;
  }

  // 5. Cancel Web Speech API
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.pause();
      window.speechSynthesis.cancel();
      activeUtterances.clear();
    } catch {
      // Ignored
    }
  }
}

export function isAudioPlaying(): boolean {
  return isAudioPlayingState;
}

let globalAudioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;

export function getAudioContext(): AudioContext {
  if (!globalAudioCtx && typeof window !== 'undefined') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      globalAudioCtx = new AudioCtx();
    }
  }
  return globalAudioCtx!;
}

export async function decodeSpeech(
  base64: string,
  mimeType: string = 'audio/wav'
): Promise<{ audioBuffer: AudioBuffer; sampleRate: number }> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {}
  }

  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }

  const sampleRate = parseSampleRateFromMime(mimeType, 24000);
  const first4Hex = Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`[decodeSpeech] mimeType=${mimeType}, byteLen=${bytes.byteLength}, first4=${first4Hex}, sampleRate=${sampleRate}, isRiff=${isRiffWav(bytes)}`);

  // Raw PCM / L16 without RIFF header
  if ((mimeType.includes('pcm') || mimeType.includes('L16')) && !isRiffWav(bytes)) {
    const numSamples = Math.floor(bytes.byteLength / 2);
    const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < numSamples; i++) {
      const int16 = view.getInt16(i * 2, true); // little endian
      channelData[i] = int16 / 32768.0;
    }
    return { audioBuffer, sampleRate };
  }

  // RIFF WAV, MP3, OGG, WEBM via decodeAudioData
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return { audioBuffer, sampleRate: audioBuffer.sampleRate };
}

function unlockAudioOnFirstUserGesture() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = getAudioContext();
    if (ctx) {
      ctx.resume().catch(() => {});
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(ctx.destination);
      source.start(0);
    }
  } catch {}
  window.removeEventListener('click', unlockAudioOnFirstUserGesture, true);
  window.removeEventListener('keydown', unlockAudioOnFirstUserGesture, true);
  window.removeEventListener('touchstart', unlockAudioOnFirstUserGesture, true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', unlockAudioOnFirstUserGesture, true);
  window.addEventListener('keydown', unlockAudioOnFirstUserGesture, true);
  window.addEventListener('touchstart', unlockAudioOnFirstUserGesture, true);
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const numSamples = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferLength = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  // RIFF chunk descriptor
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true); // size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt subchunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitDepth, true); // BitsPerSample
  // data subchunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true); // Subchunk2Size

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = buffer.getChannelData(channel)[i];
      sample = Math.max(-1, Math.min(1, sample));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export async function playDecodedSpeech(
  audioBuffer: AudioBuffer,
  onEnd?: () => void,
  rawBlob?: Blob,
  playbackRate: number = 1.0
): Promise<void> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {}
  }

  // Fallback to HTMLAudioElement if Web Audio context is not running
  if (!ctx || ctx.state !== 'running') {
    return new Promise<void>((resolve, reject) => {
      try {
        const blob = rawBlob || audioBufferToWavBlob(audioBuffer);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        if (playbackRate !== 1.0) {
          audio.preservesPitch = false;
          audio.playbackRate = playbackRate;
        }
        activeHtmlAudio = audio;
        audio.dataset.isBlobUrl = 'true';

        let finished = false;
        const durationSec = audioBuffer?.duration || 1.5;
        const timeoutMs = Math.round(durationSec * 1000) + 1500;

        const cleanup = () => {
          if (finished) return;
          finished = true;
          clearTimeout(safetyTimer);
          URL.revokeObjectURL(url);
          if (activeHtmlAudio === audio) activeHtmlAudio = null;
          onEnd?.();
          resolve();
        };

        const safetyTimer = setTimeout(cleanup, timeoutMs);
        audio.onended = cleanup;
        audio.onerror = () => {
          cleanup();
          reject(new Error('HTMLAudioElement error during playback'));
        };

        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            cleanup();
            reject(new Error(`HTMLAudioElement play failed: ${err?.message || err}`));
          });
        }
      } catch (err: any) {
        reject(new Error(`Fallback audio play error: ${err?.message || err}`));
      }
    });
  }

  if (activeSourceNode) {
    try {
      activeSourceNode.stop();
      activeSourceNode.disconnect();
    } catch {}
    activeSourceNode = null;
  }

  const sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  if (playbackRate !== 1.0) {
    sourceNode.playbackRate.value = playbackRate;
  }
  sourceNode.connect(ctx.destination);
  activeSourceNode = sourceNode;

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const durationSec = (audioBuffer.duration || 1) / Math.max(0.5, playbackRate || 1.0);
    const timeoutMs = Math.round(durationSec * 1000) + 1500;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safetyTimer);
      try {
        sourceNode.disconnect();
      } catch {}
      if (activeSourceNode === sourceNode) {
        activeSourceNode = null;
      }
      onEnd?.();
      resolve();
    };

    // Never wait only for onended: resolve after audioBuffer.duration + 1.5 s,
    // and if the context is still not running report "Audio did not start"
    const safetyTimer = setTimeout(() => {
      if (ctx.state !== 'running') {
        cleanup();
        reject(new Error('Audio did not start'));
        return;
      }
      cleanup();
    }, timeoutMs);

    sourceNode.onended = cleanup;
    try {
      sourceNode.start(0);
    } catch (err) {
      clearTimeout(safetyTimer);
      finished = true;
      reject(err);
    }
  });
}


// TTS Daily Limit Tracker & Circuit Breaker
const TTS_SUCCESS_COUNT_KEY = 'toefl_tts_success_count';
const TTS_DATE_KEY = 'toefl_tts_date';
const TTS_BLOCKED_UNTIL_KEY = 'toefl_tts_blocked_until';

function getTtsQuotaData() {
  const today = new Date().toDateString();
  const storedDate = localStorage.getItem(TTS_DATE_KEY);
  if (storedDate !== today) {
    localStorage.setItem(TTS_DATE_KEY, today);
    localStorage.setItem(TTS_SUCCESS_COUNT_KEY, '0');
    return { count: 0, blockedUntil: 0 };
  }
  const count = parseInt(localStorage.getItem(TTS_SUCCESS_COUNT_KEY) || '0', 10);
  const blockedUntil = parseInt(localStorage.getItem(TTS_BLOCKED_UNTIL_KEY) || '0', 10);
  return { count, blockedUntil };
}

function incrementTtsQuota() {
  const count = parseInt(localStorage.getItem(TTS_SUCCESS_COUNT_KEY) || '0', 10);
  localStorage.setItem(TTS_SUCCESS_COUNT_KEY, (count + 1).toString());
}

export function resetTtsQuotaBlock(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(TTS_BLOCKED_UNTIL_KEY);
  }
}

export function isTtsCircuitBreakerBlocked(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const { blockedUntil } = getTtsQuotaData();
  return Date.now() < blockedUntil;
}

export function getTtsUsageCount(): number {
  return parseInt(localStorage.getItem(TTS_SUCCESS_COUNT_KEY) || '0', 10);
}

// Fetch Cloud Audio from /api/tts via Gemini with in-memory & IndexedDB caching
export async function fetchAudioBlob(text: string, voiceName?: string, gender?: string): Promise<Blob> {
  const cleanText = stripSpeakerAndFormatting(text);
  const lockedVoice =
    voiceName || (gender === 'male' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural');
  const cacheKey = getCanonicalTtsCacheKey(lockedVoice, cleanText);
  const legacyKey = `${voiceName || 'default'}:::${text}`;

  // 1. Check in-memory audioBlobCache first
  const memBlob = audioBlobCache.get(cacheKey) || audioBlobCache.get(legacyKey);
  if (memBlob) {
    return memBlob;
  }

  // 2. Check IndexedDB toefl_tts_audio_cache second
  const db = await dbPromise;
  if (db) {
    const cached =
      (await db.get(STORE_NAME, cacheKey)) ||
      (await db.get(STORE_NAME, legacyKey));
    if (cached) {
      if (cached instanceof Blob) {
        audioBlobCache.set(cacheKey, cached);
        return cached;
      }
      if (cached.blob instanceof Blob) {
        audioBlobCache.set(cacheKey, cached.blob);
        return cached.blob;
      }
      if (cached.base64) {
        const blob = base64ToAudioBlob(cached.base64, cached.mimeType || 'audio/mpeg');
        audioBlobCache.set(cacheKey, blob);
        return blob;
      }
    }
  }

  const { blockedUntil } = getTtsQuotaData();
  if (Date.now() < blockedUntil) {
    if (blockedUntil - Date.now() > 2 * 60 * 1000) {
      localStorage.removeItem(TTS_BLOCKED_UNTIL_KEY);
    } else {
      throw new Error('GEMINI_TTS_BLOCKED');
    }
  }

  const controller = new AbortController();
  activeFetchController = controller;

  let res: Response;
  let json: any;
  try {
    const authHdrs = await getAuthHeaders();
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { ...getApiHeaders(), ...authHdrs },
      body: JSON.stringify({ text: cleanText, voice: lockedVoice, voiceName: lockedVoice, gender }),
      signal: controller.signal,
    });
    json = await res.json();
  } finally {
    if (activeFetchController === controller) {
      activeFetchController = null;
    }
  }
  
  if (res.status === 429) {
    const retryAfter = (json.rateLimit?.retryAfterSeconds || 60) * 1000;
    const blockDuration = Math.min(retryAfter + 5000, 60000);
    localStorage.setItem(TTS_BLOCKED_UNTIL_KEY, (Date.now() + blockDuration).toString());
    throw new Error('GEMINI_TTS_BLOCKED');
  }

  if (!res.ok || !json.success || (!json.audioBase64 && !json.audioUrl)) {
    throw new Error(json.error || 'TTS service failed');
  }

  incrementTtsQuota();

  let blob: Blob;
  if (json.audioUrl) {
    const audioRes = await fetch(json.audioUrl);
    blob = await audioRes.blob();
  } else {
    blob = base64ToAudioBlob(json.audioBase64, json.mimeType || 'audio/mpeg');
  }

  audioBlobCache.set(cacheKey, blob);
  await persistAudioClipToIdb(cacheKey, {
    blob,
    base64: json.audioBase64,
    mimeType: json.mimeType || 'audio/mpeg',
    engine: json.modelUsed || 'Neural TTS',
    audioUrl: json.audioUrl,
  });

  return blob;
}

// Play HTML Audio Data URI (or Blob URL) with promise resolution
// Now just a wrapper for playAudioBlob
export async function fetchAudioDataUri(text: string, voiceName: string = 'Kore'): Promise<string> {
  const blob = await fetchAudioBlob(text, voiceName);
  return URL.createObjectURL(blob);
}

// Play Blob with object URL and cleanup
export function playAudioBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  return playAudioDataUri(url, true);
}

// Play HTML Audio Data URI (or Blob URL) with promise resolution
export function playAudioDataUri(dataUri: string, isBlobUrl: boolean = false, playbackRate: number = 1.0): Promise<void> {
  if (activeHtmlAudio) {
    const prevSrc = activeHtmlAudio.dataset.blobUrl || activeHtmlAudio.src || '';
    const prevIsBlob = activeHtmlAudio.dataset.isBlobUrl === 'true';
    try {
      activeHtmlAudio.pause();
      activeHtmlAudio.currentTime = 0;
      activeHtmlAudio.src = '';
    } catch {}
    if (prevIsBlob && prevSrc) {
      try {
        URL.revokeObjectURL(prevSrc);
      } catch {}
    }
    activeHtmlAudio = null;
  }

  isAudioPlayingState = true;
  const audio = new Audio(dataUri);
  if (playbackRate !== 1.0) {
    audio.preservesPitch = false;
    audio.playbackRate = playbackRate;
  }
  audio.dataset.isBlobUrl = isBlobUrl ? 'true' : 'false';
  audio.dataset.blobUrl = dataUri;
  activeHtmlAudio = audio;

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let wasStoppedByUser = false;

    const cleanup = (isError = false, errorObj?: any) => {
      if (finished) return;
      finished = true;
      isAudioPlayingState = false;
      activeAudioCancel = null;

      const targetSrc = audio.dataset.blobUrl || audio.src || '';
      const isBlob = audio.dataset.isBlobUrl === 'true';

      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
      } catch {}

      if (isBlob && targetSrc) {
        try {
          URL.revokeObjectURL(targetSrc);
        } catch {}
      }

      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }

      if (isError && !wasStoppedByUser) {
        reject(errorObj || new Error('Audio playback failed'));
      } else {
        resolve();
      }
    };

    activeAudioCancel = () => {
      wasStoppedByUser = true;
      cleanup(false);
    };

    audio.onended = () => cleanup(false);
    audio.onerror = (e) => cleanup(true, e || new Error('HTML Audio error event fired'));

    audio.play().catch((err) => {
      if (!wasStoppedByUser) {
        console.warn('Audio play() failed:', err);
        cleanup(true, err);
      } else {
        cleanup(false);
      }
    });
  });
}

export interface PlaySpeechOptions {
  voice?: string;
  voiceName?: string;
  gender?: 'female' | 'male' | 'unknown';
  speaker?: string;
  rate?: number;
  onEngineDetected?: (engineLabel: string) => void;
  onStatus?: (statusLabel: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
  sessionId?: number;
  skipStop?: boolean;
}

export async function playSpeech(
  text: string,
  options: PlaySpeechOptions = {}
): Promise<void> {
  if (!options.skipStop) {
    stopSpeaking();
  }
  isAudioPlayingState = true;
  const currentSession = options.sessionId ?? ++currentDialogueSessionId;

  const provider = getStoredProvider();
  const voice = options.voice || options.voiceName;
  const voiceName = voice || 'en-US-AvaNeural';
  const gender = options.gender && options.gender !== 'unknown' ? options.gender : undefined;
  const cleanText = stripSpeakerAndFormatting(text);
  if (!cleanText) return;

  const engine = getVoiceEngine();
  const hasKey = !!(getStoredApiKey() || getStoredVoiceKey());
  const breakerBlocked = isTtsCircuitBreakerBlocked();

  // Helper 1: Try Cloud Voice (uses chunked pre-warmed cache + strictly locked voiceName across all chunks)
  const tryCloud = async (): Promise<{ ok: boolean; reason?: string; cancelled?: boolean }> => {
    const lockedVoice =
      voice ||
      voiceName ||
      (gender === 'male' ? 'en-US-ChristopherNeural' : 'en-US-AriaNeural');

    // 1. Check if the entire unchunked text is already in memory or IndexedDB cache
    const fullPrimaryKey = getCanonicalTtsCacheKey(lockedVoice, cleanText);
    const fullLegacyKey = `cache_${provider}_${lockedVoice}_${cleanText}`;
    const fullMemHit =
      audioBufferMemoryCache.get(fullPrimaryKey) ||
      audioBufferMemoryCache.get(fullLegacyKey);

    if (fullMemHit) {
      if (isAudioPlayingState && currentDialogueSessionId === currentSession) {
        options.onStatus?.('Voice: Cached (Neural TTS)');
        options.onEngineDetected?.('Voice: Cached (Neural TTS)');
        options.onStart?.();
        await playDecodedSpeech(fullMemHit, options.onEnd, undefined, options.rate || 1.0);
        return { ok: true };
      }
      return { ok: false, reason: 'Session cancelled or changed', cancelled: true };
    }

    // 2. Chunk text so chunk 0 (~110 chars) starts immediately and subsequent chunks pre-fetch in parallel
    const chunks = chunkTextForTTS(cleanText, 110, 220);
    if (chunks.length === 0) return { ok: false, reason: 'Empty text' };

    options.onStatus?.('Generating neural voice...');

    try {
      let nextChunkPromise = fetchCloudTtsAudio(chunks[0], gender, lockedVoice);

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        if (!isAudioPlayingState || currentDialogueSessionId !== currentSession) {
          return { ok: false, reason: 'Session cancelled or changed', cancelled: true };
        }

        const currentResult = await nextChunkPromise;

        // Kick off next chunk immediately in parallel using the EXACT SAME lockedVoice & gender
        if (cIdx + 1 < chunks.length) {
          nextChunkPromise = fetchCloudTtsAudio(chunks[cIdx + 1], gender, lockedVoice);
        }

        if (!currentResult || !currentResult.audioBuffer) {
          return { ok: false, reason: 'Server voice synthesis failed.' };
        }

        if (!isAudioPlayingState || currentDialogueSessionId !== currentSession) {
          return { ok: false, reason: 'Session cancelled or changed', cancelled: true };
        }

        if (cIdx === 0) {
          options.onStatus?.(`Voice: ${currentResult.engine}`);
          options.onEngineDetected?.(`Voice: ${currentResult.engine}`);
          options.onStart?.();
        }

        const isLastChunk = cIdx === chunks.length - 1;
        await playDecodedSpeech(
          currentResult.audioBuffer,
          isLastChunk ? options.onEnd : undefined,
          undefined,
          options.rate || 1.0
        );
      }

      return { ok: true };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || String(err).includes('abort');
      const reason = isTimeout
        ? 'Voice request timed out after 20 seconds.'
        : err?.message || 'Voice service unavailable.';
      console.warn(`Voice synthesis failed: ${reason}`);
      return { ok: false, reason };
    }
  };

  // Helper 2: Try Device Voice (Browser Speech Synthesis)
  const tryDevice = async (): Promise<{ ok: boolean; reason?: string; cancelled?: boolean }> => {
    let voices = getVoices();
    if (voices.filter((v) => v.lang.toLowerCase().startsWith('en')).length === 0) {
      await new Promise((r) => {
        const t = setTimeout(r, 1000);
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.onvoiceschanged = () => {
            clearTimeout(t);
            r(null);
          };
        }
      });
      voices = getVoices();
    }

    const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    if (englishVoices.length === 0) {
      const reason = 'Device voice: no English voices found.';
      console.warn(reason);
      return { ok: false, reason };
    }

    try {
      const spk = options.speaker || voiceName;
      const inferredFromSpk = options.speaker
        ? inferGenderFromSpeaker(options.speaker) || detectSpeakerGender(spk, '')
        : inferGender(voiceName);
      const resolvedG =
        gender === 'male' || gender === 'female'
          ? gender
          : inferredFromSpk === 'male' || inferredFromSpk === 'female'
          ? inferredFromSpk
          : inferGender(voiceName);
      const targetGender: 'male' | 'female' = resolvedG === 'male' ? 'male' : 'female';
      const pitchRate = getBrowserSpeechPitchAndRate(spk, targetGender);
      const voiceObj = pickBrowserVoiceForGender(targetGender) || englishVoices[0];

      let finalPitch = pitchRate.pitch;
      let finalRate = pitchRate.rate;
      if (voiceObj) {
        const nameLower = voiceObj.name.toLowerCase();
        const maleKeywords = ['david', 'mark', 'daniel', 'guy', 'christopher', 'arthur', 'male', 'steffan', 'eric'];
        const femaleKeywords = ['zira', 'samantha', 'aria', 'jenny', 'female', 'michelle', 'emma'];
        const hasMale = maleKeywords.some(kw => nameLower.includes(kw));
        const hasFemale = femaleKeywords.some(kw => nameLower.includes(kw));

        if (targetGender === 'male' && !hasMale) {
          finalPitch = 0.96;
          finalRate = 0.98;
        } else if (targetGender === 'female' && !hasFemale) {
          finalPitch = 1.04;
        }
      }

      if (isAudioPlayingState && currentDialogueSessionId === currentSession) {
        options.onStart?.();
        await speakScriptLineFallback(cleanText, finalPitch, voiceObj, finalRate);
        options.onEnd?.();
        return { ok: true };
      }
      return { ok: false, reason: 'Session cancelled or changed', cancelled: true };
    } catch (err: any) {
      const reason = `Device voice error: ${err?.message || err}`;
      console.warn(reason);
      return { ok: false, reason };
    }
  };

  const policy = getVoiceFallbackPolicy();
  const stepOrder: Array<'cloud' | 'device'> = [];
  
  // Fast path: if no API keys or engine set to device/offline, or male voice without API key, go straight to device
  const hasKeys = !!(getStoredApiKey() || getStoredVoiceKey());
  const spk = options.speaker || '';
  const g = spk ? detectSpeakerGender(spk, '') : inferGender(voiceName);
  const isMale = g === 'male' || /guy|christopher|eric|roger|steffan|puck|algenib|algieba|alnilam|charon|enceladus|fenrir|iapetus|orus|rasalgethi|sadachbia|sadaltager|schedar|umbriel|zubenelgenubi|male/i.test(voiceName);
  
  if (engine === 'device' || engine === 'offline') {
    stepOrder.push('device');
    stepOrder.push('cloud');
  } else {
    stepOrder.push('cloud');
    stepOrder.push('device');
  }

  const engineFailures: Record<string, string> = {};

  for (let i = 0; i < stepOrder.length; i++) {
    if (!isAudioPlayingState || currentDialogueSessionId !== currentSession) break;

    const step = stepOrder[i];
    let result: { ok: boolean; reason?: string; cancelled?: boolean } = { ok: false };
    const label = step === 'cloud' ? 'Cloud' : 'Device';

    if (step === 'cloud') {
      result = await tryCloud();
      if (!result.cancelled) {
        if (result.ok) {
          recordVoiceEngineSuccess();
        } else {
          recordVoiceEngineFailure('cloud', result.reason);
        }
      }
    } else if (step === 'device') {
      result = await tryDevice();
      if (result.ok) {
        recordVoiceEngineSuccess();
      }
    }

    if (!isAudioPlayingState || currentDialogueSessionId !== currentSession || result.cancelled) {
      return;
    }

    if (result.ok) {
      if (Object.keys(engineFailures).length > 0) {
        const firstFailedEng = Object.keys(engineFailures)[0];
        const firstReason = engineFailures[firstFailedEng];
        const fallbackMsg = `Selected voice: ${firstFailedEng}. Failed: ${firstReason}. Fallback used: ${label}.`;
        options.onStatus?.(fallbackMsg);
        options.onEngineDetected?.(fallbackMsg);
      } else {
        const successMsg = `Voice used: ${label}`;
        options.onStatus?.(successMsg);
        options.onEngineDetected?.(successMsg);
      }
      return;
    } else {
      if (result.reason) {
        engineFailures[label] = result.reason;
      }
      if (policy === 'strict') {
        break;
      }
    }
  }

  // If no step can speak: show all engine failure reasons
  console.warn('All voice synthesis methods failed or unavailable.');
  const details = Object.keys(engineFailures).length > 0
    ? Object.entries(engineFailures).map(([eng, r]) => `${eng}: ${r}`).join(' | ')
    : 'No speech voices found.';
  const finalMsg = policy === 'strict'
    ? `Strict selected engine failed. Reason: ${details}`
    : `Engines tried: [${stepOrder.join(', ')}]. Reasons: ${details}`;
  options.onStatus?.(finalMsg);
  options.onEngineDetected?.(finalMsg);
  options.onError?.(new Error(finalMsg));
  options.onEnd?.();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_no_voice_available'));
  }
}

// Browser fallback speech synthesis
function speakScriptLineFallback(
  text: string,
  pitch = 1.0,
  browserVoice?: SpeechSynthesisVoice | null,
  rate = 0.95
): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve();
  }

  const cleanText = stripSpeakerAndFormatting(text);
  if (!cleanText) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let finished = false;
    let wasStoppedByUser = false;
    let currentUtt: SpeechSynthesisUtterance | null = null;
    let safetyTimer: any = null;

    const cleanup = (hasError = false, err?: any) => {
      if (finished) return;
      finished = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      activeFallbackCancel = null;
      if (currentUtt) {
        activeUtterances.delete(currentUtt);
      }
      if (hasError && !wasStoppedByUser) {
        reject(err || new Error('Browser speech synthesis error'));
      } else {
        resolve();
      }
    };

    activeFallbackCancel = () => {
      wasStoppedByUser = true;
      try {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.cancel();
        }
      } catch {}
      cleanup(false);
    };

    // Safety timeout in case browser speech synthesis hangs
    const maxDuration = Math.max(3500, cleanText.length * 100);
    safetyTimer = setTimeout(() => cleanup(true, new Error('Browser speech synthesis timeout')), maxDuration);

    const startSpeech = async () => {
      try {
        // Fix Chromium/Brave cancel silence bug: only cancel if speaking/pending, and wait 60ms
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.cancel();
          await new Promise((r) => setTimeout(r, 60));
        }
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }

        const utt = new SpeechSynthesisUtterance(cleanText);
        currentUtt = utt;
        activeUtterances.add(utt);
        utt.lang = 'en-US';

        // Firefox speech engines distort if pitch/rate are modified
        const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
        utt.rate = isFirefox ? 1.0 : rate;
        utt.pitch = isFirefox ? 1.0 : pitch;

        if (browserVoice) {
          const availableVoices = window.speechSynthesis.getVoices();
          const matched = availableVoices.find((v) => v.name === browserVoice.name || v.voiceURI === browserVoice.voiceURI);
          if (matched) {
            utt.voice = matched;
          }
        }

        utt.onend = () => cleanup(false);
        utt.onerror = (e) => cleanup(true, e);

        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utt);
      } catch (ex) {
        cleanup(true, ex);
      }
    };

    startSpeech();
  });
}

export type VoiceEngine = 'auto' | 'cloud' | 'device' | 'offline';

export function getVoiceEngine(): VoiceEngine {
  if (typeof localStorage === 'undefined') return 'auto';
  const stored = localStorage.getItem('toefl_voice_engine');
  if (!stored) return 'auto';
  if (stored === 'gemini') return 'cloud';
  if (stored === 'auto' || stored === 'cloud' || stored === 'device' || stored === 'offline') {
    return stored;
  }
  return 'auto';
}

export function setVoiceEngine(engine: VoiceEngine) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('toefl_voice_engine', engine);
    window.dispatchEvent(new CustomEvent('toefl_voice_engine_changed', { detail: { engine } }));
  }
  resetVoiceEngineFailureCounts();
}

export type VoiceFallbackPolicy = 'fallback' | 'strict';

export function getVoiceFallbackPolicy(): VoiceFallbackPolicy {
  if (typeof localStorage === 'undefined') return 'fallback';
  return (localStorage.getItem('toefl_voice_fallback_policy') as VoiceFallbackPolicy) || 'fallback';
}

export function setVoiceFallbackPolicy(policy: VoiceFallbackPolicy) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('toefl_voice_fallback_policy', policy);
  }
}

export function getSavedBrowserVoiceName(gender: 'male' | 'female'): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(`toefl_browser_voice_${gender}`) || '';
}

export function setSavedBrowserVoiceName(gender: 'male' | 'female', voiceName: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`toefl_browser_voice_${gender}`, voiceName.trim());
  }
}

export function pickBrowserVoiceForGender(gender: 'male' | 'female', lang: string = 'en-US'): SpeechSynthesisVoice | null {
  const voices = getVoices();
  if (voices.length === 0) return null;

  const savedName = getSavedBrowserVoiceName(gender);
  if (savedName) {
    const matched = voices.find((v) => v.name === savedName);
    if (matched) return matched;
  }

  const maleKeywords = ['david', 'mark', 'daniel', 'guy', 'christopher', 'arthur', 'male', 'steffan', 'eric'];
  const femaleKeywords = ['zira', 'samantha', 'aria', 'jenny', 'female', 'michelle', 'emma'];
  const keywords = gender === 'male' ? maleKeywords : femaleKeywords;

  for (const kw of keywords) {
    const found = voices.find((v) => v.name.toLowerCase().includes(kw) && v.lang.toLowerCase().startsWith('en'));
    if (found) return found;
  }

  return voices.find((v) => v.lang.toLowerCase().startsWith('en')) || voices[0] || null;
}

export async function previewBrowserVoice(text: string, voiceName?: string, pitch: number = 1.0): Promise<void> {
  stopSpeaking();
  isAudioPlayingState = true;
  const voices = getVoices();
  const matchedVoice = voiceName ? voices.find((v) => v.name === voiceName) : null;
  await speakScriptLineFallback(text, pitch, matchedVoice);
}

// Speak single line with unified playSpeech pipeline
export async function speakScriptLine(
  text: string,
  options: {
    rate?: number;
    pitch?: number;
    voice?: string;
    voiceName?: string;
    gender?: 'female' | 'male' | 'unknown';
    browserVoice?: SpeechSynthesisVoice | null;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (err: any) => void;
    onStatus?: (status: string) => void;
    onEngineDetected?: (engine: string) => void;
  } = {}
): Promise<void> {
  const voice = options.voice || options.voiceName || 'en-US-AvaNeural';
  return playSpeech(text, {
    voice,
    voiceName: voice,
    gender: options.gender,
    rate: options.rate,
    onStart: options.onStart,
    onEnd: options.onEnd,
    onError: options.onError,
    onStatus: options.onStatus,
    onEngineDetected: options.onEngineDetected,
  });
}

// Play multi-line dialogue line by line in order using unified playSpeech pipeline
export async function playDialogue(
  lines: string[],
  voiceMapping?: { A?: string; B?: string },
  onLineChange?: (lineIndex: number) => void,
  options: {
    onStatus?: (status: string) => void;
    onEnd?: () => void;
  } = {}
): Promise<void> {
  stopSpeaking();
  isAudioPlayingState = true;
  const currentSession = ++currentDialogueSessionId;
  const manager = new DialogueVoiceManager();

  for (let i = 0; i < lines.length; i++) {
    if (!isAudioPlayingState || currentDialogueSessionId !== currentSession) break;

    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    onLineChange?.(i);

    const parsed = parseDialogueLine(rawLine);
    if (!parsed.spokenText) continue;

    const speakerName = parsed.speakerName || (i % 2 === 0 ? 'Speaker A' : 'Speaker B');
    const lowerSpk = `${speakerName} ${parsed.speakerHint || ''}`.toLowerCase();
    const isAuthority =
      /\b(professor|prof\.?|advisor|librarian|instructor|doctor|dr\.?|staff|dean|coordinator|director|coach|assistant|receptionist|narrator|lecturer|faculty|teacher|speaker\s*a|^a$)\b/i.test(
        lowerSpk
      );
    const isExplicitStudent =
      /\b(student|undergraduate|grad student|classmate|peer|speaker\s*b|^b$)\b/i.test(
        lowerSpk
      );
    // Any first-name-only speaker (like "Emma") who is not an authority figure maps to Speaker B (student)
    const isSpeakerB = isExplicitStudent || (!isAuthority && Boolean(parsed.speakerName)) || (!isAuthority && i % 2 === 1);

    const mappedVoice = isSpeakerB ? voiceMapping?.B : voiceMapping?.A;
    const voiceToUse =
      mappedVoice || manager.getVoiceForSpeaker(speakerName, parsed.speakerHint);
    const inferredSpkGender = inferGenderFromSpeaker(`${speakerName} ${parsed.speakerHint || ''}`);
    const genderToUse = inferredSpkGender || inferGender(voiceToUse);

    await playSpeech(parsed.spokenText, {
      voice: voiceToUse,
      voiceName: voiceToUse,
      gender: genderToUse,
      speaker: speakerName,
      sessionId: currentSession,
      skipStop: true,
      onStatus: options.onStatus,
      onEngineDetected: options.onStatus,
    });

    if (!isAudioPlayingState || currentDialogueSessionId !== currentSession) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (currentDialogueSessionId === currentSession) {
    isAudioPlayingState = false;
    options.onEnd?.();
  }
}

export const speakDialogue = playDialogue;

export async function clearAudioCache(): Promise<void> {
  try {
    const db = await dbPromise;
    await db.clear(STORE_NAME);
  } catch {}
}

// Tone synthesizer using Web Audio API for TOEFL test countdown beeps
export function playChime(freq = 880, durationMs = 200, type: OscillatorType = 'sine') {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    // AudioContext blocked or unavailable
  }
}

// Official TOEFL iBT acoustic "BEEP" cue right before microphone recording starts
export async function playRecordingBeep(): Promise<void> {
  // Brief 400ms pause so the speaker's final word finishes cleanly
  await new Promise((r) => setTimeout(r, 400));

  if (typeof window === 'undefined') {
    await new Promise((r) => setTimeout(r, 300));
    return;
  }

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) {
      await new Promise((r) => setTimeout(r, 300));
      return;
    }

    const ctx = getAudioContext() || new AudioCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
    }

    if (ctx.state !== 'running') {
      await new Promise((r) => setTimeout(r, 300));
      return;
    }

    const durationSec = 0.22; // 220ms
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + durationSec);

    // Resolve 150ms after the 220ms beep ends so the microphone never records the beep itself
    await new Promise((r) => setTimeout(r, 220 + 150));
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Speech Recognition helper
export function createSpeechRecognizer(
  onTranscript: (text: string, isFinal: boolean) => void,
  onStatusChange?: (status: 'listening' | 'stopped' | 'error', errorMsg?: string) => void
) {
  const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRec) {
    return null;
  }

  const recognition = new SpeechRec();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    onStatusChange?.('listening');
  };

  recognition.onresult = (event: any) => {
    let accumulatedFinal = '';
    let interim = '';

    for (let i = 0; i < event.results.length; ++i) {
      const res = event.results[i];
      if (res && res[0]) {
        if (res.isFinal) {
          accumulatedFinal += res[0].transcript + ' ';
        } else {
          interim += res[0].transcript;
        }
      }
    }

    const currentText = (accumulatedFinal + interim).trim();
    if (currentText) {
      onTranscript(currentText, Boolean(accumulatedFinal));
    }
  };

  recognition.onerror = (event: any) => {
    // Non-fatal error: user paused or momentarily quiet
    if (event.error === 'no-speech' || event.error === 'aborted') {
      return;
    }
    onStatusChange?.('error', event.error);
  };

  recognition.onend = () => {
    onStatusChange?.('stopped');
  };

  return recognition;
}

// Microphone Storage helpers
export function getStoredMicDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('toefl_mic_device_id') || null;
}

export function setStoredMicDeviceId(deviceId: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('toefl_mic_device_id', deviceId);
}

export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof window === 'undefined' || !navigator?.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

// Fast Base64 conversion using FileReader instead of byte-by-byte loop
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      resolve(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Session Web Speech tracking
let hasShownWebSpeechHintThisSession = false;

export function isWebSpeechBlocked(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem('toefl_webspeech_unavailable') === 'true';
}

export function markWebSpeechBlocked(): void {
  if (typeof window !== 'undefined') {
    sessionStorage.setItem('toefl_webspeech_unavailable', 'true');
  }
}

export const WEB_SPEECH_UNAVAILABLE_HINT =
  "Instant transcription isn't available in this browser (Brave blocks it). Use Chrome or Edge for instant results; otherwise transcription takes a few seconds.";

export function mapMicrophoneError(err: any): string {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission was denied. Click the lock/site settings icon in your browser address bar to allow microphone access, then refresh.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on your device. Please plug in or connect a microphone or headset and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is currently in use by another app or browser tab. Please close other voice apps (Zoom, Teams, Discord, etc.) and try again.';
  }
  return `Could not access microphone: ${err?.message || name}. You can type your response instead.`;
}

// Request and verify microphone access without opening throwaway streams
export async function requestMicrophoneAccess(): Promise<{ granted: boolean; error?: string }> {
  if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
    return {
      granted: false,
      error: 'Audio recording is not supported in this browser environment. You can type your response instead.',
    };
  }

  // Pre-check permission state without opening an audio stream
  try {
    if (navigator?.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (status.state === 'denied') {
        return {
          granted: false,
          error:
            'Microphone permission was denied. Click the lock/site settings icon in your browser address bar to allow microphone access, then refresh.',
        };
      }
    }
  } catch {
    // navigator.permissions.query('microphone') not supported in some browsers (e.g. Firefox/Safari) - proceed safely
  }

  return { granted: true };
}

// Send recorded audio to Groq cloud STT if key configured, or 100% Zero-API local Whisper in-browser
export async function transcribeAudioBlob(
  blob: Blob,
  onProgress?: (status: string) => void,
  targetSentence?: string
): Promise<{
  transcript: string;
  words?: Array<{ word: string; start: number; end: number }>;
  durationMs?: number;
  metrics?: any;
}> {
  // Client-side size check (max 10 MB)
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('Audio recording exceeds 10 MB limit. Please record a shorter answer.');
  }

  const { getStoredTranscriberProvider, getStoredTranscriberKey } = await import('./apiKey');
  const transcriberProvider = getStoredTranscriberProvider();
  const transcriberKey = getStoredTranscriberKey(transcriberProvider);

  // STRICT ISOLATION: NEVER read or use general gemini_api_key or evaluation keys for audio STT!
  if (transcriberProvider === 'groq' && transcriberKey) {
    try {
      onProgress?.('Transcribing via Groq Whisper Cloud...');
      const base64 = await blobToBase64(blob);
      let idToken = '';
      try {
        const { auth } = await import('../firebase');
        if (auth.currentUser) {
          idToken = await auth.currentUser.getIdToken();
        }
      } catch {}

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-groq-key': transcriberKey,
      };
      if (idToken) {
        headers['Authorization'] = `Bearer ${idToken}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch('/api/stt', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: blob.type || 'audio/webm',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const json = await res.json();
      if (res.ok && json.success) {
        const rawTranscript = json.transcript || '';
        const rawWords = json.words || [];
        const { transcript, words } = filterWhisperHallucinations(rawTranscript, rawWords);

        return {
          transcript,
          words,
          durationMs: json.durationMs,
        };
      }
    } catch (groqErr) {
      console.warn('[transcribeAudioBlob] Groq STT failed or timed out, falling back to local Whisper worker:', groqErr);
    }
  } else if (transcriberProvider === 'gemini' && transcriberKey) {
    try {
      onProgress?.('Transcribing via Gemini Audio Transcriber API...');
      const base64 = await blobToBase64(blob);
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gemini-audio-key': transcriberKey,
        },
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: blob.type || 'audio/webm',
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        const rawTranscript = json.transcript || '';
        const { transcript, words } = filterWhisperHallucinations(rawTranscript, []);
        return {
          transcript,
          words,
          durationMs: json.durationMs,
        };
      }
    } catch (geminiAudioErr) {
      console.warn('[transcribeAudioBlob] Gemini Audio STT failed, falling back to local Whisper worker:', geminiAudioErr);
    }
  }

  // 100% Zero-API In-Browser Whisper Fallback (Ideal for Brave browser on Linux)
  try {
    const { transcribeWithLocalWhisper } = await import('./localWhisperStt');
    const localRes = await transcribeWithLocalWhisper(blob, onProgress, targetSentence);
    return {
      transcript: localRes.transcript,
      words: localRes.words,
      durationMs: localRes.durationMs,
      metrics: localRes.metrics,
    };
  } catch (localErr: any) {
    console.error('[transcribeAudioBlob] Local Whisper STT failed:', localErr);
    throw new Error(localErr?.message || 'Audio transcription failed. Ensure microphone access is allowed.');
  }
}

// Unified Voice Recording Session combining Web Speech (real-time) and MediaRecorder (reliable fallback)
export interface VoiceSessionOptions {
  onTranscriptUpdate?: (text: string) => void;
  onStatusChange?: (status: 'idle' | 'listening' | 'waiting_for_voice' | 'processing' | 'error', errorMsg?: string) => void;
  onAudioLevel?: (level: number) => void; // 0 to 100 for live meter
  onQuietWarning?: (warning: string) => void; // "We can't hear you..."
  onDeviceDisconnected?: (msg: string) => void;
  onNotice?: (notice: string) => void; // e.g. Brave Web Speech notice or headphones echo notice
  autoStartThreshold?: number; // Level (0-100) to trigger auto-start
}

export interface VoiceSessionResult {
  transcript: string;
  audioBlob: Blob | null;
  durationMs?: number;
  isSilent?: boolean;
  error?: 'TRANSCRIPTION_TIMEOUT' | 'TRANSCRIPTION_FAILED';
  metrics?: any;
  fillerWordsCount?: number;
  fillerWordsList?: string[];
}

export interface VoiceSession {
  start: () => Promise<void>;
  stop: () => Promise<VoiceSessionResult>;
  abort: () => void;
  isRecording: () => boolean;
}

export function createVoiceSession(options: VoiceSessionOptions): VoiceSession {
  let isRecordingState = false;
  let activeStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let recognitionInstance: any = null;
  let accumulatedTranscript = '';
  let audioChunks: Blob[] = [];

  let audioContext: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  let meterInterval: any = null;
  let audioContextAlwaysRunning = false;

  let maxVolume = 0;
  let totalVolume = 0;
  let volumeSamples = 0;
  let quietWarningFired = false;
  let recordingStartTime = 0;
  let isDeviceUnplugged = false;
  let waitingForVoice = false;

  const tryResumeContext = () => {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  };

  const cleanupAudioNodes = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', tryResumeContext);
      window.removeEventListener('keydown', tryResumeContext);
    }
    if (meterInterval) {
      clearInterval(meterInterval);
      meterInterval = null;
    }
    if (mediaStreamSource) {
      try {
        mediaStreamSource.disconnect();
      } catch {}
      mediaStreamSource = null;
    }
    if (analyserNode) {
      try {
        analyserNode.disconnect();
      } catch {}
      analyserNode = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try {
        audioContext.close();
      } catch {}
      audioContext = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }
    options.onAudioLevel?.(0);
  };

  const cleanupAll = () => {
    isRecordingState = false;
    cleanupAudioNodes();
    if (recognitionInstance) {
      try {
        recognitionInstance.stop();
      } catch {}
      recognitionInstance = null;
    }
    mediaRecorder = null;
    audioChunks = [];
  };

  return {
    isRecording: () => isRecordingState,

    start: async () => {
      cleanupAll();
      accumulatedTranscript = '';
      audioChunks = [];
      maxVolume = 0;
      totalVolume = 0;
      volumeSamples = 0;
      quietWarningFired = false;
      isDeviceUnplugged = false;
      waitingForVoice = false;

      // Stop any TTS playback immediately to avoid microphone picking up app voice
      stopSpeaking();
      if (isAudioPlaying()) {
        await new Promise((r) => setTimeout(r, 120));
      }

      // Check mic access first without opening a throwaway stream
      const permCheck = await requestMicrophoneAccess();
      if (!permCheck.granted) {
        options.onStatusChange?.('error', permCheck.error);
        throw new Error(permCheck.error);
      }

      try {
        const selectedDeviceId = getStoredMicDeviceId();
        const speechConstraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false, // Prevents boosting distant background voices/noise when using earphones
            channelCount: 1,
            sampleRate: 16000,
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          },
        };

        // Open microphone once directly in session start
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(speechConstraints);
        } catch (firstErr: any) {
          // If browser rejects constraints or device changed, retry with { audio: true }
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (secondErr: any) {
            const errorMsg = mapMicrophoneError(secondErr || firstErr);
            options.onStatusChange?.('error', errorMsg);
            throw new Error(errorMsg);
          }
        }

        activeStream = stream;

        // Monitor if device is unplugged mid-recording
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.onended = () => {
            if (isRecordingState) {
              isDeviceUnplugged = true;
              console.warn('[Audio] Microphone device disconnected mid-recording');
              options.onDeviceDisconnected?.('Microphone was disconnected. Keeping audio recorded so far.');
            }
          };
        }

        // Setup AnalyserNode for live level meter & silence detection
        try {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          if (AudioCtx) {
            audioContext = new AudioCtx();
            // Resume immediately after creating AudioContext
            if (audioContext.state === 'suspended') {
              try {
                await audioContext.resume();
              } catch {}
            }

            // Also attach interaction resume handler if still suspended
            if (typeof window !== 'undefined') {
              window.addEventListener('click', tryResumeContext, { once: true });
              window.addEventListener('keydown', tryResumeContext, { once: true });
            }

            audioContextAlwaysRunning = audioContext.state === 'running';
            audioContext.onstatechange = () => {
              if (!audioContext || audioContext.state !== 'running') {
                audioContextAlwaysRunning = false;
              }
            };

            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 256;
            mediaStreamSource = audioContext.createMediaStreamSource(stream);
            mediaStreamSource.connect(analyserNode);

            const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
            meterInterval = setInterval(() => {
              if (!isRecordingState || !analyserNode) return;

              if (!audioContext || audioContext.state !== 'running') {
                audioContextAlwaysRunning = false;
              }

              analyserNode.getByteFrequencyData(dataArray);
              const lvl = calculateAudioLevel(dataArray);
              options.onAudioLevel?.(lvl);

              if (waitingForVoice && lvl > (options.autoStartThreshold || 0)) {
                waitingForVoice = false;
                startRecording();
              }

              volumeSamples++;
              totalVolume += lvl;
              if (lvl > maxVolume) maxVolume = lvl;

              // Only trust analyser for "We can't hear you" if audioContext was running the whole time
              const elapsed = Date.now() - recordingStartTime;
              if (elapsed >= 3000 && elapsed <= 3800 && !quietWarningFired) {
                if (audioContextAlwaysRunning && audioContext?.state === 'running') {
                  quietWarningFired = true;
                  const avgFirst3 = totalVolume / Math.max(1, volumeSamples);
                  if (avgFirst3 < 3 && maxVolume < 5) {
                    options.onQuietWarning?.("We can't hear you. Check your microphone or speak closer to it.");
                  }
                }
              }
            }, 60);
          }
        } catch (e) {
          audioContextAlwaysRunning = false;
          console.warn('[Audio] AnalyserNode setup notice:', e);
        }

        // Pick best supported MIME type in order:
        // audio/webm;codecs=opus, audio/webm, audio/mp4 (Safari), audio/ogg;codecs=opus
        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
        ];
        const supportedType = mimeTypes.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';

        try {
          mediaRecorder = supportedType
            ? new MediaRecorder(stream, { mimeType: supportedType, audioBitsPerSecond: 24000 })
            : new MediaRecorder(stream, { audioBitsPerSecond: 24000 });

          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              audioChunks.push(e.data);
            }
          };
        } catch {
          mediaRecorder = null;
        }

        const startRecording = () => {
          if (mediaRecorder && mediaRecorder.state === 'inactive') {
            try {
              mediaRecorder.start(250);
            } catch {}
          }
          recordingStartTime = Date.now();
          isRecordingState = true;
          options.onStatusChange?.('listening');

          // Setup SpeechRecognition for real-time live typing if not blocked in session (Brave safe)
          if (!isWebSpeechBlocked() && !recognitionInstance) {
            try {
              recognitionInstance = createSpeechRecognizer(
                (text) => {
                  accumulatedTranscript = text;
                  options.onTranscriptUpdate?.(text);
                },
                (status, errorMsg) => {
                  if (status === 'error' && isRecordingState) {
                    // Brave shields and privacy browsers block Web Speech API servers with network/service-not-allowed
                    // Do NOT interrupt or fail recording; MediaRecorder captures audio cleanly for /api/stt
                    if (errorMsg === 'not-allowed') {
                      options.onStatusChange?.('error', 'Microphone permission denied.');
                    } else {
                      markWebSpeechBlocked();
                      if (!hasShownWebSpeechHintThisSession) {
                        hasShownWebSpeechHintThisSession = true;
                        options.onNotice?.(WEB_SPEECH_UNAVAILABLE_HINT);
                      }
                    }
                  }
                }
              );

              if (recognitionInstance) {
                try {
                  recognitionInstance.start();
                } catch (startErr) {
                  console.warn('SpeechRecognition.start failed (Brave safe fallback):', startErr);
                  markWebSpeechBlocked();
                }
              }
            } catch (createErr) {
              console.warn('SpeechRecognition setup failed (Brave safe fallback):', createErr);
              markWebSpeechBlocked();
            }
          } else if (!hasShownWebSpeechHintThisSession && isWebSpeechBlocked()) {
            hasShownWebSpeechHintThisSession = true;
            options.onNotice?.(WEB_SPEECH_UNAVAILABLE_HINT);
          }
        };

        if (waitingForVoice) {
          isRecordingState = true;
          options.onStatusChange?.('waiting_for_voice');
        } else {
          startRecording();
        }

      } catch (err: any) {
        cleanupAll();
        options.onStatusChange?.('error', err.message || 'Could not start recording');
        throw err;
      }
    },

    stop: async (): Promise<VoiceSessionResult> => {
      if (!isRecordingState && audioChunks.length === 0) {
        return { transcript: accumulatedTranscript, audioBlob: null };
      }

      const stopRequestedTime = Date.now();
      console.log('[Audio Timing] Stop recording triggered at', new Date().toISOString());

      // Keep recording about 300 ms after the user presses Stop so the first and last words are not clipped
      if (mediaRecorder && mediaRecorder.state === 'recording' && !isDeviceUnplugged) {
        await new Promise((r) => setTimeout(r, 300));
      }

      isRecordingState = false;

      // Stop speech recognition
      if (recognitionInstance) {
        try {
          recognitionInstance.stop();
        } catch {}
        recognitionInstance = null;
      }

      // Stop MediaRecorder and collect final audio blob
      let finalAudioBlob: Blob | null = null;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mediaRecorder!.onstop = () => {
            const mime = mediaRecorder?.mimeType || 'audio/webm';
            finalAudioBlob = new Blob(audioChunks, { type: mime });
            resolve();
          };
          try {
            mediaRecorder!.stop();
          } catch {
            resolve();
          }
        });
      } else if (audioChunks.length > 0) {
        finalAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      }

      // Release audio nodes & stream tracks immediately
      cleanupAudioNodes();

      // Decide "silent" mainly from recorded blob size and duration
      // A blob under ~1 KB per second of recording is likely silent.
      // Never treat clip as silent because of analyser readings if AudioContext was suspended.
      const recordingDurationSec = Math.max(0.2, (Date.now() - recordingStartTime) / 1000);
      const blobSize = finalAudioBlob ? finalAudioBlob.size : 0;
      const bytesPerSec = blobSize / recordingDurationSec;

      let isSilentClip = false;
      if (!accumulatedTranscript.trim()) {
        if (!finalAudioBlob || blobSize < 150) {
          isSilentClip = true;
        } else if (recordingDurationSec >= 1.5 && bytesPerSec < 850) {
          if (audioContextAlwaysRunning && audioContext?.state === 'running') {
            const avgVol = volumeSamples > 0 ? totalVolume / volumeSamples : 0;
            if (maxVolume < 3 && avgVol < 1.5) {
              isSilentClip = true;
            }
          } else if (bytesPerSec < 350) {
            // When analyser was suspended or not running, transcribe anyway unless data is nearly empty
            isSilentClip = true;
          }
        }
      }

      // Clean any live Web Speech transcript against silence/punctuation hallucinations
      const { transcript: cleanedLive } = filterWhisperHallucinations(accumulatedTranscript, []);
      const liveTranscript = cleanedLive.trim();

      if (isSilentClip && !liveTranscript) {
        console.warn(`[Audio Timing] Silent clip detected (size: ${blobSize}B, duration: ${recordingDurationSec.toFixed(1)}s, ${Math.round(bytesPerSec)} B/s, ctxRunning: ${audioContextAlwaysRunning}). Skipping transcription.`);
        options.onStatusChange?.('error', 'No sound was detected in your recording. Please check your microphone or speak closer to it, then try again.');
        return { transcript: '', audioBlob: finalAudioBlob, isSilent: true };
      }

      // If we have live transcript from Web Speech, return immediately
      if (liveTranscript.length > 0) {
        console.log(`[Audio Timing] stop -> transcript: ${Date.now() - stopRequestedTime}ms (via Web Speech)`);
        options.onStatusChange?.('idle');
        return { transcript: liveTranscript, audioBlob: finalAudioBlob };
      }

      // Fallback: If Web Speech produced no text, use Whisper / STT transcription
      if (finalAudioBlob && (finalAudioBlob as Blob).size > 150) {
        options.onStatusChange?.('processing');
        try {
          const { transcript: aiTranscribed, durationMs, metrics } = await transcribeAudioBlob(finalAudioBlob);
          const { transcript: filteredAi } = filterWhisperHallucinations(aiTranscribed || '', []);
          const cleaned = filteredAi.trim() || liveTranscript;
          console.log(`[Audio Timing] stop -> transcript: ${Date.now() - stopRequestedTime}ms (via STT, model duration: ${durationMs || 'N/A'}ms)`);
          if (cleaned) {
            options.onTranscriptUpdate?.(cleaned);
          }
          options.onStatusChange?.('idle');
          return {
            transcript: cleaned,
            audioBlob: finalAudioBlob,
            durationMs,
            metrics,
            fillerWordsCount: metrics?.fillerCount ?? 0,
            fillerWordsList: metrics?.fillerWords ?? [],
          };
        } catch (err: any) {
          console.warn('[Audio] AI speech transcription fallback error:', err);
          if (liveTranscript) {
            options.onStatusChange?.('idle');
            return { transcript: liveTranscript, audioBlob: finalAudioBlob };
          }
          const errCode: 'TRANSCRIPTION_TIMEOUT' | 'TRANSCRIPTION_FAILED' =
            err?.message === 'TRANSCRIPTION_TIMEOUT' ? 'TRANSCRIPTION_TIMEOUT' : 'TRANSCRIPTION_FAILED';

          if (errCode === 'TRANSCRIPTION_TIMEOUT') {
            options.onStatusChange?.('error', 'Transcription timed out (20s). Audio saved. Click "Retry transcription" or type your answer.');
          } else {
            options.onStatusChange?.('error', 'Audio transcription failed. Audio saved. Click "Retry transcription" or type your answer.');
          }

          // Return failure status with retained audioBlob instead of throwing
          return { transcript: '', audioBlob: finalAudioBlob, error: errCode };
        }
      }

      options.onStatusChange?.('idle');
      return { transcript: liveTranscript, audioBlob: finalAudioBlob };
    },

    abort: () => {
      cleanupAll();
      options.onStatusChange?.('idle');
    },
  };
}


// Time words lookup
const TIME_HOURS: Record<string, string> = {
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  '10': 'ten',
  '11': 'eleven',
  '12': 'twelve',
};

// Numbers to words map
const NUM_WORDS: Record<string, string> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  '10': 'ten',
  '11': 'eleven',
  '12': 'twelve',
  '13': 'thirteen',
  '14': 'fourteen',
  '15': 'fifteen',
  '16': 'sixteen',
  '17': 'seventeen',
  '18': 'eighteen',
  '19': 'nineteen',
  '20': 'twenty',
  '30': 'thirty',
  '40': 'forty',
  '50': 'fifty',
  '60': 'sixty',
  '70': 'seventy',
  '80': 'eighty',
  '90': 'ninety',
  '100': 'one hundred',
  '1000': 'one thousand',
  '1st': 'first',
  '2nd': 'second',
  '3rd': 'third',
  '4th': 'fourth',
  '5th': 'fifth',
  '6th': 'sixth',
  '7th': 'seventh',
  '8th': 'eighth',
  '9th': 'ninth',
  '10th': 'tenth',
};

// Spoken text normalizer that resolves "10:00" vs "ten o'clock", contractions, and numbers
export function normalizeSpokenText(text: string): string {
  if (!text) return '';
  let s = text.toLowerCase();

  // Replace smart / curly quotes and special characters
  s = s.replace(/[\u2018\u2019\u201B\u0060\u00B4]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');

  // Convert "10:00", "10:00 am", "10:00 a.m.", "10:00pm", etc. -> "ten o'clock"
  s = s.replace(/\b(1[0-2]|[1-9]):00(?:\s*(?:am|pm|a\.m\.|p\.m\.))?\b/gi, (_, h) => {
    return `${TIME_HOURS[h] || h} o'clock`;
  });

  // Convert "10:30", "10:15", "10:45", etc.
  s = s.replace(/\b(1[0-2]|[1-9]):([0-5][0-9])(?:\s*(?:am|pm|a\.m\.|p\.m\.))?\b/gi, (_, h, m) => {
    const minWords: Record<string, string> = {
      '15': 'fifteen',
      '30': 'thirty',
      '45': 'forty five',
      '20': 'twenty',
      '10': 'ten',
      '05': 'five',
    };
    return `${TIME_HOURS[h] || h} ${minWords[m] || m}`;
  });

  // Convert "10 o'clock", "10 oclock", "10 o clock" -> "ten o'clock"
  s = s.replace(/\b(1[0-2]|[1-9])\s*o'?clock\b/gi, (_, h) => `${TIME_HOURS[h] || h} o'clock`);
  s = s.replace(/\b(1[0-2]|[1-9])\s+o\s+clock\b/gi, (_, h) => `${TIME_HOURS[h] || h} o'clock`);

  // Convert numbers to words: "10" -> "ten", "1st" -> "first"
  s = s.replace(/\b([0-9]{1,4}(?:st|nd|rd|th)?)\b/g, (match) => NUM_WORDS[match] || match);

  // Normalize o'clock variations
  s = s.replace(/\bo\s+clock\b/g, "o'clock");
  s = s.replace(/\boclock\b/g, "o'clock");

  // Symbols
  s = s.replace(/%/g, ' percent ');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\$/g, ' dollar ');

  return s;
}

// Tokenize text into normalized word tokens for comparison
export function tokenizeNormalizedWords(text: string): string[] {
  const norm = normalizeSpokenText(text);
  return norm
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// Check if two words are equivalent in TOEFL speaking context (strict — never matches "and" to "wind")
function areWordsEquivalent(targetWord: string, candidate: string): boolean {
  if (!targetWord || !candidate) return false;
  if (targetWord === candidate) return true;

  // Contraction or punctuation-stripped exact match
  const cleanTarget = targetWord.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const cleanCandidate = candidate.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!cleanTarget || !cleanCandidate) return false;
  if (cleanTarget === cleanCandidate) return true;

  // Strict TOEFL abbreviations & true homophones only
  const equivalents: Record<string, string[]> = {
    laboratory: ['lab', 'labs'],
    lab: ['laboratory'],
    professor: ['prof'],
    prof: ['professor'],
    doctor: ['dr'],
    dr: ['doctor'],
    there: ['their', 'theyre'],
    their: ['there', 'theyre'],
    theyre: ['there', 'their'],
    to: ['too', 'two'],
    too: ['to', 'two'],
    two: ['to', 'too'],
    hear: ['here'],
    here: ['hear'],
    for: ['four'],
    four: ['for'],
    right: ['write'],
    write: ['right'],
    know: ['no'],
    no: ['know'],
    new: ['knew'],
    knew: ['new'],
    our: ['hour'],
    hour: ['our'],
    by: ['buy'],
    buy: ['by'],
  };

  if (equivalents[cleanTarget]?.includes(cleanCandidate)) return true;
  if (equivalents[cleanCandidate]?.includes(cleanTarget)) return true;

  // Minor plural/past inflection ONLY on content words of 6+ letters
  if (
    cleanTarget.length >= 6 &&
    cleanCandidate.length >= 6 &&
    (cleanTarget + 's' === cleanCandidate ||
      cleanCandidate + 's' === cleanTarget ||
      cleanTarget + 'ed' === cleanCandidate ||
      cleanCandidate + 'ed' === cleanTarget)
  ) {
    return true;
  }

  // Allow at most 1 character edit ONLY on long words (>= 7 chars) that start with the same letter
  if (cleanTarget.length >= 7 && cleanCandidate.length >= 7 && cleanTarget[0] === cleanCandidate[0]) {
    const dist = levenshteinDistance(cleanTarget, cleanCandidate);
    if (dist <= 1) return true;
  }

  return false;
}

const FILLER_TOKENS_SET = new Set(['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'uhm', 'umm']);

/**
 * Strict Sequence Alignment (Needleman-Wunsch / Longest Common Subsequence)
 * for TOEFL Listen & Repeat accuracy scoring:
 * 1. Aligns target words and spoken words in strict sequential order (0..N).
 *    Each spoken word can match at most one target word in sequence.
 * 2. Penalizes both omitted/missed target words AND extra/inserted/repeated spoken words.
 * 3. Any missing target word OR any extra/inserted word guarantees accuracy < 100%.
 * 4. Returns ordered wordStatuses with 'matched' (green), 'missed' (red), and 'extra' (amber "+ word").
 */
export function calculateSentenceMatch(
  target: string,
  spoken: string
): {
  percentage: number;
  wordStatuses: Array<{ word: string; status: 'matched' | 'missed' | 'extra' }>;
  matchedCount?: number;
  missedCount?: number;
  extraCount?: number;
} {
  const mergedSpoken = mergeCompoundWords ? mergeCompoundWords(spoken, target) : spoken;
  const rawTargetWords = target.trim().split(/\s+/).filter(Boolean);
  if (rawTargetWords.length === 0) {
    return { percentage: 0, wordStatuses: [], matchedCount: 0, missedCount: 0, extraCount: 0 };
  }

  // Expand target words so each display word has its normalized comparison token(s)
  const targetItems = rawTargetWords.map((raw) => {
    const tokens = tokenizeNormalizedWords(raw);
    return {
      display: raw,
      norm: tokens.join(' ') || raw.toLowerCase().replace(/[^a-z0-9]/g, ''),
      tokens,
    };
  });

  // Tokenize spoken words while preserving display tokens and excluding pure vocalized fillers
  // (vocalized fillers are tracked separately by the filler detector)
  const rawSpokenWords = mergedSpoken
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^\[|\]$/g, '').trim())
    .filter((w) => {
      if (!w) return false;
      const clean = w.toLowerCase().replace(/[^a-z0-9']/g, '');
      return Boolean(clean) && !FILLER_TOKENS_SET.has(clean);
    });

  // Collapse multi-word spoken time expressions (e.g. "ten" + "o'clock" when target has "10:00")
  const spokenItems: Array<{ display: string; norm: string }> = [];
  for (let idx = 0; idx < rawSpokenWords.length; idx++) {
    const w1 = rawSpokenWords[idx];
    const w2 = idx + 1 < rawSpokenWords.length ? rawSpokenWords[idx + 1] : '';
    if (w2) {
      const combinedNorm = tokenizeNormalizedWords(`${w1} ${w2}`).join(' ');
      if (combinedNorm && targetItems.some((ti) => ti.norm === combinedNorm && ti.tokens.length >= 2)) {
        spokenItems.push({ display: `${w1} ${w2}`, norm: combinedNorm });
        idx++;
        continue;
      }
    }
    const norm = tokenizeNormalizedWords(w1).join(' ') || w1.toLowerCase().replace(/[^a-z0-9]/g, '');
    spokenItems.push({ display: w1, norm });
  }

  const M = targetItems.length;
  const N = spokenItems.length;

  if (N === 0) {
    return {
      percentage: 0,
      wordStatuses: targetItems.map((ti) => ({ word: ti.display, status: 'missed' as const })),
      matchedCount: 0,
      missedCount: M,
      extraCount: 0,
    };
  }

  // Dynamic Programming LCS table for strict sequential alignment
  const dp: number[][] = Array.from({ length: M + 1 }, () => Array(N + 1).fill(0));

  for (let i = 1; i <= M; i++) {
    for (let j = 1; j <= N; j++) {
      if (areWordsEquivalent(targetItems[i - 1].norm, spokenItems[j - 1].norm)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack from (M, N) to (0, 0) to reconstruct exact sequential diff (matched, missed, extra)
  const reversedStatuses: Array<{ word: string; status: 'matched' | 'missed' | 'extra' }> = [];
  let i = M;
  let j = N;
  let alignedMatchesCount = 0;
  let extraWordsCount = 0;

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      areWordsEquivalent(targetItems[i - 1].norm, spokenItems[j - 1].norm) &&
      dp[i][j] === dp[i - 1][j - 1] + 1
    ) {
      reversedStatuses.push({ word: targetItems[i - 1].display, status: 'matched' });
      alignedMatchesCount++;
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversedStatuses.push({ word: spokenItems[j - 1].display, status: 'extra' });
      extraWordsCount++;
      j--;
    } else {
      reversedStatuses.push({ word: targetItems[i - 1].display, status: 'missed' });
      i--;
    }
  }

  const wordStatuses = reversedStatuses.reverse();
  const missedWordsCount = M - alignedMatchesCount;

  // Compute strict accuracy score with penalty for extra/inserted/repeated words
  let percentage = Math.max(
    0,
    Math.round(((alignedMatchesCount - extraWordsCount * 0.5) / M) * 100)
  );

  // If ANY target word was missed OR ANY extra word was inserted, accuracy MUST be < 100%
  if (missedWordsCount > 0 || extraWordsCount > 0) {
    const maxAllowed =
      missedWordsCount === 0 && extraWordsCount > 0
        ? Math.max(0, Math.min(94, 100 - extraWordsCount * 6))
        : Math.min(95, Math.floor((alignedMatchesCount / M) * 100));
    percentage = Math.min(percentage, maxAllowed);
  }

  return {
    percentage,
    wordStatuses,
    matchedCount: alignedMatchesCount,
    missedCount: missedWordsCount,
    extraCount: extraWordsCount,
  };
}

// Play short beep tone for real exam auto-flow
export function playExamBeep(frequency = 800, durationMs = 250): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {}
}
