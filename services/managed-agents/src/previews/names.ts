// Preview names (work 074): which labels of `opencomputer.app` are previews,
// which are ours, and how a free one is generated. Pure.
//
// A preview is `https://<name>.opencomputer.app`: one DNS label, globally
// unique, first come. The tunnels the previews ride on sit one level deeper
// (`<tunnelId>.t.opencomputer.app`) and are never a preview.

export const PREVIEW_DOMAIN = "opencomputer.app";

/** One DNS label: lowercase letters, digits and inner hyphens, 1–63 characters. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Labels we keep for ourselves; a caller asking for one is refused. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "about", "abuse", "account", "admin", "api", "app", "assets", "auth", "billing", "blog", "cdn", "dashboard",
  "dev", "docs", "help", "id", "login", "mail", "news", "opencomputer", "preview", "previews", "security",
  "signin", "signup", "smtp", "static", "status", "support", "t", "www",
]);

export function validPreviewName(name: string): boolean {
  return NAME.test(name) && !name.includes("--") && !RESERVED_NAMES.has(name);
}

/** What a request's `Host` addresses on the preview domain. */
export type PreviewHost =
  | { kind: "apex" }
  | { kind: "preview"; name: string }
  | { kind: "other" };

export function previewHost(host: string | null, domain = PREVIEW_DOMAIN): PreviewHost {
  if (!host) return { kind: "other" };
  const bare = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (bare === domain || bare === `www.${domain}`) return { kind: "apex" };
  if (!bare.endsWith(`.${domain}`)) return { kind: "other" };
  const name = bare.slice(0, -domain.length - 1);
  return validPreviewName(name) ? { kind: "preview", name } : { kind: "other" };
}

// Generated names: adjective-noun-xxxx, 7 + 7 + 4·log2(31) ≈ 33.8 bits. Readable
// aloud, not guessable; the four characters avoid look-alikes.
const ADJECTIVES = [
  "amber", "ample", "azure", "balmy", "bold", "brave", "brisk", "bright", "calm", "candid", "cheery", "clear",
  "clever", "cosy", "crisp", "curious", "dapper", "daring", "deft", "dewy", "eager", "early", "easy", "elegant",
  "fair", "fancy", "fast", "fine", "fleet", "fresh", "frosty", "gentle", "giddy", "glad", "golden", "grand",
  "green", "happy", "hardy", "hazel", "honest", "humble", "icy", "ideal", "jolly", "keen", "kind", "lively",
  "lucid", "lucky", "mellow", "merry", "mighty", "misty", "modest", "neat", "nimble", "noble", "olive", "open",
  "plucky", "polite", "proud", "quick", "quiet", "rapid", "ready", "regal", "rosy", "royal", "rustic", "sandy",
  "savvy", "sharp", "shiny", "silent", "silver", "simple", "sleek", "smooth", "snowy", "solar", "sound", "spry",
  "steady", "stellar", "still", "sturdy", "sunny", "super", "sweet", "swift", "tidy", "tranquil", "true", "trusty",
  "upbeat", "vast", "velvet", "vivid", "warm", "wavy", "wild", "windy", "wise", "witty", "young", "zesty",
  "agile", "airy", "breezy", "bubbly", "cobalt", "coral", "crimson", "dusky", "fiery", "floral", "glossy", "hidden",
  "indigo", "ivory", "jade", "lunar", "maple", "minty", "pearly", "tawny",
] as const;

const NOUNS = [
  "acorn", "anchor", "apple", "arrow", "aspen", "badger", "bamboo", "beacon", "bear", "beetle", "birch", "bison",
  "breeze", "brook", "canyon", "cedar", "cherry", "cliff", "cloud", "clover", "comet", "coral", "cove", "crane",
  "creek", "daisy", "delta", "dolphin", "dove", "dune", "eagle", "ember", "falcon", "fern", "finch", "fjord",
  "flame", "forest", "fox", "garden", "gecko", "glacier", "grove", "harbor", "hawk", "heron", "hill", "island",
  "ivy", "jaguar", "kite", "koala", "lagoon", "lake", "lark", "leaf", "lemur", "lily", "lion", "lotus",
  "lynx", "maple", "marsh", "meadow", "mesa", "moon", "moose", "moss", "neon", "nest", "oak", "ocean",
  "orbit", "orchid", "otter", "owl", "panda", "peak", "pebble", "pine", "planet", "pond", "poppy", "prairie",
  "puffin", "quail", "rabbit", "raven", "reef", "ridge", "river", "robin", "rocket", "sage", "salmon", "shore",
  "sparrow", "spruce", "star", "stone", "stream", "summit", "swan", "thistle", "tide", "tiger", "trail", "tulip",
  "valley", "violet", "walnut", "wave", "willow", "wolf", "wren", "zebra", "aurora", "basil", "cactus", "cobra",
  "dahlia", "dingo", "elm", "galaxy", "hazel", "iris", "juniper", "kestrel",
] as const;

const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A random preview name; `random` is for tests. */
export function generatePreviewName(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(2));
  const adjective = ADJECTIVES[bytes[0]! % ADJECTIVES.length]!;
  const noun = NOUNS[bytes[1]! % NOUNS.length]!;
  // The word lists are 128 long, so a byte modulo them is uniform; the alphabet is not,
  // so bytes that would bias it are rejected instead.
  const limit = 256 - (256 % SUFFIX_ALPHABET.length);
  let suffix = "";
  while (suffix.length < 4) {
    for (const byte of random(new Uint8Array(8))) {
      if (byte < limit && suffix.length < 4) suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
    }
  }
  return `${adjective}-${noun}-${suffix}`;
}

export const WORD_LIST_SIZES = { adjectives: ADJECTIVES.length, nouns: NOUNS.length } as const;
