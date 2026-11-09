// Extracts a usable first name from an Instagram display name for the
// {first_name} personalization variable.
//
// A plain split(' ')[0] produces "Dr." for "Dr. John Smith", "❤️riana" for
// stylized names, and the whole run for "MARÍA JOSÉ". A cold DM that opens
// with the wrong token reads as an obvious mail-merge, so this cleans the
// input first and then picks the real given name.

// Latin letters dressed up in Unicode math/blackboard/fullwidth/etc. ranges,
// mapped back to plain ASCII. Instagram bios lean on these heavily.
const STYLIZED_RANGES = [
  // Mathematical bold, italic, script, fraktur, double-struck, sans, mono...
  [0x1d400, 0x1d7ff],
  // Fullwidth Latin
  [0xff21, 0xff3a, 0x41], // A-Z
  [0xff41, 0xff5a, 0x61], // a-z
  // Enclosed alphanumerics (circled letters)
  [0x24b6, 0x24cf, 0x41],
  [0x24d0, 0x24e9, 0x61],
];

function foldStylizedChar(cp) {
  // The math ranges repeat the 52-letter Latin alphabet in blocks; map each
  // codepoint back to its base letter by position within the block.
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    const offset = (cp - 0x1d400) % 52;
    return offset < 26
      ? String.fromCharCode(0x41 + offset)
      : String.fromCharCode(0x61 + (offset - 26));
  }
  for (const [lo, hi, base] of STYLIZED_RANGES) {
    if (base !== undefined && cp >= lo && cp <= hi) {
      return String.fromCharCode(base + (cp - lo));
    }
  }
  return null;
}

export function normalizeUnicodeText(input) {
  if (!input) return '';
  let s = String(input);

  // Fold stylized Latin back to ASCII, char by char.
  let folded = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const mapped = foldStylizedChar(cp);
    folded += mapped !== null ? mapped : ch;
  }

  // Decompose accents (é → e + combining mark) and drop the combining marks,
  // but keep the base letters. Zalgo stacks are combining marks, so this
  // clears them too.
  folded = folded.normalize('NFKD').replace(/[̀-ͯ]/g, '');

  // Strip emoji, symbols, and other non-name characters, keeping letters,
  // spaces, apostrophes and hyphens (O'Brien, Anna-Maria).
  folded = folded.replace(/[^\p{L}\p{M}\s'’.-]/gu, ' ');

  return folded.replace(/\s{2,}/g, ' ').trim();
}

// Tokens that are never the given name.
const PREFIXES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam', 'mx', 'rev', 'fr', 'st']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'dds', 'cpa']);
// Nobiliary particles: part of the surname, so a name that *starts* with one
// still means the next token is what we greet.
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'di', 'da', 'la', 'le', 'du', 'den', 'der', 'bin', 'al', 'el']);

export function parseFirstName(rawName, fallbackUsername = '') {
  const cleaned = normalizeUnicodeText(rawName);
  const tokens = cleaned
    .split(/\s+/)
    .map(t => t.replace(/^[.'’-]+|[.'’-]+$/g, ''))
    .filter(Boolean);

  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (PREFIXES.has(low) || SUFFIXES.has(low) || PARTICLES.has(low)) continue;
    // A lone initial ("J.") isn't a usable name.
    if (tok.length < 2) continue;
    return titleCase(tok);
  }

  // Contact name is authoritative. Never invent a greeting from an Instagram
  // username; if Contacts has no usable name, return an empty string and let
  // the caller decide how to handle the missing name.
  return '';
}

function titleCase(word) {
  if (!word) return '';
  // Capitalize the first letter of each sub-part split on apostrophe/hyphen,
  // so o'brien → O'Brien and anna-maria → Anna-Maria.
  return word
    .toLowerCase()
    .replace(/(^|['’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}
