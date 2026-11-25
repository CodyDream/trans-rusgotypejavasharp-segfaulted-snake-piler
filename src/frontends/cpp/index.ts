/**
 * C++ frontend (Layer 1) — parses the v1 C++ dialect into IR.
 *
 * The dialect is the exact shape a C++ backend will emit: real, compilable
 * C++ whose runtime surface comes from the prelude header (the same code the
 * C++ backend will emit inside //<ouro-prelude>). That makes the dialect the
 * oracle language: `g++ -include test/cpp_prelude.hpp` runs it natively.
 *
 *   - types spell `long` (int is 32-bit in C++; IR ints are 64-bit),
 *     `double`, `bool`, `string`, `vector<T>`, `PyDict<T>` — `int`, `float`,
 *     `auto` (outside foreach), `std::`, pointers, `char` fail loudly
 *   - declarations require explicit types: `long x = ...;` — the initializer
 *     may be a braced list `{1, 2}` (list) or pair list `{{"a", 1}}` (map)
 *   - `vector<T>(...)` / `vector<T>{...}` and `PyDict<V>{...}` / `PyDict<V>()`
 *     are list / map literals in expression position
 *   - forrange -> `for (long i = a; i < b; i += s)` (also i++ / i-- / i -= s;
 *     a `>` condition heads downward)
 *   - foreach  -> `for (const auto& x : xs)` (the only `auto` allowed)
 *   - fields and methods go through `this->`; classes end with `};`
 *   - methods canonicalized to IR names: push_back->append, pop_back->pop,
 *     size()->len; sort/reverse/string transforms are prelude free helpers:
 *     pysort(xs), pyreverse(xs), pyupper(s), pylower(s), pystrip(s),
 *     pyreplace(s,a,b), pysplit(s,sep), pystartswith(s,p), pyendswith(s,p),
 *     pystr_find(s,n), pyisdigit(s), pyjoin(sep,xs), pylist_index(xs,v),
 *     pypop(xs)
 *   - `//` and `%` (floor semantics) spell idiv(a,b) / imod(a,b); membership
 *     (no C++ `in`) spells pyin(x, xs) / pynotin(x, xs); conversions spell
 *     pystr(x) / pyint(x) / pyfloat(x); `len(x)` keeps its name
 *   - `d.set(k, v);` as a statement is map index-assignment
 *   - `print(...)` stays a free call (the prelude provides it)
 *   - a prelude, if present, is wrapped in `//<ouro-prelude>` ...
 *     `//</ouro-prelude>` and skipped here
 *
 * Everything outside the subset fails LOUDLY with a line number, never
 * silently. After parsing, the shared inferencer fills the few remaining
 * null types (braced-list element types, foreach bindings) and validates.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tokenize, decodeStr } from '../tokenizer.ts';
import type { Tok, LexSpec } from '../tokenizer.ts';
import type {
  Module, Item, Stmt, Expr, Ty, BinOp, Param, Method, ClassDecl, FunDecl,
} from '../../ir/types.ts';
import {
  TY_INT, TY_FLOAT, TY_BOOL, TY_STRING, TY_VOID, eInt, eFloat, eBool, eStr, eVar,
  eThis, eBin, eUn, eCall, eMethod, eField, eIndex, eNew,
  sVardecl, sAssign, sExpr, sReturn, sIf, sWhile, sForrange, sForeach, sBreak,
  sContinue, sPrint, TranspileError,
} from '../../ir/types.ts';
import { inferModule } from '../../infer/infer.ts';

const CPP_SPEC: LexSpec = {
  lineComment: '//',
  blockComment: true,
  twoChar: ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '->', '::'],
  single: '+-*/%<>!=;,.(){}[]:&',
  keywords: new Set([
    'if', 'else', 'while', 'for', 'return', 'break', 'continue',
    'true', 'false', 'class', 'public', 'private', 'protected', 'this',
    'const', 'auto', 'new', 'delete', 'nullptr', 'sizeof',
    'static', 'virtual', 'override', 'final', 'template', 'typename',
    'namespace', 'using', 'typedef', 'struct', 'enum', 'union',
    'try', 'catch', 'throw', 'switch', 'case', 'default', 'do', 'goto',
    'friend', 'mutable', 'explicit', 'operator', 'inline', 'extern',
    'constexpr', 'consteval', 'noexcept', 'reinterpret_cast', 'static_cast',
    'const_cast', 'dynamic_cast', 'co_await', 'co_yield', 'co_return',
    'requires', 'concept', 'export', 'module', 'volatile', 'register',
  ]),
};

const PRELUDE_OPEN = '//<ouro-prelude>';
const PRELUDE_CLOSE = '//</ouro-prelude>';

// Words that start a TYPE in the dialect. `vector` / `PyDict` are reserved
// outright (they carry generics, so no variable can be spelled that way);
// the plain ones only begin a declaration when followed by an identifier.
const GENERIC_TYPE_WORDS = new Set(['vector', 'PyDict']);
const PLAIN_TYPE_WORDS = new Set(['long', 'double', 'bool', 'string', 'void']);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private toks: Tok[];
  private i = 0;
  private lineStarts: number[];
  private classNames = new Set<string>();   // declared so far (C++ declares before use)

  constructor(src: string) {
    const a = src.indexOf(PRELUDE_OPEN);
    if (a >= 0) {
      const b = src.indexOf(PRELUDE_CLOSE, a);
      if (b < 0) throw new TranspileError(`${PRELUDE_OPEN} is never closed`, 'cpp');
      src = src.slice(0, a) + src.slice(b + PRELUDE_CLOSE.length);
    }
    this.lineStarts = [0];
    for (let j = 0; j < src.length; j++) {
      if (src[j] === '\n') this.lineStarts.push(j + 1);
    }
    this.toks = tokenize(src, CPP_SPEC);
  }

  // -- token plumbing -------------------------------------------------------

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)];
  }
  private at(t: string): boolean {
    return this.peek().t === t;
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private expect(t: string, what = ''): Tok {
    const tok = this.peek();
    if (tok.t !== t) {
      this.err(`expected '${t}'${what ? ` ${what}` : ''}, found '${tok.v || tok.t}'`, tok);
    }
    return this.next();
  }
  private err(msg: string, tok?: Tok): never {
    const t = tok ?? this.peek();
    let line = 1;
    for (const s of this.lineStarts) {
      if (s <= t.pos) line = this.lineStarts.indexOf(s) + 1;
      else break;
    }
    throw new TranspileError(msg, 'cpp', line);
  }

  // -- module ---------------------------------------------------------------

  parseModule(): { items: Item[]; mainBody: Stmt[] } {
    const items: Item[] = [];
    const mainBody: Stmt[] = [];
    while (!this.at('<eof>')) {
      const t = this.peek();
      if (t.v === 'int' && t.t === 'ident' && this.peek(1).v === 'main' && this.peek(2).t === '(') {
        // C++ requires the entry to spell `int main()` — IR's entry is void
        this.next();   // consume the spelled 'int'
        items.push(this.parseDeclOrFun(TY_VOID));
        continue;
      }
      if (this.atTypeStart()) { items.push(this.parseDeclOrFun()); continue; }
      if (t.t === 'class') { items.push(this.parseClass()); continue; }
      if (t.t === 'template' || t.t === 'namespace' || t.t === 'using' || t.t === 'typedef') {
        this.err(`'${t.v}' at top level is not supported in v1`, t);
      }
      mainBody.push(this.parseStmt());
    }
    return { items, mainBody };
  }

  /**
   * A declaration or function definition starts with a type. C++'s own rule:
   * `ident ident` can only be a declaration (`Matrix m`, `long x`), never an
   * expression — `foo(1)` / `x = 5` / `a.set(...)` don't match. Generics
   * (`vector<T>`, `PyDict<V>`) are reserved, so ident + '<' is always one.
   */
  private atTypeStart(): boolean {
    const t = this.peek();
    if (t.t !== 'ident') return false;
    if (this.peek(1).t === 'ident') return true;
    return this.peek(1).t === '<' && GENERIC_TYPE_WORDS.has(t.v);
  }

  // -- declarations ---------------------------------------------------------

  /** `T name(params) { ... }` (function) — reached only via atTypeStart. */
  private parseDeclOrFun(preRet?: Ty, skipRetTok = false): FunDecl {
    const ret = preRet ?? this.parseTy();
    const nameTok = this.expect('ident', 'for the function name');
    if (this.classNames.has(nameTok.v)) {
      this.err(`'${nameTok.v}' names both a class and a function (C++ rejects it too)`, nameTok);
    }
    this.expect('(');
    const params = this.parseParams();
    this.expect(')');
    this.expect('{');
    const body = this.parseStmtsUntil('}');
    this.expect('}');
    return { name: nameTok.v, params, ret, body };
  }

  private parseParams(): Param[] {
    const out: Param[] = [];
    if (this.at(')')) return out;
    for (;;) {
      if (this.at('const') && this.peek(1).t === 'ident' && this.peek(2).t === '&') {
        this.err('const-reference parameters are not part of the dialect (pass by value)', this.peek());
      }
      if (this.at('&') || this.at('*')) {
        this.err('reference/pointer parameters are not part of the dialect (pass by value)', this.peek());
      }
      const ty = this.parseTy();
      const nameTok = this.expect('ident', 'for a parameter name');
      out.push({ name: nameTok.v, ty });
      if (this.at(',')) { this.next(); continue; }
      break;
    }
    return out;
  }

  private parseClass(): ClassDecl {
    this.expect('class');
    const nameTok = this.expect('ident', 'for the class name');
    if (GENERIC_TYPE_WORDS.has(nameTok.v) || PLAIN_TYPE_WORDS.has(nameTok.v)) {
      this.err(`class name '${nameTok.v}' collides with a dialect type word`, nameTok);
    }
    this.classNames.add(nameTok.v);
    this.expect('{');
    const fields: ClassDecl['fields'] = [];
    let ctor: ClassDecl['ctor'] = null;
    const methods: Method[] = [];
    while (!this.at('}')) {
      if (this.at('<eof>')) this.err("unterminated class body (expected '}')");
      const t = this.peek();
      if (t.t === 'public' && this.peek(1).t === ':') { this.next(); this.next(); continue; }
      if (['private', 'protected'].includes(t.t)) {
        this.err(`'${t.v}:' members are not supported in v1 (everything is public)`, t);
      }
      if (t.t === 'static') {
        this.err("'static' members are not supported in v1", t);
      }
      if (t.t === 'class') {
        this.err('nested classes are not supported in v1', t);
      }
      // constructor: Name(params) { ... }
      if (t.t === 'ident' && t.v === nameTok.v && this.peek(1).t === '(') {
        this.next();
        this.expect('(');
        const params = this.parseParams();
        this.expect(')');
        this.expect('{');
        const body = this.parseStmtsUntil('}');
        this.expect('}');
        ctor = { params, body };
        continue;
      }
      if (t.t !== 'ident' || !(GENERIC_TYPE_WORDS.has(t.v) || PLAIN_TYPE_WORDS.has(t.v) || this.classNames.has(t.v))) {
        this.err(`expected a member declaration in class '${nameTok.v}' (fields spell 'long x;', methods 'long f() { ... }')`, t);
      }
      const mty = this.parseTy();
      const mName = this.expect('ident', 'for a field or method name');
      if (this.at('(')) {
        this.next();
        const params = this.parseParams();
        this.expect(')');
        this.expect('{');
        const body = this.parseStmtsUntil('}');
        this.expect('}');
        methods.push({ name: mName.v, params, ret: mty, body });
        continue;
      }
      this.expect(';');
      fields.push({ name: mName.v, ty: mty });
    }
    this.expect('}');
    if (this.at(';')) this.next();   // C++ requires the trailing `};`
    return { name: nameTok.v, fields, ctor, methods };
  }

  // -- types ----------------------------------------------------------------

  private parseTy(): Ty {
    const t = this.peek();
    if (t.t !== 'ident') this.err(`expected a type, found '${t.v || t.t}'`, t);
    this.next();
    const name = t.v;
    if (name === 'int') this.err("the dialect spells integers 'long' ('int' is 32-bit in C++, the IR is 64-bit)", t);
    if (name === 'float') this.err("the dialect spells floats 'double'", t);
    if (name === 'auto') this.err("'auto' is only allowed in 'for (const auto& x : xs)'", t);
    if (name === 'std') this.err("'std::' qualifications are not part of the dialect — the prelude aliases string/vector/PyDict", t);
    if (name === 'char' || name === 'unsigned' || name === 'signed' || name === 'short') {
      this.err(`type '${name}' is not supported in v1`, t);
    }
    if (name === 'vector' || name === 'PyDict') {
      this.expect('<');
      const elem = this.parseTy();
      this.expect('>');
      return name === 'vector' ? { k: 'list', elem } : { k: 'map', val: elem };
    }
    let ty: Ty;
    if (name === 'long') ty = TY_INT;
    else if (name === 'double') ty = TY_FLOAT;
    else if (name === 'bool') ty = TY_BOOL;
    else if (name === 'string') ty = TY_STRING;
    else if (name === 'void') ty = TY_VOID;
    else ty = { k: 'class', name };
    if (this.at('&') || this.at('*')) {
      this.err('reference/pointer types are not part of the dialect (values only)', this.peek());
    }
    return ty;
  }

  // -- statements -----------------------------------------------------------

  private parseStmtsUntil(closer: string): Stmt[] {
    const out: Stmt[] = [];
    while (!this.at(closer)) {
      if (this.at('<eof>')) this.err(`unterminated block (expected '${closer}')`);
      out.push(this.parseStmt());
    }
    return out;
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.t === 'if') return this.parseIf();
    if (t.t === 'while') return this.parseWhile();
    if (t.t === 'for') return this.parseFor();
    if (t.t === 'return') {
      this.next();
      if (this.at(';')) { this.next(); return sReturn(null); }
      const v = this.parseExpr();
      this.expect(';');
      return sReturn(v);
    }
    if (t.t === 'break') { this.next(); this.expect(';'); return sBreak(); }
    if (t.t === 'continue') { this.next(); this.expect(';'); return sContinue(); }
    if (t.t === 'const') {
      this.err("'const' declarations are not part of the dialect (only 'for (const auto& ...)')", t);
    }
    if (t.t === '{') this.err('bare nested blocks are not part of the dialect', t);
    if (this.atTypeStart()) return this.parseLocalDecl();

    const e = this.parseExpr();
    if (this.at('=')) {
      this.next();
      const value = this.parseExpr();
      this.expect(';');
      this.checkAssignTarget(e, t);
      return sAssign(e, value);
    }
    if (['+=', '-=', '*=', '/=', '%='].includes(this.peek().t)) {
      const opTok = this.next();
      const rhs = this.parseExpr();
      this.expect(';');
      this.checkAssignTarget(e, t);
      return sAssign(e, eBin(opTok.t[0] as BinOp, structuredClone(e), rhs));
    }
    if (this.at('++') || this.at('--')) {
      const op = this.next().t === '++' ? '+' : '-';
      this.expect(';');
      this.checkAssignTarget(e, t);
      return sAssign(e, eBin(op as BinOp, structuredClone(e), eInt(1)));
    }
    this.expect(';');
    if (e.k === 'call' && e.name === 'print') return sPrint(e.args);
    if (e.k === 'method' && e.name === 'set' && e.args.length === 2) {
      // d.set(k, v); is how the backend spells map index-assignment
      return sAssign(eIndex(e.obj, e.args[0]), e.args[1]);
    }
    return sExpr(e);
  }

  private checkAssignTarget(e: Expr, tok: Tok): void {
    if (e.k !== 'var' && e.k !== 'field' && e.k !== 'index') {
      this.err('unsupported assignment target', tok);
    }
  }

  /** `long x = init;` / `vector<long> xs = {1, 2};` inside a body. */
  private parseLocalDecl(): Stmt {
    const ty = this.parseTy();
    const nameTok = this.expect('ident', 'for the declared name');
    if (GENERIC_TYPE_WORDS.has(nameTok.v) || PLAIN_TYPE_WORDS.has(nameTok.v)) {
      this.err(`'${nameTok.v}' is a dialect type word and cannot name a variable`, nameTok);
    }
    if (this.at(';')) {
      this.err('declaration without initializer is not supported in v1 (write `long x = ...;`)', this.peek());
    }
    this.expect('=');
    const init = this.parseInitFor(ty);
    this.expect(';');
    return sVardecl(nameTok.v, ty, init);
  }

  /**
   * A declaration initializer: braced lists take their shape from the
   * declared type (`{1, 2}` list / `{{"a", 1}}` map); everything else parses
   * as an expression.
   */
  private parseInitFor(ty: Ty): Expr {
    if (this.at('{')) {
      const open = this.next();
      const elems: Expr[] = [];
      const entries: { key: string; val: Expr }[] = [];
      const isMap = ty.k === 'map';
      if (!this.at('}')) {
        for (;;) {
          if (isMap) {
            // both C++ spellings: {"k", v} pairs nested in braces, or flat
            const nested = this.at('{');
            if (nested) this.next();
            const kt = this.peek();
            if (kt.t !== 'str') this.err('PyDict keys must be string literals in v1', kt);
            this.next();
            this.expect(',');
            entries.push({ key: decodeStr(kt.v), val: this.parseExpr() });
            if (nested) this.expect('}');
          } else {
            elems.push(this.parseExpr());
          }
          if (this.at(',')) { this.next(); continue; }
          break;
        }
      }
      this.expectAt('}', open);
      return isMap ? { k: 'map', entries } : { k: 'list', elems };
    }
    return this.parseExpr();
  }

  private expectAt(t: string, open: Tok): Tok {
    const tok = this.peek();
    if (tok.t !== t) {
      this.err(`expected '${t}' to close the brace list opened at offset ${open.pos}, found '${tok.v || tok.t}'`, tok);
    }
    return this.next();
  }

  private parseIf(): Stmt {
    this.expect('if');
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    this.expect('{');
    const then = this.parseStmtsUntil('}');
    this.expect('}');
    const elifs: { cond: Expr; body: Stmt[] }[] = [];
    let els: Stmt[] | null = null;
    while (this.at('else')) {
      this.next();
      if (this.at('if')) {
        this.next();
        this.expect('(');
        const c = this.parseExpr();
        this.expect(')');
        this.expect('{');
        const body = this.parseStmtsUntil('}');
        this.expect('}');
        elifs.push({ cond: c, body });
        continue;
      }
      this.expect('{');
      els = this.parseStmtsUntil('}');
      this.expect('}');
      break;
    }
    return sIf(cond, then, elifs, els);
  }

  private parseWhile(): Stmt {
    this.expect('while');
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    this.expect('{');
    const body = this.parseStmtsUntil('}');
    this.expect('}');
    return sWhile(cond, body);
  }

  private parseFor(): Stmt {
    this.expect('for');
    this.expect('(');
    // foreach: for (const auto& x : xs)
    if (this.at('const')) {
      const autoTok = this.peek(1);
      if (autoTok.t !== 'auto') this.err("foreach spells 'for (const auto& x : xs)'", autoTok);
      if (this.peek(2).t !== '&') this.err("foreach spells 'for (const auto& x : xs)' (the '&' belongs to auto)", this.peek(2));
      this.next(); this.next(); this.next();
      const nameTok = this.expect('ident', 'as the loop variable');
      this.expect(':');
      const iter = this.parseExpr();
      this.expect(')');
      this.expect('{');
      const body = this.parseStmtsUntil('}');
      this.expect('}');
      return sForeach(nameTok.v, null, iter, body);
    }
    // forrange: for (long i = a; i < b; i += s)
    if (!this.atTypeStart()) {
      this.err("for-loop must start with a typed declaration 'long i = ...' (forrange) or 'const auto& x' (foreach)", this.peek());
    }
    this.parseTy();   // the loop variable's type (unused — IR forrange is untyped)
    const varTok = this.expect('ident');
    this.expect('=');
    const start = this.parseExpr();
    this.expect(';');
    const condTok = this.expect('ident', 'as the loop condition variable');
    const cmp = this.peek();
    if (cmp.t !== '<' && cmp.t !== '>') {
      this.err("forrange condition must be 'i < stop' or 'i > stop'", cmp);
    }
    this.next();
    const stop = this.parseExpr();
    this.expect(';');
    const up = this.parseForUpdate(condTok.v);
    this.expect(')');
    this.expect('{');
    const body = this.parseStmtsUntil('}');
    this.expect('}');
    if (condTok.v !== varTok.v) {
      this.err(`forrange condition tests '${condTok.v}' but the loop variable is '${varTok.v}'`, condTok);
    }
    if (cmp.t === '<' && up.kind === 'dec') {
      this.err("an upward forrange ('i < stop') cannot count down", cmp);
    }
    const step = cmp.t === '<' ? up.delta : eUn('-', up.delta);
    return sForrange(varTok.v, start, stop, step, body);
  }

  private parseForUpdate(varName: string): { delta: Expr; kind: 'inc' | 'dec' } {
    const nameTok = this.expect('ident', 'as the update target');
    if (nameTok.v !== varName) {
      this.err(`forrange update must reassign the loop variable '${varName}'`, nameTok);
    }
    const t = this.peek();
    if (t.t === '++') { this.next(); return { delta: eInt(1), kind: 'inc' }; }
    if (t.t === '--') { this.next(); return { delta: eInt(1), kind: 'dec' }; }
    if (t.t === '+=') { this.next(); return { delta: this.parseExpr(), kind: 'inc' }; }
    if (t.t === '-=') { this.next(); return { delta: this.parseExpr(), kind: 'dec' }; }
    this.expect('=');
    const rhs = this.parseExpr();
    if (rhs.k === 'bin' && (rhs.op === '+' || rhs.op === '-') && rhs.l.k === 'var' && rhs.l.name === varName) {
      return { delta: rhs.r, kind: rhs.op === '+' ? 'inc' : 'dec' };
    }
    this.err("forrange update must be 'i++', 'i += s', 'i--', 'i -= s' or 'i = i ± s'", nameTok);
  }

  // -- expressions ----------------------------------------------------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.at('||')) { this.next(); l = eBin('||', l, this.parseAnd()); }
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseEq();
    while (this.at('&&')) { this.next(); l = eBin('&&', l, this.parseEq()); }
    return l;
  }

  private parseEq(): Expr {
    let l = this.parseRel();
    while (this.at('==') || this.at('!=')) {
      const op = this.next().t as BinOp;
      l = eBin(op, l, this.parseRel());
    }
    return l;
  }

  private parseRel(): Expr {
    let l = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.t === '<' || t.t === '<=' || t.t === '>' || t.t === '>=') {
        this.next();
        l = eBin(t.t as BinOp, l, this.parseAdd());
        continue;
      }
      break;
    }
    return l;
  }

  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.at('+') || this.at('-')) {
      const op = this.next().t as BinOp;
      l = eBin(op, l, this.parseMul());
    }
    return l;
  }

  private parseMul(): Expr {
    let l = this.parseUnary();
    while (this.at('*') || this.at('/') || this.at('%')) {
      const op = this.next().t as BinOp;
      l = eBin(op, l, this.parseUnary());
    }
    return l;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.t === '-') { this.next(); return eUn('-', this.parseUnary()); }
    if (t.t === '!') { this.next(); return eUn('!', this.parseUnary()); }
    if (t.t === '+') this.err("unary '+' is not part of the dialect", t);
    if (t.t === '*') this.err('pointer dereference is not part of the dialect', t);
    if (t.t === '&') this.err("address-of '&' is not part of the dialect", t);
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.t === '.' || t.t === '->') {
        this.next();
        const nameTok = this.expect('ident', "after '.'");
        if (this.at('(')) {
          this.next();
          const args = this.parseArgs();
          e = this.methodCall(e, nameTok.v, args, nameTok);
        } else {
          e = eField(e, nameTok.v);
        }
        continue;
      }
      if (t.t === '::') this.err("'std::' qualifications are not part of the dialect — the prelude aliases string/vector/PyDict", t);
      if (t.t === '[') {
        this.next();
        const idx = this.parseExpr();
        this.expect(']');
        e = eIndex(e, idx);
        continue;
      }
      if (t.t === '(') {
        if (e.k !== 'var') this.err('calls on complex expressions are not part of the dialect', t);
        this.next();
        const args = this.parseArgs();
        e = this.freeCall(e.name, args, t);
        continue;
      }
      break;
    }
    return e;
  }

  private parseArgs(): Expr[] {
    const out: Expr[] = [];
    if (this.at(')')) { this.next(); return out; }
    for (;;) {
      out.push(this.parseExpr());
      if (this.at(',')) { this.next(); continue; }
      this.expect(')');
      break;
    }
    return out;
  }

  /** Method call with dialect canonicalization. */
  private methodCall(obj: Expr, name: string, args: Expr[], tok: Tok): Expr {
    if (name === 'push_back') return eMethod(obj, 'append', args);
    if (name === 'pop_back') {
      if (args.length > 0) this.err('pop_back(i) is not supported in v1', tok);
      return eMethod(obj, 'pop', []);
    }
    if (name === 'size') {
      if (args.length > 0) this.err('.size() takes no arguments', tok);
      return eCall('len', [obj]);
    }
    if (name === 'push' || name === 'append') {
      this.err("the dialect spells list append 'push_back'", tok);
    }
    if (['upper', 'lower', 'strip', 'trim', 'replace', 'split', 'startswith', 'endswith', 'find', 'isdigit', 'join', 'sort', 'reverse', 'index'].includes(name)) {
      this.err(`method '.${name}(...)' is not part of the dialect — use the prelude free helper (pyupper(s), pysort(xs), pyjoin(sep, xs), ...)`, tok);
    }
    return eMethod(obj, name, args);
  }

  /** Free call: prelude helpers + IR built-ins + user functions/constructors. */
  private freeCall(name: string, args: Expr[], tok: Tok): Expr {
    const two = (op: BinOp): Expr => {
      if (args.length !== 2) this.err(`${name}(a, b) takes exactly 2 arguments`, tok);
      return eBin(op, args[0], args[1]);
    };
    const one = (make: (x: Expr) => Expr, n: number, what: string): Expr => {
      if (args.length !== n) this.err(`${name}(...) takes exactly ${n} argument${n === 1 ? '' : 's'} (${what})`, tok);
      return make(args[0]);
    };
    switch (name) {
      case 'idiv': return two('//');
      case 'imod': return two('%');
      case 'pyin': return two('in');
      case 'pynotin': return two('notin');
      case 'pyisdigit': return one(x => eMethod(x, 'isdigit', []), 1, 'pyisdigit(s)');
      case 'pyupper': return one(x => eMethod(x, 'upper', []), 1, 'pyupper(s)');
      case 'pylower': return one(x => eMethod(x, 'lower', []), 1, 'pylower(s)');
      case 'pystrip': return one(x => eMethod(x, 'strip', []), 1, 'pystrip(s)');
      case 'pyreplace': {
        if (args.length !== 3) this.err('pyreplace(s, a, b) takes exactly 3 arguments', tok);
        return eMethod(args[0], 'replace', [args[1], args[2]]);
      }
      case 'pysplit': {
        if (args.length !== 2) this.err('pysplit(s, sep) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'split', [args[1]]);
      }
      case 'pystartswith': {
        if (args.length !== 2) this.err('pystartswith(s, p) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'startswith', [args[1]]);
      }
      case 'pyendswith': {
        if (args.length !== 2) this.err('pyendswith(s, p) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'endswith', [args[1]]);
      }
      case 'pystr_find': {
        if (args.length !== 2) this.err('pystr_find(s, n) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'find', [args[1]]);
      }
      case 'pyjoin': {
        if (args.length !== 2) this.err('pyjoin(sep, xs) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'join', [args[1]]);
      }
      case 'pysort': return one(x => eMethod(x, 'sort', []), 1, 'pysort(xs)');
      case 'pyreverse': return one(x => eMethod(x, 'reverse', []), 1, 'pyreverse(xs)');
      case 'pypop': return one(x => eMethod(x, 'pop', []), 1, 'pypop(xs)');
      case 'pylist_index': {
        if (args.length !== 2) this.err('pylist_index(xs, v) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'index', [args[1]]);
      }
      case 'pystr': return eCall('str', args);
      case 'pyint': return eCall('int', args);
      case 'pyfloat': return eCall('float', args);
      case 'len': case 'print': return eCall(name, args);
      case 'main': return eCall('main', args);
      default:
        if (this.classNames.has(name)) return eNew(name, args);
        return eCall(name, args);
    }
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.t) {
      case 'int': this.next(); return eInt(parseInt(t.v, 10));
      case 'float': this.next(); return eFloat(parseFloat(t.v));
      case 'str': this.next(); return eStr(decodeStr(t.v));
      case 'true': this.next(); return eBool(true);
      case 'false': this.next(); return eBool(false);
      case 'nullptr': this.err('nullptr is not supported in v1', t);
      case 'new': this.err("'new' (heap allocation) is not part of the dialect — objects are values", t);
      case 'delete': this.err("'delete' is not part of the dialect", t);
      case 'sizeof': this.err("'sizeof' is not part of the dialect", t);
      case 'this': this.next(); return eThis();
      case 'auto': this.err("'auto' is only allowed in 'for (const auto& x : xs)'", t);
      case 'ident': {
        if (t.v === 'vector' && this.peek(1).t === '<') return this.parseVectorLit();
        if (t.v === 'PyDict' && this.peek(1).t === '<') return this.parsePyDictLit();
        this.next();
        return eVar(t.v);
      }
      case '(': {
        this.next();
        const e = this.parseExpr();
        this.expect(')');
        return e;
      }
      default: this.err(`unexpected token '${t.v || t.t}' in expression`, t);
    }
  }

  /** vector<T>() / vector<T>{...} — empty or braced list literal. */
  private parseVectorLit(): Expr {
    const open = this.expect('ident', "'vector'");
    this.expect('<');
    this.parseTy();
    this.expect('>');
    if (this.at('(')) {
      this.next();
      if (!this.at(')')) {
        this.err('vector<T>(args) is not part of the dialect (use {1, 2} or vector<T>())', this.peek());
      }
      this.next();
      return { k: 'list', elems: [] };
    }
    this.expectAt('{', open);
    const elems: Expr[] = [];
    if (!this.at('}')) {
      for (;;) {
        elems.push(this.parseExpr());
        if (this.at(',')) { this.next(); continue; }
        break;
      }
    }
    this.expectAt('}', open);
    return { k: 'list', elems };
  }

  /** PyDict<V>() / PyDict<V>{ {"a", 1}, ... } — empty or pair-list map literal. */
  private parsePyDictLit(): Expr {
    const open = this.expect('ident', "'PyDict'");
    this.expect('<');
    this.parseTy();
    this.expect('>');
    const entries: { key: string; val: Expr }[] = [];
    if (this.at('(')) {
      this.next();
      if (!this.at(')')) {
        this.err('PyDict<V>(args) is not part of the dialect (use PyDict<V>{ {"a", 1} })', this.peek());
      }
      this.next();
      return { k: 'map', entries };
    }
    this.expectAt('{', open);
    if (!this.at('}')) {
      for (;;) {
        const nested = this.at('{');
        if (nested) this.next();
        const kt = this.peek();
        if (kt.t !== 'str') this.err('PyDict keys must be string literals in v1', kt);
        this.next();
        this.expect(',');
        entries.push({ key: decodeStr(kt.v), val: this.parseExpr() });
        if (nested) this.expect('}');
        if (this.at(',')) { this.next(); continue; }
        break;
      }
    }
    this.expectAt('}', open);
    return { k: 'map', entries };
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Load a C++ file (the v1 dialect) into an IR Module (types filled by infer). */
export function parseCppFile(filePath: string): Module {
  let src: string;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new TranspileError(`cannot read '${filePath}': ${(e as Error).message}`, 'cpp');
  }
  const { items, mainBody } = new Parser(src).parseModule();
  if (mainBody.length > 0 && items.some(i => !('fields' in i) && i.name === 'main')) {
    throw new TranspileError("module defines its own 'main' and has top-level statements — conflict", 'cpp');
  }
  if (mainBody.length > 0) {
    items.push({ name: 'main', params: [], ret: TY_VOID, body: mainBody });
  }
  const name = basename(filePath).replace(/\.[^.]+$/, '');
  const m: Module = { name, sourceLang: 'cpp', items, implicitMain: mainBody.length > 0 };
  // NOTE: inference happens in the CLI (loadTyped/trans/link), never here —
  // a module may reference classes/functions defined in ANOTHER module that
  // only type-check once the linker has merged them.
  return m;
}

void inferModule;   // inference runs in the CLI; kept for symmetry with the ts frontend
