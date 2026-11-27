import { upgradeRecord, type MatchRecord } from "../../engine/record";

const HISTORY_KEY = "uplink-duel.history.v1";
const MAX_SAVED = 40;

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const OPENROUTER_KEY = "uplink-duel.openrouter-key";

export const loadOpenRouterKey = (): string => loadJson<string>(OPENROUTER_KEY, "");

/** Saves the key in this browser, or removes it when empty. False when the browser refuses storage. */
export const saveOpenRouterKey = (key: string): boolean => saveJson(OPENROUTER_KEY, key);

/** Saved matches, newest first. Records that fail to load (e.g. from a newer version) are skipped. */
export function loadHistory(): MatchRecord[] {
  const raw = loadJson<unknown[]>(HISTORY_KEY, []);
  const out: MatchRecord[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    try {
      out.push(upgradeRecord(entry));
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
}

/** Stores a finished match. When storage is full the oldest matches are dropped until it fits. */
export function saveToHistory(record: MatchRecord): MatchRecord[] {
  let list = [record, ...loadHistory().filter((r) => r.id !== record.id)].slice(0, MAX_SAVED);
  while (list.length && !saveJson(HISTORY_KEY, list)) list = list.slice(0, -1);
  return list;
}

export function removeFromHistory(id: string): MatchRecord[] {
  const list = loadHistory().filter((r) => r.id !== id);
  saveJson(HISTORY_KEY, list);
  return list;
}

export function clearHistory(): void {
  saveJson(HISTORY_KEY, []);
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
