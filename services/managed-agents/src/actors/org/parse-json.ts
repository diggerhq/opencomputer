// A stored JSON column, read with a fallback.

export const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
