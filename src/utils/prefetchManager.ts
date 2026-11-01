import { TaskTypeId, TASK_DEFINITIONS } from '../types/taskTypes';
import { hasAnyProviderKey } from './apiKey';
import { callBackendGenerate } from '../services/geminiService';

export type PrefetchedItem = {
  id: string;
  level: string;
  topic: string;
  isPrefetched: true;
  modelUsed?: string;
  createdAt: number;
  [key: string]: any;
};

export type PrefetchQueue = Record<string, PrefetchedItem[]>;

const STORAGE_KEY = 'toefl_prefetched_queue_v4';
const COACH_STORAGE_KEY = 'toefl_prefetched_coach_queue_v2';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

if (typeof window !== 'undefined') {
  try {
    sessionStorage.removeItem('toefl_prefetched_queue_v3');
    sessionStorage.removeItem('toefl_prefetched_coach_queue_v1');
    localStorage.removeItem('toefl_prefetched_queue_v3');
    localStorage.removeItem('toefl_prefetched_coach_queue_v1');
  } catch {
    // ignore storage errors
  }
}

function getStorageKeyForMode(mode: 'exam' | 'coach' = 'exam'): string {
  return mode === 'coach' ? COACH_STORAGE_KEY : STORAGE_KEY;
}

export const PREFETCH_GAP_MS = 12000;
export const PREFETCH_COOLDOWN_MS = 30000;

export let consecutiveFailures = 0;
export let circuitBreakerOpen = false;
let lastFailureTime = 0;

export function resetPrefetchCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitBreakerOpen = false;
  lastFailureTime = 0;
}

export function recordPrefetchSuccess(): void {
  consecutiveFailures = 0;
  circuitBreakerOpen = false;
}

export function recordPrefetchFailure(): void {
  consecutiveFailures += 1;
  lastFailureTime = Date.now();
  if (consecutiveFailures >= 3) {
    circuitBreakerOpen = true;
  }
}

export function isPrefetchCircuitBreakerOpen(now: number = Date.now()): boolean {
  if (!circuitBreakerOpen) return false;
  if (now - lastFailureTime >= PREFETCH_COOLDOWN_MS) {
    consecutiveFailures = 0;
    circuitBreakerOpen = false;
    return false;
  }
  return true;
}

export async function prefetchQuestions(
  taskType: TaskTypeId,
  level: string,
  topic: string,
  mode: 'exam' | 'coach' = 'exam'
): Promise<PrefetchedItem | null> {
  if (!hasAnyProviderKey()) {
    return null;
  }

  // Reset circuit breaker when triggered with a valid provider key or after 30s cooldown
  if (hasAnyProviderKey() || Date.now() - lastFailureTime >= PREFETCH_COOLDOWN_MS) {
    consecutiveFailures = 0;
    circuitBreakerOpen = false;
  }

  try {
    const json = await callBackendGenerate(taskType, level, topic, mode === 'coach');
    if (json && json.success && json.data && !json.data.isFallback) {
      recordPrefetchSuccess();
      const item: PrefetchedItem = {
        ...json.data,
        level,
        topic,
        mode,
        id: json.data.id || `ai-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        isPrefetched: true,
        createdAt: Date.now(),
        source: 'ai',
      };
      const queue = loadPrefetchQueueFromStorage(mode);
      const currentItems = queue[taskType] || [];
      queue[taskType] = [...currentItems, item].slice(-2);
      savePrefetchQueueToStorage(queue, mode);
      return item;
    }
    recordPrefetchFailure();
    return null;
  } catch {
    recordPrefetchFailure();
    return null;
  }
}

export interface RateLimitPauseState {
  kind: 'per-minute' | 'per-day' | 'unknown';
  resumeAt: number;
  retryAfterSeconds: number;
}

export function evaluateRateLimitPause(
  errorOrResponse: any,
  now: number
): RateLimitPauseState {
  const errStr = JSON.stringify(errorOrResponse || '');
  let kind: 'per-minute' | 'per-day' | 'unknown' = 'per-minute';
  let retryAfterSeconds = 25;

  const match = errStr.match(/(\d+)\s*(?:s|sec|seconds|second)\b/i);
  if (match) {
    retryAfterSeconds = Math.max(5, parseInt(match[1], 10));
  }

  if (/(per[-_ ]?day|daily[-_ ]quota|daily[-_ ]limit|generate_content_free_tier_requests|resets at midnight pt)/i.test(errStr)) {
    kind = 'per-day';
    retryAfterSeconds = 3600;
  }

  const durationMs = kind === 'per-day' ? 3600 * 1000 : Math.max(20, (retryAfterSeconds + 2) * 1000);
  return {
    kind,
    resumeAt: now + durationMs,
    retryAfterSeconds,
  };
}

export function loadPrefetchQueueFromStorage(mode: 'exam' | 'coach' = 'exam'): PrefetchQueue {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(getStorageKeyForMode(mode));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const cleanQueue: PrefetchQueue = {};
    for (const [key, items] of Object.entries(parsed)) {
      if (Array.isArray(items)) {
        const valid = items.filter(
          (item: any) => item && typeof item === 'object' && now - (item.createdAt || 0) < CACHE_TTL_MS
        );
        if (valid.length > 0) cleanQueue[key] = valid;
      }
    }
    return cleanQueue;
  } catch (err) {
    return {};
  }
}

export function savePrefetchQueueToStorage(
  queue: PrefetchQueue,
  mode: 'exam' | 'coach' = 'exam'
): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(getStorageKeyForMode(mode), JSON.stringify(queue));
  } catch (err) {}
}

export function getPrefetchProgress(
  queue: PrefetchQueue,
  level: string,
  topic: string
): { done: boolean; filled: number; total: number } {
  let totalFilled = 0;
  for (const task of TASK_DEFINITIONS) {
    const items = queue[task.id] || [];
    const matching = items.filter((item) => item.level === level && item.topic === topic);
    totalFilled += Math.min(matching.length, 1);
  }
  const total = TASK_DEFINITIONS.length;
  const done = totalFilled >= total;
  return { done, filled: totalFilled, total };
}

export const BACKGROUND_PREFETCH_TASKS: TaskTypeId[] = TASK_DEFINITIONS.map((t) => t.id);

export function getNextTaskToPrefetch(
  currentTaskType: TaskTypeId,
  _queue: PrefetchQueue,
  _level: string,
  _topic: string,
  cooldowns: Record<string, number>,
  now: number
): TaskTypeId | null {
  const isEligible = (taskId: TaskTypeId) => {
    return (cooldowns[taskId] || 0) <= now;
  };

  // Only focus on the current active task — never loop across other sections!
  if (isEligible(currentTaskType)) {
    return currentTaskType;
  }

  return null;
}

export function hasReadyTask(queue: PrefetchQueue, taskType: string, level?: string, topic?: string): boolean {
  const items = queue[taskType] || [];
  if (items.length === 0) return false;
  if (level && level !== 'all' && topic && topic !== 'all') {
    return items.some((item) => item.level === level && item.topic === topic) || items.length > 0;
  }
  return items.length > 0;
}

export function popPrefetchedTask(
  queue: PrefetchQueue,
  taskType: string,
  level: string,
  topic: string,
  mode: 'exam' | 'coach' = 'exam'
): { item: PrefetchedItem | null; updatedQueue: PrefetchQueue } {
  const items = queue[taskType] || [];
  if (items.length === 0) return { item: null, updatedQueue: queue };

  const updatedQueue = { ...queue };
  const matchIdx = items.findIndex(
    (item) =>
      (!level || level === 'all' || item.level === level) &&
      (!topic || topic === 'all' || item.topic === topic)
  );
  const pickIdx = matchIdx !== -1 ? matchIdx : 0;
  const item = items[pickIdx];
  const remaining = items.filter((_, idx) => idx !== pickIdx);

  if (remaining.length > 0) {
    updatedQueue[taskType] = remaining;
  } else {
    delete updatedQueue[taskType];
  }
  savePrefetchQueueToStorage(updatedQueue, mode);
  return { item, updatedQueue };
}

