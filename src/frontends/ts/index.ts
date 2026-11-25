/**
 * TypeScript frontend (Layer 1) — parses the v1 TS dialect into IR.
 *
 * The dialect is exactly what the TS backend (src/backends/ts/, planned) will
 * emit, so a hop's output can feed the reverse edge unchanged:
 *
 *   - types spell `int` / `float` (a prelude aliases them to `number`);
 *     `number` / `any` / unions / generics beyond Map are rejected loudly
 *   - `let x: T = ...;` declarations, `x = ...;` reassignment
 *   - forrange -> `for (let i = a; i < b; i += s)` (also i++ / i-- / i -= s;
 *     a `>` condition heads downward)
 *   - foreach  -> `for (const x of xs)`
 *   - f-strings -> backtick templates
 *   - `//`     -> idiv(a, b)      (floor-div helper from the prelude)
 *   - `%`      -> imod(a, b)
 *   - `in`     -> isin(x, xs)     isnotin(x, xs)
 *   - str.isdigit -> isdigit(s)
 *   - d.pop(k) -> mapPop(d, k)    (returns the value, like Python)
 *   - d.keys() / d.values() -> Array.from(d.keys()) / Array.from(d.values())
 *   - methods canonicalized to IR names: push->append, toUpperCase->upper,
 *     toLowerCase->lower, trim->strip, replaceAll->replace,
 *     startsWith->startswith, endsWith->endswith; `indexOf` is left as-is —
 *     the inferencer maps it to list.index / string.find by object type
 *   - `print(...)` stays a free call (the prelude provides it)
 *   - class fields are bare declarations `count: int;` — no initializers
 *   - a prelude, if present, is wrapped in `//<ouro-prelude>` ...
 *     `//</ouro-prelude>` and skipped here
 *
 * Everything outside the subset fails LOUDLY with a line number, never
 * silently. After parsing, the shared inferencer fills the few remaining
 * null types (literal-initialized lets, foreach bindings) and validates.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tokenize, templateParts, decodeStr } from '../tokenizer.ts';
import type { Tok, LexSpec } from '../tokenizer.ts';
import type {
  Module, Item, Stmt, Expr, Ty, BinOp, Param, Method, ClassDecl, FunDecl,
} from '../../ir/types.ts';
import {
  TY_INT, TY_FLOAT, TY_BOOL, TY_STRING, TY_VOID, eInt, eFloat, eBool, eStr, eVar,
  eThis, eBin, eUn, eCall, eMethod, eField, eIndex, eNew, eInterp,
  sVardecl, sAssign, sExpr, sReturn, sIf, sWhile, sForrange, sForeach, sBreak,
  sContinue, sPrint, TranspileError,
} from '../../ir/types.ts';
import { inferModule } from '../../infer/infer.ts';

const TS_SPEC: LexSpec = {
  lineComment: '//',
  blockComment: true,
  singleQuoted: true,
  template: true,
  threeChar: ['===', '!=='],
  twoChar: ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '=>', '?.'],
  single: '+-*/%<>!=;,.(){}[]:?',
  keywords: new Set([
    'let', 'const', 'var', 'function', 'return', 'if', 'else', 'while', 'for', 'of', 'in',
    'break', 'continue', 'new', 'class', 'this', 'constructor',
    'true', 'false', 'null', 'undefined',
    'import', 'export', 'typeof', 'static', 'readonly', 'interface', 'type', 'enum',
  ]),
};

const METHOD_CANON: Record<string, string> = {
  push: 'append',
  toUpperCase: 'upper',
  toLowerCase: 'lower',
  trim: 'strip',
  replaceAll: 'replace',
  replace: 'replace',
  startsWith: 'startswith',
  endsWith: 'endswith',
};

const PRELUDE_OPEN = '//<ouro-prelude>';
const PRELUDE_CLOSE = '//</ouro-prelude>';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private toks: Tok[];
  private i = 0;
  private lineStarts: number[];

  constructor(src: string) {
    const a = src.indexOf(PRELUDE_OPEN);
    if (a >= 0) {
      const b = src.indexOf(PRELUDE_CLOSE, a);
      if (b < 0) throw new TranspileError(`${PRELUDE_OPEN} is never closed`, 'ts');
      src = src.slice(0, a) + src.slice(b + PRELUDE_CLOSE.length);
    }
    this.lineStarts = [0];
    for (let j = 0; j < src.length; j++) {
      if (src[j] === '\n') this.lineStarts.push(j + 1);
    }
    this.toks = tokenize(src, TS_SPEC);
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
    throw new TranspileError(msg, 'ts', line);
  }

  // -- module ---------------------------------------------------------------

  parseModule(): { items: Item[]; mainBody: Stmt[] } {
    const items: Item[] = [];
    const mainBody: Stmt[] = [];
    while (!this.at('<eof>')) {
      const t = this.peek();
      if (t.t === 'function') { items.push(this.parseFun()); continue; }
      if (t.t === 'class') { items.push(this.parseClass()); continue; }
      if (['import', 'export', 'interface', 'enum', 'type', 'var'].includes(t.t)) {
        this.err(
          t.t === 'var'
            ? "the dialect declares with 'let', not 'var'"
            : `'${t.t}' at top level is not supported in v1`,
          t,
        );
      }
      mainBody.push(this.parseStmt());
    }
    return { items, mainBody };
  }

  // -- declarations ---------------------------------------------------------

  private parseFun(): FunDecl {
    this.expect('function');
    const nameTok = this.expect('ident', 'for the function name');
    this.expect('(');
    const params = this.parseParams();
    this.expect(')');
    const ret = this.at(':') ? (this.next(), this.parseTy()) : null;
    this.expect('{');
    const body = this.parseStmtsUntil('}');
    this.expect('}');
    return { name: nameTok.v, params, ret, body };
  }

  private parseParams(): Param[] {
    const out: Param[] = [];
    if (this.at(')')) return out;
    for (;;) {
      const t = this.peek();
      if (t.t === '?' || t.t === '=') {
        this.err('optional/default parameters are not supported in v1', t);
      }
      const nameTok = this.expect('ident', 'for a parameter name');
      this.expect(':');
      const ty = this.parseTy();
      out.push({ name: nameTok.v, ty });
      if (this.at(',')) { this.next(); continue; }
      break;
    }
    return out;
  }

  private parseClass(): ClassDecl {
    this.expect('class');
    const nameTok = this.expect('ident', 'for the class name');
    this.expect('{');
    const fields: ClassDecl['fields'] = [];
    let ctor: ClassDecl['ctor'] = null;
    const methods: Method[] = [];
    while (!this.at('}')) {
      if (this.at('<eof>')) this.err("unterminated class body (expected '}')");
      const t = this.peek();
      if (t.t === 'static' || t.t === 'readonly') {
        this.err(`'${t.t}' members are not supported in v1`, t);
      }
      if (t.t === 'constructor') {
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
      const nameTok = this.expect('ident', 'for a field or method name');
      if (this.at('(')) {
        this.next();
        const params = this.parseParams();
        this.expect(')');
        const ret = this.at(':') ? (this.next(), this.parseTy()) : null;
        this.expect('{');
        const body = this.parseStmtsUntil('}');
        this.expect('}');
        methods.push({ name: nameTok.v, params, ret, body });
        continue;
      }
      this.expect(':');
      const ty = this.parseTy();
      if (this.at('=')) {
        this.err('class field initializers are not supported in v1 (assign fields in the constructor)', this.peek());
      }
      this.expect(';');
      fields.push({ name: nameTok.v, ty });
    }
    this.expect('}');
    return { name: nameTok.v, fields, ctor, methods };
  }

  // -- types ----------------------------------------------------------------

  private parseTy(): Ty {
    const t = this.peek();
    if (t.t !== 'ident') this.err(`expected a type, found '${t.v || t.t}'`, t);
    this.next();
    const name = t.v;
    if (name === 'number') this.err("the dialect spells numeric types 'int' / 'float', not 'number'", t);
    if (name === 'Array') this.err("the dialect spells array types 'T[]', not 'Array<T>'", t);
    if (['any', 'unknown', 'never', 'object', 'symbol', 'bigint'].includes(name)) {
      this.err(`type '${name}' is not supported in v1`, t);
    }
    if (name === 'Map') {
      this.expect('<');
      const kt = this.expect('ident', 'as the Map key type');
      if (kt.v !== 'string') this.err('Map keys must be string in v1', kt);
      this.expect(',');
      const vt = this.parseTy();
      this.expect('>');
      return { k: 'map', val: vt };
    }
    let ty: Ty;
    if (name === 'int') ty = TY_INT;
    else if (name === 'float') ty = TY_FLOAT;
    else if (name === 'string') ty = TY_STRING;
    else if (name === 'boolean' || name === 'bool') ty = TY_BOOL;
    else if (name === 'void') ty = TY_VOID;
    else ty = { k: 'class', name };
    if (this.at('[')) {
      this.next();
      this.expect(']');
      return { k: 'list', elem: ty };
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
    if (t.t === 'let' || t.t === 'const') return this.parseLet();
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
    if (t.t === 'var') this.err("the dialect declares with 'let', not 'var'", t);
    if (t.t === '{') this.err('bare nested blocks are not part of the dialect', t);

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
    return sExpr(e);
  }

  private checkAssignTarget(e: Expr, tok: Tok): void {
    if (e.k !== 'var' && e.k !== 'field' && e.k !== 'index') {
      this.err('unsupported assignment target', tok);
    }
  }

  private parseLet(): Stmt {
    this.next(); // let / const
    const nameTok = this.expect('ident');
    let ty: Ty | null = null;
    if (this.at(':')) { this.next(); ty = this.parseTy(); }
    if (this.at(';')) {
      this.err('declaration without initializer is not supported in v1 (write `let x: int = ...`)', this.peek());
    }
    this.expect('=');
    const init = this.parseExpr();
    this.expect(';');
    return sVardecl(nameTok.v, ty, init);
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
    // foreach: for (const x of xs)
    if (this.at('const') || this.at('let')) {
      if (this.peek(2).t === 'of') {
        this.next();
        const nameTok = this.expect('ident');
        this.expect('of');
        const iter = this.parseExpr();
        this.expect(')');
        this.expect('{');
        const body = this.parseStmtsUntil('}');
        this.expect('}');
        return sForeach(nameTok.v, null, iter, body);
      }
      if (this.peek(2).t === 'in') {
        this.err('for-in is not part of the dialect (iterate with for-of over .keys())', this.peek(2));
      }
    }
    // forrange: for (let i = a; i < b; i += s)
    if (!this.at('let') && !this.at('const')) {
      this.err("for-loop must start with 'let i = ...' (forrange) or 'const x of ...' (foreach)", this.peek());
    }
    this.next();
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
    const t = this.peek();
    if (t.t === '++') { this.next(); return { delta: eInt(1), kind: 'inc' }; }
    if (t.t === '--') { this.next(); return { delta: eInt(1), kind: 'dec' }; }
    if (t.t === '+=') { this.next(); return { delta: this.parseExpr(), kind: 'inc' }; }
    if (t.t === '-=') { this.next(); return { delta: this.parseExpr(), kind: 'dec' }; }
    this.expect('=');
    const lhs = this.parseExpr();
    if (lhs.k !== 'var' || lhs.name !== varName) {
      this.err(`forrange update must reassign the loop variable '${varName}'`, t);
    }
    const opTok = this.peek();
    if (opTok.t !== '+' && opTok.t !== '-') {
      this.err("forrange update must be 'i++', 'i += s', 'i--', 'i -= s' or 'i = i ± s'", opTok);
    }
    this.next();
    const delta = this.parseExpr();
    return { delta, kind: opTok.t === '+' ? 'inc' : 'dec' };
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
    while (['==', '!=', '===', '!=='].includes(this.peek().t)) {
      const raw = this.next().t;
      const op: BinOp = raw === '===' ? '==' : raw === '!==' ? '!=' : (raw as BinOp);
      l = eBin(op, l, this.parseRel());
    }
    return l;
  }

  private parseRel(): Expr {
    let l = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.t === '<' || t.t === '<=' || t.t === '>' || t.t === '>=' || t.t === 'in') {
        this.next();
        l = eBin((t.t === 'in' ? 'in' : t.t) as BinOp, l, this.parseAdd());
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
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.t === '.') {
        this.next();
        const nameTok = this.expect('ident', "after '.'");
        if (e.k === 'var' && e.name === 'console') {
          this.err("console.* is not part of the dialect — use print(...)", nameTok);
        }
        if (this.at('(')) {
          this.next();
          const args = this.parseArgs();
          e = this.methodCall(e, nameTok.v, args, nameTok);
        } else {
          e = eField(e, nameTok.v);
        }
        continue;
      }
      if (t.t === '[') {
        this.next();
        const idx = this.parseExpr();
        this.expect(']');
        e = eIndex(e, idx);
        continue;
      }
      if (t.t === '?.') this.err('optional chaining is not part of the dialect', t);
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
    if (obj.k === 'var' && obj.name === 'Array') {
      if (
        name === 'from' && args.length === 1 && args[0].k === 'method' &&
        (args[0].name === 'keys' || args[0].name === 'values') && args[0].args.length === 0
      ) {
        return args[0];   // Array.from(d.keys()) -> the .keys() method itself
      }
      this.err('only Array.from(d.keys()) / Array.from(d.values()) are part of the dialect', tok);
    }
    return eMethod(obj, METHOD_CANON[name] ?? name, args);
  }

  /** Free call: prelude helpers + IR built-ins + user functions. */
  private freeCall(name: string, args: Expr[], tok: Tok): Expr {
    const two = (op: BinOp): Expr => {
      if (args.length !== 2) this.err(`${name}(a, b) takes exactly 2 arguments`, tok);
      return eBin(op, args[0], args[1]);
    };
    switch (name) {
      case 'idiv': return two('//');
      case 'imod': return two('%');
      case 'isin': return two('in');
      case 'isnotin': return two('notin');
      case 'isdigit':
        if (args.length !== 1) this.err('isdigit(s) takes exactly 1 argument', tok);
        return eMethod(args[0], 'isdigit', []);
      case 'mapPop':
        if (args.length !== 2) this.err('mapPop(d, k) takes exactly 2 arguments', tok);
        return eMethod(args[0], 'pop', [args[1]]);
      case 'len': case 'str': case 'int': case 'float': case 'print':
        return eCall(name, args);
      default:
        return eCall(name, args);
    }
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.t) {
      case 'int': this.next(); return eInt(parseInt(t.v, 10));
      case 'float': this.next(); return eFloat(parseFloat(t.v));
      case 'str': this.next(); return eStr(decodeStr(t.v));
      case 'template': this.next(); return this.interpOf(t);
      case 'true': this.next(); return eBool(true);
      case 'false': this.next(); return eBool(false);
      case 'null': this.err('null is not supported in v1', t);
      case 'undefined': this.err('undefined is not supported in v1', t);
      case 'this': this.next(); return eThis();
      case 'new': return this.parseNew();
      case 'ident': this.next(); return eVar(t.v);
      case '(': {
        this.next();
        const e = this.parseExpr();
        this.expect(')');
        return e;
      }
      case '[': {
        this.next();
        const elems: Expr[] = [];
        if (!this.at(']')) {
          for (;;) {
            elems.push(this.parseExpr());
            if (this.at(',')) { this.next(); continue; }
            break;
          }
        }
        this.expect(']');
        return { k: 'list', elems };
      }
      case 'typeof': this.err('typeof expressions are not supported in v1', t);
      default: this.err(`unexpected token '${t.v || t.t}' in expression`, t);
    }
  }

  private parseNew(): Expr {
    this.expect('new');
    const clsTok = this.expect('ident', "a class name after 'new'");
    if (clsTok.v === 'Map') {
      let valTy: Ty | null = null;
      if (this.at('<')) {
        this.next();
        const kt = this.expect('ident', 'as the Map key type');
        if (kt.v !== 'string') this.err('Map keys must be string in v1', kt);
        this.expect(',');
        valTy = this.parseTy();
        this.expect('>');
      }
      this.expect('(');
      const entries: { key: string; val: Expr }[] = [];
      const outer = this.at('[');          // new Map([["a", 1], ...]) — one array of pairs
      if (outer) this.next();
      if (!this.at(outer ? ']' : ')')) {   // also accept direct pair args: new Map(["a", 1], ...)
        for (;;) {
          this.expect('[');
          const keyTok = this.peek();
          if (keyTok.t !== 'str') this.err('Map keys must be string literals in v1', keyTok);
          this.next();
          const key = decodeStr(keyTok.v);
          this.expect(',');
          const val = this.parseExpr();
          this.expect(']');
          entries.push({ key, val });
          if (this.at(',')) { this.next(); continue; }
          break;
        }
      }
      if (outer) this.expect(']');
      this.expect(')');
      const e: Expr = { k: 'map', entries };
      if (valTy != null) e.valTy = valTy;
      return e;
    }
    if (this.at('<')) this.err('generics beyond list/map are not supported in v1', this.peek());
    this.expect('(');
    const args = this.parseArgs();
    return eNew(clsTok.v, args);
  }

  private interpOf(tok: Tok): Expr {
    const parts: (string | Expr)[] = [];
    for (const p of templateParts(tok.v)) {
      if (p.lit != null) parts.push(p.lit);
      else parts.push(this.parseSubExpr(p.expr ?? '', tok));
    }
    return eInterp(parts);
  }

  private parseSubExpr(text: string, tok: Tok): Expr {
    const p = new Parser(text);
    const e = p.parseExpr();
    if (!p.at('<eof>')) {
      p.err(`unexpected trailing input in template expression '${text}'`, tok);
    }
    return e;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Load a TypeScript file (the v1 dialect) into a fully-typed IR Module. */
export function parseTsFile(filePath: string): Module {
  let src: string;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new TranspileError(`cannot read '${filePath}': ${(e as Error).message}`, 'ts');
  }
  const { items, mainBody } = new Parser(src).parseModule();
  if (mainBody.length > 0 && items.some(i => !('fields' in i) && i.name === 'main')) {
    throw new TranspileError("module defines its own 'main' and has top-level statements — conflict", 'ts');
  }
  if (mainBody.length > 0) {
    items.push({ name: 'main', params: [], ret: TY_VOID, body: mainBody });
  }
  const name = basename(filePath).replace(/\.[^.]+$/, '');
  const m: Module = { name, sourceLang: 'ts', items };
  inferModule(m);   // fill remaining nulls (literal lets, foreach) + validate
  return m;
}
