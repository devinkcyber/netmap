/** Tiny typed event bus — used for one-shot graph commands (fit, focus a node, export). */

type Events = {
  fit: void;
  'reset-layout': void; // re-run the layout, discarding manual node moves
  'export-png': void;
  focus: string; // node id
};

type Handler<T> = (payload: T) => void;

const handlers = new Map<keyof Events, Set<(p?: unknown) => void>>();

export function on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(fn as (p?: unknown) => void);
  return () => set.delete(fn as (p?: unknown) => void);
}

export function emit<K extends keyof Events>(event: K, ...args: Events[K] extends void ? [] : [Events[K]]): void {
  handlers.get(event)?.forEach((fn) => fn(args[0]));
}

// ---------- localStorage helpers ----------

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}
