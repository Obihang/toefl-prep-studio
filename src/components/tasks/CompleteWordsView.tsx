import React, { useState, useEffect, useRef } from 'react';
import { CompleteWordsTask } from '../../data/curatedQuestions';
import { CheckCircle2, RotateCcw, ArrowRight, Keyboard } from 'lucide-react';
import { convertToScaledScore, convertScaledToBand6, savePracticeRecord } from '../../utils/scoreTracker';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { normalizeCompleteWordsTask } from '../../utils/taskNormalizer';
import { TaskSubtitleMeta, TaskReportButton, CollapsibleTaskInstructions } from '../shared/TaskHeaderMeta';

interface Props {
  task: CompleteWordsTask;
  onNextTask?: () => void;
  onComplete?: (score: number) => void;
  wordWrapperClassName?: string;
  blankInputClassName?: string;
  coachMode?: boolean;
}

interface BlankItem {
  prefix: string;
  solution: string;
  trailingPunct: string;
  userValue: string;
  isCorrect?: boolean;
}

function inferWordPartOfSpeechClue(fullWord: string): string {
  const w = fullWord.toLowerCase();
  if (/(tion|sion|ment|ness|ity|ism|ance|ence|ship|logy|ist|er|or)s?$/.test(w)) return 'Noun / Concept';
  if (/(ly)$/.test(w)) return 'Adverb';
  if (/(ive|ous|al|ic|able|ible|ful|less|ent|ant)$/.test(w)) return 'Adjective';
  if (/(ed|ing|ize|ise|ate|ify)$/.test(w)) return 'Verb / Participle';
  return 'Academic Content Word';
}

/**
 * Canonicalizes same-length US/UK and standard academic spelling variants
 * (e.g., advisors/advisers, -ize/-ise, -yze/-yse, -ization/-isation, -er/-re, -ense/-ence)
 */
function canonicalizeSameLengthVariant(word: string): string {
  return word
    .toLowerCase()
    .replace(/adviser/g, 'advisor')
    .replace(/sceptic/g, 'skeptic')
    .replace(/artefact/g, 'artifact')
    .replace(/grey/g, 'gray')
    .replace(/(cent|theat|met|fib|calib|lust|somb|spect)re(s|d)?$/g, '$1er$2')
    .replace(/(def|off|lic|pret)ence(s)?$/g, '$1ense$2')
    .replace(/([a-z]{2,})isations$/g, '$1izations')
    .replace(/([a-z]{2,})isation$/g, '$1ization')
    .replace(/([a-z]{2,})ising$/g, '$1izing')
    .replace(/([a-z]{2,})ised$/g, '$1ized')
    .replace(/([a-z]{2,})isers$/g, '$1izers')
    .replace(/([a-z]{2,})iser$/g, '$1izer')
    .replace(/([a-z]{2,})ises$/g, '$1izes')
    .replace(/([a-z]{2,})ise$/g, '$1ize')
    .replace(/([a-z]{2,})ysing$/g, '$1yzing')
    .replace(/([a-z]{2,})ysed$/g, '$1yzed')
    .replace(/([a-z]{2,})yses$/g, '$1yzes')
    .replace(/([a-z]{2,})yse$/g, '$1yze');
}

export function isAcceptedCTestAnswer(prefix: string, userValue: string, solution: string): boolean {
  const cleanUser = userValue.trim().toLowerCase();
  const cleanSol = solution.trim().toLowerCase();
  if (!cleanUser) return false;
  if (cleanUser === cleanSol) return true;
  if (cleanUser.length !== cleanSol.length) return false;

  const fullUserWord = `${prefix}${cleanUser}`.toLowerCase();
  const fullExpectedWord = `${prefix}${cleanSol}`.toLowerCase();

  return canonicalizeSameLengthVariant(fullUserWord) === canonicalizeSameLengthVariant(fullExpectedWord);
}

export const CompleteWordsView: React.FC<Props> = ({ task, onNextTask, onComplete, coachMode = false }) => {
  const [blanks, setBlanks] = useState<BlankItem[]>([]);
  const [segments, setSegments] = useState<Array<{ type: 'text' | 'blank'; value: string; blankIndex?: number }>>([]);
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState<{ correct: number; total: number } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [coachHintBanner, setCoachHintBanner] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Parse text formatted with [[missing_letters]] after enforcing strict 2026 C-Test normalization
  useEffect(() => {
    const normalized = normalizeCompleteWordsTask(task);
    const parts = [...normalized.text.split(/\[+([^\]]+)\]+/)];
    const newBlanks: BlankItem[] = [];
    const newSegments: Array<{ type: 'text' | 'blank'; value: string; blankIndex?: number }> = [];

    // First pass: extract word prefix from preceding text segment and trailing punctuation from following text segment
    for (let i = 1; i < parts.length; i += 2) {
      const solution = parts[i];
      const prevText = parts[i - 1] || '';
      const nextText = parts[i + 1] || '';

      const prefixMatch = prevText.match(/([a-zA-Z'\u2019-]+)$/);
      const prefix = prefixMatch ? prefixMatch[1] : '';
      if (prefix) {
        parts[i - 1] = prevText.slice(0, prevText.length - prefix.length);
      }

      const punctMatch = nextText.match(/^([.,;:!?"')\]]+)/);
      const trailingPunct = punctMatch ? punctMatch[1] : '';
      if (trailingPunct) {
        parts[i + 1] = nextText.slice(trailingPunct.length);
      }

      newBlanks.push({
        prefix,
        solution,
        trailingPunct,
        userValue: '',
      });
    }

    let blankCounter = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i]) {
          newSegments.push({ type: 'text', value: parts[i] });
        }
      } else {
        newSegments.push({
          type: 'blank',
          value: parts[i],
          blankIndex: blankCounter,
        });
        blankCounter++;
      }
    }

    setBlanks(newBlanks);
    setSegments(newSegments);
    setChecked(false);
    setScore(null);
    setFocusedIndex(null);
    setCoachHintBanner(null);
  }, [task]);

  const handleCheck = () => {
    let correctCount = 0;
    const evaluated = blanks.map((b) => {
      const isRight = isAcceptedCTestAnswer(b.prefix, b.userValue, b.solution);
      if (isRight) correctCount++;
      return { ...b, isCorrect: isRight };
    });

    setBlanks(evaluated);
    setChecked(true);
    setScore({ correct: correctCount, total: blanks.length });

    evaluated.forEach((b) => {
      if (!b.isCorrect) {
        const fullWord = `${b.prefix}${b.solution}`;
        saveMistake(
          `${b.prefix}_____ in "${task.title}"`,
          'Complete the Words',
          `${b.prefix}${b.userValue || '...'}`,
          fullWord,
          `Full word: "${fullWord}" (prefix "${b.prefix}" + missing suffix "${b.solution}")`
        );
      }
    });

    // Save record
    const scaledScore = convertToScaledScore(correctCount, blanks.length);
    savePracticeRecord({
      taskType: 'complete-words',
      taskTitle: task.title,
      section: 'Reading',
      score: correctCount,
      maxScore: blanks.length,
      scaledScore30: scaledScore,
      timeSpentSeconds: 60,
      feedbackSummary: `Complete the Words: scored ${correctCount}/${blanks.length} content words (${Math.round((correctCount / blanks.length) * 100)}%)`,
    });
    onComplete?.(scaledScore);
  };

  const handleCoachHintOneLetter = (explicitIdx?: number) => {
    if (checked || blanks.length === 0) return;
    let targetIdx = explicitIdx !== undefined ? explicitIdx : focusedIndex;
    if (
      targetIdx === null ||
      targetIdx === undefined ||
      isAcceptedCTestAnswer(blanks[targetIdx]?.prefix || '', blanks[targetIdx]?.userValue || '', blanks[targetIdx]?.solution || '')
    ) {
      const firstIncomplete = blanks.findIndex(
        (b) => !isAcceptedCTestAnswer(b.prefix, b.userValue, b.solution)
      );
      targetIdx = firstIncomplete !== -1 ? firstIncomplete : 0;
    }

    const b = blanks[targetIdx];
    if (!b) return;
    const sol = b.solution;
    const cur = b.userValue;

    // Find the first character position where userValue doesn't match solution
    let revealUpTo = 0;
    while (
      revealUpTo < sol.length &&
      cur[revealUpTo] &&
      cur[revealUpTo].toLowerCase() === sol[revealUpTo].toLowerCase()
    ) {
      revealUpTo++;
    }
    const nextValue = sol.slice(0, Math.min(sol.length, revealUpTo + 1));
    const fullWord = `${b.prefix}${sol}`;
    const posClue = inferWordPartOfSpeechClue(fullWord);

    setBlanks((prev) => {
      const updated = [...prev];
      updated[targetIdx!] = {
        ...updated[targetIdx!],
        userValue: nextValue,
        isCorrect: nextValue.length === sol.length ? true : undefined,
      };
      return updated;
    });

    setCoachHintBanner(
      `Blank #${targetIdx + 1}: "${b.prefix}${nextValue}${'_'.repeat(Math.max(0, sol.length - nextValue.length))}" — ${fullWord.length}-letter ${posClue} (${b.prefix.length} given + ${sol.length} missing letters)`
    );
    inputRefs.current[targetIdx]?.focus();
  };

  const handleCoachCheckProgress = () => {
    if (checked || blanks.length === 0) return;
    let correctSoFar = 0;
    let attemptedSoFar = 0;
    const evaluated = blanks.map((b) => {
      if (!b.userValue.trim()) {
        return { ...b, isCorrect: undefined };
      }
      attemptedSoFar++;
      const isRight = isAcceptedCTestAnswer(b.prefix, b.userValue, b.solution);
      if (isRight) correctSoFar++;
      return { ...b, isCorrect: isRight };
    });
    setBlanks(evaluated);
    setCoachHintBanner(
      `Progress Check: ${correctSoFar}/${blanks.length} blanks correct (${attemptedSoFar} attempted). Green blanks are verified; keep editing any red or empty blanks!`
    );
  };

  // Keyboard shortcut Ctrl+Enter or Cmd+Enter to submit anywhere
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (localStorage.getItem('toefl_shortcuts_enabled') === 'false') return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        if (!checked) {
          handleCheck();
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [blanks, checked]);

  const handleInputChange = (index: number, val: string) => {
    if (checked) return;
    const clean = val.replace(/[^a-zA-Z]/g, '');
    const maxLen = blanks[index].solution.length;
    const truncated = clean.slice(0, maxLen);

    const updated = [...blanks];
    updated[index] = {
      ...updated[index],
      userValue: truncated,
      isCorrect: undefined,
    };
    setBlanks(updated);

    // Auto-focus next input when current blank is filled
    if (truncated.length === maxLen && index < blanks.length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const shortcutsOn = localStorage.getItem('toefl_shortcuts_enabled') !== 'false';

    // Ctrl + Enter (or Cmd + Enter) submits the answers
    if (shortcutsOn && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      handleCheck();
      return;
    }

    if (shortcutsOn && coachMode && e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const b = blanks[index];
      if (b && !isAcceptedCTestAnswer(b.prefix, b.userValue, b.solution)) {
        e.preventDefault();
        handleCoachHintOneLetter(index);
        return;
      }
    }

    // Pressing Enter advances to the next answer dash
    if (shortcutsOn && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const nextIndex = (index + 1) % blanks.length;
      inputRefs.current[nextIndex]?.focus();
      return;
    }

    // Backspace jumps to previous blank if current is empty
    if (e.key === 'Backspace' && !blanks[index].userValue && index > 0) {
      e.preventDefault();
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleReset = () => {
    setBlanks((prev) => prev.map((b) => ({ ...b, userValue: '', isCorrect: undefined })));
    setChecked(false);
    setScore(null);
    setFocusedIndex(null);
    setCoachHintBanner(null);
  };

  return (
    <div className="space-y-4">
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
            {coachMode && (
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-800 border border-indigo-200">
                🎓 Coach &amp; Marathon Mode ({blanks.length} Blanks)
              </span>
            )}
          </div>
          <TaskSubtitleMeta task={task} extra={`${blanks.length} Word Underlines`} />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg">
            <Keyboard className="w-3.5 h-3.5 text-slate-400" />
            <span><strong className="font-semibold text-slate-800">Enter</strong>: Next dash</span>
            {coachMode && (
              <>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span><strong className="font-semibold text-indigo-700">Tab</strong>: +1 Letter Hint</span>
              </>
            )}
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span><strong className="font-semibold text-teal-800">Ctrl + Enter</strong>: Submit</span>
          </div>
          <TaskReportButton task={task} />
        </div>
      </div>

      {/* Collapsible Official Exam Format Context Note */}
      <CollapsibleTaskInstructions
        label="Task Instructions"
        summary="Type missing letters in each word blank · Press Enter for next dash · Ctrl + Enter to submit"
      >
        <strong>Navigation Guide:</strong> A vertical blinking cursor line indicates your active typing position.
        Press <strong>Enter</strong> to jump to the next word blank, and press <strong>Ctrl + Enter</strong> to check your answers.
      </CollapsibleTaskInstructions>

      {coachMode && !checked && (
        <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="text-xs text-indigo-950 space-y-0.5">
            <div className="font-bold text-indigo-900 flex items-center gap-1.5">
              <span>🎓 Interactive C-Test Coach Tools</span>
            </div>
            <p className="text-indigo-800">
              {coachHintBanner || 'Click any word blank and use "+1 Letter Hint" (or press Tab) to reveal one letter + part-of-speech clue, or check your progress without locking the test.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => handleCoachHintOneLetter()}
              className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-indigo-100 text-indigo-900 border border-indigo-300 rounded-lg shadow-2xs transition-colors cursor-pointer"
            >
              💡 Hint (+1 Letter)
            </button>
            <button
              type="button"
              onClick={handleCoachCheckProgress}
              className="px-3 py-1.5 text-xs font-semibold bg-indigo-700 hover:bg-indigo-800 text-white rounded-lg shadow-2xs transition-colors cursor-pointer"
            >
              ✓ Check Current Progress
            </button>
          </div>
        </div>
      )}

      {/* Interactive C-Test Paragraph with Cursor and Discrete Slots */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs">
        <p className="text-base leading-loose text-slate-800 font-normal">
          {segments.map((seg, idx) => {
            if (seg.type === 'text') {
              return <span key={idx}>{seg.value}</span>;
            }

            const bIndex = seg.blankIndex ?? 0;
            const blank = blanks[bIndex];
            if (!blank) return null;

            const targetLength = blank.solution.length;
            const isRight = blank.isCorrect === true;
            const isWrong = blank.isCorrect === false;
            const isFocused = focusedIndex === bIndex;
            const isFullyFilled = blank.userValue.length === targetLength;

            return (
              <span
                key={idx}
                className="inline-flex items-baseline whitespace-nowrap"
              >
                {blank.prefix && <span className="text-base font-normal text-slate-800">{blank.prefix}</span>}

                <span
                  onClick={() => inputRefs.current[bIndex]?.focus()}
                  className="inline-flex items-baseline relative cursor-text select-none group"
                >
                  {/* Hidden input capturing exact keystrokes */}
                  <input
                    ref={(el) => {
                      inputRefs.current[bIndex] = el;
                    }}
                    type="text"
                    maxLength={targetLength}
                    value={blank.userValue}
                    disabled={checked}
                    onFocus={() => setFocusedIndex(bIndex)}
                    onBlur={() => setFocusedIndex(null)}
                    onChange={(e) => handleInputChange(bIndex, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(bIndex, e)}
                    className="absolute inset-0 opacity-0 cursor-text z-10 w-full h-full pointer-events-auto text-base font-semibold"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={`Blank ${bIndex + 1} (${targetLength} letters)`}
                  />

                  {/* Visible discrete letter slots with high-contrast cursor */}
                  <span
                    className={`inline-flex items-baseline border-b-2 transition-colors relative ${
                      checked || blank.isCorrect !== undefined
                        ? isRight
                          ? 'border-emerald-600 bg-emerald-50/70'
                          : 'border-rose-500 bg-rose-50/70'
                        : isFocused
                        ? 'border-teal-700 bg-teal-50/40'
                        : 'border-slate-900 bg-transparent'
                    }`}
                  >
                    {Array.from({ length: targetLength }).map((_, charIdx) => {
                      const char = blank.userValue[charIdx];
                      const isCurrentSlot = isFocused && blank.userValue.length === charIdx;

                      return (
                        <span
                          key={charIdx}
                          className={`inline-flex items-center justify-center min-w-[10px] sm:min-w-[11px] h-5 px-[0.5px] text-base font-semibold tracking-normal transition-all relative ${
                            checked || blank.isCorrect !== undefined
                              ? isRight
                                ? 'text-emerald-900'
                                : 'text-rose-900'
                              : char
                              ? 'text-slate-950'
                              : 'text-slate-900'
                          }`}
                        >
                          {/* Blinking Vertical Cursor Bar */}
                          {isCurrentSlot && !checked && (
                            <span
                              aria-hidden="true"
                              className="absolute -left-[1px] top-[2px] bottom-[2px] w-[2px] bg-teal-700 animate-pulse rounded-full z-20 shadow-xs"
                            />
                          )}

                          {char ? (
                            char
                          ) : (
                            // Clean high-contrast dash matching passage font scale
                            <span className="text-slate-800 font-semibold leading-none pb-0.5">_</span>
                          )}
                        </span>
                      );
                    })}

                    {/* Cursor at the end of word when full and focused */}
                    {isFocused && isFullyFilled && !checked && (
                      <span
                        aria-hidden="true"
                        className="absolute -right-[1px] top-[2px] bottom-[2px] w-[2px] bg-teal-700 animate-pulse rounded-full z-20 shadow-xs"
                      />
                    )}
                  </span>

                  {/* Correction badge when checked and incorrect */}
                  {checked && isWrong && (
                    <span className="inline-flex items-center text-xs font-mono font-bold text-emerald-800 ml-1 bg-emerald-100/90 px-1.5 py-0.5 rounded border border-emerald-400">
                      {blank.solution}
                    </span>
                  )}
                </span>

                {blank.trailingPunct && <span className="text-slate-800">{blank.trailingPunct}</span>}
              </span>
            );
          })}
        </p>
      </div>

      {/* Score and Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
        <div className="flex items-center gap-3">
          {!checked ? (
            <button
              onClick={handleCheck}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-800 hover:bg-teal-900 rounded-lg shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              Check Answers (Ctrl+Enter)
            </button>
          ) : (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Try Again
            </button>
          )}

          {onNextTask && (
            <button
              onClick={onNextTask}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Next Practice Item
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>

        {score && (
          <div className="flex items-center gap-4 text-sm bg-slate-50 border border-slate-200 px-4 py-2 rounded-lg">
            <span className="text-slate-600">
              Score: <strong className="text-slate-900 font-mono text-base">{score.correct}</strong> / {score.total}
            </span>
            <span aria-hidden="true" className="text-slate-300">|</span>
            <span className="text-slate-600">
              Accuracy: <strong className="text-teal-700 font-mono">{Math.round((score.correct / score.total) * 100)}%</strong>
            </span>
            <span aria-hidden="true" className="text-slate-300">|</span>
            <span className="text-slate-600">
              Est. TOEFL: <strong className="text-teal-800 font-mono">Band {convertScaledToBand6(convertToScaledScore(score.correct, score.total), 'Reading').toFixed(1)} / 6.0</strong> <span className="text-slate-500 font-mono text-xs">({convertToScaledScore(score.correct, score.total)}/30)</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
