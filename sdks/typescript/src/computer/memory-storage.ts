// A `Storage` in memory: for tests, and for a caller with nowhere to keep things. Values are copied
// in and out as JSON, as a real store would.

import type { Storage } from "./types.js";

export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  const put = (key: string, value: unknown) => void map.set(key, JSON.stringify(value));
  return {
    async get(key) {
      const v = map.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
    async put(key, value) {
      put(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix) {
      return [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => [k, JSON.parse(map.get(k)!)] as [string, unknown]);
    },
    async batch(ops) {
      for (const op of ops) {
        if ("put" in op) put(op.put, op.value);
        else map.delete(op.delete);
      }
    },
  };
}
