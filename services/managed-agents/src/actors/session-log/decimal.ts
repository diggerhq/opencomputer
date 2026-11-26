// Exact addition of decimal strings.

/** Exact decimal-string addition (costUsd is a decimal string; floats would drift). */
export function addDecimal(a: string | null, b: string): string {
  if (a === null) return b;
  const scale = Math.max(fraction(a), fraction(b));
  const total = toScaled(a, scale) + toScaled(b, scale);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}
const fraction = (s: string) => (s.includes(".") ? s.length - s.indexOf(".") - 1 : 0);
function toScaled(s: string, scale: number): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(`${whole}${frac.padEnd(scale, "0")}`);
}
