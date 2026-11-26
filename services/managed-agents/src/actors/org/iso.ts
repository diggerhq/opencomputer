// Stored millisecond times as the API's ISO strings.

export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : iso(ms));
