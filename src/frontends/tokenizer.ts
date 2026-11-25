/**
 * Shared tokenizer (Layer 1 kit) — one lexer for every hand-written frontend.
 *
 * Frontends for ts/cs/java/go/rust/cpp parse the exact dialect their backend
 * emits (a regular, machine-friendly shape). The tokenizer is shared; each
 * frontend declares its punctuation set and keyword set.
 */

export interface Tok { t: string; v: string; pos: number }

export interface LexSpec {
  lineComment?: string;        // '//' or '#'
  blockComment?: boolean;      // /* */
  singleQuoted?: boolean;      // python/rust char strings
  template?: boolean;          // backtick templates with ${}
  interpString?: boolean;      // C# $"..." interpolated strings
  threeChar?: string[];        // three-char punctuation tokens (===, !==, ...)
  twoChar: string[];           // two-char punctuation tokens
  single: string;              // one-char punctuation set
  keywords: Set<string>;
  keywordsCaseInsensitive?: boolean;
}

export function tokenize(src: string, spec: LexSpec): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (spec.lineComment && src.startsWith(spec.lineComment, i)) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (spec.blockComment && c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (spec.interpString && c === '$' && src[i + 1] === '"') {
      let j = i + 2;
      let raw = '$"';
      while (j < n) {
        if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === '"') { raw += '"'; j++; break; }
        raw += src[j]; j++;
      }
      toks.push({ t: 'istr', v: raw, pos: i });
      i = j;
      continue;
    }
    if (c === '"' || (spec.singleQuoted && c === "'")) {
      let j = i + 1;
      let raw = c;
      while (j < n) {
        if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === c) { raw += c; j++; break; }
        raw += src[j]; j++;
      }
      toks.push({ t: 'str', v: raw, pos: i });
      i = j;
      continue;
    }
    if (spec.template && c === '`') {
      const { raw, end } = scanTemplateRaw(src, i);
      toks.push({ t: 'template', v: raw, pos: i });
      i = end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && (/[0-9]/.test(src[j]) || (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) ||
        ((src[j] === 'e' || src[j] === 'E') && j > i))) j++;
      const raw = src.slice(i, j);
      toks.push({ t: raw.includes('.') || /e/i.test(raw) ? 'float' : 'int', v: raw, pos: i });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      const raw = src.slice(i, j);
      const key = spec.keywordsCaseInsensitive ? raw.toLowerCase() : raw;
      toks.push({ t: spec.keywords.has(key) ? key : 'ident', v: raw, pos: i });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (spec.threeChar?.includes(three)) { toks.push({ t: three, v: three, pos: i }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (spec.twoChar.includes(two)) { toks.push({ t: two, v: two, pos: i }); i += 2; continue; }
    if (spec.single.includes(c)) { toks.push({ t: c, v: c, pos: i }); i++; continue; }
    throw new Error(`tokenize: unexpected character '${c}' at offset ${i}`);
  }
  toks.push({ t: '<eof>', v: '', pos: n });
  return toks;
}

function scanTemplateRaw(src: string, start: number): { raw: string; end: number } {
  let i = start + 1;
  let raw = '`';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { raw += src[i] + src[i + 1]; i += 2; continue; }
    if (c === '`') { raw += '`'; return { raw, end: i + 1 }; }
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      raw += '${';
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { raw += '}'; i++; break; } }
        raw += src[i];
        i++;
      }
      continue;
    }
    raw += c;
    i++;
  }
  throw new Error('tokenize: unterminated template literal');
}

/** Split a raw template token into literal / ${expr} parts (expr text). */
export function templateParts(raw: string): { lit?: string; expr?: string }[] {
  const inner = raw.slice(1, -1); // strip backticks
  const parts: { lit?: string; expr?: string }[] = [];
  let cur = '';
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = inner[i];
    if (c === '\\') { cur += unescapeChar(inner[i + 1]); i += 2; continue; }
    if (c === '$' && inner[i + 1] === '{') {
      if (cur) parts.push({ lit: cur });
      cur = '';
      let depth = 1;
      let j = i + 2;
      let ex = '';
      while (j < n && depth > 0) {
        if (inner[j] === '{') depth++;
        else if (inner[j] === '}') { depth--; if (depth === 0) break; }
        ex += inner[j];
        j++;
      }
      parts.push({ expr: ex });
      i = j + 1;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur) parts.push({ lit: cur });
  return parts;
}

function unescapeChar(c: string): string {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '\0';
    default: return c;   // \\ \" \` \$ etc.
  }
}

/** Decode a quoted string token (JSON-style escapes). */
export function decodeStr(raw: string): string {
  return JSON.parse(raw);
}
