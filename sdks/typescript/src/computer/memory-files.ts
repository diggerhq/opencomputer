// A `Files` in memory: for tests, and the default of a caller with nowhere to keep blobs. What is
// kept here does not survive a reload (work 126, K2's fallback).

import type { Files } from "./client-interface.js";

export function memoryFiles(): Files {
  const map = new Map<string, Blob>();
  return {
    async get(id) {
      return map.get(id);
    },
    async put(id, blob) {
      map.set(id, blob);
    },
    async delete(id) {
      map.delete(id);
    },
  };
}
