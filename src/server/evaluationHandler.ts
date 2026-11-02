import { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import {
  evaluateResponseLocally,
  LocalEvaluationResult,
  buildCriteriaArray,
  CriterionItem,
  GrammarErrorItem,
} from '../utils/localEvaluator';

type AIProvider = 'gemini' | 'groq' | 'openrouter' | 'nvidia';

interface FallbackStep {
  provider: AIProvider;
  modelId: string;
  apiKey: string;
}

function extractJsonObject(raw: string): any {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function resolveAvailableKeys(options: any): Partial<Record<AIProvider, string>> {
  const keys: Partial<Record<AIProvider, string>> = {};
  const pk = options?.providerKeys || options?.availableKeys || {};
  const headers = options?.headers || {};
  const explicitProv = String(options?.provider || '').trim().toLowerCase() as AIProvider;
  const pkEntries = Object.entries(pk).filter(([_, v]) => typeof v === 'string' && v.trim().length > 0);
  const isStrict =
    Boolean(options?.strictProvider) ||
    (explicitProv && pkEntries.length === 1 && pkEntries[0][0].toLowerCase() === explicitProv);

  if (isStrict && explicitProv) {
    const singleKey = String(
      options?.apiKey || options?.customApiKey || pk[explicitProv] || ''
    ).trim();
    if (singleKey) {
      keys[explicitProv] = singleKey;
      return keys;
    }
  }

  const gemini =
    pk.gemini ||
    headers['x-gemini-key'] ||
    (options?.provider === 'gemini' ? options?.apiKey || options?.customApiKey : '') ||
    (pkEntries.length === 0 ? process.env.GEMINI_API_KEY : '') ||
    '';
  const groq =
    pk.groq ||
    options?.groqKey ||
    headers['x-groq-key'] ||
    (options?.provider === 'groq' ? options?.apiKey || options?.customApiKey : '') ||
    (pkEntries.length === 0 ? process.env.GROQ_API_KEY : '') ||
    '';
  const openrouter =
    pk.openrouter ||
    headers['x-openrouter-key'] ||
    (options?.provider === 'openrouter' ? options?.apiKey || options?.customApiKey : '') ||
    (pkEntries.length === 0 ? process.env.OPENROUTER_API_KEY : '') ||
    '';
  const nvidia =
    pk.nvidia ||
    headers['x-nvidia-key'] ||
    (options?.provider === 'nvidia' ? options?.apiKey || options?.customApiKey : '') ||
    (pkEntries.length === 0 ? process.env.NVIDIA_API_KEY : '') ||
    '';

  if (gemini && String(gemini).trim()) keys.gemini = String(gemini).trim();
  if (groq && String(groq).trim()) keys.groq = String(groq).trim();
  if (openrouter && String(openrouter).trim()) keys.openrouter = String(openrouter).trim();
  if (nvidia && String(nvidia).trim()) keys.nvidia = String(nvidia).trim();

  // If a generic apiKey was passed without explicit provider
  const rawKey = String(options?.apiKey || options?.customApiKey || headers['x-api-key'] || '').trim();
  if (rawKey && Object.keys(keys).length === 0) {
    if (rawKey.startsWith('gsk_')) keys.groq = rawKey;
    else if (rawKey.startsWith('sk-or-')) keys.openrouter = rawKey;
    else if (rawKey.startsWith('nvapi-')) keys.nvidia = rawKey;
    else keys.gemini = rawKey;
  }

  return keys;
}

function buildFallbackChain(
  preferredProvider: string | undefined,
  keys: Partial<Record<AIProvider, string>>
): FallbackStep[] {
  const modelsByProvider: Record<AIProvider, string[]> = {
    gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    groq: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'llama-3.1-8b-instant',
    ],
    openrouter: [
      'openrouter/free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    nvidia: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    ],
  };

  const order: AIProvider[] = ['gemini', 'groq', 'openrouter', 'nvidia'];
  if (preferredProvider && order.includes(preferredProvider as AIProvider)) {
    const idx = order.indexOf(preferredProvider as AIProvider);
    order.splice(idx, 1);
    order.unshift(preferredProvider as AIProvider);
  }

  const steps: FallbackStep[] = [];
  for (const p of order) {
    const k = keys[p];
    if (!k) continue;
    for (const m of modelsByProvider[p]) {
      steps.push({ provider: p, modelId: m, apiKey: k });
    }
  }
  return steps;
}

function buildEvaluationPrompt(taskType: string, promptData: any, studentResponse: any): string {
  const promptJson = JSON.stringify(promptData || {}, null, 2);
  const responseStr =
    typeof studentResponse === 'string'
      ? studentResponse
      : JSON.stringify(studentResponse || {}, null, 2);

  return `You are an official 2026 ETS TOEFL iBT Senior Rater. Evaluate the student's response strictly using the 2026 ETS 1.0–6.0 Band Scale (half-point increments: 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0) and the 0–5 Task Rubric Scale.

Task Type: ${taskType}

Prompt / Task Context:
${promptJson}

Student Response:
${responseStr}

CRITICAL ETS 2026 SCORING & DIAGNOSTIC RULES:
1. For "write-email" (7-minute task): Full length credit is achieved at 85–130+ words. Verify all 3 required bullet points/goals in the prompt! Specifically, if a bullet point asks the student to "suggest two alternative times" (or propose specific days/times) and the student only writes vague text like "another time whenever you are free" without naming two specific days or time slots (e.g. Tuesday at 2:00 PM or Thursday morning), mark that objective as incomplete, deduct from Task Fulfillment, and cap the score accordingly.
2. For "academic-discussion" (10-minute task): Full length credit is achieved at 105–150+ words. Check clear stance, engagement with classmates, and academic register.
3. For "speaking-interview" (4 x 45s questions): Score each of the 4 questions individually and average across all 4. If only k of 4 questions are answered, cap the overall band score at 6.0 * (k / 4).
4. Spelling, Capitalization, Grammar & Wording Detection:
   - Flag EVERY spelling mistake (e.g., "disucss" -> "discuss", "introdutory" -> "introductory"), capitalization error (including standalone lowercase "i" -> "I"), repeated consecutive words (e.g., "about about" -> "about"), preposition/collocation errors (e.g., "discuss about" -> "discuss", "during Wednesday" -> "on Wednesday", "you office hours" -> "your office hours", "have by biology" -> "had my biology", "classes and its requirement" -> "class and its requirements"), and missing commas after sign-offs ("Sincerely" -> "Sincerely,").
   - Also identify informal or clunky phrasing and suggest formal academic wording upgrades (type: "wording"), such as replacing "I am writing to tell you that I couldn't manage to meet you" with "I am writing to inform you that I was unable to attend your scheduled office hours", or replacing "whenever you are free" with specific proposed times.
   - Deduct appropriately from Grammar & Mechanics and the overall score when multiple spelling, capitalization, and grammar errors are present.
5. Prompt-Copying & Off-Topic Guard:
   - If > 45% of words are copied verbatim from the prompt, cap bandScore6 at <= 1.5.
   - If the response is off-topic, cap bandScore6 at <= 2.0.

Return ONLY a valid JSON object matching this exact schema:
{
  "bandScore6": 4.5,
  "rawRubricScore": 3.8,
  "scaledScore": 23,
  "performanceLevel": "High-Intermediate",
  "criteria": [
    {
      "name": "Task Fulfillment & Elaboration",
      "score": 3.8,
      "feedback": "Detailed feedback on objective completion and elaboration."
    },
    {
      "name": "Organization & Coherence",
      "score": 4.0,
      "feedback": "Detailed feedback on paragraphing and transitions."
    },
    {
      "name": "Vocabulary & Academic Register",
      "score": 3.5,
      "feedback": "Detailed feedback on lexical precision and formal tone."
    },
    {
      "name": "Grammar & Mechanics (Spelling/Punctuation/Capitalization)",
      "score": 3.0,
      "feedback": "Detailed feedback on grammar, spelling, capitalization, and punctuation."
    }
  ],
  "summary": "2-3 sentence holistic assessment referencing specific strengths, missing objectives, and error patterns.",
  "strengths": ["Specific strength 1", "Specific strength 2"],
  "improvements": ["Specific actionable improvement 1", "Specific actionable improvement 2"],
  "topFixes": ["Priority fix 1", "Priority fix 2"],
  "exemplar": "A complete Band 6.0 model response to this exact prompt.",
  "corrections": [
    {
      "original": "exact substring from student response",
      "corrected": "corrected academic phrasing",
      "explanation": "Clear explanation of the grammar, spelling, capitalization, or wording rule.",
      "type": "spelling"
    }
  ]
}`;
}

async function callProviderForEvaluation(
  provider: AIProvider,
  modelId: string,
  apiKey: string,
  prompt: string
): Promise<string> {
  if (provider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: modelId,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    });
    return response.text || '';
  }

  let endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  if (provider === 'groq') {
    endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  } else if (provider === 'nvidia') {
    endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
  } else if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://toefl-prep-studio.app';
    headers['X-Title'] = 'TOEFL Prep Studio';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'system',
            content: 'You are an official ETS TOEFL iBT Evaluator. Always output valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeCriteriaField(
  rawCriteria: any,
  localGuard?: LocalEvaluationResult
): CriterionItem[] {
  if (Array.isArray(rawCriteria) && rawCriteria.length > 0) {
    const mapped: CriterionItem[] = rawCriteria.map((c: any, idx: number) => {
      const fallbackItem = localGuard?.criteria?.[idx];
      const rawScore = Number(c?.score ?? fallbackItem?.score ?? 4.0);
      const score5 = rawScore > 5 ? Number(((rawScore / 100) * 5.0).toFixed(1)) : Number(rawScore.toFixed(1));
      const text = String(c?.feedback || c?.comment || fallbackItem?.feedback || 'Evaluated against ETS rubric descriptors.');
      return {
        name: String(c?.name || fallbackItem?.name || `Criterion ${idx + 1}`),
        score: score5,
        maxScore: 5.0,
        displayScore: c?.displayScore || `${score5.toFixed(1)} / 5.0`,
        feedback: text,
        comment: text,
      };
    });
    return buildCriteriaArray(
      mapped,
      localGuard?.criteriaBreakdown || {
        taskFulfillment: 80,
        coherence: 80,
        vocabulary: 80,
        grammar: 80,
      }
    );
  }

  if (rawCriteria && typeof rawCriteria === 'object' && !Array.isArray(rawCriteria)) {
    const tf = Number(rawCriteria.taskFulfillment ?? localGuard?.criteriaBreakdown?.taskFulfillment ?? 78);
    const coh = Number(rawCriteria.coherence ?? localGuard?.criteriaBreakdown?.coherence ?? 78);
    const voc = Number(rawCriteria.vocabulary ?? localGuard?.criteriaBreakdown?.vocabulary ?? 78);
    const gram = Number(rawCriteria.grammar ?? localGuard?.criteriaBreakdown?.grammar ?? 78);

    const toFive = (v: number) => (v > 5 ? Number(((v / 100) * 5.0).toFixed(1)) : Number(v.toFixed(1)));
    const items: CriterionItem[] = [
      {
        name: 'Task Fulfillment & Elaboration',
        score: toFive(tf),
        maxScore: 5.0,
        displayScore: `${toFive(tf).toFixed(1)} / 5.0`,
        feedback: localGuard?.criteria?.[0]?.feedback || 'Evaluated on communicative task completion and elaboration.',
        comment: localGuard?.criteria?.[0]?.comment || 'Evaluated on communicative task completion and elaboration.',
      },
      {
        name: 'Organization & Coherence',
        score: toFive(coh),
        maxScore: 5.0,
        displayScore: `${toFive(coh).toFixed(1)} / 5.0`,
        feedback: localGuard?.criteria?.[1]?.feedback || 'Evaluated on paragraph unity, progression, and discourse markers.',
        comment: localGuard?.criteria?.[1]?.comment || 'Evaluated on paragraph unity, progression, and discourse markers.',
      },
      {
        name: 'Vocabulary & Academic Register',
        score: toFive(voc),
        maxScore: 5.0,
        displayScore: `${toFive(voc).toFixed(1)} / 5.0`,
        feedback: localGuard?.criteria?.[2]?.feedback || 'Evaluated on lexical variety, collocations, and academic register.',
        comment: localGuard?.criteria?.[2]?.comment || 'Evaluated on lexical variety, collocations, and academic register.',
      },
      {
        name: 'Grammar & Mechanics (Spelling/Punctuation/Capitalization)',
        score: toFive(gram),
        maxScore: 5.0,
        displayScore: `${toFive(gram).toFixed(1)} / 5.0`,
        feedback: localGuard?.criteria?.[3]?.feedback || 'Evaluated on syntactic variety, spelling, capitalization, and punctuation.',
        comment: localGuard?.criteria?.[3]?.comment || 'Evaluated on syntactic variety, spelling, capitalization, and punctuation.',
      },
    ];
    return buildCriteriaArray(items, {
      taskFulfillment: tf,
      coherence: coh,
      vocabulary: voc,
      grammar: gram,
    });
  }

  return localGuard?.criteria || [];
}

function mergeCorrections(
  aiCorrections: any[],
  localCorrections: GrammarErrorItem[]
): GrammarErrorItem[] {
  const merged: GrammarErrorItem[] = [];
  const seen = new Set<string>();

  const addOne = (item: any) => {
    const orig = String(item?.original || '').trim();
    const corr = String(item?.corrected || '').trim();
    if (!orig || !corr) return;
    const key = orig.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({
      original: orig,
      corrected: corr,
      explanation: String(item?.explanation || 'Improve grammatical accuracy and academic register.'),
      type: item?.type || 'grammar',
    });
  };

  for (const lc of localCorrections || []) {
    addOne(lc);
  }
  for (const ac of Array.isArray(aiCorrections) ? aiCorrections : []) {
    addOne(ac);
  }

  return merged.slice(0, 18);
}

function normalizeEvalResult(parsed: any, localGuard: LocalEvaluationResult): any {
  let bandScore6 = Number(parsed?.bandScore6 ?? parsed?.overallBand ?? parsed?.bandScore ?? localGuard.bandScore6);
  if (isNaN(bandScore6) || bandScore6 < 1.0) bandScore6 = localGuard.bandScore6;
  bandScore6 = Math.min(6.0, Math.max(1.0, Math.round(bandScore6 * 2) / 2));

  if (localGuard.copiedPromptDetected) {
    bandScore6 = Math.min(bandScore6, 1.5);
  }
  if (localGuard.offTopicDetected) {
    bandScore6 = Math.min(bandScore6, 2.0);
  }
  if (typeof localGuard.answeredQuestionsCount === 'number' && localGuard.answeredQuestionsCount < 4) {
    const cap = Math.max(1.0, Math.round(6.0 * (localGuard.answeredQuestionsCount / 4) * 2) / 2);
    bandScore6 = Math.min(bandScore6, cap);
  }

  const localHardErrors = (localGuard.corrections || []).filter((c) => c.type !== 'wording');
  if (localHardErrors.length >= 6) {
    bandScore6 = Math.min(bandScore6, 3.5);
  } else if (localHardErrors.length >= 4) {
    bandScore6 = Math.min(bandScore6, 4.0);
  }
  if (localGuard.bulletAnalysis && localGuard.bulletAnalysis.some((b) => !b.addressed)) {
    bandScore6 = Math.min(bandScore6, 4.0);
  }

  const scaledScore = Math.round((bandScore6 / 6.0) * 30);
  const rawRubricScore = Number(((bandScore6 / 6.0) * 5.0).toFixed(1));
  const performanceLevel =
    bandScore6 >= 5.5
      ? 'Advanced'
      : bandScore6 >= 4.0
      ? 'High-Intermediate'
      : bandScore6 >= 2.5
      ? 'Low-Intermediate'
      : 'Basic';

  const criteria = normalizeCriteriaField(parsed?.criteria, localGuard);
  const corrections = mergeCorrections(
    parsed?.corrections || parsed?.errors || parsed?.grammarErrors || [],
    localGuard.corrections || []
  );

  const aiImprovements = Array.isArray(parsed?.improvements) && parsed.improvements.length > 0
    ? parsed.improvements.map(String)
    : [];
  const missingBulletNotes = (localGuard.bulletAnalysis || [])
    .filter((b) => !b.addressed)
    .map((b) => b.feedback);

  const combinedImprovements = [
    ...missingBulletNotes,
    ...aiImprovements.filter((imp: string) => !missingBulletNotes.includes(imp)),
    ...localGuard.improvements.filter((imp) => !aiImprovements.includes(imp) && !missingBulletNotes.includes(imp)),
  ].slice(0, 6);

  const strengths =
    Array.isArray(parsed?.strengths) && parsed.strengths.length > 0
      ? parsed.strengths.map(String)
      : localGuard.strengths;

  const topFixes =
    missingBulletNotes.length > 0
      ? [...missingBulletNotes, ...(Array.isArray(parsed?.topFixes) ? parsed.topFixes.map(String) : combinedImprovements)].slice(0, 3)
      : Array.isArray(parsed?.topFixes) && parsed.topFixes.length > 0
      ? parsed.topFixes.map(String).slice(0, 3)
      : combinedImprovements.slice(0, 3);

  const exemplar = parsed?.exemplar || parsed?.exemplarResponse || parsed?.modelBand6Rewrite || localGuard.exemplar;
  const summary = parsed?.summary || parsed?.feedbackSummary || localGuard.summary;

  return {
    ...localGuard,
    ...parsed,
    bandScore6,
    overallBand: bandScore6,
    bandScore: bandScore6,
    rawRubricScore,
    scaledScore,
    performanceLevel,
    criteria,
    criteriaBreakdown: localGuard.criteriaBreakdown,
    subScores: parsed?.subScores || localGuard.subScores,
    bulletAnalysis: localGuard.bulletAnalysis,
    summary,
    feedbackSummary: summary,
    strengths,
    improvements: combinedImprovements,
    areasForImprovement: combinedImprovements,
    topFixes,
    tips: combinedImprovements,
    exemplar,
    exemplarResponse: exemplar,
    modelBand6Rewrite: exemplar,
    modelAnswer: exemplar,
    questionModelAnswers:
      Array.isArray(parsed?.questionModelAnswers) && parsed.questionModelAnswers.length > 0
        ? parsed.questionModelAnswers
        : localGuard.questionModelAnswers,
    corrections,
    errors: corrections,
    grammarErrors: corrections,
  };
}

export async function evaluateResponseCore(
  taskType: string = 'academic-discussion',
  promptData: any = {},
  studentResponse: any = '',
  options: any = {}
): Promise<any> {
  const localGuard = evaluateResponseLocally(promptData, studentResponse, taskType, options);

  if (String(taskType).toLowerCase().includes('repeat')) {
    return {
      ...localGuard,
      isLocalEvaluation: true,
      modelUsed: 'Local Rubric Engine (Zero-API)',
    };
  }

  const availableKeys = resolveAvailableKeys(options);
  const chain = buildFallbackChain(options?.provider, availableKeys);
  if (chain.length === 0) {
    return {
      ...localGuard,
      isLocalEvaluation: true,
      modelUsed: 'Local Rubric Engine (Zero-API)',
    };
  }

  const prompt = buildEvaluationPrompt(taskType, promptData, studentResponse);

  for (const step of chain) {
    try {
      const rawText = await callProviderForEvaluation(step.provider, step.modelId, step.apiKey, prompt);
      const parsed = extractJsonObject(rawText);
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizeEvalResult(parsed, localGuard);
        return {
          ...normalized,
          isLocalEvaluation: false,
          modelUsed: step.modelId,
          providerUsed: step.provider,
        };
      }
    } catch (err: any) {
      console.warn(`[EvalChain] ${step.provider}/${step.modelId} failed:`, err?.message || err);
    }
  }

  return {
    ...localGuard,
    isLocalEvaluation: true,
    modelUsed: 'Local Rubric Engine (Fallback)',
  };
}

/**
 * Supports both:
 * 1) Express route handler: handleEvaluateResponse(req, res)
 * 2) Direct helper call: handleEvaluateResponse(taskType, promptData, studentResponse, config)
 */
export async function handleEvaluateResponse(
  arg1: Request | string,
  arg2?: Response | any,
  arg3?: any,
  arg4?: any
): Promise<any> {
  if (arg1 && typeof arg1 === 'object' && 'body' in arg1 && arg2 && typeof arg2.status === 'function') {
    const req = arg1 as Request;
    const res = arg2 as Response;
    const { taskType = 'academic-discussion', promptData = {}, studentResponse = '', options = {} } = req.body || {};
    const mergedOptions = { ...req.body, ...options, headers: req.headers };
    const data = await evaluateResponseCore(taskType, promptData, studentResponse, mergedOptions);
    return res.status(200).json({
      success: true,
      data,
      isLocalEvaluation: data.isLocalEvaluation,
      modelUsed: data.modelUsed,
    });
  }

  return evaluateResponseCore(String(arg1 || 'academic-discussion'), arg2, arg3, arg4);
}
