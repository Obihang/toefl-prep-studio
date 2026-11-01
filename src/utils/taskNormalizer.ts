import {
  LEVELS,
  ACADEMIC_TOPICS,
  Level,
  AcademicTopic,
  isValidLevel,
  isValidAcademicTopic,
} from '../constants/filters';
import { TASK_DEFINITIONS, TaskTypeId } from '../types/taskTypes';
import { inferGender } from './voices';

const CANONICAL_TASK_IDS = new Set<string>(TASK_DEFINITIONS.map((t) => t.id));

const TASK_TYPE_ALIASES: Record<string, TaskTypeId> = {
  // Reading (3)
  'complete-words': 'complete-words',
  complete_words: 'complete-words',
  completewords: 'complete-words',
  'c-test': 'complete-words',

  'daily-life': 'daily-life',
  daily_life: 'daily-life',
  'reading-daily-life': 'daily-life',
  reading_daily_life: 'daily-life',
  dailylife: 'daily-life',

  'reading-academic': 'reading-academic',
  reading_academic: 'reading-academic',
  'reading-passage': 'reading-academic',
  reading_passage: 'reading-academic',
  reading: 'reading-academic',

  // Listening (4)
  'listening-choose-response': 'listening-choose-response',
  listening_choose_response: 'listening-choose-response',
  'choose-response': 'listening-choose-response',
  choose_response: 'listening-choose-response',

  'listening-dialogue': 'listening-dialogue',
  listening_dialogue: 'listening-dialogue',
  'listening-conversation': 'listening-dialogue',
  listening_conversation: 'listening-dialogue',
  listening: 'listening-dialogue',

  'listening-announcement': 'listening-announcement',
  listening_announcement: 'listening-announcement',
  announcement: 'listening-announcement',

  'listening-academic-talk': 'listening-academic-talk',
  listening_academic_talk: 'listening-academic-talk',
  'listening-lecture': 'listening-academic-talk',
  listening_lecture: 'listening-academic-talk',
  'academic-talk': 'listening-academic-talk',
  academic_talk: 'listening-academic-talk',

  // Writing (3)
  'build-sentence': 'build-sentence',
  build_sentence: 'build-sentence',
  'writing-build-sentence': 'build-sentence',
  writing_build_sentence: 'build-sentence',

  'write-email': 'write-email',
  write_email: 'write-email',
  'writing-email': 'write-email',
  writing_email: 'write-email',
  email: 'write-email',

  'academic-discussion': 'academic-discussion',
  academic_discussion: 'academic-discussion',
  'writing-discussion': 'academic-discussion',
  writing_discussion: 'academic-discussion',
  discussion: 'academic-discussion',

  // Speaking (2)
  'listen-repeat': 'listen-repeat',
  listen_repeat: 'listen-repeat',
  'speaking-listen-repeat': 'listen-repeat',
  speaking_listen_repeat: 'listen-repeat',

  'speaking-interview': 'speaking-interview',
  speaking_interview: 'speaking-interview',
  interview: 'speaking-interview',
};

const DIFFICULTY_ALIASES: Record<string, Level> = {
  beginner: 'beginner',
  easy: 'beginner',
  basic: 'beginner',
  foundation: 'beginner',
  a1: 'beginner',
  a2: 'beginner',
  intermediate: 'intermediate',
  medium: 'intermediate',
  moderate: 'intermediate',
  standard: 'intermediate',
  b1: 'intermediate',
  b2: 'intermediate',
  'b1-b2': 'intermediate',
  'upper-intermediate': 'upper-intermediate',
  upper_intermediate: 'upper-intermediate',
  upperintermediate: 'upper-intermediate',
  'upper intermediate': 'upper-intermediate',
  'b2-c1': 'upper-intermediate',
  high: 'upper-intermediate',
  advanced: 'advanced',
  hard: 'advanced',
  difficult: 'advanced',
  expert: 'advanced',
  c1: 'advanced',
  c2: 'advanced',
  'c1-c2': 'advanced',
};

const TOPIC_ALIASES: Record<string, AcademicTopic> = {
  'science-tech': 'science-tech',
  science_tech: 'science-tech',
  'science & technology': 'science-tech',
  science: 'science-tech',
  technology: 'science-tech',
  biology: 'science-tech',
  chemistry: 'science-tech',
  physics: 'science-tech',
  astronomy: 'science-tech',
  neuroscience: 'science-tech',
  medicine: 'science-tech',
  engineering: 'science-tech',
  'computer-science': 'science-tech',
  'campus-life': 'campus-life',
  campus_life: 'campus-life',
  'campus life': 'campus-life',
  'campus life & academics': 'campus-life',
  campus: 'campus-life',
  education: 'campus-life',
  university: 'campus-life',
  academics: 'campus-life',
  student: 'campus-life',
  'social-sciences': 'social-sciences',
  social_sciences: 'social-sciences',
  'social sciences': 'social-sciences',
  'social sciences & history': 'social-sciences',
  psychology: 'social-sciences',
  sociology: 'social-sciences',
  anthropology: 'social-sciences',
  history: 'social-sciences',
  archaeology: 'social-sciences',
  linguistics: 'social-sciences',
  'political-science': 'social-sciences',
  environment: 'environment',
  'ecology & environment': 'environment',
  ecology: 'environment',
  climate: 'environment',
  geology: 'environment',
  earth: 'environment',
  conservation: 'environment',
  sustainability: 'environment',
  'business-economics': 'business-economics',
  business_economics: 'business-economics',
  'business & economics': 'business-economics',
  business: 'business-economics',
  economics: 'business-economics',
  finance: 'business-economics',
  management: 'business-economics',
  marketing: 'business-economics',
  trade: 'business-economics',
  'arts-humanities': 'arts-humanities',
  arts_humanities: 'arts-humanities',
  'arts & humanities': 'arts-humanities',
  arts: 'arts-humanities',
  humanities: 'arts-humanities',
  literature: 'arts-humanities',
  philosophy: 'arts-humanities',
  art: 'arts-humanities',
  music: 'arts-humanities',
  architecture: 'arts-humanities',
  theatrical: 'arts-humanities',
};

const TOPIC_KEYWORD_RULES: Array<{ topic: AcademicTopic; pattern: RegExp }> = [
  {
    topic: 'campus-life',
    pattern:
      /\b(registrar|dormitory|dormitories|syllabus|syllabi|semester|undergraduate|advisor|counselor|tuition|scholarship|library|librarian|internship|coursework|enrollment|campus|faculty|commencement|capstone|prerequisite|lecture hall|office hours|student union)\b/i,
  },
  {
    topic: 'environment',
    pattern:
      /\b(ecosystem|biodiversity|deforestation|glacier|permafrost|climate|carbon dioxide|emission|acidification|coral|reef|wetland|estuary|pollution|drought|renewable|solar|hydrothermal|albedo|evapotranspiration|conservation|habitat|erosion|forestry|atmosphere)\b/i,
  },
  {
    topic: 'business-economics',
    pattern:
      /\b(inflation|monetary|central bank|tariff|supply chain|monopoly|elasticity|utility|commodity|marginal|macroeconomic|microeconomic|entrepreneur|subsidy|subsidies|fiscal|revenue|market|consumer|investment|portfolio|recession|currency|trade deficit|pricing)\b/i,
  },
  {
    topic: 'arts-humanities',
    pattern:
      /\b(renaissance|painting|sculpture|museum|curator|exhibition|symphony|acoustic|portrait|rhetoric|aristotelian|mythology|literary|poetry|avant-garde|surrealist|trompe|vanitas|fresco|architecture|classical|philosopher|aesthetic|manuscript)\b/i,
  },
  {
    topic: 'social-sciences',
    pattern:
      /\b(archaeology|archaeological|mayan|mesopotamian|cuneiform|anthropology|ethnographic|indigenous|sociology|cognitive bias|kahneman|framing effect|demographic|urbanization|civilization|linguistic|dialect|bilingual|voter|questionnaire)\b/i,
  },
  {
    topic: 'science-tech',
    pattern:
      /\b(neuron|synaptic|plasticity|dna|rna|histone|epigenetic|chloroplast|photosynthesis|quantum|algorithm|spectrophotometer|centrifuge|carbocation|peroxide|nucleosynthesis|supernova|seismometer|tectonic|cetacean|echolocation|avian|metabolism|enzyme)\b/i,
  },
];

const CTEST_STOPWORDS = new Set([
  'that',
  'with',
  'from',
  'this',
  'they',
  'have',
  'were',
  'been',
  'into',
  'only',
  'also',
  'more',
  'most',
  'some',
  'such',
  'than',
  'then',
  'them',
  'what',
  'when',
  'where',
  'which',
  'while',
  'your',
  'their',
  'there',
  'these',
  'those',
  'would',
  'could',
  'should',
  'about',
  'after',
  'other',
  'under',
  'until',
  'very',
  'well',
  'will',
  'each',
  'both',
  'much',
  'many',
  'over',
  'upon',
  'even',
  'does',
  'done',
  'made',
  'make',
  'like',
]);

const SENTENCE_ABBREVIATIONS = new Set([
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
  'st.',
  'jr.',
  'sr.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'fig.',
  'vol.',
  'no.',
]);

export interface NormalizedBlankItem {
  id?: string;
  index: number;
  word?: string;
  prefix: string;
  answer: string;
  fullWord: string;
}

export function canonicalizeTaskType(rawType?: string): TaskTypeId {
  const cleaned = String(rawType || '')
    .trim()
    .toLowerCase();
  if (TASK_TYPE_ALIASES[cleaned]) {
    return TASK_TYPE_ALIASES[cleaned];
  }
  if (CANONICAL_TASK_IDS.has(cleaned)) {
    return cleaned as TaskTypeId;
  }
  return 'academic-discussion';
}

export function normalizeDifficultyLabel(rawLevel?: any): Level {
  const cleaned = String(rawLevel || '')
    .trim()
    .toLowerCase();
  if (isValidLevel(cleaned)) {
    return cleaned;
  }
  if (DIFFICULTY_ALIASES[cleaned]) {
    return DIFFICULTY_ALIASES[cleaned];
  }
  if (cleaned.includes('upper')) return 'upper-intermediate';
  if (cleaned.includes('adv') || cleaned.includes('c1') || cleaned.includes('hard')) return 'advanced';
  if (cleaned.includes('beg') || cleaned.includes('easy') || cleaned.includes('a1') || cleaned.includes('a2')) {
    return 'beginner';
  }
  return 'intermediate';
}

export function normalizeTopicLabel(rawTopic?: any, fallbackContent?: any): AcademicTopic {
  const cleaned = String(rawTopic || '')
    .trim()
    .toLowerCase();
  if (isValidAcademicTopic(cleaned)) {
    return cleaned;
  }
  if (TOPIC_ALIASES[cleaned]) {
    return TOPIC_ALIASES[cleaned];
  }

  const textBlob = JSON.stringify(fallbackContent || '').toLowerCase();
  for (const rule of TOPIC_KEYWORD_RULES) {
    if (rule.pattern.test(textBlob)) {
      return rule.topic;
    }
  }

  return 'science-tech';
}

/**
 * Repairs corrupted bracket tokens where overlapping prefixes/suffixes collided
 * without stripping valid English double letters (like 'ss' in pressure or 'oo' in microorganisms)
 * or valid repeated syllables (like 'inin' in sustaining).
 */
function repairBracketToken(prefix: string, answer: string): string {
  const pLower = prefix.toLowerCase();
  const aLower = answer.toLowerCase();

  // Known collision pattern: "quant" + "umntum" -> "quantum"
  if (pLower.startsWith('qua') && (aLower.includes('ntum') || aLower === 'umntum')) {
    return prefix.slice(0, 3) + 'ntum';
  }

  // Known collision pattern: "biodegr" + "gradable" -> "biodegradable"
  if (pLower.startsWith('biodegr') && aLower.endsWith('adable')) {
    return 'biodegradable';
  }

  return prefix + answer;
}

/**
 * Heals words that may have been damaged by legacy seam stripping in cached IndexedDB/Firestore records.
 */
export function healCorruptedCTestWords(input: string): string {
  return input
    .replace(/\bbiodegr\[+gradable\]+/gi, 'biodeg[radable]')
    .replace(/\bquant\[+umntum\]+/gi, 'qua[ntum]')
    .replace(/\bmicror\[+ganisms\]+/gi, 'microor[ganisms]')
    .replace(/\bmicro\[+organisms\]+/gi, 'microor[ganisms]')
    .replace(/\bmicrorganisms\b/gi, 'microorganisms')
    .replace(/\bself-sustaing\b/gi, 'self-su[staining]')
    .replace(/\bself-su\[+staing\]+/gi, 'self-su[staining]')
    .replace(/\bpre\[+sure\]+/gi, 'pre[ssure]')
    .replace(/\bhydrostatic\s+pres\[+sure\]+/gi, 'hydrostatic pre[ssure]')
    .replace(/\bpresure\b/gi, 'pressure')
    .replace(/\benerg\b/gi, 'energy')
    .replace(/\bdurin\b/gi, 'during')
    .replace(/\bdaays\b/gi, 'days')
    .replace(/\badvancments\b/gi, 'advancements')
    .replace(/\badvancment\b/gi, 'advancement')
    .replace(/\benviroment\b/gi, 'environment')
    .replace(/\benviromental\b/gi, 'environmental')
    .replace(/\bdevelopement\b/gi, 'development')
    .replace(/\bsustaing\b/gi, 'sustaining')
    .replace(/\bmaintaing\b/gi, 'maintaining')
    .replace(/\bremaing\b/gi, 'remaining')
    .replace(/\bcontaing\b/gi, 'containing')
    .replace(/\bobtaing\b/gi, 'obtaining')
    .replace(/\bexplaing\b/gi, 'explaining')
    .replace(/\bcomunities\b/gi, 'communities')
    .replace(/\bcomunity\b/gi, 'community')
    .replace(/\bsuport\b/gi, 'support')
    .replace(/\bcurent\b/gi, 'current')
    .replace(/\bpasage\b/gi, 'passage')
    .replace(/\bpatern\b/gi, 'pattern')
    .replace(/\bmilion\b/gi, 'million')
    .replace(/\bchanel\b/gi, 'channel')
    .replace(/\bcorect\b/gi, 'correct')
    .replace(/\bsugest\b/gi, 'suggest')
    .replace(/\bacount\b/gi, 'account')
    .replace(/\bcomand\b/gi, 'command')
    .replace(/\bcoment\b/gi, 'comment')
    .replace(/\bconect\b/gi, 'connect')
    .replace(/\bcolect\b/gi, 'collect')
    .replace(/\bcolege\b/gi, 'college')
    .replace(/\btrafic\b/gi, 'traffic')
    .replace(/\bfosil\b/gi, 'fossil')
    .replace(/\bmasive\b/gi, 'massive')
    .replace(/\bpasive\b/gi, 'passive')
    .replace(/\bsesion\b/gi, 'session')
    .replace(/\bmision\b/gi, 'mission')
    .replace(/\btisue\b/gi, 'tissue')
    .replace(/\bpolution\b/gi, 'pollution')
    .replace(/\bcolusion\b/gi, 'collusion')
    .replace(/\bsurounding\b/gi, 'surrounding')
    .replace(/\bacces\b/gi, 'access')
    .replace(/\bprocesing\b/gi, 'processing')
    .replace(/\bnecesary\b/gi, 'necessary')
    .replace(/\bposible\b/gi, 'possible')
    .replace(/\bprofesor\b/gi, 'professor')
    .replace(/\bquanties\b/gi, 'quantities')
    .replace(/\bsupercondcut\b/gi, 'superconducting')
    .replace(/\bsuperconduct\b/gi, 'superconducting')
    .replace(/([a-zA-Z])\1{2,}/g, '$1$1');
}

/**
 * Extracts the ordered NormalizedBlankItem[] directly from `prefix[answer]` tokens in bracketed text.
 */
export function extractBlanksFromBracketedText(text: string): NormalizedBlankItem[] {
  const blanks: NormalizedBlankItem[] = [];
  const regex = /([a-zA-Z'\u2019-]*)\[+([^\]]+)\]+/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1] || '';
    const answer = match[2] || '';
    if (!prefix || !answer) continue;
    const fullWord = `${prefix}${answer}`;
    blanks.push({
      id: `blank-${idx + 1}`,
      index: idx,
      word: fullWord,
      prefix,
      answer,
      fullWord,
    });
    idx++;
  }
  return blanks;
}

/**
 * Synchronizes bracketed `text` and `blanks` array so they never disagree.
 * - When `preferBlanks` is true (e.g. user edited `blanks` in JSON), updates `prefix[answer]` tokens in `text`
 *   to match `blanks[i].prefix` and `blanks[i].answer` (automatically adjusting prefix if only answer was changed on the same word, or vice versa).
 * - Otherwise, recomputes `blanks` directly from the `prefix[answer]` tokens in `text`.
 */
export function syncBracketedTextWithBlanks(
  rawTextInput: string,
  rawBlanks?: any[],
  preferBlanks: boolean = false
): { text: string; blanks: NormalizedBlankItem[] } {
  let text = healCorruptedCTestWords(String(rawTextInput || '').trim());

  if (preferBlanks && Array.isArray(rawBlanks) && rawBlanks.length > 0) {
    let matchIdx = 0;
    text = text.replace(/([a-zA-Z'\u2019-]*)\[+([^\]]+)\]+/g, (fullMatch, oldPrefix, oldAnswer) => {
      const b = rawBlanks[matchIdx++];
      if (!b || typeof b !== 'object') return fullMatch;
      const oldFull = `${oldPrefix}${oldAnswer}`;
      let nextPrefix = typeof b.prefix === 'string' ? b.prefix : oldPrefix;
      let nextAnswer =
        typeof b.answer === 'string'
          ? b.answer
          : typeof b.solution === 'string'
          ? b.solution
          : oldAnswer;

      // If user edited only `answer` (e.g. changed "sure" -> "ssure" on "pressure"), adjust `prefix` automatically
      if (
        nextAnswer !== oldAnswer &&
        nextPrefix === oldPrefix &&
        oldFull.toLowerCase().endsWith(nextAnswer.toLowerCase()) &&
        nextAnswer.length < oldFull.length
      ) {
        nextPrefix = oldFull.slice(0, oldFull.length - nextAnswer.length);
      } else if (
        nextPrefix !== oldPrefix &&
        nextAnswer === oldAnswer &&
        oldFull.toLowerCase().startsWith(nextPrefix.toLowerCase()) &&
        nextPrefix.length < oldFull.length
      ) {
        nextAnswer = oldFull.slice(nextPrefix.length);
      }

      if (nextPrefix.length >= 1 && nextAnswer.length >= 1) {
        return `${nextPrefix}[${nextAnswer}]`;
      }
      return fullMatch;
    });
  }

  const blanks = extractBlanksFromBracketedText(text);
  return { text, blanks };
}

/**
 * Deterministically normalizes any "Complete the Words" (C-Test) task according to
 * official ETS 2026 TOEFL iBT C-Test specifications:
 * - Preserves manual Developer Question Editor edits verbatim when `raw?.isManualDevEdit === true`.
 * - For all AI-generated and static passages (`raw?.isManualDevEdit !== true`), strips any brackets,
 *   heals typos, keeps Sentence 1 intact, and blanks strictly every 2nd eligible word in Sentence 2+
 *   (NEVER blanking two consecutive words in a row!) for `targetBlankCount` words (`10` in Exam Mode, `25` in Coach Mode).
 */
export function normalizeCompleteWordsTask(raw: any): {
  title: string;
  text: string;
  passage: string;
  totalBlanks: number;
  blanks: NormalizedBlankItem[];
  explanation?: string;
  isManualDevEdit?: boolean;
} {
  const fallbackText =
    'Synaptic plasticity is the biological foundation of human learning and memory retention. Neuroscientists have discovered that synapses gradually strengthen through repeated electrical stimulation. This phenomenon directly enables cortical neurons to store vast quantities of complex information across cerebral circuits. As neural pathways consolidate during deep restorative sleep, newly acquired declarative knowledge transitions from temporary hippocampal storage into permanent neocortical networks. Consequently, sustained cognitive engagement and adequate rest remain essential for long-term intellectual development.';

  const fallbackContinuation =
    'Furthermore, longitudinal empirical investigations confirm that these interconnected mechanisms operate consistently across diverse environmental conditions. Consequently, contemporary researchers continue to refine analytical models to account for subtle structural variations.';

  const title = String(raw?.title || 'Complete the Words').trim() || 'Complete the Words';
  let rawText = String(raw?.passage || raw?.text || raw?.content?.passage || raw?.content?.text || '').trim();
  if (!rawText || rawText.length < 40) {
    rawText = fallbackText;
  }

  const isCoach = Boolean(
    raw?.coachMode ||
      raw?.mode === 'coach' ||
      Number(raw?.totalBlanks) > 12 ||
      (rawText.match(/\[+[^\]]+\]+/g) || []).length > 12
  );
  const targetBlankCount = isCoach ? 25 : 10;

  // Step 0: Only preserve existing brackets verbatim when `raw?.isManualDevEdit === true` (from Developer Question Editor)
  if (raw?.isManualDevEdit === true) {
    const synced = syncBracketedTextWithBlanks(
      rawText,
      raw?.blanks,
      Boolean(raw?._preferBlanks)
    );
    if (synced.blanks.length > 0) {
      const cleanText = synced.text.replace(/\s+/g, ' ').trim();
      const finalBlanks = extractBlanksFromBracketedText(cleanText);
      return {
        title,
        text: cleanText,
        passage: cleanText,
        totalBlanks: finalBlanks.length,
        blanks: finalBlanks,
        isManualDevEdit: true,
        ...(raw?.explanation ? { explanation: String(raw.explanation) } : {}),
      };
    }
  }

  // Curated morphological splits for specific words
  const customSplitsByWord = new Map<string, { prefix: string; answer: string }>([
    ['pressure', { prefix: 'pre', answer: 'ssure' }],
    ['microorganisms', { prefix: 'microor', answer: 'ganisms' }],
    ['self-sustaining', { prefix: 'self-su', answer: 'staining' }],
  ]);

  // Step 1: Repair any corrupted bracket tokens and strip ALL brackets/underscores to produce clean plain English
  rawText = rawText.replace(/([a-zA-Z'\u2019-]+)\[+([a-zA-Z'\u2019-]+)\]+/g, (_, p, a) =>
    repairBracketToken(p, a)
  );
  rawText = rawText.replace(/\[+([a-zA-Z'\u2019-]+)\]+([a-zA-Z'\u2019-]+)/g, '$1$2');
  rawText = rawText.replace(/\[+([^\]]+)\]+/g, '$1');
  rawText = rawText.replace(/[\[\]_]+/g, '');

  const cleanParagraph = healCorruptedCTestWords(rawText.replace(/\s+/g, ' ').trim());

  // Step 2: Keep Sentence 1 100% intact (up to first terminal punctuation followed by space)
  let s1EndIdx = -1;
  const termRegex = /([.!?])\s+/g;
  let termMatch: RegExpExecArray | null;
  while ((termMatch = termRegex.exec(cleanParagraph)) !== null) {
    const before = cleanParagraph.slice(0, termMatch.index + 1);
    const lastWord = (before.match(/[a-zA-Z0-9.'’]+$/) || [''])[0].toLowerCase();
    if (!SENTENCE_ABBREVIATIONS.has(lastWord)) {
      s1EndIdx = termMatch.index + 1;
      break;
    }
  }

  let sentence1 = '';
  let sentenceRest = '';
  if (s1EndIdx !== -1) {
    sentence1 = cleanParagraph.slice(0, s1EndIdx).trim();
    sentenceRest = cleanParagraph.slice(s1EndIdx).trim();
  } else {
    const words = cleanParagraph.split(/\s+/);
    const splitAt = Math.min(12, Math.floor(words.length / 3));
    sentence1 = words.slice(0, splitAt).join(' ') + '.';
    sentenceRest = words.slice(splitAt).join(' ');
  }

  // Ensure sentenceRest has enough words so that strictly alternating every-2nd-word selection
  // reaches targetBlankCount without ever blanking two consecutive words in a row
  const minRestWordsNeeded = targetBlankCount * 2 + 8;
  if (sentenceRest.split(/\s+/).filter(Boolean).length < minRestWordsNeeded) {
    sentenceRest = `${sentenceRest} ${fallbackContinuation} ${fallbackText}`.trim();
  }

  // Step 3: Tokenize sentenceRest and analyze eligible words (including hyphenated compounds like self-sustaining)
  const tokens = sentenceRest.split(/(\s+)/);

  interface WordTokenInfo {
    tokenIndex: number;
    lead: string;
    word: string;
    trail: string;
    isEligible: boolean;
  }

  const wordInfos: WordTokenInfo[] = [];
  let isAtSentenceStart = true;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok) || tok === '') continue;

    const m = tok.match(/^([^a-zA-Z]*)([a-zA-Z]+(?:-[a-zA-Z]+)?)([^a-zA-Z]*)$/);
    if (!m) continue;

    const [, lead, word, trail] = m;
    const isAlphaOrHyphen = /^[a-zA-Z]+(?:-[a-zA-Z]+)?$/.test(word);
    const isAcronym = word.length >= 2 && word === word.toUpperCase();
    const isCapitalized = /^[A-Z]/.test(word);
    const isProperNounMidSentence = isCapitalized && !isAtSentenceStart;
    const isEligible = isAlphaOrHyphen && word.length >= 2 && !isAcronym && !isProperNounMidSentence;

    wordInfos.push({
      tokenIndex: i,
      lead,
      word,
      trail,
      isEligible,
    });

    if (/[.!?]/.test(trail)) {
      const lower = (word + trail).toLowerCase();
      if (!SENTENCE_ABBREVIATIONS.has(lower)) {
        isAtSentenceStart = true;
      }
    } else {
      isAtSentenceStart = false;
    }
  }

  // Step 4: Deterministically select strictly every 2nd eligible word (skip 1, blank 1, skip 1, blank 1...)
  // NEVER blanking two consecutive words in a row!
  const selectedTokenIndices = new Set<number>();
  let eligibleCount = 0;

  for (const wi of wordInfos) {
    if (!wi.isEligible) continue;
    eligibleCount++;
    if (eligibleCount % 2 === 0 && selectedTokenIndices.size < targetBlankCount) {
      selectedTokenIndices.add(wi.tokenIndex);
    }
  }

  // Step 5: Rebuild sentenceRest with bracketed blanks and populate blanks array
  const blanks: NormalizedBlankItem[] = [];
  let blankCounter = 0;

  const rebuiltTokens = tokens.map((tok, i) => {
    if (!selectedTokenIndices.has(i)) {
      return tok;
    }

    const wi = wordInfos.find((w) => w.tokenIndex === i);
    if (!wi) return tok;

    const fullWord = wi.word;
    const custom = customSplitsByWord.get(fullWord.toLowerCase());
    let prefix = '';
    let answer = '';
    if (
      custom &&
      custom.prefix.length >= 1 &&
      custom.answer.length >= 1 &&
      custom.prefix.length + custom.answer.length === fullWord.length
    ) {
      prefix = fullWord.slice(0, custom.prefix.length);
      answer = fullWord.slice(custom.prefix.length);
    } else {
      const prefixLen = Math.floor(fullWord.length / 2);
      prefix = fullWord.slice(0, prefixLen);
      answer = fullWord.slice(prefixLen);
    }

    blanks.push({
      id: `blank-${blankCounter + 1}`,
      index: blankCounter,
      word: fullWord,
      prefix,
      answer,
      fullWord,
    });
    blankCounter++;

    return `${wi.lead}${prefix}[${answer}]${wi.trail}`;
  });

  // Step 6: Keep 1–2 concluding sentences after the final blank so the passage is ~75–90 words total in Exam Mode
  const targetCutoffBlank = blanks.length;
  if (targetCutoffBlank > 0) {
    let tokenLastIdx = -1;
    let bCount = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (selectedTokenIndices.has(i)) {
        bCount++;
        if (bCount === targetCutoffBlank) {
          tokenLastIdx = i;
          break;
        }
      }
    }

    if (tokenLastIdx !== -1) {
      let sentenceEndIdx = tokenLastIdx;
      while (sentenceEndIdx < tokens.length) {
        const tok = tokens[sentenceEndIdx];
        if (/[.!?]/.test(tok)) {
          const cleanTok = tok.replace(/[^a-zA-Z0-9.'’]/g, '').toLowerCase();
          if (!SENTENCE_ABBREVIATIONS.has(cleanTok)) {
            break;
          }
        }
        sentenceEndIdx++;
      }

      let maxKeptIdx = sentenceEndIdx;
      let concludingSentencesFound = 0;
      let nextSentenceEndIdx = sentenceEndIdx + 1;
      while (nextSentenceEndIdx < tokens.length) {
        const tok = tokens[nextSentenceEndIdx];
        if (/[.!?]/.test(tok)) {
          const cleanTok = tok.replace(/[^a-zA-Z0-9.'’]/g, '').toLowerCase();
          if (!SENTENCE_ABBREVIATIONS.has(cleanTok)) {
            maxKeptIdx = nextSentenceEndIdx;
            concludingSentencesFound++;
            if (concludingSentencesFound >= 2) {
              break;
            }
          }
        }
        nextSentenceEndIdx++;
      }

      rebuiltTokens.splice(maxKeptIdx + 1);
    }
  }

  const normalizedText = `${sentence1} ${rebuiltTokens.join('')}`.replace(/\s+/g, ' ').trim();

  return {
    title,
    text: normalizedText,
    passage: normalizedText,
    totalBlanks: blanks.length,
    blanks,
    ...(raw?.explanation ? { explanation: String(raw.explanation) } : {}),
  };
}

function tokenizeSentenceWords(sentence: string): string[] {
  return (sentence || '')
    .trim()
    .replace(/[.!?;:,]+$/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/^[,;:.!?()"']+|[.!?;:,()"']+$/g, ''))
    .filter(Boolean);
}

function haveSameWordMultiset(wordsA: string[], wordsB: string[]): boolean {
  if (wordsA.length !== wordsB.length || wordsA.length === 0) return false;
  const countMap = new Map<string, number>();
  for (const w of wordsA) {
    const key = w.toLowerCase();
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }
  for (const w of wordsB) {
    const key = w.toLowerCase();
    const prev = countMap.get(key) || 0;
    if (prev <= 0) return false;
    if (prev === 1) countMap.delete(key);
    else countMap.set(key, prev - 1);
  }
  return countMap.size === 0;
}

function deterministicScrambleWords(targetWords: string[], seedStr: string): string[] {
  if (targetWords.length <= 1) return [...targetWords];
  const arr = [...targetWords];
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  // Ensure scrambled order is never identical to original sentence order
  const isIdentical = arr.every((w, idx) => w === targetWords[idx]);
  if (isIdentical && arr.length >= 2) {
    const first = arr[0];
    arr[0] = arr[arr.length - 1];
    arr[arr.length - 1] = first;
    if (arr.every((w, idx) => w === targetWords[idx]) && arr.length >= 3) {
      const mid = arr[1];
      arr[1] = arr[0];
      arr[0] = mid;
    }
  }
  return arr;
}

function sanitizeBuildSentenceContext(rawContext: string, answerSentence: string, index: number): string {
  const fallbackPrompts = [
    'What did the faculty committee conclude after reviewing the departmental curriculum report?',
    'How do researchers explain the unexpected outcome observed during the laboratory trial?',
    'Why did the university administration revise the campus sustainability guidelines this semester?',
    'What factor primarily influences student participation in interdisciplinary research seminars?',
    'How does the new municipal policy affect public transit ridership during peak hours?',
  ];
  const cleanCtx = (rawContext || '').trim();
  const cleanAns = (answerSentence || '').trim();
  if (!cleanCtx || cleanCtx.length < 12) {
    return fallbackPrompts[index % fallbackPrompts.length];
  }
  const normCtx = cleanCtx.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normAns = cleanAns.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (!normAns) return cleanCtx;

  // Reject context if it contains or equals the answer sentence
  if (normCtx === normAns || normCtx.includes(normAns) || normAns.includes(normCtx)) {
    return fallbackPrompts[index % fallbackPrompts.length];
  }

  // Also check word overlap ratio: if >= 70% of the answer content words appear in sequence in context, replace it
  const ansWords = tokenizeSentenceWords(cleanAns).map((w) => w.toLowerCase());
  const ctxWords = new Set(tokenizeSentenceWords(cleanCtx).map((w) => w.toLowerCase()));
  const contentAnsWords = ansWords.filter((w) => w.length > 3);
  if (contentAnsWords.length >= 4) {
    const overlap = contentAnsWords.filter((w) => ctxWords.has(w)).length;
    if (overlap / contentAnsWords.length >= 0.75) {
      return fallbackPrompts[index % fallbackPrompts.length];
    }
  }

  return cleanCtx;
}

export function normalizeTileChunk(rawChunk: string): string {
  const stripped = String(rawChunk || '')
    .trim()
    .replace(/^[,;:.!?()"']+|[.!?;:,()"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped
    .split(' ')
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === 'i') return 'I';
      if (lower === "i'm" || lower === 'i’m') return "I'm";
      if (lower === "i've" || lower === 'i’ve') return "I've";
      if (lower === "i'd" || lower === 'i’d') return "I'd";
      if (lower === "i'll" || lower === 'i’ll') return "I'll";
      return lower;
    })
    .join(' ');
}

const SINGLE_STRUCTURAL_WORDS = new Set([
  'who', 'whom', 'whose', 'which', 'that', 'where', 'when', 'why', 'how',
  'whether', 'if', 'unless', 'although', 'though', 'because', 'since', 'while',
  'was', 'were', 'is', 'are', 'has', 'have', 'had', 'did', 'do', 'does',
  'can', 'could', 'will', 'would', 'should', 'must', 'may', 'might',
  'the', 'a', 'an', 'to', 'by', 'in', 'on', 'at', 'for', 'from', 'with', 'without',
  'not', 'never', 'rarely', 'seldom', 'only', 'than', 'as', 'been', 'being',
]);

const GRAMMATICAL_DISTRACTOR_MAP: Record<string, string> = {
  were: 'was',
  was: 'were',
  has: 'have',
  have: 'has',
  'has been': 'have been',
  'have been': 'has been',
  "wasn't": "weren't",
  "weren't": "wasn't",
  who: 'which',
  which: 'who',
  whether: 'what',
  is: 'are',
  are: 'is',
  did: 'do',
  does: 'do',
  unless: 'despite',
};

function enforceSingleWordDominantChunks(rawChunks: string[]): string[] {
  // First normalize each chunk and split any phrase > 2 words so phrase chunks are at most 2 words
  let chunks: string[] = [];
  for (const raw of rawChunks) {
    const clean = normalizeTileChunk(raw);
    if (!clean) continue;
    const parts = clean.split(' ').filter(Boolean);
    if (parts.length > 2) {
      chunks.push(...parts.slice(0, parts.length - 2), parts.slice(-2).join(' '));
    } else {
      chunks.push(clean);
    }
  }

  // Official ETS Tile Balance Rule:
  // 4-5+ single words and at most 1 (or 2 for long sentences) short 2-word phrase
  let safety = 0;
  while (safety < 20) {
    safety++;
    const multiIndices: number[] = [];
    let singleCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].includes(' ')) {
        multiIndices.push(i);
      } else {
        singleCount++;
      }
    }

    const maxAllowedMulti = chunks.length >= 6 ? 1 : 1;
    if (multiIndices.length <= maxAllowedMulti && (singleCount >= 4 || multiIndices.length === 0)) {
      break;
    }

    // Choose a multi-word chunk to split, prioritizing chunks that contain structural/function words
    let splitIdx = multiIndices[0];
    for (const idx of multiIndices) {
      const words = chunks[idx].split(' ');
      if (words.some((w) => SINGLE_STRUCTURAL_WORDS.has(w))) {
        splitIdx = idx;
        break;
      }
    }

    const wordsToSplit = chunks[splitIdx].split(' ');
    chunks.splice(splitIdx, 1, ...wordsToSplit);
  }

  return chunks;
}

/**
 * Splits the middle portion of `targetSentence` into 5 to 6 chunks consisting of
 * 4–5 single words and at most 1 short 2-word phrase (or additional merges only if > 7 words),
 * all lowercased (except standalone "I").
 */
function groupWordsIntoTargetChunks(words: string[], targetSlotCount: number = 6): string[] {
  const cleanWords = words
    .flatMap((w) => normalizeTileChunk(w).split(' '))
    .filter(Boolean);
  if (cleanWords.length === 0) return [];
  if (cleanWords.length <= 5) {
    return cleanWords;
  }

  const chunks: string[] = [...cleanWords];
  let safety = 0;

  // Merge adjacent pairs until chunks.length <= targetSlotCount (preferring 1 short 2-word phrase and 4-5 single words)
  while (chunks.length > targetSlotCount && safety < 20) {
    safety++;
    const currentMultiCount = chunks.filter((c) => c.includes(' ')).length;
    if (currentMultiCount >= 1 && chunks.length <= 6) break;
    if (currentMultiCount >= 2) break;

    let merged = false;
    // Prefer merging two adjacent non-structural content words into a 2-word phrase
    for (let i = chunks.length - 2; i >= 0; i--) {
      const a = chunks[i];
      const b = chunks[i + 1];
      if (!a.includes(' ') && !b.includes(' ') && !SINGLE_STRUCTURAL_WORDS.has(a) && !SINGLE_STRUCTURAL_WORDS.has(b)) {
        chunks.splice(i, 2, `${a} ${b}`);
        merged = true;
        break;
      }
    }
    // Or merge article/preposition + noun ("the city", "at night", "to study")
    if (!merged) {
      for (let i = chunks.length - 2; i >= 0; i--) {
        const a = chunks[i];
        const b = chunks[i + 1];
        if (
          !a.includes(' ') &&
          !b.includes(' ') &&
          (a === 'the' || a === 'a' || a === 'an' || a === 'to' || a === 'in' || a === 'on' || a === 'at') &&
          !SINGLE_STRUCTURAL_WORDS.has(b)
        ) {
          chunks.splice(i, 2, `${a} ${b}`);
          merged = true;
          break;
        }
      }
    }
    // Fallback: merge the last two single-word tiles if still > targetSlotCount
    if (!merged && chunks.length > 6) {
      for (let i = chunks.length - 2; i >= 0; i--) {
        if (!chunks[i].includes(' ') && !chunks[i + 1].includes(' ')) {
          chunks.splice(i, 2, `${chunks[i]} ${chunks[i + 1]}`);
          merged = true;
          break;
        }
      }
    }
    if (!merged) break;
  }

  return chunks;
}

/**
 * Verifies whether existing `framePrefix`, `targetChunks`, and `frameSuffix`
 * reconstruct `cleanAnswer` 100% accurately with lowercase tiles (except "I").
 */
function doesChunksReconstructSentence(
  framePrefix: string,
  targetChunks: string[],
  frameSuffix: string,
  cleanAnswer: string
): boolean {
  if (!Array.isArray(targetChunks) || targetChunks.length < 4 || targetChunks.length > 8) {
    return false;
  }
  const prefixWords = tokenizeSentenceWords(framePrefix);
  const chunkWords = targetChunks.flatMap((c) => tokenizeSentenceWords(c));
  const suffixWords = tokenizeSentenceWords(frameSuffix);
  const reconstructed = [...prefixWords, ...chunkWords, ...suffixWords].map((w) => w.toLowerCase());
  const expected = tokenizeSentenceWords(cleanAnswer).map((w) => w.toLowerCase());

  if (reconstructed.length !== expected.length || expected.length === 0) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (reconstructed[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function deriveFrameAndChunksFromSentence(
  cleanAnswer: string,
  idx: number,
  rawDistractorWord?: string,
  rawDistractorChunks?: any[]
): {
  framePrefix: string;
  frameSuffix: string;
  targetChunks: string[];
  distractorChunks: string[];
} {
  const terminalPunctMatch = cleanAnswer.match(/([.!?]+)$/);
  const punct = terminalPunctMatch ? terminalPunctMatch[1][0] : '.';
  const rawTokens = cleanAnswer
    .replace(/[.!?]+$/, '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[,;:.!?()"']+|[.!?;:,()"']+$/g, ''))
    .filter(Boolean);

  // Rotate deterministically across the 4 official ETS frame styles (index % 4):
  // 0 = both framePrefix (first 1-2 words) and frameSuffix (last 1-2 words + punctuation)
  // 1 = framePrefix only (first 1-2 words) + ending punctuation in frameSuffix
  // 2 = frameSuffix only (last 2 words + punctuation)
  // 3 = no fixed words, only ending punctuation (. or ?) in frameSuffix
  const styleIdx = idx % 4;
  let framePrefix = '';
  let frameSuffix = punct;
  let middleTokens = [...rawTokens];

  if (rawTokens.length >= 7) {
    if (styleIdx === 0) {
      const pCount = rawTokens.length >= 10 ? 2 : 1;
      const sCount = rawTokens.length >= 9 ? 2 : 1;
      framePrefix = rawTokens.slice(0, pCount).join(' ');
      frameSuffix = `${rawTokens.slice(-sCount).join(' ')}${punct}`;
      middleTokens = rawTokens.slice(pCount, rawTokens.length - sCount);
    } else if (styleIdx === 1) {
      const pCount = rawTokens.length >= 9 ? 2 : 1;
      framePrefix = rawTokens.slice(0, pCount).join(' ');
      frameSuffix = punct;
      middleTokens = rawTokens.slice(pCount);
    } else if (styleIdx === 2) {
      const sCount = rawTokens.length >= 8 ? 2 : 1;
      framePrefix = '';
      frameSuffix = `${rawTokens.slice(-sCount).join(' ')}${punct}`;
      middleTokens = rawTokens.slice(0, rawTokens.length - sCount);
    } else {
      framePrefix = '';
      frameSuffix = punct;
      middleTokens = [...rawTokens];
    }
  }

  const targetChunks = groupWordsIntoTargetChunks(middleTokens, 6);
  const distractorChunks: string[] = [];

  if (typeof rawDistractorWord === 'string' && rawDistractorWord.trim()) {
    const cleanDist = normalizeTileChunk(rawDistractorWord);
    if (cleanDist && !targetChunks.includes(cleanDist)) {
      distractorChunks.push(cleanDist);
    }
  }

  if (distractorChunks.length === 0 && Array.isArray(rawDistractorChunks)) {
    for (const rawD of rawDistractorChunks) {
      const cleanDist = normalizeTileChunk(String(rawD || ''));
      if (cleanDist && !targetChunks.includes(cleanDist)) {
        distractorChunks.push(cleanDist);
        break;
      }
    }
  }

  if (distractorChunks.length === 0) {
    for (const chunk of targetChunks) {
      const dist = GRAMMATICAL_DISTRACTOR_MAP[chunk];
      if (dist && !targetChunks.includes(dist)) {
        distractorChunks.push(dist);
        break;
      }
    }
  }

  return {
    framePrefix,
    frameSuffix,
    targetChunks,
    distractorChunks,
  };
}

const FALLBACK_BUILD_SENTENCE_ITEMS = [
  {
    context: 'What did you think of the guided tour of the historical district?',
    framePrefix: 'The',
    frameSuffix: 'fantastic.',
    targetChunks: ['tour guides', 'who', 'showed', 'us', 'around', 'were'],
    distractorChunks: ['was'],
    answer: 'The tour guides who showed us around were fantastic.',
    explanation:
      'Subject relative clause ("who showed us around") modifying plural "tour guides", requiring the plural verb "were" rather than "was".',
  },
  {
    context: 'I tried studying in the science library last night, but the doors were locked at eight.',
    framePrefix: '',
    frameSuffix: 'on weeknights?',
    targetChunks: ['how', 'long', 'has', 'the', 'science library', 'closed'],
    distractorChunks: ['have'],
    answer: 'How long has the science library closed on weeknights?',
    explanation:
      'Direct wh-interrogative in present perfect: "How + long + has + singular subject (the science library) + past participle + modifiers?".',
  },
  {
    context: "Has the department chair approved the budget for next month's robotics symposium?",
    framePrefix: "I'm not sure",
    frameSuffix: 'by the committee.',
    targetChunks: ['whether', 'the', 'revised budget', 'has', 'been', 'approved'],
    distractorChunks: ['have'],
    answer: "I'm not sure whether the revised budget has been approved by the committee.",
    explanation:
      'Embedded indirect question: "whether" is followed by statement word order ("the revised budget has been approved") without auxiliary inversion.',
  },
  {
    context: 'Where are the guest lecturers staying during the environmental policy conference?',
    framePrefix: '',
    frameSuffix: 'near the gate?',
    targetChunks: ["aren't", 'most', 'of', 'the', 'visiting speakers', 'staying'],
    distractorChunks: ["isn't"],
    answer: "Aren't most of the visiting speakers staying near the gate?",
    explanation:
      'Negative interrogative question: plural subject "most of the visiting speakers" agrees with the plural auxiliary "aren\'t" rather than "isn\'t".',
  },
  {
    context: 'Can undergraduate students borrow these high-resolution cameras for weekend projects?',
    framePrefix: '',
    frameSuffix: 'written permission.',
    targetChunks: ['the', 'cameras', 'cannot', 'be', 'borrowed', 'without'],
    distractorChunks: ['unless'],
    answer: 'The cameras cannot be borrowed without written permission.',
    explanation:
      'Passive modal construction ("cannot be borrowed") followed by a prepositional phrase ("without written permission").',
  },
];

export interface NormalizedBuildSentenceItem {
  id?: string;
  context: string;
  framePrefix: string;
  frameSuffix: string;
  targetChunks: string[];
  distractorChunks: string[];
  distractorWord?: string;
  words: string[];
  scrambledWords: string[];
  targetSentence: string;
  answer: string;
  correctSentence: string;
  grammarRule: string;
  explanation: string;
}

export function normalizeBuildSentenceItem(
  it: any,
  idx: number = 0,
  _topic?: string,
  _title?: string
): NormalizedBuildSentenceItem {
  const fb = FALLBACK_BUILD_SENTENCE_ITEMS[idx % FALLBACK_BUILD_SENTENCE_ITEMS.length];
  const rawAns = String(
    it?.targetSentence || it?.answer || it?.correctSentence || it?.sentence || fb.answer
  ).trim();
  const cleanAnswer = /[.!?]$/.test(rawAns) ? rawAns : `${rawAns}.`;
  const terminalPunct = cleanAnswer.endsWith('?') ? '?' : '.';

  let framePrefix = typeof it?.framePrefix === 'string' ? it.framePrefix.trim() : '';
  let frameSuffix = typeof it?.frameSuffix === 'string' ? it.frameSuffix.trim() : '';
  if (!frameSuffix) {
    frameSuffix = terminalPunct;
  } else if (!/[.!?]$/.test(frameSuffix)) {
    frameSuffix = `${frameSuffix}${terminalPunct}`;
  }

  const rawTargetChunks = Array.isArray(it?.targetChunks)
    ? it.targetChunks.map((c: any) => normalizeTileChunk(c)).filter(Boolean)
    : [];

  let targetChunks: string[] = [];
  let distractorChunks: string[] = [];

  // Deterministically construct framePrefix, targetChunks, frameSuffix, and words in TypeScript
  // directly from targetSentence whenever targetChunks is missing or doesn't reconstruct targetSentence 100%
  if (
    rawTargetChunks.length >= 4 &&
    doesChunksReconstructSentence(framePrefix, rawTargetChunks, frameSuffix, cleanAnswer)
  ) {
    targetChunks = enforceSingleWordDominantChunks(rawTargetChunks);
    if (!doesChunksReconstructSentence(framePrefix, targetChunks, frameSuffix, cleanAnswer)) {
      const derived = deriveFrameAndChunksFromSentence(
        cleanAnswer,
        idx,
        it?.distractorWord,
        it?.distractorChunks
      );
      framePrefix = derived.framePrefix;
      frameSuffix = derived.frameSuffix;
      targetChunks = derived.targetChunks;
      distractorChunks = derived.distractorChunks;
    } else {
      if (typeof it?.distractorWord === 'string' && it.distractorWord.trim()) {
        const cleanDist = normalizeTileChunk(it.distractorWord);
        if (cleanDist && !targetChunks.includes(cleanDist)) {
          distractorChunks = [cleanDist];
        }
      }
      if (distractorChunks.length === 0 && Array.isArray(it?.distractorChunks)) {
        distractorChunks = it.distractorChunks
          .map((c: any) => normalizeTileChunk(c))
          .filter((c: string) => Boolean(c) && !targetChunks.includes(c));
      }
    }
  } else {
    const derived = deriveFrameAndChunksFromSentence(
      cleanAnswer,
      idx,
      it?.distractorWord,
      it?.distractorChunks
    );
    framePrefix = derived.framePrefix;
    frameSuffix = derived.frameSuffix;
    targetChunks = derived.targetChunks;
    distractorChunks = derived.distractorChunks;
  }

  if (distractorChunks.length === 0 && Array.isArray(it?.words)) {
    const normalizedBankWords = it.words.map((w: any) => normalizeTileChunk(w)).filter(Boolean);
    if (
      normalizedBankWords.length === targetChunks.length + 1 &&
      targetChunks.every((tc) => normalizedBankWords.includes(tc))
    ) {
      const targetMultiset = [...targetChunks];
      for (const bw of normalizedBankWords) {
        const foundIdx = targetMultiset.indexOf(bw);
        if (foundIdx !== -1) {
          targetMultiset.splice(foundIdx, 1);
        } else {
          distractorChunks.push(bw);
        }
      }
    }
  }

  const combinedPool = [...targetChunks, ...distractorChunks];
  const candidateWordsRaw = Array.isArray(it?.words)
    ? it.words
    : Array.isArray(it?.scrambledWords)
    ? it.scrambledWords
    : [];
  const candidateWords = candidateWordsRaw
    .map((w: any) => normalizeTileChunk(w))
    .filter(Boolean);

  const isValidBank =
    haveSameWordMultiset(candidateWords, combinedPool) &&
    !candidateWords.slice(0, targetChunks.length).every((w: string, i: number) => w === targetChunks[i]);

  const finalScrambled = isValidBank
    ? candidateWords
    : deterministicScrambleWords(combinedPool, `${cleanAnswer}-${idx}`);

  const cleanContext = sanitizeBuildSentenceContext(
    String(it?.context || it?.prompt || fb.context),
    cleanAnswer,
    idx
  );

  const grammarRule = String(
    it?.grammarRule ||
      it?.explanation ||
      it?.why ||
      fb.explanation ||
      'Follow standard academic English subject-verb-object word order and clause structure.'
  ).trim();

  return {
    ...(it?.id ? { id: String(it.id) } : {}),
    context: cleanContext,
    framePrefix,
    frameSuffix,
    targetChunks,
    distractorChunks,
    ...(distractorChunks[0] ? { distractorWord: distractorChunks[0] } : {}),
    words: finalScrambled,
    scrambledWords: finalScrambled,
    targetSentence: cleanAnswer,
    answer: cleanAnswer,
    correctSentence: cleanAnswer,
    grammarRule,
    explanation: grammarRule,
  };
}

export function normalizeBuildSentenceTask(raw: any): {
  title: string;
  items: NormalizedBuildSentenceItem[];
} {
  const title =
    String(raw?.title || 'Build a Sentence: Academic & Campus Syntax').trim() ||
    'Build a Sentence: Academic & Campus Syntax';
  const rawItems: any[] = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw?.questions)
    ? raw.questions
    : raw?.answer || raw?.correctSentence || raw?.targetSentence
    ? [raw]
    : [];

  const normalizedItems: NormalizedBuildSentenceItem[] = [];

  for (let idx = 0; idx < rawItems.length; idx++) {
    const it = rawItems[idx];
    if (!it || typeof it !== 'object') continue;
    const rawAns = String(it.targetSentence || it.answer || it.correctSentence || it.sentence || '').trim();
    if (!rawAns && (!Array.isArray(it.targetChunks) || it.targetChunks.length < 3)) continue;

    normalizedItems.push(normalizeBuildSentenceItem(it, idx, raw?.topic, title));
  }

  let fallbackIdx = 0;
  while (normalizedItems.length < 5 && fallbackIdx < FALLBACK_BUILD_SENTENCE_ITEMS.length) {
    const fb = FALLBACK_BUILD_SENTENCE_ITEMS[fallbackIdx++];
    if (normalizedItems.some((existing) => existing.answer === fb.answer)) continue;
    normalizedItems.push(normalizeBuildSentenceItem(fb, normalizedItems.length, raw?.topic, title));
  }

  const isCoach = Boolean(raw?.coachMode || raw?.mode === 'coach' || normalizedItems.length > 5);
  return {
    title,
    items: normalizedItems.slice(0, isCoach ? 10 : 5),
  };
}

const FALLBACK_LISTEN_REPEAT_SENTENCES = [
  'Please submit your laboratory safety forms before Friday afternoon.',
  'The university library recently expanded its digital archive of historical manuscripts.',
  'Undergraduate researchers must calibrate the optical spectrophotometer prior to analyzing chemical samples.',
  'Microeconomic theory suggests that consumer price elasticity varies significantly across essential commodity markets.',
  'Paleoclimatologists examine microscopic marine fossils within sediment cores to reconstruct prehistoric oceanic temperatures.',
  'Interdisciplinary collaboration between structural engineers and urban ecologists fosters resilient metropolitan infrastructure design.',
  'Neuroimaging studies demonstrate that sustained bilingual communication strengthens executive control networks across the prefrontal cortex.',
];

export function normalizeTaskContent(taskType: string, rawTask: any): any {
  const canonicalType = canonicalizeTaskType(taskType);
  const task = rawTask && typeof rawTask === 'object' ? (rawTask.content && typeof rawTask.content === 'object' && !rawTask.title ? { ...rawTask, ...rawTask.content } : rawTask) : {};

  switch (canonicalType) {
    case 'complete-words': {
      const cw = normalizeCompleteWordsTask(task);
      return {
        ...task,
        title: cw.title,
        text: cw.text,
        passage: cw.passage,
        totalBlanks: cw.totalBlanks,
        blanks: cw.blanks,
        ...(cw.isManualDevEdit ? { isManualDevEdit: true } : {}),
      };
    }

    case 'build-sentence': {
      const bs = normalizeBuildSentenceTask(task);
      return {
        ...task,
        title: bs.title,
        items: bs.items,
      };
    }

    case 'listen-repeat': {
      const title = String(task.title || 'Campus & Academic Listen and Repeat').trim();
      const speakerName = String(task.speakerName || 'Dr. Evelyn Vance (Female)').trim();
      const speakerGender =
        task.speakerGender === 'male' || task.speakerGender === 'female'
          ? task.speakerGender
          : inferGender(speakerName);

      let rawSentences: string[] = Array.isArray(task.sentences)
        ? task.sentences.map((s: any) => String(typeof s === 'string' ? s : s?.sentence || s?.text || '').trim()).filter(Boolean)
        : Array.isArray(task.items)
        ? task.items.map((s: any) => String(typeof s === 'string' ? s : s?.sentence || s?.text || '').trim()).filter(Boolean)
        : [];

      // Filter out overly short fragments (< 5 words)
      rawSentences = rawSentences.filter((s) => s.replace(/\|/g, ' ').split(/\s+/).filter(Boolean).length >= 5);

      let fbIdx = 0;
      while (rawSentences.length < 7 && fbIdx < FALLBACK_LISTEN_REPEAT_SENTENCES.length) {
        const candidate = FALLBACK_LISTEN_REPEAT_SENTENCES[fbIdx++];
        if (!rawSentences.includes(candidate)) {
          rawSentences.push(candidate);
        }
      }

      const isCoachLr = Boolean(task.coachMode || task.mode === 'coach' || rawSentences.length > 7);

      return {
        ...task,
        title,
        speakerName,
        speakerGender,
        sentences: rawSentences.slice(0, isCoachLr ? 12 : 7),
      };
    }

    case 'speaking-interview': {
      const title = String(task.title || 'Academic Research & Policy Interview').trim();
      const context = String(
        task.context ||
          'You are participating in a structured academic interview regarding university policy and contemporary research.'
      ).trim();
      const interviewerName = String(task.interviewerName || 'Professor Arthur Miller (Male)').trim();
      const interviewerGender =
        task.interviewerGender === 'male' || task.interviewerGender === 'female'
          ? task.interviewerGender
          : inferGender(interviewerName);

      const rawQs = Array.isArray(task.questions) ? task.questions : [];
      const normalizedQs = rawQs
        .map((q: any, qIdx: number) => {
          const qText = String(typeof q === 'string' ? q : q?.question || q?.prompt || '').trim();
          if (!qText) return null;
          return {
            id: q?.id,
            question: qText,
            prepTimeSeconds: Number(q?.prepTimeSeconds) || 15,
            responseTimeSeconds: Number(q?.responseTimeSeconds) || 45,
            suggestedPoints:
              Array.isArray(q?.suggestedPoints) && q.suggestedPoints.length > 0
                ? q.suggestedPoints.map(String)
                : [
                    'State your primary position clearly',
                    'Support your argument with a concrete academic or personal example',
                    'Synthesize the broader implications of your view',
                  ],
            ...(q?.speakingFormula ? { speakingFormula: q.speakingFormula } : {}),
            ...(Array.isArray(q?.topicVocabulary)
              ? {
                  topicVocabulary: q.topicVocabulary.map((v: any) =>
                    typeof v === 'string'
                      ? v
                      : v && typeof v === 'object'
                      ? `${v.word || v.term || ''}${v.meaning || v.definition ? ': ' + (v.meaning || v.definition) : ''}`
                      : String(v || '')
                  ),
                }
              : {}),
            ...(Array.isArray(q?.sentenceStarters)
              ? {
                  sentenceStarters: q.sentenceStarters.map((st: any) =>
                    typeof st === 'string'
                      ? st
                      : st && typeof st === 'object'
                      ? String(st.text || st.starter || st.sentence || JSON.stringify(st))
                      : String(st || '')
                  ),
                }
              : {}),
            sampleAnswer:
              typeof q?.sampleAnswer === 'string' && q.sampleAnswer.trim().length > 0
                ? q.sampleAnswer.trim()
                : typeof q?.modelAnswer === 'string' && q.modelAnswer.trim().length > 0
                ? q.modelAnswer.trim()
                : Array.isArray(task?.modelAnswers) && typeof task.modelAnswers[qIdx] === 'string'
                ? task.modelAnswers[qIdx].trim()
                : undefined,
          };
        })
        .filter(Boolean) as Array<{
        id?: string;
        question: string;
        prepTimeSeconds: number;
        responseTimeSeconds: number;
        suggestedPoints: string[];
        speakingFormula?: any;
        topicVocabulary?: string[];
        sentenceStarters?: string[];
        sampleAnswer?: string;
      }>;

      const defaultFollowUps = [
        {
          question: `Looking more broadly at ${title.toLowerCase()}, what practical challenges do students or institutions typically encounter first?`,
          prepTimeSeconds: 15,
          responseTimeSeconds: 45,
          suggestedPoints: [
            'Identify a specific logistical or resource obstacle',
            'Explain how this obstacle affects daily academic work',
            'Propose a realistic initial mitigation step',
          ],
          sampleAnswer: 'In my view, the most immediate challenge students face in this area is managing limited time and academic resources effectively. When new policies or courses are introduced without clear orientation, students often feel overwhelmed and struggle to balance coursework with extracurricular commitments. For example, during my freshman year, navigating self-directed research was difficult until our department hosted targeted workshops. Providing accessible peer advising significantly eases this initial friction.',
        },
        {
          question:
            'How should universities balance short-term financial constraints against long-term educational quality in this area?',
          prepTimeSeconds: 15,
          responseTimeSeconds: 45,
          suggestedPoints: [
            'Compare immediate budget pressures with long-term academic outcomes',
            'Provide an example of a high-impact institutional investment',
            'Explain how stakeholders benefit over time',
          ],
          sampleAnswer: 'Universities should prioritize long-term instructional quality even when confronted with short-term fiscal constraints. Investing in modern digital infrastructure, laboratory upgrades, and experienced faculty pays substantial dividends by enhancing graduate employability and institutional reputation. For instance, universities that invested in comprehensive digital learning hubs experienced higher student retention rates. A strategic, forward-looking investment strategy ultimately delivers sustainable institutional value.',
        },
        {
          question:
            'Some critics argue that traditional institutional approaches are outdated. To what extent do you agree or disagree with that view?',
          prepTimeSeconds: 15,
          responseTimeSeconds: 45,
          suggestedPoints: [
            'Take a clear stance on traditional versus modern reforms',
            'Acknowledge one valid point from the opposing perspective',
            'Defend your conclusion with specific evidence',
          ],
          sampleAnswer: 'I partially agree that certain legacy practices require modern updates, yet core pedagogical traditions remain essential. While integrating collaborative technology and practical project-based learning enhances engagement, traditional lecture fundamentals provide the theoretical groundwork students need. For example, combining classic seminar discussions with contemporary simulations yielded the best learning outcomes in our economics courses. Balancing foundational theory with modern innovation produces the most capable scholars.',
        },
        {
          question:
            'Looking ahead over the next decade, how do you expect technological and social shifts to transform this field?',
          prepTimeSeconds: 15,
          responseTimeSeconds: 45,
          suggestedPoints: [
            'Forecast a key technological or demographic trend',
            'Evaluate potential risks and ethical considerations',
            'Conclude with how future graduates should prepare',
          ],
          sampleAnswer: 'Over the coming decade, I anticipate that automated analytics and collaborative digital platforms will fundamentally reshape academic and professional practices. Routine computational tasks will become automated, allowing researchers and students to focus on critical interpretation and interdisciplinary problem-solving. Consequently, future graduates must cultivate strong adaptability, digital literacy, and ethical judgment to lead effectively in an evolving technological landscape.',
        },
      ];

      let fIdx = 0;
      while (normalizedQs.length < 4 && fIdx < defaultFollowUps.length) {
        normalizedQs.push(defaultFollowUps[fIdx++]);
      }

      const isCoachSi = Boolean(task.coachMode || task.mode === 'coach' || normalizedQs.length > 4);
      const maxSiQs = isCoachSi ? 6 : 4;
      const finalQs = normalizedQs.slice(0, maxSiQs);
      const modelAnswers = finalQs
        .map((q) => q.sampleAnswer)
        .filter((sa): sa is string => typeof sa === 'string' && sa.trim().length > 0);

      return {
        ...task,
        title,
        context,
        interviewerName,
        interviewerGender,
        questions: finalQs,
        ...(modelAnswers.length > 0 ? { modelAnswers } : {}),
      };
    }

    case 'daily-life': {
      return normalizeDailyLifeTask(task);
    }

    case 'reading-academic':
    case 'reading-passage': {
      return normalizeReadingAcademicTask(task);
    }

    case 'listening-choose-response': {
      return normalizeListeningChooseResponseTask(task);
    }

    case 'listening-dialogue':
    case 'listening-conversation': {
      return normalizeListeningDialogueTask(task, canonicalType);
    }

    case 'listening-announcement': {
      return normalizeListeningAnnouncementTask(task);
    }

    case 'listening-academic-talk':
    case 'listening-lecture': {
      return normalizeListeningAcademicTalkTask(task);
    }

    case 'write-email': {
      const title = String(task.title || 'Academic Campus Email').trim();
      const situation = String(task.situation || task.context || task.prompt || '').trim();
      const recipient = String(task.recipient || 'Professor Harrison').trim();
      const goals = Array.isArray(task.goals)
        ? task.goals.map(String).filter(Boolean)
        : Array.isArray(task.bulletPoints)
        ? task.bulletPoints.map(String).filter(Boolean)
        : [];
      const suggestedWordCount = String(task.suggestedWordCount || '100-130 words').trim();
      return {
        ...task,
        title,
        situation,
        recipient,
        goals,
        suggestedWordCount,
      };
    }

    case 'academic-discussion':
    default: {
      const title = String(task.title || 'Academic Course Discussion').trim();
      const professorName = String(task.professorName || task.professor?.name || 'Professor Henderson').trim();
      const professorPrompt = String(task.professorPrompt || task.prompt || task.professor?.prompt || '').trim();
      const s1 = {
        name: String(task.s1?.name || task.student1?.name || 'Marcus').trim(),
        text: String(task.s1?.text || task.student1?.text || '').trim(),
      };
      const s2 = {
        name: String(task.s2?.name || task.student2?.name || 'Elena').trim(),
        text: String(task.s2?.text || task.student2?.text || '').trim(),
      };
      const question = String(
        task.question ||
          'Express and support your personal opinion in the academic discussion forum, contributing a distinct perspective.'
      ).trim();

      return {
        ...task,
        title,
        professorName,
        professorPrompt,
        s1,
        s2,
        question,
      };
    }
  }
}

const FALLBACK_ACADEMIC_DISTRACTORS = [
  'It remains entirely unaffected by external environmental or institutional variables.',
  'It relies exclusively on outdated nineteenth-century observational methodologies.',
  'It contradicts the primary empirical conclusion established by the researchers.',
  'It eliminates the need for any further experimental or longitudinal verification.',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Eliminates option key bias (e.g. "always option B") across MCQ items:
 * Deterministically permutes options so that the verified correct option lands at:
 *   targetIdx = (hashString(questionText) + questionIdx) % options.length (0..3)
 * If targetIdx === correctAnswerIdx, returns options unmodified (100% idempotent).
 */
export function balanceMcqOptions(
  questionText: string,
  options: string[],
  correctAnswerIdx: number,
  questionIdx: number
): { options: string[]; correctAnswer: number } {
  if (!Array.isArray(options) || options.length !== 4) {
    return { options: options || [], correctAnswer: correctAnswerIdx };
  }

  const validCorrectIdx =
    typeof correctAnswerIdx === 'number' && correctAnswerIdx >= 0 && correctAnswerIdx < options.length
      ? correctAnswerIdx
      : 0;

  const correctText = options[validCorrectIdx] ?? options[0];
  const targetIdx = (hashString(questionText || '') + questionIdx) % options.length;

  if (targetIdx === validCorrectIdx) {
    return { options: [...options], correctAnswer: validCorrectIdx };
  }

  // Deterministically swap targetIdx and validCorrectIdx so correctText lands at targetIdx
  const permutedOptions = [...options];
  const temp = permutedOptions[targetIdx];
  permutedOptions[targetIdx] = correctText;
  permutedOptions[validCorrectIdx] = temp;

  return {
    options: permutedOptions,
    correctAnswer: targetIdx,
  };
}

export function updateExplanationOptionLetter(why: string, oldIdx: number, newIdx: number): string {
  if (!why) return why;
  const letters = ['A', 'B', 'C', 'D'];
  const oldLetter = letters[oldIdx];
  const newLetter = letters[newIdx];
  if (!newLetter) return why;

  let updated = why;
  if (oldLetter && oldLetter !== newLetter) {
    updated = updated.replace(
      new RegExp(`\\b(Option|Choice)\\s+\\(?${oldLetter}\\)?\\b`, 'gi'),
      (_, prefix) => `${prefix} ${newLetter}`
    );
  }

  // Also handle previously cached/balanced items where a single positive "Option X" reference still points to the pre-balanced letter
  const matches = Array.from(updated.matchAll(/\b(Option|Choice)\s+\(?([A-D])\)?\b/gi));
  if (matches.length === 1) {
    const matchedLetter = matches[0][2].toUpperCase();
    const matchPos = matches[0].index ?? 0;
    const afterText = updated.slice(matchPos, matchPos + 45).toLowerCase();
    const isNegativeRef = /\b(is incorrect|is wrong|is false|is not|contradicts)\b/.test(afterText);
    if (!isNegativeRef && matchedLetter !== newLetter) {
      updated = updated.replace(
        /\b(Option|Choice)\s+\(?[A-D]\)?\b/i,
        (_, prefix) => `${prefix} ${newLetter}`
      );
    }
  }

  return updated;
}

export type NormalizedQuestionType =
  | 'factual'
  | 'factual_detail'
  | 'negative_factual'
  | 'inference'
  | 'vocabulary'
  | 'idiomatic_meaning'
  | 'rhetorical_purpose'
  | 'main_purpose'
  | 'Factual Detail'
  | 'Negative Factual (EXCEPT/NOT)'
  | 'Vocabulary in Context'
  | 'Inference'
  | 'Rhetorical Purpose'
  | 'Gist / Main Idea'
  | 'Detail'
  | "Speaker's Purpose / Function"
  | 'Inference / Implied Meaning';

export function inferReadingQuestionType(
  questionText: string
): 'factual' | 'negative_factual' | 'inference' | 'vocabulary' | 'rhetorical_purpose' {
  const lower = (questionText || '').toLowerCase();
  if (
    /\b(not|except|least likely|false)\b/i.test(questionText) &&
    !/\b(cannot|whether or not)\b/i.test(questionText)
  ) {
    return 'negative_factual';
  }
  if (/\b(closest in meaning|the word|the phrase|in paragraph \d+, the word)\b/i.test(lower)) {
    return 'vocabulary';
  }
  if (/\b(infer|inferred|implies|imply|implied|suggests|can be concluded)\b/i.test(lower)) {
    return 'inference';
  }
  if (
    /\b(why does the author|why did the author|in order to|purpose|serves to|reason for mentioning|author discusses|author mention|author compare|author use|relate|relationship)\b/i.test(
      lower
    )
  ) {
    return 'rhetorical_purpose';
  }
  return 'factual';
}

export function classifyReadingQuestionTypeBadge(
  questionText: string
): 'Negative Factual (EXCEPT/NOT)' | 'Vocabulary in Context' | 'Inference' | 'Rhetorical Purpose' | 'Factual Detail' {
  const skill = inferReadingQuestionType(questionText);
  switch (skill) {
    case 'negative_factual':
      return 'Negative Factual (EXCEPT/NOT)';
    case 'vocabulary':
      return 'Vocabulary in Context';
    case 'inference':
      return 'Inference';
    case 'rhetorical_purpose':
      return 'Rhetorical Purpose';
    default:
      return 'Factual Detail';
  }
}

export function inferListeningQuestionType(
  questionText: string,
  rawQType?: string,
  hasAudioExcerpt?: boolean
): 'Gist / Main Idea' | 'Detail' | "Speaker's Purpose / Function" | 'Inference / Implied Meaning' {
  const cleanRaw = (rawQType || '').trim().toLowerCase();
  if (
    cleanRaw === "speaker's purpose / function" ||
    cleanRaw === 'rhetorical_purpose' ||
    cleanRaw === 'purpose' ||
    cleanRaw === 'function' ||
    cleanRaw === 'attitude' ||
    cleanRaw === 'pragmatic'
  ) {
    return "Speaker's Purpose / Function";
  }
  if (
    cleanRaw === 'inference / implied meaning' ||
    cleanRaw === 'inference' ||
    cleanRaw === 'implication' ||
    cleanRaw === 'implied_meaning'
  ) {
    return 'Inference / Implied Meaning';
  }
  if (
    cleanRaw === 'gist / main idea' ||
    cleanRaw === 'main_idea' ||
    cleanRaw === 'main_purpose' ||
    cleanRaw === 'gist'
  ) {
    return 'Gist / Main Idea';
  }

  const qText = questionText || '';
  const lower = qText.toLowerCase();

  if (
    /\b(why does the (?:professor|speaker|student|man|woman|librarian|advisor|coordinator|coach|manager|instructor) (?:say|mention|bring up|ask|discuss|refer|point out|express|advise|tell|decide)|what is the (?:speaker|professor)'s purpose|what is the primary rhetorical purpose|attitude|tone|mean when (?:he|she|they) say|say this)\b/i.test(
      lower
    )
  ) {
    return "Speaker's Purpose / Function";
  }
  if (
    /\b(imply|implies|implied|infer|inferred|most likely do next|probably|can be concluded|suggest about|what will the student most likely|what does the .* suspect)\b/i.test(
      lower
    )
  ) {
    return 'Inference / Implied Meaning';
  }
  if (
    /\b(main topic|mainly about|main purpose of the (?:lecture|talk|conversation|announcement)|primarily about|primary focus|mainly discuss)\b/i.test(
      lower
    )
  ) {
    return 'Gist / Main Idea';
  }
  if (hasAudioExcerpt) {
    return "Speaker's Purpose / Function";
  }
  return 'Detail';
}

function extractRelevantScriptExcerpt(
  script: string,
  questionText: string,
  whyText: string,
  options: string[],
  answerIdx: number,
  isDialogue: boolean = false
): string | undefined {
  const cleanScript = (script || '').trim();
  if (!cleanScript) return undefined;

  const candidates: string[] = isDialogue
    ? cleanScript
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.split(/\s+/).length >= 5)
    : cleanScript
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.split(/\s+/).length >= 6);

  if (candidates.length === 0) return undefined;

  const stopWords = new Set([
    'professor',
    'student',
    'speaker',
    'lecture',
    'conversation',
    'talk',
    'listen',
    'again',
    'part',
    'what',
    'does',
    'when',
    'this',
    'that',
    'with',
    'from',
    'have',
    'will',
    'about',
    'which',
    'their',
    'there',
    'would',
    'could',
    'should',
    'because',
    'option',
    'correct',
    'explains',
    'states',
    'mentions',
    'according',
    'imply',
    'implies',
    'inferred',
  ]);

  const correctOption = options[answerIdx] || '';
  const searchSource = `${questionText} ${correctOption} ${whyText}`.toLowerCase();
  const keywords = Array.from(
    new Set(
      searchSource
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopWords.has(w))
    )
  );

  let bestCandidate = candidates[Math.min(1, candidates.length - 1)];
  let bestScore = -1;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const candLower = cand.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (candLower.includes(kw)) {
        score += 2;
      }
    }
    // Slight preference for middle turns/sentences over the opening greeting
    if (i > 0 && i < candidates.length - 1) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = cand;
    }
  }

  return bestCandidate;
}

function enrichListeningQuestionsWithExcerpt(
  questions: Array<{
    q: string;
    question: string;
    options: string[];
    answer: number;
    correctAnswer: number;
    why: string;
    explanation: string;
    questionType: NormalizedQuestionType;
    audioExcerpt?: string;
  }>,
  script: string,
  isAcademicTalk: boolean
) {
  if (!Array.isArray(questions) || questions.length === 0) return questions;

  const isDialogue = !isAcademicTalk;
  const enriched = questions.map((q) => {
    const existingExcerpt =
      typeof q.audioExcerpt === 'string' && q.audioExcerpt.trim().length > 0
        ? q.audioExcerpt.trim()
        : undefined;
    const inferredType = inferListeningQuestionType(q.q, q.questionType, Boolean(existingExcerpt));
    return {
      ...q,
      ...(existingExcerpt ? { audioExcerpt: existingExcerpt } : {}),
      questionType: inferredType as NormalizedQuestionType,
    };
  });

  const hasAnyExcerpt = enriched.some((q) => Boolean(q.audioExcerpt));
  if (!hasAnyExcerpt && script && script.trim().length >= 30) {
    // Find a question testing Speaker's Purpose / Function or Inference / Implied Meaning
    let targetIdx = enriched.findIndex(
      (q) =>
        q.questionType === "Speaker's Purpose / Function" ||
        /\b(why does the|what does the .* imply|what is the .* purpose|mean when|say this)\b/i.test(q.q)
    );
    if (targetIdx === -1) {
      targetIdx = enriched.findIndex((q) => q.questionType === 'Inference / Implied Meaning');
    }
    if (targetIdx === -1 && isAcademicTalk) {
      targetIdx = enriched.length - 1;
    }

    if (targetIdx !== -1) {
      const targetQ = enriched[targetIdx];
      const excerpt = extractRelevantScriptExcerpt(
        script,
        targetQ.q,
        targetQ.why,
        targetQ.options,
        targetQ.answer,
        isDialogue
      );
      if (excerpt) {
        enriched[targetIdx] = {
          ...targetQ,
          audioExcerpt: excerpt,
          questionType:
            targetQ.questionType === 'Inference / Implied Meaning'
              ? 'Inference / Implied Meaning'
              : "Speaker's Purpose / Function",
        };
      }
    }
  }

  return enriched;
}

function deterministicShuffleQuestions<T extends { q: string }>(items: T[], seedStr: string): T[] {
  if (items.length <= 1) return [...items];
  // Canonical sort first so calling normalizeReadingAcademicTask multiple times is 100% idempotent
  const arr = [...items].sort((a, b) => a.q.localeCompare(b.q));
  let seed = hashString(seedStr || 'toefl-reading-2026') || 123456789;
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function inferDailyLifeQuestionType(
  questionText: string,
  rawQType?: string
): 'main_purpose' | 'inference' | 'factual_detail' | 'idiomatic_meaning' | 'negative_factual' {
  const cleanType = (rawQType || '').trim().toLowerCase();
  if (cleanType === 'main_purpose' || cleanType === 'rhetorical_purpose') return 'main_purpose';
  if (cleanType === 'idiomatic_meaning' || cleanType === 'vocabulary') return 'idiomatic_meaning';
  if (cleanType === 'inference') return 'inference';
  if (cleanType === 'negative_factual') return 'negative_factual';
  if (cleanType === 'factual_detail') return 'factual_detail';

  const qText = questionText || '';
  const lower = qText.toLowerCase();

  if (
    /\b(not|except|least likely|false)\b/i.test(qText) &&
    !/\b(cannot|whether or not)\b/i.test(qText)
  ) {
    return 'negative_factual';
  }
  if (
    /\b(purpose|main reason|why did .* send|why was .* posted|why is .* writing|who issued|intended for|primarily to|written to)\b/i.test(
      lower
    )
  ) {
    return 'main_purpose';
  }
  if (
    /\b(closest in meaning|mean by|means|the word|the phrase|expression|informal|refers to)\b/i.test(
      lower
    )
  ) {
    return 'idiomatic_meaning';
  }
  if (
    /\b(infer|inferred|imply|implied|implies|most likely|probably|suggests|can be concluded|what will .* likely)\b/i.test(
      lower
    )
  ) {
    return 'inference';
  }
  return 'factual_detail';
}

/**
 * Ensures all 4 MCQ options are unique strings, performs Answer-Key Self-Verification,
 * tags questionType, and eliminates option position bias by deterministically balancing answers across A, B, C, D (0..3).
 */
export function verifyAndNormalizeMcqQuestions(
  rawQs: any[],
  defaultWhy: string
): Array<{
  q: string;
  question: string;
  options: string[];
  answer: number;
  correctAnswer: number;
  why: string;
  explanation: string;
  questionType: NormalizedQuestionType;
  audioExcerpt?: string;
}> {
  if (!Array.isArray(rawQs)) return [];

  const result: Array<{
    q: string;
    question: string;
    options: string[];
    answer: number;
    correctAnswer: number;
    why: string;
    explanation: string;
    questionType: NormalizedQuestionType;
    audioExcerpt?: string;
  }> = [];

  for (let qIdx = 0; qIdx < rawQs.length; qIdx++) {
    const q = rawQs[qIdx];
    if (!q || typeof q !== 'object') continue;
    const qText = String(q.q || q.question || '').trim();
    const rawOptions = Array.isArray(q.options) ? q.options.map((o: any) => String(o || '').trim()).filter(Boolean) : [];
    if (!qText || rawOptions.length === 0) continue;

    // Ensure 4 distinct options (replace duplicates with plausible distractors)
    const uniqueOptions: string[] = [];
    const seenLower = new Set<string>();
    for (const opt of rawOptions) {
      const cleanedOpt = opt.replace(/^[A-Da-d][.)]\s*/, '').trim() || opt;
      const key = cleanedOpt.toLowerCase();
      if (!seenLower.has(key)) {
        seenLower.add(key);
        uniqueOptions.push(cleanedOpt);
      }
      if (uniqueOptions.length === 4) break;
    }

    let distIdx = 0;
    while (uniqueOptions.length < 4) {
      const candidate = FALLBACK_ACADEMIC_DISTRACTORS[(qIdx + distIdx) % FALLBACK_ACADEMIC_DISTRACTORS.length];
      distIdx++;
      const key = candidate.toLowerCase();
      if (!seenLower.has(key)) {
        seenLower.add(key);
        uniqueOptions.push(candidate);
      } else {
        uniqueOptions.push(`${candidate.replace(/\.$/, '')} (Alternative ${uniqueOptions.length + 1}).`);
      }
    }

    let answer = typeof q.answer === 'number' ? q.answer : Number(q.correctAnswer ?? 0);
    if (isNaN(answer) || answer < 0 || answer > 3) answer = 0;

    const whyText = String(q.why || q.explanation || defaultWhy).trim() || defaultWhy;
    const whyLower = whyText.toLowerCase();

    // Answer-Key Self-Verification:
    // Check if why/explanation explicitly states or quotes one of the 4 option texts verbatim
    const verbatimMatches: number[] = [];
    for (let i = 0; i < 4; i++) {
      const optClean = uniqueOptions[i]
        .toLowerCase()
        .replace(/[.!?;:,]+$/g, '')
        .trim();
      if (optClean.length >= 6 && whyLower.includes(optClean)) {
        // Ensure it's not mentioned only as "is incorrect" or "is wrong"
        const pos = whyLower.indexOf(optClean);
        const afterSnippet = whyLower.slice(pos + optClean.length, pos + optClean.length + 35);
        const isNegated = /\b(is incorrect|is wrong|is false|is not correct|contradicts)\b/.test(afterSnippet);
        if (!isNegated) {
          verbatimMatches.push(i);
        }
      }
    }

    if (verbatimMatches.length === 1 && verbatimMatches[0] !== answer) {
      answer = verbatimMatches[0];
    } else if (verbatimMatches.length === 0) {
      // Also check if explanation explicitly says "Option B is correct" / "correct answer is C"
      const letterMatch = whyText.match(
        /\b(?:option|choice|correct answer is)\s*\(?([A-D])\)?\s*(?:is correct|because|accurately|correctly)/i
      );
      if (letterMatch) {
        const letterIdx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
        if (letterIdx >= 0 && letterIdx <= 3) {
          answer = letterIdx;
        }
      }
    }

    // Apply deterministic option balancing across A (0), B (1), C (2), D (3)
    const balanced = balanceMcqOptions(qText, uniqueOptions.slice(0, 4), answer, qIdx);
    const updatedWhy = updateExplanationOptionLetter(whyText, answer, balanced.correctAnswer);
    const rawQType = String(q.questionType || q.type || '').trim();
    const rawQTypeLower = rawQType.toLowerCase();
    const validQType: NormalizedQuestionType = [
      'factual',
      'factual_detail',
      'negative_factual',
      'inference',
      'vocabulary',
      'idiomatic_meaning',
      'rhetorical_purpose',
      'main_purpose',
    ].includes(rawQTypeLower)
      ? (rawQTypeLower as NormalizedQuestionType)
      : [
          'Gist / Main Idea',
          'Detail',
          "Speaker's Purpose / Function",
          'Inference / Implied Meaning',
        ].includes(rawQType)
      ? (rawQType as NormalizedQuestionType)
      : inferReadingQuestionType(qText);

    const audioExcerpt =
      typeof q.audioExcerpt === 'string' && q.audioExcerpt.trim().length > 0
        ? q.audioExcerpt.trim()
        : undefined;
    const hint =
      typeof q.hint === 'string' && q.hint.trim().length > 0
        ? q.hint.trim()
        : undefined;

    result.push({
      q: qText,
      question: qText,
      options: balanced.options,
      answer: balanced.correctAnswer,
      correctAnswer: balanced.correctAnswer,
      why: updatedWhy,
      explanation: updatedWhy,
      questionType: validQType,
      ...(audioExcerpt ? { audioExcerpt } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  return result;
}

export function normalizeReadingAcademicTask(task: any): any {
  const title = String(task?.title || 'Academic Reading Comprehension').trim();
  const passage = String(task?.passage || task?.text || '').trim();
  const rawQs = Array.isArray(task?.questions) ? task.questions : [];
  const verifiedQs = verifyAndNormalizeMcqQuestions(
    rawQs,
    'Supported directly by evidence in the reading passage.'
  ).map((q) => {
    const badgeLabel = classifyReadingQuestionTypeBadge(q.q);
    const skillKey = inferReadingQuestionType(q.q);
    return {
      ...q,
      questionType: badgeLabel,
      skillKey,
    };
  });

  const questions = deterministicShuffleQuestions(verifiedQs, `${title}::${passage.slice(0, 120)}`);

  return {
    ...task,
    title,
    passage,
    questions,
  };
}

export function normalizeListeningDialogueTask(task: any, normalizedType?: string): any {
  const canonicalType = canonicalizeTaskType(normalizedType || task?.taskType || task?.type);
  if (canonicalType === 'listening-announcement' || task?.type === 'announcement') {
    return normalizeListeningAnnouncementTask(task);
  }
  if (canonicalType === 'listening-academic-talk' || task?.type === 'academic_talk' || task?.type === 'lecture') {
    return normalizeListeningAcademicTalkTask(task);
  }

  const title = String(task?.title || 'Campus Conversation').trim();
  const context = String(
    task?.context || task?.situation || 'Listen to a conversation between a student and a university representative.'
  ).trim();
  const script = String(task?.script || task?.dialogue || task?.text || '').trim();

  let speakers = task?.speakers;
  if (!speakers || typeof speakers !== 'object' || Array.isArray(speakers)) {
    speakers = { A: 'Emma (Student)', B: 'Professor Miller' };
  }

  const speakerGenders = task?.speakerGenders || {
    A: inferGender(String(speakers.A || '')),
    B: inferGender(String(speakers.B || '')),
  };

  const rawQs = Array.isArray(task?.questions) ? task.questions : [];
  const isCoachLd = Boolean(task?.coachMode || task?.mode === 'coach' || rawQs.length > 2);
  const baseQuestions = verifyAndNormalizeMcqQuestions(rawQs, 'Directly stated in the audio passage.').slice(
    0,
    isCoachLd ? 6 : 2
  );
  const questions = enrichListeningQuestionsWithExcerpt(baseQuestions, script, false);

  return {
    ...task,
    type: 'conversation',
    taskType: 'listening-dialogue',
    title,
    context,
    speakers,
    speakerGenders,
    script,
    questions,
  };
}

export function normalizeDailyLifeTask(task: any): any {
  const title = String(task?.title || 'Real-World Daily Life Reading').trim();
  const rawFormat = String(task?.formatType || task?.format || 'notice').toLowerCase();
  const formatType = ['notice', 'email', 'text-chain', 'menu', 'schedule', 'invoice', 'social-post'].includes(rawFormat)
    ? rawFormat
    : 'notice';
  const contentText = String(
    task?.contentText ||
    task?.text ||
    task?.notice ||
    task?.content ||
    task?.passage ||
    task?.body ||
    ''
  ).trim();
  const context = String(task?.context || task?.situation || '').trim();
  const rawQs = Array.isArray(task?.questions) ? task.questions : [];
  const isCoachDl = Boolean(task?.coachMode || task?.mode === 'coach' || rawQs.length > 3);
  const normalizedQs = verifyAndNormalizeMcqQuestions(
    rawQs,
    'Directly supported by the document or message.'
  )
    .slice(0, isCoachDl ? 5 : 3)
    .map((q) => ({
      ...q,
      questionType: inferDailyLifeQuestionType(q.q, q.questionType),
    }));

  return {
    ...task,
    title,
    formatType,
    format: formatType,
    contentText,
    text: contentText,
    context,
    meta: task?.meta || task?.metadata || {},
    questions: normalizedQs,
  };
}

export function normalizeListeningChooseResponseTask(task: any): any {
  const title = String(task?.title || 'Listen & Choose a Response').trim();
  const category = String(task?.category || 'Campus Life').trim();

  const rawItems =
    Array.isArray(task?.items) && task.items.length > 0
      ? task.items
      : [task];

  const items = rawItems.map((it: any, idx: number) => {
    const audioPrompt = String(
      it?.audioPrompt ||
      it?.promptAudioScript ||
      it?.script ||
      it?.spokenPrompt ||
      it?.prompt ||
      ''
    ).trim();
    const speakerName = String(it?.speakerName || task?.speakerName || 'Campus Speaker').trim();
    const speakerGender = String(it?.speakerGender || task?.speakerGender || inferGender(speakerName)) === 'female' ? 'female' : 'male';
    const rawOptions = Array.isArray(it?.options)
      ? it.options.map((o: any) => String(o || '').trim()).filter(Boolean)
      : [];
    const rawAnswer = typeof it?.answer === 'number' ? it.answer : Number(it?.correctAnswer ?? 0);
    const validRawAnswer = isNaN(rawAnswer) || rawAnswer < 0 || rawAnswer > 3 ? 0 : rawAnswer;
    const balanced = balanceMcqOptions(audioPrompt, rawOptions.slice(0, 4), validRawAnswer, idx);
    const rawWhy = String(
      it?.why || it?.explanation || 'Most appropriate and natural response in this spoken campus exchange.'
    ).trim();
    const why = updateExplanationOptionLetter(rawWhy, validRawAnswer, balanced.correctAnswer);
    const coachTip = typeof it?.coachTip === 'string' && it.coachTip.trim() ? it.coachTip.trim() : undefined;

    return {
      audioPrompt,
      promptAudioScript: audioPrompt,
      script: audioPrompt,
      speakerName,
      speakerGender,
      options: balanced.options,
      answer: balanced.correctAnswer,
      correctAnswer: balanced.correctAnswer,
      why,
      explanation: why,
      ...(coachTip ? { coachTip } : {}),
    };
  });

  const first = items[0] || {
    audioPrompt: '',
    speakerName: 'Campus Speaker',
    speakerGender: 'male',
    options: [],
    answer: 0,
    why: '',
  };

  return {
    ...task,
    title,
    category,
    items,
    audioPrompt: first.audioPrompt,
    promptAudioScript: first.audioPrompt,
    script: first.audioPrompt,
    speakerName: first.speakerName,
    speakerGender: first.speakerGender,
    options: first.options,
    answer: first.answer,
    correctAnswer: first.answer,
    why: first.why,
    explanation: first.why,
  };
}

export function normalizeListeningAnnouncementTask(task: any): any {
  const title = String(task?.title || 'Campus Announcement').trim();
  const context = String(task?.context || 'University Campus Announcement').trim();
  const speakerName = String(task?.speakerName || 'Dean of Students').trim();
  const speakerGender = String(task?.speakerGender || inferGender(speakerName));
  const script = String(task?.script || task?.announcement || task?.text || '').trim();
  const rawQs = Array.isArray(task?.questions) ? task.questions : [];
  const questions = verifyAndNormalizeMcqQuestions(rawQs, 'Directly stated in the announcement.').map((q) => ({
    ...q,
    questionType: inferListeningQuestionType(q.q, q.questionType, Boolean(q.audioExcerpt)) as NormalizedQuestionType,
  }));

  return {
    ...task,
    title,
    context,
    speakerName,
    speakerGender,
    script,
    questions,
  };
}

export function normalizeListeningAcademicTalkTask(task: any): any {
  const title = String(task?.title || 'Academic Talk & Lecture').trim();
  const topic = String(task?.topic || 'Science & Technology').trim();
  const speakerName = String(task?.speakerName || 'Dr. Williams').trim();
  const speakerGender = String(task?.speakerGender || inferGender(speakerName));
  const script = String(task?.script || task?.lecture || task?.text || '').trim();
  const rawQs = Array.isArray(task?.questions) ? task.questions : [];
  const baseQuestions = verifyAndNormalizeMcqQuestions(rawQs, 'Supported directly by the academic talk.');
  const questions = enrichListeningQuestionsWithExcerpt(baseQuestions, script, true);

  return {
    ...task,
    title,
    topic,
    speakerName,
    speakerGender,
    script,
    questions,
  };
}

/**
 * Validates that a normalized task strictly meets 2026 TOEFL iBT structural and quality rules.
 */
export function validateNormalizedTask(taskTypeOrItem: string | any, normalizedData?: any): boolean {
  const isSingleArgObject = typeof taskTypeOrItem === 'object' && taskTypeOrItem !== null && normalizedData === undefined;
  const rawType = isSingleArgObject ? taskTypeOrItem.taskType : taskTypeOrItem;
  const targetObj = isSingleArgObject ? taskTypeOrItem : normalizedData;

  if (!targetObj || typeof targetObj !== 'object') return false;
  const canonicalType = canonicalizeTaskType(rawType);
  const data =
    targetObj.content && typeof targetObj.content === 'object' && !targetObj.title && !targetObj.text && !targetObj.items
      ? targetObj.content
      : targetObj;

  switch (canonicalType) {
    case 'complete-words': {
      const text = String(data.text || '');
      if (!text || text.length < 50) return false;
      // Reject any backwards blank where ] or ]] is followed immediately by letters (e.g. [penetr]ate or [[penetr]]ate)
      if (/\]+[a-zA-Z]/.test(text)) return false;
      // Split on [answer] or [[answer]]
      const parts = text.split(/\[+([^\]]+)\]+/);
      if (parts.length < 17) return false; // At least 8 blanks (10 standard)
      for (let i = 1; i < parts.length; i += 2) {
        const solution = parts[i];
        const prevText = parts[i - 1] || '';
        const prefixMatch = prevText.match(/([a-zA-Z'\u2019-]+)$/);
        if (!prefixMatch || prefixMatch[1].length < 1) return false;
        if (!/^[a-zA-Z'\u2019-]+$/.test(solution)) return false;
      }
      return true;
    }

    case 'build-sentence': {
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length < 5) return false;
      return items.every((item: any) => {
        const ans = String(item.targetSentence || item.answer || item.correctSentence || '').trim();
        const ctx = String(item.context || '').trim();
        const words = Array.isArray(item.words) ? item.words : [];
        const targetChunks = Array.isArray(item.targetChunks) ? item.targetChunks : [];
        if (!ans || !ctx || words.length < 3) return false;
        if (ctx.toLowerCase().includes(ans.toLowerCase().replace(/[.!?]+$/, ''))) return false;
        if (targetChunks.length >= 3) {
          const bankLower = words.map((w: any) => String(w || '').toLowerCase().trim());
          return (
            words.length >= targetChunks.length &&
            targetChunks.every((tc: any) => bankLower.includes(String(tc || '').toLowerCase().trim()))
          );
        }
        const targetWords = tokenizeSentenceWords(ans);
        return targetWords.length >= 5 && haveSameWordMultiset(words, targetWords);
      });
    }

    case 'daily-life': {
      const text = String(data.contentText || data.text || data.notice || data.passage || '');
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (text.trim().length < 20 || questions.length < 2) return false;
      return questions.every(
        (q: any) =>
          q.q &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          new Set(q.options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof q.answer === 'number' &&
          q.answer >= 0 &&
          q.answer <= 3
      );
    }

    case 'reading-academic':
    case 'reading-passage': {
      const passage = String(data.passage || data.text || '');
      const wordCount = passage.trim().split(/\s+/).filter(Boolean).length;
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (wordCount < 100 || questions.length < 3) return false;
      return questions.every(
        (q: any) =>
          q.q &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          new Set(q.options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof q.answer === 'number' &&
          q.answer >= 0 &&
          q.answer <= 3
      );
    }

    case 'listening-choose-response': {
      const items = Array.isArray(data.items) && data.items.length > 0 ? data.items : [data];
      return items.every((item: any) => {
        const prompt = String(item.audioPrompt || item.promptAudioScript || item.script || '');
        const options = Array.isArray(item.options) ? item.options : [];
        return (
          prompt.trim().length >= 8 &&
          options.length === 4 &&
          new Set(options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof item.answer === 'number' &&
          item.answer >= 0 &&
          item.answer <= 3
        );
      });
    }

    case 'listening-dialogue':
    case 'listening-conversation': {
      const script = String(data.script || '');
      const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (wordCount < 60 || questions.length < 2) return false;
      return questions.every(
        (q: any) =>
          q.q &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          new Set(q.options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof q.answer === 'number' &&
          q.answer >= 0 &&
          q.answer <= 3
      );
    }

    case 'listening-announcement': {
      const script = String(data.script || data.announcement || '');
      const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (wordCount < 30 || questions.length < 2) return false;
      return questions.every(
        (q: any) =>
          q.q &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          new Set(q.options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof q.answer === 'number' &&
          q.answer >= 0 &&
          q.answer <= 3
      );
    }

    case 'listening-academic-talk':
    case 'listening-lecture': {
      const script = String(data.script || data.lecture || '');
      const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (wordCount < 80 || questions.length < 3) return false;
      return questions.every(
        (q: any) =>
          q.q &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          new Set(q.options.map((o: any) => String(o).toLowerCase().trim())).size === 4 &&
          typeof q.answer === 'number' &&
          q.answer >= 0 &&
          q.answer <= 3
      );
    }

    case 'listen-repeat': {
      const sentences = Array.isArray(data.sentences) ? data.sentences : [];
      if (sentences.length < 7) return false;
      return sentences.every((s: string) => String(s || '').replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean).length >= 5);
    }

    case 'speaking-interview': {
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (questions.length < 4) return false;
      return questions.every((q: any) => String(q?.question || '').trim().length >= 15);
    }

    case 'write-email': {
      const situation = String(data.situation || '').trim();
      const recipient = String(data.recipient || '').trim();
      const goals = Array.isArray(data.goals) ? data.goals : [];
      return situation.length >= 30 && recipient.length >= 2 && goals.length >= 3;
    }

    case 'academic-discussion': {
      const prompt = String(data.professorPrompt || '').trim();
      const s1Text = String(data.s1?.text || '').trim();
      const s2Text = String(data.s2?.text || '').trim();
      return prompt.length >= 40 && s1Text.length >= 40 && s2Text.length >= 40;
    }

    default:
      return false;
  }
}

export function normalizeQuestionBankItem(rawItem: any, fallbackTaskType?: string): any {
  if (!rawItem || typeof rawItem !== 'object') return null;

  const taskType = canonicalizeTaskType(rawItem.taskType || fallbackTaskType);
  const rawContent =
    rawItem.content && typeof rawItem.content === 'object'
      ? { ...rawItem, ...rawItem.content }
      : { ...rawItem };

  const level = normalizeDifficultyLabel(rawItem.level || rawContent.level || rawItem.difficulty);
  const topic = normalizeTopicLabel(rawItem.topic || rawContent.topic, rawContent);

  const normalizedContent = normalizeTaskContent(taskType, rawContent);

  return {
    ...normalizedContent,
    id: String(rawItem.id || rawContent.id || `${taskType}-${Date.now()}`),
    taskType,
    level,
    difficulty: level,
    topic,
    content: {
      ...normalizedContent,
      level,
      difficulty: level,
      topic,
    },
  };
}

export function normalizeTaskData(
  raw: any,
  fallbackTaskType?: string,
  options?: { coachMode?: boolean }
): any {
  if (!raw || typeof raw !== 'object') return raw;
  const taskType = canonicalizeTaskType(raw.taskType || fallbackTaskType);
  const baseObj =
    raw.content && typeof raw.content === 'object'
      ? {
          ...raw,
          ...raw.content,
          ...(options?.coachMode ? { coachMode: true, mode: 'coach' } : {}),
        }
      : {
          ...raw,
          ...(options?.coachMode ? { coachMode: true, mode: 'coach' } : {}),
        };

  const level = normalizeDifficultyLabel(raw.level || baseObj.level || raw.difficulty);
  const topic = normalizeTopicLabel(raw.topic || baseObj.topic, baseObj);
  const normalizedContent = normalizeTaskContent(taskType, baseObj);

  return {
    ...raw,
    ...normalizedContent,
    taskType,
    level,
    difficulty: level,
    topic,
    ...(raw.content && typeof raw.content === 'object'
      ? {
          content: {
            ...raw.content,
            ...normalizedContent,
            level,
            difficulty: level,
            topic,
          },
        }
      : {}),
  };
}
