import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { resolveModelChains, getModelsForRole } from './modelRoles';
import * as CURATED from '../data/curatedQuestions';
import { ACADEMIC_GLOSSARY } from '../utils/academicGlossary';
import { generateWithFallback } from './geminiUtils';
import { redactKey, isKeyError, isTransientError, getStatus, extractErrorMessage, isQuotaExhaustedError, redactSensitiveInfo } from './geminiErrors';
import { inferGender } from '../utils/voices';
import { callOpenAiCompatibleChat, testOpenAiCompatible, callOpenAiTts, callOpenRouterTts, callWhisperTranscription } from './llmClient';
import { callChatWithHealing } from './chatHealing';
import { callGroqSpeech } from './groqSpeech';
import { callAudio8Speech } from './audio8Speech';
import { wrapWavHeaderIfNeeded, parseSampleRateFromMime } from '../utils/audioHelpers';
import {
  collectAvailableProviders,
  prioritizeForGeneration,
  incrementProviderInFlight,
  decrementProviderInFlight,
  recordProviderErrorCooldown,
  clearProviderCooldown,
} from './providerRouter';
import {
  normalizeCompleteWordsTask,
  normalizeBuildSentenceTask,
  verifyAndNormalizeMcqQuestions,
  normalizeDailyLifeTask,
  normalizeReadingAcademicTask,
  classifyReadingQuestionTypeBadge,
  normalizeListeningChooseResponseTask,
  normalizeListeningAnnouncementTask,
  normalizeListeningAcademicTalkTask,
  normalizeListeningDialogueTask,
  canonicalizeTaskType,
} from '../utils/taskNormalizer';
import { COACH_CURATED_BANK } from '../utils/coachCuratedBank';

export type ApiCallOptions = string | { provider?: string; apiKey?: string; baseUrl?: string; model?: string; sttModel?: string; ttsModel?: string; voiceApiKey?: string; ttsProvider?: string; audio8Url?: string; prompt?: string; coachMode?: boolean; mode?: 'exam' | 'coach' };

export { redactKey, isKeyError, isTransientError, getStatus, extractErrorMessage, isQuotaExhaustedError, redactSensitiveInfo };

export function parseRateLimitFromError(error: any) {
  let kind: 'per-minute' | 'per-day' | 'unknown' = 'per-minute';
  let retryAfterSeconds = 25;

  const errStr = JSON.stringify(error?.details || error?.message || error || '');
  const lower = errStr.toLowerCase();

  // Extract explicit retry seconds if mentioned in message (e.g. "try again in 12s", "retry after 20 seconds")
  const secMatch = errStr.match(/(\d+)\s*(?:s|sec|seconds|second)\b/i);
  if (secMatch) {
    retryAfterSeconds = Math.max(5, parseInt(secMatch[1], 10));
  }

  if (/(per[-_ ]?day|daily[-_ ]quota|daily[-_ ]limit|generate_content_free_tier_requests|resets at midnight pt)/i.test(errStr)) {
    kind = 'per-day';
    retryAfterSeconds = 1800;
  }

  if (error?.details && Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
        const match = String(detail.retryDelay).match(/([\d.]+)s/);
        if (match) retryAfterSeconds = Math.ceil(parseFloat(match[1]));
      }
      if (detail['@type']?.includes('QuotaFailure')) {
        const violations = detail.violations || [];
        for (const v of violations) {
          const qId = String(v.quotaId || '').toLowerCase();
          if (qId.includes('perday') || qId.includes('daily')) {
            kind = 'per-day';
            retryAfterSeconds = 1800;
          } else if (qId.includes('perminute') || qId.includes('minute')) {
            kind = 'per-minute';
          }
        }
      }
    }
  }

  return { kind, retryAfterSeconds };
}

// Module-level Map of models that rejected the thinking parameter with a 400
export const rejectedThinkingModels = new Map<string, boolean>();

export interface ModelThinkingConfig {
  transcribe?: { thinkingBudget: number };
  evaluation?: { thinkingLevel?: string; thinkingBudget?: number };
}

// Verified model thinking specifications chosen per model
export const VERIFIED_MODEL_THINKING_CONFIGS: Record<string, ModelThinkingConfig> = {
  'gemini-3.8-flash': {
    evaluation: { thinkingBudget: 256 },
  },
  'gemini-3.5-flash-lite': {
    evaluation: { thinkingBudget: 256 },
  },
};

export function getModelThinkingConfig(
  model: string,
  mode: 'transcribe' | 'evaluation'
): { thinkingLevel?: string; thinkingBudget?: number } | null {
  if (mode === 'transcribe') {
    return null; // Transcription does not need thinking tokens
  }
  if (rejectedThinkingModels.get(model)) {
    return null;
  }
  const config = VERIFIED_MODEL_THINKING_CONFIGS[model];
  if (config) {
    return config.evaluation || null;
  }
  return null;
}

const CoachBlueprintSchema = z.array(
  z.object({
    step: z.string(),
    description: z.string(),
    starters: z.array(z.string()),
  })
).optional();

const Schemas = {
  completeWords: z.object({
    title: z.string(),
    passage: z.string().optional(),
    text: z.string(),
    totalBlanks: z.number(),
    blanks: z.any().optional(),
  }),
  readingPassage: z.object({
    title: z.string(),
    passage: z.string(),
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number(),
        why: z.string(),
        questionType: z.string().optional(),
        hint: z.string().optional(),
      })
    ),
  }),
  listeningDialogue: z.object({
    title: z.string(),
    context: z.string(),
    speakers: z.record(z.string(), z.string()),
    speakerGenders: z.record(z.string(), z.string()).default({ A: 'female', B: 'male' }),
    script: z.string(),
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number(),
        why: z.string(),
        audioExcerpt: z.string().optional(),
        questionType: z.string().optional(),
        hint: z.string().optional(),
      })
    ),
  }),
  listenRepeat: z.object({
    title: z.string(),
    speakerName: z.string().default('Sarah (student)'),
    speakerGender: z.string().default('female'),
    sentences: z.array(z.string()),
  }),
  speakingInterview: z.object({
    title: z.string(),
    context: z.string(),
    interviewerName: z.string().default('Professor Lee'),
    interviewerGender: z.string().default('male'),
    questions: z.array(
      z.object({
        question: z.string(),
        prepTimeSeconds: z.number(),
        responseTimeSeconds: z.number(),
        suggestedPoints: z.array(z.string()),
        sampleAnswer: z.string().optional(),
        speakingFormula: z.array(z.string()).optional(),
        topicVocabulary: z.array(z.string()).optional(),
        sentenceStarters: z.array(z.string()).optional(),
      })
    ),
  }),
  buildSentence: z.object({
    title: z.string(),
    items: z.array(
      z.object({
        context: z.string(),
        framePrefix: z.string().optional().default(''),
        frameSuffix: z.string().optional().default('.'),
        targetChunks: z.array(z.string()),
        distractorChunks: z.array(z.string()).optional().default([]),
        distractorWord: z.string().optional(),
        words: z.array(z.string()),
        targetSentence: z.string().optional(),
        answer: z.string(),
        grammarRule: z.string().optional(),
        explanation: z.string(),
      })
    ),
  }),
  writeEmail: z.object({
    title: z.string(),
    situation: z.string(),
    recipient: z.string(),
    goals: z.array(z.string()),
    suggestedWordCount: z.string(),
    coachBlueprint: CoachBlueprintSchema,
  }),
  academicDiscussion: z.object({
    title: z.string(),
    professorName: z.string(),
    professorPrompt: z.string(),
    s1: z.object({ name: z.string(), text: z.string() }),
    s2: z.object({ name: z.string(), text: z.string() }),
    question: z.string(),
    coachBlueprint: CoachBlueprintSchema,
  }),
  vocabularyExplanation: z.object({
    word: z.string(),
    phonetic: z.string().optional().default(''),
    meanings: z.array(
      z.object({
        partOfSpeech: z.string(),
        definition: z.string(),
        example: z.string().optional().default(''),
      })
    ),
    examples: z.array(z.string()).optional().default([]),
    synonyms: z.array(z.string()).optional().default([]),
  }),
  dailyLife: z.object({
    title: z.string(),
    formatType: z.string().default('notice'),
    context: z.string(),
    contentText: z.string(),
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number(),
        why: z.string(),
        questionType: z.string().optional(),
        hint: z.string().optional(),
      })
    ),
  }),
  listeningChooseResponse: z.object({
    title: z.string(),
    category: z.string().optional().default('Campus Life'),
    items: z
      .array(
        z.object({
          audioPrompt: z.string(),
          speakerName: z.string().default('Campus Speaker'),
          speakerGender: z.string().default('male'),
          options: z.array(z.string()),
          answer: z.number(),
          why: z.string(),
          coachTip: z.string().optional(),
        })
      )
      .optional(),
    audioPrompt: z.string().optional(),
    speakerName: z.string().optional().default('Campus Speaker'),
    speakerGender: z.string().optional().default('male'),
    options: z.array(z.string()).optional(),
    answer: z.number().optional(),
    why: z.string().optional(),
    coachTip: z.string().optional(),
  }),
  listeningAnnouncement: z.object({
    title: z.string(),
    context: z.string(),
    speakerName: z.string().default('University Administrator'),
    speakerGender: z.string().default('female'),
    script: z.string(),
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number(),
        why: z.string(),
        questionType: z.string().optional(),
        hint: z.string().optional(),
      })
    ),
  }),
  listeningAcademicTalk: z.object({
    title: z.string(),
    topic: z.string(),
    speakerName: z.string().default('Professor'),
    speakerGender: z.string().default('male'),
    script: z.string(),
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number(),
        why: z.string(),
        audioExcerpt: z.string().optional(),
        questionType: z.string().optional(),
        hint: z.string().optional(),
      })
    ),
  }),
};

export function cleanAndExtractJson(text: string): any {
  if (!text || !text.trim()) {
    throw new Error('Model returned an empty response');
  }

  try {
    return JSON.parse(text.trim());
  } catch {}

  let unmarkdown = text.trim();
  if (unmarkdown.includes('```')) {
    unmarkdown = unmarkdown.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
    try {
      return JSON.parse(unmarkdown);
    } catch {}
  }

  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      try {
        let repair = objMatch[0].replace(/,\s*([\}\]])/g, '$1');
        
        // Count braces to repair truncation
        let open = (repair.match(/\{/g) || []).length;
        let closed = (repair.match(/\}/g) || []).length;
        while (open > closed) {
          repair += '}';
          closed++;
        }
        
        return JSON.parse(repair);
      } catch {}
    }
  }

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {}
  }

  throw new Error(`Unable to parse valid JSON from AI response: ${text.slice(0, 100)}...`);
}

function normalizeAcademicDiscussion(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || 'Writing for an Academic Discussion');
  const profName = String(data.professorName || data.professor_name || data.professor?.name || 'Dr. Henderson');
  const profPrompt = String(data.professorPrompt || data.professor_prompt || data.professor?.prompt || data.prompt || data.context || '');
  if (!profPrompt || profPrompt.trim().length < 10) {
    throw new Error('AI response missing valid professor discussion prompt');
  }
  
  let s1 = data.s1 || data.student1 || (Array.isArray(data.students) ? data.students[0] : null);
  let s2 = data.s2 || data.student2 || (Array.isArray(data.students) ? data.students[1] : null);

  const s1Text = String((typeof s1 === 'object' ? (s1?.text || s1?.post || s1?.response || s1?.content) : (typeof s1 === 'string' ? s1 : '')) || '');
  const s2Text = String((typeof s2 === 'object' ? (s2?.text || s2?.post || s2?.response || s2?.content) : (typeof s2 === 'string' ? s2 : '')) || '');

  if (!s1Text || !s2Text) {
    throw new Error('AI response missing student discussion posts');
  }

  const s1Norm = {
    name: String((typeof s1 === 'object' ? (s1?.name || s1?.student || s1?.studentName) : null) || 'Student A'),
    text: s1Text,
  };
  const s2Norm = {
    name: String((typeof s2 === 'object' ? (s2?.name || s2?.student || s2?.studentName) : null) || 'Student B'),
    text: s2Text,
  };

  const question = String(data.question || data.instruction || 'Participate in the discussion by responding to the professor and explaining your position.');
  const coachBlueprint = Array.isArray(data.coachBlueprint) ? data.coachBlueprint : undefined;
  return { title, professorName: profName, professorPrompt: profPrompt, s1: s1Norm, s2: s2Norm, question, ...(coachBlueprint ? { coachBlueprint } : {}) };
}

function normalizeCompleteWords(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || 'Complete the Words').trim();
  if (!title) throw new Error('Complete the Words missing title');
  const rawText = String(data.passage || data.text || '').trim();
  if (!rawText || rawText.split(/\s+/).filter(Boolean).length < 25) {
    throw new Error('AI response missing valid complete_words paragraph passage');
  }

  const normalized = normalizeCompleteWordsTask({
    title,
    passage: rawText,
    text: rawText,
    totalBlanks: data.totalBlanks,
    coachMode: Boolean(data.coachMode),
  });
  return {
    title: normalized.title,
    passage: normalized.passage,
    text: normalized.text,
    totalBlanks: normalized.totalBlanks,
    blanks: normalized.blanks,
  };
}

function normalizeReadingPassage(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || 'Reading Comprehension Passage');
  const passage = String(data.passage || '');
  if (!passage || passage.trim().length < 30) {
    throw new Error('AI response missing valid reading passage text');
  }

  const rawQs = Array.isArray(data.questions) ? data.questions : [];
  if (rawQs.length < 3 || rawQs.length > 10) {
    throw new Error(`Reading comprehension requires 3 to 10 questions (received ${rawQs.length})`);
  }

  const preValidated = rawQs.map((q: any, idx: number) => {
    if (!q || typeof q !== 'object') throw new Error(`Question ${idx + 1} is invalid`);
    const qText = String(q.q || q.question || '').trim();
    if (!qText) throw new Error(`Question ${idx + 1} missing question text`);

    const options = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];
    if (options.length !== 4) {
      throw new Error(`Question ${idx + 1} must have exactly 4 options (received ${options.length})`);
    }

    let answer = q.answer ?? q.correctAnswer;
    if (typeof answer === 'string') {
      const char = answer.trim().toLowerCase();
      const mapped = ['a', 'b', 'c', 'd'].indexOf(char);
      answer = mapped !== -1 ? mapped : parseInt(char, 10);
    }

    if (typeof answer !== 'number' || isNaN(answer) || answer < 0 || answer > 3) {
      throw new Error(`Question ${idx + 1} contains invalid correct answer index (${q.answer}), must be 0-3`);
    }

    return {
      q: qText,
      options,
      answer,
      why: String(q.why || q.explanation || q.reason || 'Accurately supported by passage evidence.'),
      ...(q.questionType ? { questionType: String(q.questionType).trim() } : {}),
      ...(q.hint ? { hint: String(q.hint).trim() } : {}),
    };
  });

  const normalized = normalizeReadingAcademicTask({
    title,
    passage,
    questions: preValidated,
  });

  return {
    title: normalized.title,
    passage: normalized.passage,
    questions: normalized.questions,
  };
}

function normalizeListeningDialogue(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || 'Campus Conversation');
  const context = String(data.context || data.situation || 'A discussion between a professor and student.');
  let speakers: Record<string, string> = { A: 'Sarah (student)', B: 'Professor Lee' };
  if (data.speakers && typeof data.speakers === 'object' && !Array.isArray(data.speakers)) {
    speakers = {
      A: String(data.speakers.A || data.speakers['Speaker A'] || 'Sarah (student)'),
      B: String(data.speakers.B || data.speakers['Speaker B'] || 'Professor Lee'),
    };
  } else if (Array.isArray(data.speakers) && data.speakers.length >= 2) {
    speakers = { A: String(data.speakers[0]), B: String(data.speakers[1]) };
  }

  const speakerGenders = data.speakerGenders || {
    A: inferGender(speakers.A || ''),
    B: inferGender(speakers.B || ''),
  };

  const script = String(data.script || data.dialogue || data.text || '').trim();
  if (!script || script.length < 20) {
    throw new Error('AI response missing valid listening audio script');
  }

  const rawQs = Array.isArray(data.questions) ? data.questions : [];
  if (rawQs.length < 2 || rawQs.length > 6) {
    throw new Error(`Listening conversation requires 2 to 6 questions (received ${rawQs.length})`);
  }

  const preValidated = rawQs.map((q: any, idx: number) => {
    if (!q || typeof q !== 'object') throw new Error(`Question ${idx + 1} is invalid`);
    const qText = String(q.q || q.question || '').trim();
    if (!qText) throw new Error(`Question ${idx + 1} missing question text`);

    const options = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];
    if (options.length !== 4) {
      throw new Error(`Question ${idx + 1} must have exactly 4 options (received ${options.length})`);
    }

    let answer = q.answer ?? q.correctAnswer;
    if (typeof answer === 'string') {
      const char = answer.trim().toLowerCase();
      const mapped = ['a', 'b', 'c', 'd'].indexOf(char);
      answer = mapped !== -1 ? mapped : parseInt(char, 10);
    }

    if (typeof answer !== 'number' || isNaN(answer) || answer < 0 || answer > 3) {
      throw new Error(`Question ${idx + 1} contains invalid correct answer index (${q.answer}), must be 0-3`);
    }

    return {
      q: qText,
      options,
      answer,
      why: String(q.why || q.explanation || q.reason || 'Supported by dialogue.'),
      ...(q.audioExcerpt ? { audioExcerpt: String(q.audioExcerpt).trim() } : {}),
      ...(q.questionType ? { questionType: String(q.questionType).trim() } : {}),
      ...(q.hint ? { hint: String(q.hint).trim() } : {}),
    };
  });

  const maxQs = preValidated.length >= 4 ? Math.min(preValidated.length, 6) : 2;
  const normalized = normalizeListeningDialogueTask({
    title,
    context,
    speakers,
    speakerGenders,
    script,
    questions: preValidated.slice(0, maxQs),
  });

  return {
    title: normalized.title,
    context: normalized.context,
    speakers: normalized.speakers,
    speakerGenders: normalized.speakerGenders,
    script: normalized.script,
    questions: normalized.questions,
  };
}

function normalizeListenRepeat(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || 'Listen & Repeat Practice');
  const speakerName = String(data.speakerName || 'Sarah (student)');
  const speakerGender = String(data.speakerGender || inferGender(speakerName));
  let sentences = Array.isArray(data.sentences) ? data.sentences.map(String).filter(Boolean) : [];
  if (sentences.length === 0 && Array.isArray(data.items)) {
    sentences = data.items.map((it: any) => String(typeof it === 'string' ? it : it.sentence || it.text || '')).filter(Boolean);
  }
  if (sentences.length === 0) {
    throw new Error('AI response missing sentences array');
  }
  return { title, speakerName, speakerGender, sentences };
}

function normalizeSpeakingInterview(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Speaking Interview missing title');
  const context = String(data.context || '').trim();
  if (!context) throw new Error('Speaking Interview missing context');
  const interviewerName = String(data.interviewerName || '').trim();
  if (!interviewerName) throw new Error('Speaking Interview missing interviewerName');
  const interviewerGender = String(data.interviewerGender || inferGender(interviewerName));
  const rawQs = Array.isArray(data.questions) ? data.questions : [];
  if (rawQs.length === 0) {
    throw new Error('Speaking interview requires at least 1 question');
  }

  // If fewer than 4 questions, duplicate or pad with follow-up questions
  while (rawQs.length < 4 && rawQs.length > 0) {
    const lastQ = rawQs[rawQs.length - 1];
    rawQs.push({
      ...lastQ,
      question: `${lastQ.question || lastQ.prompt || 'Could you elaborate further on this aspect?'} (Follow-up)`,
    });
  }

  // Allow up to 6 questions for Coach & Marathon Mode
  const activeQs = rawQs.slice(0, 6);

  const questions = activeQs.map((q: any, idx: number) => {
    if (!q || typeof q !== 'object') throw new Error(`Interview question ${idx + 1} is invalid`);
    const qText = String(q.question || q.prompt || '').trim();
    if (!qText) throw new Error(`Interview question ${idx + 1} missing text`);
    const prepTime = Number(q.prepTimeSeconds) || 15;
    const respTime = Number(q.responseTimeSeconds) || 45;
    const suggestedPoints = Array.isArray(q.suggestedPoints) && q.suggestedPoints.length > 0
      ? q.suggestedPoints.map(String).filter(Boolean)
      : ['Provide clear examples', 'Support your viewpoint'];
    const sampleAnswer = typeof q.sampleAnswer === 'string' && q.sampleAnswer.trim()
      ? q.sampleAnswer.trim()
      : typeof q.modelAnswer === 'string' && q.modelAnswer.trim()
      ? q.modelAnswer.trim()
      : undefined;
    return {
      question: qText,
      prepTimeSeconds: prepTime,
      responseTimeSeconds: respTime,
      suggestedPoints,
      ...(sampleAnswer ? { sampleAnswer } : {}),
      ...(Array.isArray(q.speakingFormula) ? { speakingFormula: q.speakingFormula.map(String).filter(Boolean) } : {}),
      ...(Array.isArray(q.topicVocabulary) ? { topicVocabulary: q.topicVocabulary.map(String).filter(Boolean) } : {}),
      ...(Array.isArray(q.sentenceStarters) ? { sentenceStarters: q.sentenceStarters.map(String).filter(Boolean) } : {}),
    };
  });
  return { title, context, interviewerName, interviewerGender, questions };
}

function normalizeBuildSentence(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Build a Sentence missing title');
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (rawItems.length < 5 || rawItems.length > 10) {
    throw new Error(`Build a sentence requires 5 to 10 items (received ${rawItems.length})`);
  }
  rawItems.forEach((it: any, idx: number) => {
    if (!it || typeof it !== 'object') throw new Error(`Build sentence item ${idx + 1} is invalid`);
    const context = String(it.context || '').trim();
    if (!context) throw new Error(`Build sentence item ${idx + 1} missing context`);
    const answer = String(it.targetSentence || it.answer || it.correctSentence || '').trim();
    if (!answer) {
      throw new Error(`Build sentence item ${idx + 1} missing correct sentence answer`);
    }
    const explanation = String(it.grammarRule || it.explanation || '').trim();
    if (!explanation) {
      throw new Error(`Build sentence item ${idx + 1} missing explanation`);
    }
  });
  const normalized = normalizeBuildSentenceTask({
    title,
    items: rawItems,
    coachMode: Boolean(data.coachMode),
  });
  return {
    title: normalized.title,
    items: normalized.items.map((it) => ({
      context: it.context,
      framePrefix: it.framePrefix,
      frameSuffix: it.frameSuffix,
      targetChunks: it.targetChunks,
      distractorChunks: it.distractorChunks,
      ...(it.distractorWord ? { distractorWord: it.distractorWord } : {}),
      words: it.words,
      targetSentence: it.targetSentence,
      answer: it.answer,
      grammarRule: it.grammarRule,
      explanation: it.explanation,
    })),
  };
}

function normalizeWriteEmail(data: any) {
  if (!data || typeof data !== 'object') throw new Error('AI response is not an object');
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Write an Email missing title');
  const situation = String(data.situation || data.scenario || '').trim();
  if (!situation || situation.length < 15) {
    throw new Error('Write an Email missing valid situation description');
  }
  const recipient = String(data.recipient || '').trim();
  if (!recipient) {
    throw new Error('Write an Email missing recipient');
  }
  const goals = Array.isArray(data.goals)
    ? data.goals.map(String).filter(Boolean)
    : Array.isArray(data.bulletPoints)
    ? data.bulletPoints.map(String).filter(Boolean)
    : [];
  if (goals.length === 0) {
    throw new Error('Write an Email must have at least 1 goal');
  }
  const suggestedWordCount = String(data.suggestedWordCount || '100-130 words').trim();
  if (!suggestedWordCount) {
    throw new Error('Write an Email missing suggestedWordCount');
  }
  const coachBlueprint = Array.isArray(data.coachBlueprint) ? data.coachBlueprint : undefined;
  return { title, situation, recipient, goals, suggestedWordCount, ...(coachBlueprint ? { coachBlueprint } : {}) };
}

function normalizeVocabularyExplanation(data: any): any {
  const word = String(data.word || '').trim();
  const phonetic = String(data.phonetic || '').trim();
  const rawMeanings = Array.isArray(data.meanings) ? data.meanings : [];
  const meanings = rawMeanings.map((m: any) => ({
    partOfSpeech: String(m.partOfSpeech || 'noun').toLowerCase().trim(),
    definition: String(m.definition || '').trim(),
    example: String(m.example || '').trim(),
  })).filter((m: any) => m.definition.length > 0);

  if (meanings.length === 0 && data.definition) {
    meanings.push({
      partOfSpeech: String(data.partOfSpeech || 'noun').toLowerCase().trim(),
      definition: String(data.definition).trim(),
      example: String(data.example || '').trim(),
    });
  }

  const examples = Array.isArray(data.examples)
    ? data.examples.map((e: any) => String(e).trim()).filter(Boolean)
    : (meanings[0]?.example ? [meanings[0].example] : []);

  const synonyms = Array.isArray(data.synonyms)
    ? data.synonyms.map((s: any) => String(s).trim()).filter(Boolean)
    : [];

  return {
    word: word || 'word',
    phonetic,
    meanings: meanings.length > 0 ? meanings : [{ partOfSpeech: 'noun', definition: 'Definition unavailable', example: '' }],
    examples,
    synonyms,
  };
}

export function normalizeTask(taskType: string, data: any): any {
  if (!data || typeof data !== 'object') {
    throw new Error('Parsed data is not an object');
  }

  switch (taskType) {
    case 'complete-words':
    case 'complete_words':
      return normalizeCompleteWords(data);
    case 'reading-passage':
    case 'reading_academic':
    case 'reading-academic':
      return normalizeReadingPassage(data);
    case 'daily-life':
    case 'daily_life':
      return normalizeDailyLifeTask(data);
    case 'listening-dialogue':
    case 'listening_dialogue':
    case 'listening-conversation':
    case 'listening_conversation':
      return normalizeListeningDialogue(data);
    case 'listening-choose-response':
    case 'listening_choose_response':
      return normalizeListeningChooseResponseTask(data);
    case 'listening-announcement':
    case 'listening_announcement':
      return normalizeListeningAnnouncementTask(data);
    case 'listening-academic-talk':
    case 'listening_academic_talk':
    case 'listening-lecture':
    case 'listening_lecture':
      return normalizeListeningAcademicTalkTask(data);
    case 'listen-repeat':
    case 'speaking_listen_repeat':
      return normalizeListenRepeat(data);
    case 'speaking-interview':
    case 'speaking_interview':
      return normalizeSpeakingInterview(data);
    case 'build-sentence':
    case 'writing_build_sentence':
      return normalizeBuildSentence(data);
    case 'write-email':
    case 'writing_email':
      return normalizeWriteEmail(data);
    case 'academic-discussion':
    case 'writing_discussion':
      return normalizeAcademicDiscussion(data);
    case 'vocabulary_explanation':
    case 'vocabulary-explanation':
      return normalizeVocabularyExplanation(data);
    default:
      throw new Error(`Unknown task type: ${taskType}`);
  }
}

export function getAiClient(customApiKey?: string) {
  let apiKey = '';
  if (customApiKey && customApiKey.trim()) {
    const trimmed = customApiKey.trim();
    if (/^(AIza|AQ\.)/i.test(trimmed)) {
      apiKey = trimmed;
    } else if (/^(gsk_|nvapi-|sk-or-|sk-proj-|sk-admin-|xai-|sk-ant-|ds-)/i.test(trimmed)) {
      // Key belongs to a third-party provider (Groq, NVIDIA, OpenRouter, OpenAI, etc.)
      apiKey = process.env.GEMINI_API_KEY || '';
    } else {
      apiKey = trimmed;
    }
  } else {
    apiKey = process.env.GEMINI_API_KEY || '';
  }

  if (!apiKey || !apiKey.trim()) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function handleTestApiKey(options?: ApiCallOptions): Promise<{
  success: true;
  message: string;
  model: string;
  provider?: string;
  providerName?: string;
  generationModel?: string;
  evaluationModel?: string;
}> {
  const opts = typeof options === 'string' ? { apiKey: options } : options || {};
  let provider = opts.provider || 'gemini';
  const rawKey = (opts.apiKey || (typeof options === 'string' ? options : '')).trim();

  // If provider is gemini or auto, but key clearly belongs to another provider
  if ((provider === 'gemini' || provider === 'auto') && rawKey) {
    if (/^nvapi-/i.test(rawKey)) provider = 'nvidia';
    else if (/^gsk_/.test(rawKey)) provider = 'groq';
    else if (/^sk-or-/i.test(rawKey)) provider = 'openrouter';
    else if (/^sk-/.test(rawKey)) provider = 'openai';
  }

  if (provider !== 'gemini') {
    return testOpenAiCompatible({
      provider,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    });
  }

  const apiKey = (opts.apiKey && opts.apiKey.trim()) || process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('No API key provided. Add yours in Dashboard > Settings & API Key');
  }

  const chains = await resolveModelChains('gemini', apiKey.trim());
  const customModel =
    opts.model && opts.model.trim() && opts.model !== 'Auto-Routed by Purpose' && opts.model !== 'Auto-Optimized'
      ? opts.model.trim()
      : null;
  const chain = customModel ? [customModel, ...chains.generation] : chains.generation;

  const ai = new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const { modelUsed } = await generateWithFallback(ai, chain, async (model) => {
    await ai.models.generateContent({
      model,
      contents: 'Reply with the single word OK',
      config: {
        temperature: 0.1,
      },
    });
    return true;
  });

  const genModel = chains.generation[0] || modelUsed;
  const evalModel = chains.evaluation[0] || genModel;

  return {
    success: true,
    provider: 'gemini',
    providerName: 'Google Gemini',
    message: `Connected to Google Gemini. Generation model: ${genModel}, Evaluation model: ${evalModel}.`,
    model: modelUsed,
    generationModel: genModel,
    evaluationModel: evalModel,
  };
}

export async function handleGenerateTask(taskType: string, level: string, topic: string, options?: ApiCallOptions, promptData?: any) {
  const optsObj = typeof options === 'object' && options !== null ? options : {};
  const isCoachMode = Boolean(
    promptData === true ||
      promptData?.coachMode === true ||
      promptData?.mode === 'coach' ||
      optsObj.coachMode === true ||
      optsObj.mode === 'coach'
  );

  const taskMap: Record<string, string> = {
    'complete-words': 'completeWords',
    complete_words: 'completeWords',
    'daily-life': 'dailyLife',
    daily_life: 'dailyLife',
    'reading-academic': 'readingPassage',
    reading_academic: 'readingPassage',
    'reading-passage': 'readingPassage',
    'listening-choose-response': 'listeningChooseResponse',
    listening_choose_response: 'listeningChooseResponse',
    'listening-dialogue': 'listeningDialogue',
    listening_dialogue: 'listeningDialogue',
    'listening-conversation': 'listeningDialogue',
    listening_conversation: 'listeningDialogue',
    'listening-announcement': 'listeningAnnouncement',
    listening_announcement: 'listeningAnnouncement',
    'listening-academic-talk': 'listeningAcademicTalk',
    listening_academic_talk: 'listeningAcademicTalk',
    'listening-lecture': 'listeningAcademicTalk',
    listening_lecture: 'listeningAcademicTalk',
    'listen-repeat': 'listenRepeat',
    speaking_listen_repeat: 'listenRepeat',
    'speaking-listen-repeat': 'listenRepeat',
    'speaking-interview': 'speakingInterview',
    speaking_interview: 'speakingInterview',
    'build-sentence': 'buildSentence',
    writing_build_sentence: 'buildSentence',
    'writing-build-sentence': 'buildSentence',
    'write-email': 'writeEmail',
    writing_email: 'writeEmail',
    'writing-email': 'writeEmail',
    'academic-discussion': 'academicDiscussion',
    writing_discussion: 'academicDiscussion',
    'writing-discussion': 'academicDiscussion',
    'vocabulary_explanation': 'vocabularyExplanation',
    'vocabulary-explanation': 'vocabularyExplanation',
  };
  const curatedMap: Record<string, string> = {
    'complete-words': 'CURATED_COMPLETE_WORDS',
    complete_words: 'CURATED_COMPLETE_WORDS',
    'daily-life': 'CURATED_READING_PASSAGES',
    daily_life: 'CURATED_READING_PASSAGES',
    'reading-academic': 'CURATED_READING_PASSAGES',
    reading_academic: 'CURATED_READING_PASSAGES',
    'reading-passage': 'CURATED_READING_PASSAGES',
    'listening-choose-response': 'CURATED_LISTENING',
    listening_choose_response: 'CURATED_LISTENING',
    'listening-dialogue': 'CURATED_LISTENING',
    listening_dialogue: 'CURATED_LISTENING',
    'listening-conversation': 'CURATED_LISTENING',
    listening_conversation: 'CURATED_LISTENING',
    'listening-announcement': 'CURATED_LISTENING',
    listening_announcement: 'CURATED_LISTENING',
    'listening-academic-talk': 'CURATED_LISTENING',
    listening_academic_talk: 'CURATED_LISTENING',
    'listening-lecture': 'CURATED_LISTENING',
    listening_lecture: 'CURATED_LISTENING',
    'listen-repeat': 'CURATED_LISTEN_REPEAT',
    speaking_listen_repeat: 'CURATED_LISTEN_REPEAT',
    'speaking-listen-repeat': 'CURATED_LISTEN_REPEAT',
    'speaking-interview': 'CURATED_SPEAKING_INTERVIEWS',
    speaking_interview: 'CURATED_SPEAKING_INTERVIEWS',
    'build-sentence': 'CURATED_BUILD_SENTENCES',
    writing_build_sentence: 'CURATED_BUILD_SENTENCES',
    'writing-build-sentence': 'CURATED_BUILD_SENTENCES',
    'write-email': 'CURATED_WRITE_EMAILS',
    writing_email: 'CURATED_WRITE_EMAILS',
    'writing-email': 'CURATED_WRITE_EMAILS',
    'academic-discussion': 'CURATED_ACADEMIC_DISCUSSIONS',
    writing_discussion: 'CURATED_ACADEMIC_DISCUSSIONS',
    'writing-discussion': 'CURATED_ACADEMIC_DISCUSSIONS',
  };

  const schemaKey = taskMap[taskType];
  if (!schemaKey) {
    throw new Error(`Unknown task type: ${taskType}`);
  }
  const schema = Schemas[schemaKey as keyof typeof Schemas];

  const getPrompt = (tType: string, lvl: string, top: string) => {
    const levelDesc =
      lvl === 'advanced'
        ? 'Advanced (C1-C2 CEFR / TOEFL 100-120)'
        : lvl === 'beginner'
        ? 'Beginner-Intermediate (A2-B1 CEFR / TOEFL 40-60)'
        : lvl === 'intermediate'
        ? 'Intermediate (B1-B2 CEFR / TOEFL 60-85)'
        : 'Upper-Intermediate (B2-C1 CEFR / TOEFL 85-100)';
    switch (tType) {
      case 'complete-words':
      case 'complete_words':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create a Marathon "Complete the Words" (C-Test) passage for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
Write a concise academic paragraph consisting of: (1) ONE introductory head sentence (~12–18 words), (2) ONE or TWO middle sentences (~55–65 words total) that will hold the blanks, and (3) ONE concluding tail sentence (~12–18 words). Write 100% plain English with ZERO brackets [ ] or underscores.
Return ONLY this exact JSON schema: {"title": "Academic Topic Title", "passage": "A 100% plain-English academic paragraph with ZERO brackets [ ] and flawless spelling."}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create an authentic TOEFL Reading "Complete the Words" (C-Test) passage for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
Write a concise academic paragraph consisting of: (1) ONE introductory head sentence (~12–18 words), (2) ONE or TWO middle sentences (~22–28 words total) that will hold the blanks, and (3) ONE concluding tail sentence (~12–18 words). Write 100% plain English with ZERO brackets [ ] or underscores.
Return ONLY this exact JSON schema: {"title": "Academic Topic Title", "passage": "A 100% plain-English academic paragraph with ZERO brackets [ ] and flawless spelling."}`;
      case 'daily-life':
      case 'daily_life':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an Extended "Read in Daily Life" item for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Choose an authentic daily life format (formatType): "notice", "email", "text-chain", "menu", "schedule", "invoice", or "social-post".
2. Write a detailed realistic text of 110 to 160 words (contentText).
3. Include EXACTLY 4 multiple-choice questions covering main_purpose, factual_detail, negative_factual, and inference.
4. STRICT ANSWER-KEY VERIFICATION: Verify that \`options[answer]\` is 100% supported by \`contentText\` and matches the exact option quoted in \`why\`, and that all 3 distractor options are clearly false or unsupported.
5. Include a "hint" field on each question pointing to the exact line/section clue and strategy.
Return JSON format: {"title": "Title", "formatType": "email", "context": "Campus context description", "contentText": "Full text...", "questions": [{"q": "Question?", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 0, "why": "Explanation quoting the exact correct option text...", "questionType": "main_purpose", "hint": "Strategy & target clue in the document..."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test creator. Create a TOEFL Reading "Read in Daily Life" item for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS (Official PDF Page 6):
1. Choose an authentic daily life format (formatType): "notice", "email", "text-chain", "menu", "schedule", "invoice", or "social-post".
2. Write a realistic text of 15 to 150 words (contentText) with relevant campus or everyday context. Avoid repetitive phrasing or filler text.
3. Follow the official length-dependent question rule:
   - If the text is shorter (15–70 words, such as a campus notice, sign, social post, or short text message chain), include EXACTLY 2 multiple-choice questions.
   - If the text is longer (75–150 words, such as a detailed email, event schedule, itemized invoice, or dining menu), include EXACTLY 3 multiple-choice questions.
4. Vary the question skills across the official Page 6 types and tag each question's \`questionType\` accurately using:
   - "main_purpose" (identifying the main purpose or issuer of the communication)
   - "inference" (making inferences based on the text)
   - "factual_detail" (skimming and scanning for specific nonlinear information)
   - "idiomatic_meaning" (understanding informal or telegraphic language in context)
   - "negative_factual" (identifying which option is NOT true or EXCEPT)
5. STRICT ANSWER-KEY VERIFICATION: Verify that \`options[answer]\` is 100% supported by \`contentText\` and matches the option quoted in \`why\`, and that all 3 distractor options are clearly false or unsupported.
Return JSON format: {"title": "Title", "formatType": "notice", "context": "Campus context description", "contentText": "Full text...", "questions": [{"q": "What is the main purpose of this notice?", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 0, "why": "Explanation quoting the exact correct option...", "questionType": "main_purpose"}, {"q": "What can be inferred about...?", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 2, "why": "Explanation quoting the exact correct option...", "questionType": "inference"}]}`;
      case 'reading-passage':
      case 'reading_academic':
      case 'reading-academic': {
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create a Mega-Passage "Read an Academic Passage" item with 8 multiple-choice questions for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Write a 350 to 420 word multi-paragraph university-level academic passage (4 focused paragraphs).
2. Provide EXACTLY 8 multiple-choice questions covering ALL official reading question types: Factual Detail, Negative Factual (EXCEPT/NOT), Vocabulary in Context, Inference, Rhetorical Purpose, Sentence Relationship, and Main Idea Summary.
3. STRICT ANSWER-KEY VERIFICATION: Verify that \`options[answer]\` is 100% supported by the passage and matches the option quoted in \`why\`, and that all 3 distractor options are clearly false or unsupported.
4. Every question MUST include a "hint" field pointing to the exact paragraph/sentence clue and explaining the strategy for solving that question type.
Return JSON format: {"title": "Passage Title", "passage": "350-420 word passage...", "questions": [{"q": "Question prompt?", "options": ["Unique Option A", "Unique Option B", "Unique Option C", "Unique Option D"], "answer": 2, "why": "Detailed explanation quoting the exact correct option...", "questionType": "Inference", "hint": "Paragraph 2 Clue & Strategy..."}]}`;
        }
        const hasSpecificFocus = promptData?.questionSkillFocus && promptData.questionSkillFocus !== 'all';
        const skillDirective = hasSpecificFocus
          ? `NOTE: Focus questions specifically on the skill: ${promptData.questionSkillFocus} (all 5 questions testing ${promptData.questionSkillFocus}).`
          : `CRITICAL QUESTION TYPE REQUIREMENT (readingQuestionFocus === 'all'):
Every 5-question passage MUST include EXACTLY 1 of each of the 5 official TOEFL iBT Reading question types (NO duplicate Factual Comprehension questions!), presented in a RANDOMIZED order across the 5 questions:
  1. Factual Detail ("According to paragraph X...") -> questionType: "Factual Detail"
  2. Negative Factual (EXCEPT / NOT) ("According to the passage, all of the following are true EXCEPT:" or "Which of the following is NOT mentioned in paragraph X?") -> questionType: "Negative Factual (EXCEPT/NOT)"
  3. Vocabulary in Context ("The word 'X' in paragraph Y is closest in meaning to:") -> questionType: "Vocabulary in Context"
  4. Inference ("What can be inferred from paragraph X about...?" or "Which of the following does the passage imply about...?") -> questionType: "Inference"
  5. Rhetorical Purpose / Relationship ("Why does the author mention 'X' in paragraph Y?" or "How do the ideas in paragraph 2 relate to the ideas in paragraph 1?") -> questionType: "Rhetorical Purpose"`;
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create an authentic TOEFL "Read an Academic Passage" item with 5 multiple-choice questions for level: ${levelDesc}. Topic: ${top}.
${skillDirective}
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Write a 180-210 word university-level academic passage (3 focused, cohesive paragraphs). Avoid repetitive phrasing or redundant concluding summaries.
2. Provide EXACTLY 5 multiple-choice questions in a randomized sequence of question types (1 Factual Detail, 1 Negative Factual EXCEPT/NOT, 1 Vocabulary in Context, 1 Inference, 1 Rhetorical Purpose / Relationship).
3. STRICT ANSWER-KEY VERIFICATION: Every question MUST have 4 distinct, unique options (\`options.length === 4\`), \`answer\` (0..3, varied across questions), \`questionType\`, and a detailed \`why\` explanation that explicitly quotes \`options[answer]\` and verifies that it is 100% supported by the passage while all 3 distractor options are clearly false or unsupported.
Return JSON format: {"title": "Passage Title", "passage": "180-210 word passage...", "questions": [{"q": "Question prompt?", "options": ["Unique Option A", "Unique Option B", "Unique Option C", "Unique Option D"], "answer": 2, "why": "Detailed explanation quoting Unique Option C and verifying why index 2 is correct...", "questionType": "Inference"}]}`;
      }
      case 'listening-choose-response':
      case 'listening_choose_response':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an 8-item TOEFL Listening "Listen & Choose a Response" practice set for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Provide EXACTLY 8 independent short items in the \`items\` array.
2. Each item's \`audioPrompt\` MUST be a natural spoken 1-sentence campus/everyday question or statement (6-15 words) with explicit gendered \`speakerName\` and \`speakerGender\` ('male' or 'female').
3. STRICT ANSWER-KEY VERIFICATION: Verify that \`options[answer]\` is the single natural reply and matches \`why\`, while all 3 distractors are clearly inappropriate.
4. Include a \`coachTip\` field on each item explaining the pragmatic intent, idiom, or indirect speech act.
Return JSON format: {"title": "Marathon Pragmatics Set", "category": "Campus Life", "items": [{"audioPrompt": "Short 6-15 word question?", "speakerName": "Sarah", "speakerGender": "female", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 1, "why": "Direct and natural response matching Option B.", "coachTip": "Pragmatic clue explaining indirect speech act..."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create a 5-item TOEFL Listening "Listen & Choose a Response" practice set for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS (Official PDF Pages 8-9):
1. Provide EXACTLY 5 independent short items in the \`items\` array.
2. Each item's \`audioPrompt\` MUST be a short, natural spoken 1-sentence everyday or campus question/statement of strictly 6 to 15 words (e.g., "Didn't I just see you in the library an hour ago?").
3. Provide explicit gendered \`speakerName\` and \`speakerGender\` ('male' or 'female') for each item.
4. STRICT ANSWER-KEY VERIFICATION: For each item, provide EXACTLY 4 brief conversational reply \`options\` (each 5 to 12 words). Verify that \`options[answer]\` (0..3) is the single natural, appropriate reply and matches the option quoted in \`why\`, while all 3 distractors are clearly inappropriate.
Return JSON format: {"title": "Campus Interaction Set", "category": "Campus Life", "items": [{"audioPrompt": "Short 6-15 word question?", "speakerName": "Sarah", "speakerGender": "female", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 1, "why": "Direct and natural response matching Option B."}]}`;
      case 'listening-announcement':
      case 'listening_announcement':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an Extended TOEFL Listening "Listen to an Announcement" item for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Write a 90 to 130 word natural spoken campus announcement (script) with an explicit gendered \`speakerName\` and \`speakerGender\` ('male'|'female').
2. Follow with EXACTLY 4 comprehension questions, each with a verified \`options[answer]\` matching \`why\`, and a "hint" field explaining what to listen for.
Return JSON format: {"title": "Announcement Title", "context": "University announcement context", "speakerName": "Dean Williams", "speakerGender": "male", "script": "Attention all students...", "questions": [{"q": "Question 1?", "options": ["A", "B", "C", "D"], "answer": 1, "why": "Explanation quoting the correct option...", "hint": "Listen for the main policy change..."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create a TOEFL Listening "Listen to an Announcement" item for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Write a strictly 45 to 80 word natural spoken campus announcement (script) by 1 university official or professor with explicit gendered \`speakerName\` and \`speakerGender\` ('male'|'female'). Avoid repetitive phrasing or filler text.
2. Follow with EXACTLY 2 comprehension questions. Each question must have 4 distinct options, a verified \`answer\` index (0..3) where \`options[answer]\` is 100% supported by the script and matches \`why\`, and 3 clearly false distractors.
Return JSON format: {"title": "Announcement Title", "context": "University announcement context", "speakerName": "Dean Williams", "speakerGender": "male", "script": "Attention all students...", "questions": [{"q": "Question 1?", "options": ["A", "B", "C", "D"], "answer": 1, "why": "Explanation 1 quoting option B..."}, {"q": "Question 2?", "options": ["A", "B", "C", "D"], "answer": 2, "why": "Explanation 2 quoting option C..."}]}`;
      case 'listening-academic-talk':
      case 'listening_academic_talk':
      case 'listening-lecture':
      case 'listening_lecture':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an Extended TOEFL Listening "Listen to an Academic Talk" item for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Write a 200 to 260 word natural spoken academic lecture (script) with explicit gendered \`speakerName\` and \`speakerGender\` ('male'|'female').
2. Follow with EXACTLY 5 comprehension questions (including 1 "audioExcerpt" pragmatic question), each with a verified \`options[answer]\` matching \`why\`, and include a "hint" field on each question.
Return JSON format: {"title": "Lecture Title", "topic": "${top}", "speakerName": "Dr. Angela Evans", "speakerGender": "female", "script": "Good morning class...", "questions": [{"q": "Why does the professor say this?", "audioExcerpt": "Exact 1-sentence quote from the script.", "questionType": "Speaker's Purpose / Function", "options": ["A", "B", "C", "D"], "answer": 0, "why": "Explanation quoting option A...", "hint": "Listen to how the professor introduces this example..."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create a TOEFL Listening "Listen to an Academic Talk" item for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Write a strictly 140 to 200 word natural spoken academic talk or mini-lecture (script) by a university educator with explicit gendered \`speakerName\` and \`speakerGender\` ('male'|'female'). Avoid repetitive phrasing or redundant concluding summaries.
2. Follow with EXACTLY 4 comprehension questions covering:
   - Gist / Main Idea ("questionType": "Gist / Main Idea")
   - Detail ("questionType": "Detail")
   - Inference / Implied Meaning ("questionType": "Inference / Implied Meaning")
   - Pragmatic "Listen Again to an Excerpt" Function/Purpose question ("questionType": "Speaker's Purpose / Function"): On EXACTLY 1 of the 4 questions, include \`"audioExcerpt"\` containing an exact 1-sentence quote from the lecture \`script\`, and ask "Why does the professor say this?" or "What does the professor imply when saying this?".
3. STRICT ANSWER-KEY VERIFICATION: Each question must have 4 distinct options, a verified \`answer\` index (0..3) where \`options[answer]\` matches the option quoted in \`why\`, and 3 clearly unsupported distractors.
Return JSON format: {"title": "Lecture Title", "topic": "${top}", "speakerName": "Dr. Angela Evans", "speakerGender": "female", "script": "Good morning class...", "questions": [{"q": "Why does the professor say this?", "audioExcerpt": "Exact 1-sentence quote from the script.", "questionType": "Speaker's Purpose / Function", "options": ["A", "B", "C", "D"], "answer": 0, "why": "..."}, {"q": "Question 2?", "questionType": "Detail", "options": ["A", "B", "C", "D"], "answer": 1, "why": "..."}, {"q": "Question 3?", "questionType": "Detail", "options": ["A", "B", "C", "D"], "answer": 2, "why": "..."}, {"q": "Question 4?", "questionType": "Inference / Implied Meaning", "options": ["A", "B", "C", "D"], "answer": 3, "why": "..."}]}`;
      case 'listening-dialogue':
      case 'listening_dialogue':
      case 'listening-conversation':
      case 'listening_conversation':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an Extended TOEFL Listening "Listen to a Conversation" task for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Write a natural spoken 10 to 12 turn conversation of 130 to 170 words between 1 female and 1 male speaker with explicit gendered speaker names.
2. Follow with EXACTLY 4 multiple-choice questions (including 1 "audioExcerpt" question), each with a verified \`options[answer]\` matching \`why\`, and include a "hint" field on every question.
Return JSON format: {"title": "Conversation Title", "context": "Listen to a conversation between a student and a professor.", "speakers": {"A": "Emma (Student)", "B": "Professor Miller"}, "speakerGenders": {"A": "female", "B": "male"}, "script": "Emma: ...\\nProfessor Miller: ...", "questions": [{"q": "Why does the professor say this?", "audioExcerpt": "Professor Miller: Exact 1-sentence turn from the script.", "questionType": "Speaker's Purpose / Function", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 1, "why": "Explanation quoting Option B...", "hint": "Listen for the professor's concern in Turn 4..."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test content creator. Create a TOEFL Listening "Listen to a Conversation" task for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS (Official PDF Pages 9-10):
1. Write a short, natural spoken 8 to 10 turn conversation of strictly 75 to 110 words total (5 to 15 words per turn, like a real 30-second spoken campus exchange—NOT a long multi-sentence monologue!) between two distinct speakers (1 female and 1 male with explicit gendered names, e.g., "Emma (Student)" & "Professor Miller", or "Lucas (Student)" & "Ms. Rivera (Librarian)").
2. Format every script line with the speaker name at the start of the line, e.g. "Emma: Professor Miller, do you have a minute to look at my survey design?\\nProfessor Miller: Sure, Emma. Did you narrow down your topic on sleep and memory?"
3. Follow with EXACTLY 2 multiple-choice questions testing official TOEFL Listening skills:
   - Question 1 MUST be an official "Listen Again to an Excerpt" pragmatic/function/implication question: include \`"audioExcerpt"\` with an exact 1-sentence line from the conversation (including the speaker prefix, e.g. "Professor Miller: Relying only on self-reported sleep logs can be pretty inaccurate, though."), set \`"questionType"\` to \`"Speaker's Purpose / Function"\` or \`"Inference / Implied Meaning"\`, and ask "Why does the speaker say this?" or "What does the speaker imply when saying this?".
   - Question 2 tests Detail or Gist / Main Idea (\`"questionType": "Detail"\` or \`"Gist / Main Idea"\`).
4. STRICT ANSWER-KEY VERIFICATION: Every question MUST have 4 distinct options (\`options.length === 4\`), a verified \`answer\` index (0..3) where \`options[answer]\` matches the option quoted in \`why\`, and 3 clearly false distractors.
Return JSON format: {"title": "Conversation Title", "context": "Listen to a conversation between a student and a professor.", "speakers": {"A": "Emma (Student)", "B": "Professor Miller"}, "speakerGenders": {"A": "female", "B": "male"}, "script": "Emma: ...\\nProfessor Miller: ...", "questions": [{"q": "Why does the professor say this?", "audioExcerpt": "Professor Miller: Exact 1-sentence turn from the script.", "questionType": "Speaker's Purpose / Function", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 1, "why": "Explanation 1 quoting Option B..."}, {"q": "Question 2?", "questionType": "Detail", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 2, "why": "Explanation 2 quoting Option C..."}]}`;
      case 'listen-repeat':
      case 'speaking_listen_repeat':
      case 'speaking-listen-repeat':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create a 12-sentence TOEFL Speaking "Listen and Repeat" Shadowing & Prosody set for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. COHESIVE SINGLE-SPEAKER TOUR/ORIENTATION: All 12 sentences MUST be spoken by ONE single speaker role giving a continuous tour or orientation in one setting (e.g., "Sarah (Lab Coordinator)", "Marcus (Head Librarian)").
2. PROGRESSIVE WORD LENGTH: Progress strictly in length from 6–7 words (Sentence 1) up to 14–16 words (Sentence 12).
3. Insert " | " prosody chunking bars between natural 3-5 word phrase groups in every sentence so students can practice chunked shadowing!
Return JSON format: {"title": "Orientation Shadowing Set", "speakerName": "Sarah (Lab Coordinator)", "speakerGender": "female", "sentences": ["Welcome to the | undergraduate biology laboratory.", "Please store your backpacks | inside the hallway lockers."]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test creator. Create a TOEFL Speaking "Listen and Repeat" practice set for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 ETS TOEFL iBT "LISTEN AND REPEAT" SPECIFICATIONS:
1. COHESIVE SINGLE-SPEAKER SCENARIO: All 7 sentences in the set MUST be spoken by ONE single speaker role (e.g., "Sarah (Lab Coordinator)", "Marcus (Head Librarian)", "Dr. Chen (Observatory Guide)", "Clara (Museum Docent)", "David (Academic Advisor)") directly addressing the listener ("Welcome to...", "Please store...", "You will find...", "If you need...") in ONE continuous, coherent campus or academic tour/orientation in one setting!
2. FORBIDDEN: Do NOT write 7 random disconnected textbook statements about unrelated topics. Every sentence must belong to the same continuous briefing or guided tour.
3. PROGRESSIVE WORD LENGTH: Provide EXACTLY 7 natural spoken sentences that progress strictly in length and grammatical complexity from 6–7 words (Sentence 1) to 14–16 words (Sentence 7):
   - Sentence 1: 6–7 words (warm welcome or opening statement)
   - Sentence 2: 8 words
   - Sentence 3: 9–10 words
   - Sentence 4: 11 words
   - Sentence 5: 12 words
   - Sentence 6: 13–14 words
   - Sentence 7: 14–16 words
Return JSON format: {"title": "Biology Laboratory Safety Orientation", "speakerName": "Sarah (Lab Coordinator)", "speakerGender": "female", "sentences": ["Welcome to the undergraduate biology laboratory.", "Please store your backpacks inside the hallway lockers.", "Safety goggles and lab coats are required at all times.", "You will find clean glass slides inside the top cabinet drawer.", "Make sure to calibrate your microscope carefully before examining the tissue samples.", "Dispose of all used pipettes and gloves in the labeled biohazard container near the sink.", "If any chemical spill occurs during the experiment, notify your laboratory supervisor immediately for assistance."]}`;
      case 'speaking-interview':
      case 'speaking_interview':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon Speaking examiner. Create a 6-question TOEFL Speaking "Take an Interview" coaching set for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Provide 6 progressive interview questions on the topic (prepTimeSeconds: 15, responseTimeSeconds: 90).
2. On EVERY question, include:
   - "sampleAnswer": a natural 70–85 word first-person spoken model response that directly answers that exact question with a specific personal example
   - "speakingFormula": array of 3 step-by-step response steps
   - "topicVocabulary": array of 3 high-scoring Band 6.0 vocabulary phrases
   - "sentenceStarters": array of 2 natural spoken sentence starters
Return JSON format: {"title": "Marathon Interview Simulation", "context": "Brief interviewer introduction", "interviewerName": "Prof. Lee (Male)", "interviewerGender": "male", "questions": [{"question": "Q1...", "prepTimeSeconds": 15, "responseTimeSeconds": 90, "suggestedPoints": ["Point 1", "Point 2"], "sampleAnswer": "70-85 word first-person response with a specific personal example...", "speakingFormula": ["Step 1...", "Step 2...", "Step 3..."], "topicVocabulary": ["phrase 1", "phrase 2", "phrase 3"], "sentenceStarters": ["From my perspective, ...", "For instance, ..."]}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT Speaking examiner. Create a TOEFL Speaking "Take an Interview" practice simulation for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Format interviewerName with a realistic name and gender tag, e.g. "Prof. Lee (Male)" or "Dr. Patel (Female)".
2. Provide a brief interviewer introduction (\`context\`) followed by EXACTLY 4 progressive interview questions on one topic:
   - Q1: Personal preference or concrete personal experience.
   - Q2: Specific examples or elaboration.
   - Q3: Broader community or educational impact.
   - Q4: Future policy or abstract evaluation.
3. Each question MUST have \`prepTimeSeconds: 15\`, \`responseTimeSeconds: 45\`, \`suggestedPoints\`, and a natural 70–85 word first-person \`sampleAnswer\` that directly answers that exact question with a specific personal example.
Return JSON format: {"title": "University Interview Simulation", "context": "Brief interviewer introduction to the topic", "interviewerName": "Prof. Lee (Male)", "interviewerGender": "male", "questions": [{"question": "Q1...", "prepTimeSeconds": 15, "responseTimeSeconds": 45, "suggestedPoints": ["Point 1", "Point 2"], "sampleAnswer": "70-85 word first-person spoken sample answer with a specific personal example..."}, {"question": "Q2...", "prepTimeSeconds": 15, "responseTimeSeconds": 45, "suggestedPoints": ["Point 1", "Point 2"], "sampleAnswer": "70-85 word first-person spoken sample answer..."}, {"question": "Q3...", "prepTimeSeconds": 15, "responseTimeSeconds": 45, "suggestedPoints": ["Point 1", "Point 2"], "sampleAnswer": "70-85 word first-person spoken sample answer..."}, {"question": "Q4...", "prepTimeSeconds": 15, "responseTimeSeconds": 45, "suggestedPoints": ["Point 1", "Point 2"], "sampleAnswer": "70-85 word first-person spoken sample answer..."}]}`;
      case 'build-sentence':
      case 'writing_build_sentence':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Coach & Marathon test creator. Create an 8-item TOEFL Writing "Build a Sentence" syntax marathon set for level: ${levelDesc}. Topic: ${top}.
COACH & MARATHON SPECIFICATIONS:
1. Provide EXACTLY 8 conversational exchanges in the \`items\` array.
2. For each exchange, generate ONLY:
   - \`context\`: Speaker 1's natural conversational question or statement (1 sentence).
   - \`targetSentence\`: Speaker 2's complete, grammatically flawless reply (8–12 words; ensure at least 3 items per set are direct interrogative questions ending in \`?\`, and the rest are statements ending in \`.\` using relative clauses, indirect questions, passive voice, or conditionals).
   - \`distractorWord\`: 1 single lowercase grammatical distractor word (e.g., "was" when targetSentence uses "were", or "has" when targetSentence uses "have").
   - \`grammarRule\`: Clear 1-sentence explanation of the syntactic structure.
Return JSON format: {"title": "Build a Sentence: Marathon Syntax", "items": [{"context": "What did you think of the guided tour of the historical district?", "targetSentence": "The tour guides who showed us around the old city were fantastic.", "distractorWord": "was", "grammarRule": "Subject relative clause ('who showed us around the old city') modifying plural 'tour guides', requiring plural verb 'were' instead of 'was'."}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT test creator. Create a 5-item TOEFL Writing "Build a Sentence" set for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 ETS TOEFL iBT "BUILD A SENTENCE" SPECIFICATIONS:
1. Provide EXACTLY 5 conversational exchanges in the \`items\` array.
2. For each exchange, generate ONLY:
   - \`context\`: Speaker 1's natural conversational question or statement (1 sentence).
   - \`targetSentence\`: Speaker 2's complete, grammatically flawless reply (8–12 words; ensure at least 2 items per set are direct interrogative questions ending in \`?\`, and the rest are statements ending in \`.\` using relative clauses, indirect questions, passive voice, or conditionals). Avoid proper nouns inside \`targetSentence\` so movable tiles remain 100% lowercase (except "I").
   - \`distractorWord\`: 1 single lowercase grammatical distractor word (e.g., "was" when targetSentence uses "were", or "has" when targetSentence uses "have").
   - \`grammarRule\`: Clear 1-sentence explanation of the syntactic structure.
Return JSON format: {"title": "Build a Sentence: Campus & Academic Syntax", "items": [{"context": "What did you think of the guided tour of the historical district?", "targetSentence": "The tour guides who showed us around the old city were fantastic.", "distractorWord": "was", "grammarRule": "Subject relative clause ('who showed us around the old city') modifying plural 'tour guides', requiring plural verb 'were' instead of 'was'."}, {"context": "I tried studying in the science library last night, but the doors were locked at eight.", "targetSentence": "How long has the science library been closing so early on weeknights?", "distractorWord": "have", "grammarRule": "Direct wh-interrogative in present perfect continuous requiring singular auxiliary 'has' before 'the science library'."}]}`;
      case 'write-email':
      case 'writing_email':
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Writing Coach. Create a TOEFL Writing "Write an Email" prompt with a 4-stage "coachBlueprint" for level: ${levelDesc}. Topic: ${top}.
Return JSON format: {"title": "Email Task Title", "situation": "Detailed campus or academic scenario description...", "recipient": "Recipient name and role", "goals": ["Specific bullet point 1", "Specific bullet point 2", "Specific bullet point 3"], "suggestedWordCount": "110-150 words", "coachBlueprint": [{"step": "Stage 1: Opening & Purpose", "description": "Address recipient and state purpose.", "starters": ["Dear ..., I am writing to ...", "I hope this message finds you well. I am reaching out regarding ..."]}, {"step": "Stage 2: Addressing Goal 1 & 2", "description": "Explain context and details.", "starters": ["Specifically, ...", "Furthermore, ..."]}, {"step": "Stage 3: Addressing Goal 3", "description": "Propose next step or request.", "starters": ["Would it be possible to ...", "I would appreciate it if ..."]}, {"step": "Stage 4: Professional Sign-Off", "description": "Close politely.", "starters": ["Thank you for your time and consideration.\\nSincerely,"]}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT Writing test designer. Create a 7-minute TOEFL Writing "Write an Email" prompt for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Provide a clear campus or academic scenario (\`situation\`), \`recipient\` name and role, and EXACTLY 3 specific bullet points (\`goals\`) the student must accomplish in their email.
2. Set \`suggestedWordCount\` to "85-130 words".
Return JSON format: {"title": "Email Task Title", "situation": "Detailed campus or academic scenario description...", "recipient": "Recipient name and role", "goals": ["Specific bullet point 1", "Specific bullet point 2", "Specific bullet point 3"], "suggestedWordCount": "85-130 words"}`;
      case 'vocabulary_explanation':
      case 'vocabulary-explanation': {
        const targetWord = promptData?.word || top || 'word';
        const sentenceContext = promptData?.context || '';
        return `You are an expert English lexicographer and official TOEFL vocabulary instructor.
Provide the precise modern academic definition and grammatical explanation for the word "${targetWord}" in the context of this sentence: "${sentenceContext}".
Requirements:
1. Identify the exact part of speech used in the context sentence (e.g. "adjective", "verb", "noun", "adverb"). Note: If the word modifies a noun (e.g. "academic topic"), it is an "adjective".
2. Provide a modern, TOEFL-level definition explaining how the word is used in this specific context sentence. NEVER return archaic, historical, or ancient definitions (such as references to Plato, Platonists, sects, or obsolete meanings).
3. Provide 2 authentic, high-quality modern example sentences demonstrating this exact usage.
4. If the word has other common modern meanings, include them in the meanings array.
5. Provide 2-4 academic synonyms.
Return valid JSON matching this schema:
{
  "word": "${targetWord}",
  "phonetic": "/.../",
  "meanings": [
    {
      "partOfSpeech": "adjective",
      "definition": "Relating to education, study, or scholarship at a college or university",
      "example": "She excelled in her academic pursuits and was awarded a scholarship."
    }
  ],
  "examples": [
    "The university maintains rigorous academic standards.",
    "They discussed several academic topics during the seminar."
  ],
  "synonyms": ["scholarly", "educational", "intellectual", "pedagogical"]
}`;
      }
      case 'academic-discussion':
      case 'writing_discussion':
      default:
        if (isCoachMode) {
          return `You are an official ETS 2026 TOEFL iBT Writing Coach. Create a TOEFL Writing "Writing for an Academic Discussion" prompt with a 4-stage "coachBlueprint" for level: ${levelDesc}. Topic: ${top}.
Return JSON format: {"title": "Academic Discussion Board", "professorName": "Professor Name", "professorPrompt": "50-70 word professor question...", "s1": {"name": "Student A", "text": "50-70 word post taking viewpoint 1..."}, "s2": {"name": "Student B", "text": "50-70 word post taking contrasting viewpoint 2..."}, "question": "Express and support your personal opinion in the academic discussion forum, contributing a new point beyond the existing student posts.", "coachBlueprint": [{"step": "Stage 1: State Your Thesis", "description": "Directly answer the professor's prompt.", "starters": ["In my view, ...", "While both perspectives have merit, I strongly contend that ..."]}, {"step": "Stage 2: Engage with a Classmate", "description": "Acknowledge and build upon or counter a student's point.", "starters": ["While I understand Student A's point regarding ..., it overlooks ...", "Building upon Student B's observation about ..., I would add that ..."]}, {"step": "Stage 3: Introduce Your Original Argument & Example", "description": "Provide a concrete mechanism or real-world example.", "starters": ["A more compelling factor to consider is ...", "For example, empirical studies demonstrate that ..."]}, {"step": "Stage 4: Concluding Policy Synthesis", "description": "Tie your argument back to the broader question.", "starters": ["Ultimately, prioritizing ... ensures long-term sustainability."]}]}`;
        }
        return `You are an official ETS 2026 TOEFL iBT Writing test designer. Create a 10-minute TOEFL Writing "Writing for an Academic Discussion" prompt for level: ${levelDesc}. Topic: ${top}.
STRICT 2026 TOEFL iBT SPECIFICATIONS:
1. Provide a professor's course question (\`professorPrompt\`, 50-70 words) posing an open-ended academic debate question.
2. Provide 2 contrasting student posts (\`s1\` and \`s2\`, 50-70 words each, with distinct student names and contrasting viewpoints/examples).
Return JSON format: {"title": "Academic Discussion Board", "professorName": "Professor Name", "professorPrompt": "50-70 word professor question...", "s1": {"name": "Student A", "text": "50-70 word post taking viewpoint 1..."}, "s2": {"name": "Student B", "text": "50-70 word post taking contrasting viewpoint 2..."}, "question": "Express and support your personal opinion in the academic discussion forum, contributing a new point beyond the existing student posts."}`;
    }
  };

  const prompt = getPrompt(taskType, level, topic);
  const systemInstruction = 'You are an expert ETS TOEFL test design specialist. Write natural, authentic ETS TOEFL prose. Avoid repetitive phrasing, redundant concluding summaries, or artificial buzzword stuffing. Return valid JSON matching the schema only.';
  const fullPrompt = `${systemInstruction}\n\n${prompt}\n\nIMPORTANT: Return valid JSON matching the schema only. Do not wrap in markdown fences.`;

  // Collect available providers and distribute via round-robin for question generation (high throughput)
  const candidates = collectAvailableProviders(options);
  const prioritized = prioritizeForGeneration(candidates);

  let lastError: any = null;

  for (const candidate of prioritized) {
    incrementProviderInFlight(candidate.provider);
    try {
      if (candidate.provider === 'gemini') {
        const ai = getAiClient(candidate.apiKey);
        if (!ai) continue;

        const chains = await resolveModelChains('gemini', candidate.apiKey);
        const { result, modelUsed } = await generateWithFallback(ai, chains.generation, async (model) => {
          let response;
          try {
            response = await ai.models.generateContent({
              model,
              contents: fullPrompt,
              config: {
                responseMimeType: 'application/json',
                temperature: 0.7,
              },
            });
          } catch (firstErr: any) {
            if (isKeyError(firstErr) || isQuotaExhaustedError(firstErr)) {
              throw firstErr;
            }
            console.warn(`Model ${model} JSON mime attempt failed, retrying plain contents:`, redactSensitiveInfo(firstErr?.message || firstErr));
            response = await ai.models.generateContent({
              model,
              contents: fullPrompt,
              config: {
                temperature: 0.7,
              },
            });
          }

          const rawText = response.text || response.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
          const parsed = cleanAndExtractJson(rawText);
          const normalized = normalizeTask(taskType, { ...parsed, coachMode: isCoachMode });
          return schema.parse(normalized);
        });

        clearProviderCooldown(candidate.provider);
        return { ...result, isFallback: false, modelUsed, providerUsed: candidate.provider };
      } else {
        let modelsToTry = getModelsForRole('generator', candidate.provider);
        const explicitModel = (candidate.model || optsObj.model || '').trim();
        const isValidExplicitForProvider =
          explicitModel &&
          explicitModel !== 'Auto-Routed by Purpose' &&
          explicitModel !== 'Auto-Optimized' &&
          !/^gemini-/i.test(explicitModel) &&
          (modelsToTry.includes(explicitModel) ||
            (candidate.provider === 'openrouter' && explicitModel.endsWith(':free')) ||
            (candidate.provider === 'nvidia' && explicitModel.includes('/')) ||
            (candidate.provider === 'groq' && !explicitModel.startsWith('meta/') && !explicitModel.endsWith(':free')));

        if (isValidExplicitForProvider && modelsToTry[0] !== explicitModel) {
          modelsToTry = [explicitModel, ...modelsToTry.filter((m) => m !== explicitModel)];
        }
        if (modelsToTry.length === 0) {
          modelsToTry = [explicitModel || 'llama-3.3-70b-versatile'];
        }

        let providerModelErr: any = null;
        for (const modelToUse of modelsToTry) {
          try {
            const { text, modelUsed } = await callChatWithHealing({
              provider: candidate.provider,
              apiKey: candidate.apiKey,
              baseUrl: candidate.baseUrl,
              model: modelToUse,
              purpose: 'generation',
              prompt: fullPrompt,
              systemInstruction,
              responseJson: true,
            });

            const parsed = cleanAndExtractJson(text);
            const normalized = normalizeTask(taskType, { ...parsed, coachMode: isCoachMode });
            const result = schema.parse(normalized);
            clearProviderCooldown(candidate.provider);
            return { ...result, isFallback: false, modelUsed, providerUsed: candidate.provider };
          } catch (mErr: any) {
            providerModelErr = mErr;
            const status = getStatus(mErr);
            if (status === 401 || status === 403 || isKeyError(mErr)) {
              throw mErr;
            }
          }
        }
        throw providerModelErr || new Error(`All models failed for provider ${candidate.provider}`);
      }
    } catch (candidateErr: any) {
      lastError = candidateErr;
      recordProviderErrorCooldown(candidate.provider, candidateErr);
      const status = getStatus(candidateErr);
      const isQuota = isQuotaExhaustedError(candidateErr) || status === 429;
      console.warn(`Generation provider [${candidate.provider}] failed (${isQuota ? '429 Quota Exceeded' : candidateErr?.message || candidateErr}), continuing to next provider in chain...`);
      continue;
    } finally {
      decrementProviderInFlight(candidate.provider);
    }
  }

  // If all API providers fail, drop down to local/curated fallbacks
  if (taskType === 'vocabulary_explanation' || taskType === 'vocabulary-explanation') {
    const targetWord = promptData?.word || topic || 'word';
    const cleanW = targetWord.toLowerCase().trim();
    const glossaryEntry = ACADEMIC_GLOSSARY[cleanW];
    if (glossaryEntry) {
      return {
        word: targetWord,
        phonetic: '',
        meanings: [{
          partOfSpeech: glossaryEntry.partOfSpeech || 'adjective',
          definition: glossaryEntry.definition,
          example: promptData?.context || '',
        }],
        examples: promptData?.context ? [promptData.context] : [],
        synonyms: glossaryEntry.synonyms || [],
        isFallback: false,
        modelUsed: 'Academic Glossary',
      };
    }
    const isAdj = /\b\w+(ic|al|ive|ous|less|able|ible|ful|ial|ical)\b/i.test(targetWord);
    const isV = targetWord.endsWith('ing') || targetWord.endsWith('ed');
    const pos = isAdj ? 'adjective' : isV ? 'verb' : 'noun';
    return {
      word: targetWord,
      phonetic: '',
      meanings: [{
        partOfSpeech: pos,
        definition: isAdj ? `Relating to or characterized by ${targetWord}` : `Pertaining to ${targetWord}`,
        example: promptData?.context || '',
      }],
      examples: promptData?.context ? [promptData.context] : [],
      synonyms: [],
      isFallback: true,
      modelUsed: 'Local fallback',
    };
  }

  const isQuota = isQuotaExhaustedError(lastError) || getStatus(lastError) === 429;
  const rateLimit = isQuota ? parseRateLimitFromError(lastError) : undefined;
  const errMsg = extractErrorMessage(lastError, 'AI Service');

  if (isCoachMode) {
    const canonicalType = canonicalizeTaskType(taskType);
    const coachList = COACH_CURATED_BANK[canonicalType] || [];
    const coachItem = coachList.length > 0 ? coachList[Math.floor(Math.random() * coachList.length)] : null;
    if (coachItem) {
      return {
        ...coachItem,
        isFallback: true,
        isQuotaExhausted: isQuota,
        rateLimit,
        fallbackReason: errMsg,
        modelUsed: 'Curated Coach & Marathon Question Bank',
      };
    }
  }

  const curatedKey = curatedMap[taskType] as keyof typeof CURATED;
  const curatedTasks = CURATED[curatedKey] as any[];
  const item = curatedTasks ? curatedTasks[Math.floor(Math.random() * curatedTasks.length)] : null;

  return {
    ...item,
    isFallback: true,
    isQuotaExhausted: isQuota,
    rateLimit,
    fallbackReason: errMsg,
    modelUsed: 'Curated ETS TOEFL Question Bank',
  };
}

export { handleEvaluateResponse } from './evaluationHandler';

function addWavHeader(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  return wrapWavHeaderIfNeeded(pcmBuffer, sampleRate, numChannels, bitsPerSample);
}

export async function handleSynthesizeSpeech(
  text: string,
  voiceName: string = 'Kore',
  options?: ApiCallOptions
) {
  const opts = typeof options === 'string' ? { apiKey: options } : options || {};
  let provider = opts.provider || 'gemini';
  const customApiKey = (opts.apiKey || (typeof options === 'string' ? options : '')).trim();

  // Check if Audio8-TTS provider requested
  if (provider === 'audio8' || (opts as any).ttsProvider === 'audio8' || (opts as any).audio8Url) {
    const audio8Url = (opts as any).audio8Url || opts.baseUrl || process.env.AUDIO8_TTS_URL || 'http://localhost:8000';
    try {
      const res = await callAudio8Speech({
        baseUrl: audio8Url,
        apiKey: customApiKey,
        text,
        voiceName,
      });
      return res;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('401') || msg.includes('UNAUTHORIZED')) {
        throw new Error('TTS_INVALID_CREDENTIALS');
      }
      throw new Error(`Audio8-TTS service error: ${msg}`);
    }
  }

  // If OpenRouter key, utilize OpenRouter TTS API directly (/api/v1/audio/speech)
  if (provider === 'openrouter' && customApiKey) {
    try {
      const res = await callOpenRouterTts({
        apiKey: customApiKey,
        text,
        voiceName,
        model: opts.ttsModel,
      });
      return res;
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes('401')) {
        throw new Error('TTS_INVALID_CREDENTIALS');
      }
      if (err?.status === 429 || err?.message?.includes('429')) {
        throw new Error('TTS_QUOTA_EXCEEDED');
      }
      throw new Error(`OpenRouter TTS failed: ${err?.message || 'SPEECH_UNAVAILABLE'}`);
    }
  }

  // If Groq key, utilize Groq TTS API directly
  if (provider === 'groq' && customApiKey) {
    try {
      let ttsModel = opts.ttsModel || '';
      if (!ttsModel) {
        try {
          const chains = await resolveModelChains('groq', customApiKey);
          ttsModel = chains.tts[0] || 'playai-tts';
        } catch {
          ttsModel = 'playai-tts';
        }
      }
      const res = await callGroqSpeech({
        apiKey: customApiKey,
        text,
        voiceName,
        model: ttsModel,
      });
      return res;
    } catch (err: any) {
      if (err?.code === 'TTS_TERMS_REQUIRED') {
        throw Object.assign(
          new Error(err.message || 'Groq voice model terms must be accepted in the Groq console.'),
          { code: 'TTS_TERMS_REQUIRED' }
        );
      }
      if (err?.status === 401 || err?.message?.includes('401')) {
        throw new Error('TTS_INVALID_CREDENTIALS');
      }
      if (err?.status === 429 || err?.message?.includes('429')) {
        throw new Error('TTS_QUOTA_EXCEEDED');
      }
      throw new Error(`Groq TTS failed: ${err?.message || 'SPEECH_UNAVAILABLE'}`);
    }
  }

  // If OpenAI key, utilize OpenAI TTS API directly
  if (provider === 'openai' && customApiKey) {
    try {
      const res = await callOpenAiTts({ apiKey: customApiKey, text, voiceName });
      return res;
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes('401')) {
        throw new Error('TTS_INVALID_CREDENTIALS');
      }
      if (err?.status === 429 || err?.message?.includes('429')) {
        throw new Error('TTS_QUOTA_EXCEEDED');
      }
      throw new Error(`OpenAI TTS failed: ${err?.message || 'SPEECH_UNAVAILABLE'}`);
    }
  }

  // If Anthropic, XAI, DeepSeek, NVIDIA, or custom, throw unsupported provider error
  const unsupportedProviders = ['anthropic', 'xai', 'deepseek', 'nvidia', 'custom'];
  if (unsupportedProviders.includes(provider)) {
    throw new Error(`TTS_UNSUPPORTED_PROVIDER: Provider '${provider}' does not support text-to-speech synthesis. Use Cloud (Gemini), Groq, OpenRouter, OpenAI, or Offline Neural voice.`);
  }

  // Gemini TTS path: NEVER send non-Gemini keys to Gemini
  const isGeminiKey = (k: string) => /^(AIza|AQ\.)/i.test(k);
  const rawVoiceKey = (opts.voiceApiKey || '').trim();
  const voiceApiKey = rawVoiceKey && isGeminiKey(rawVoiceKey) ? rawVoiceKey : '';
  const validCustomGeminiKey = customApiKey && isGeminiKey(customApiKey) ? customApiKey : '';
  const envKey = process.env.GEMINI_TTS_API_KEY && isGeminiKey(process.env.GEMINI_TTS_API_KEY) ? process.env.GEMINI_TTS_API_KEY : '';

  const geminiKey = voiceApiKey || validCustomGeminiKey || envKey;
  if (!geminiKey) {
    throw new Error('TTS_INVALID_CREDENTIALS: No valid dedicated Gemini API key configured for Cloud TTS.');
  }

  try {
    const isMale = /Male|Guy|Christopher|Eric|Puck/i.test(voiceName);
    const result = await synthesizeGeminiTts(text, geminiKey, { voiceName, isMale });
    return { audioBase64: result.base64Audio, mimeType: result.mimeType, modelUsed: result.modelUsed };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('401') || msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED')) {
      throw new Error('TTS_INVALID_CREDENTIALS');
    }
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      throw new Error('TTS_QUOTA_EXCEEDED');
    }
    throw new Error(`Gemini TTS error: ${msg}`);
  }
}

export async function synthesizeGeminiTts(
  cleanText: string,
  apiKey: string,
  options: { voiceName?: string; isMale?: boolean } = {}
): Promise<{
  base64Audio: string;
  mimeType: string;
  modelUsed: string;
  voiceUsed: string;
}> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Missing dedicated Gemini TTS API key. Please enter a valid Gemini TTS API key in Settings.');
  }

  // Prebuilt Gemini 3.8 TTS voices: Puck, Charon, Kore, Fenrir, Zephyr
  const validVoices = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
  let geminiVoice = options.voiceName || '';
  if (!validVoices.has(geminiVoice)) {
    geminiVoice = options.isMale ? 'Puck' : 'Kore';
  }

  const model = 'gemini-3.8-flash-lite-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: cleanText,
            speechMetadata: {
              style: 'Clear, professional voice',
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: geminiVoice,
          },
        },
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    let detail = errText;
    try {
      const errJson = JSON.parse(errText);
      detail = errJson.error?.message || detail;
    } catch {}
    throw new Error(`Gemini HTTP ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const part = data.candidates?.[0]?.content?.parts?.[0];
  const base64Audio = part?.inlineData?.data;
  let mimeType = part?.inlineData?.mimeType || 'audio/wav';

  if (!base64Audio || typeof base64Audio !== 'string' || base64Audio.length < 100) {
    throw new Error('No valid audio data returned from Gemini TTS API.');
  }

  return {
    base64Audio,
    mimeType,
    modelUsed: `${model} (${geminiVoice})`,
    voiceUsed: geminiVoice,
  };
}

export async function handleTranscribeAudio(
  audioBase64: string,
  mimeType: string = 'audio/webm',
  options?: ApiCallOptions
) {
  const opts = typeof options === 'string' ? { apiKey: options } : options || {};
  let provider = opts.provider || 'gemini';
  const customApiKey = (opts.apiKey || (typeof options === 'string' ? options : '')).trim();

  // If Groq, OpenRouter, or OpenAI key, utilize native Whisper transcription
  if ((provider === 'groq' || provider === 'openai' || provider === 'openrouter') && customApiKey) {
    try {
      const startTime = Date.now();
      const res = await callWhisperTranscription({
        provider,
        apiKey: customApiKey,
        audioBase64,
        mimeType,
        sttModel: opts.sttModel,
        prompt: opts.prompt,
      });
      return { transcript: res.transcript, modelUsed: res.modelUsed, durationMs: Date.now() - startTime };
    } catch (err: any) {
      console.warn(`${provider.toUpperCase()} Whisper transcription failed, checking Gemini fallback:`, redactSensitiveInfo(err?.message || err));
    }
  }

  const geminiKey = (customApiKey && /^(AIza|AQ\.)/i.test(customApiKey)) ? customApiKey : (process.env.GEMINI_API_KEY || '');
  const ai = getAiClient(geminiKey);
  if (!ai) {
    throw new Error('SPEECH_UNAVAILABLE');
  }

  const startTime = Date.now();
  const chains = await resolveModelChains('gemini', geminiKey);
  const { result, modelUsed } = await generateWithFallback(ai, chains.generation, async (model) => {
    const thinkingConfig = getModelThinkingConfig(model, 'transcribe');
    const promptText = opts.prompt
      ? `Transcribe the spoken speech in this audio accurately. Target sentence reference: "${opts.prompt}". Return only the transcribed speech.`
      : 'Transcribe the spoken speech in this audio accurately. Return only the exact transcribed transcript text with no extra commentary, quotation marks, or notes.';

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          inlineData: {
            mimeType: mimeType || 'audio/webm',
            data: audioBase64,
          },
        },
        {
          text: promptText,
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      } as any,
    });

    const transcript = response.text || response.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    return { transcript: transcript.trim() };
  });

  const durationMs = Date.now() - startTime;
  return { transcript: result.transcript, modelUsed, durationMs };
}
