/**
 * TypeScript backend (Layer 3) — IR -> the v1 TS dialect.
 *
 * Emits exactly the dialect src/frontends/ts/ parses, around a skip-marked
 * prelude, so a `py->ts` edge followed by re-parse yields structurally
 * identical IR (gold-checked in tests/run.ts). The prelude gives the dialect
 * its Python semantics: print formatting, floor-div/mod, `in`, dict ops.
 *
 * Method dispatch is by canonical IR name; container kinds come from the
 * inferencer's stamps (index.objTy, foreach.iterTy, method.objTy). Dynamic
 * forrange steps (non-literal direction) fail loudly — v1 limitation.
 *
 * v1 divergences (documented in the README): int is a JS number (no 32-bit
 * limit, but no BigInt either); idiv/imod use Python floor semantics.
 */

import type { Module, Item, Stmt, Expr, Ty, FunDecl, ClassDecl } from '../../ir/types.ts';
import { tyShow, TranspileError } from '../../ir/types.ts';

const PRELUDE = `//<ouro-prelude>
// Python-flavored runtime helpers (the TS frontend skips this span on re-parse).
type int = number;
type float = number;

function pyStr(x: any): string {
  if (typeof x === "boolean") return x ? "True" : "False";
  if (typeof x === "number") return String(x);
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return "[" + x.map(pyRepr).join(", ") + "]";
  if (x instanceof Map) {
    return "{" + Array.from(x.entries()).map(([k, v]) => pyRepr(k) + ": " + pyRepr(v)).join(", ") + "}";
  }
  return String(x);
}
function pyRepr(x: any): string {
  return typeof x === "string" ? "'" + x + "'" : pyStr(x);
}
function print(...args: any[]): void { console.log(args.map(pyStr).join(" ")); }
function len(x: any): int { return x instanceof Map ? x.size : x.length; }
function str(x: any): string { return pyStr(x); }
function int(x: any): int { return (typeof x === "string" ? parseInt(x, 10) : Math.trunc(x)) as int; }
function float(x: any): float { return (typeof x === "string" ? parseFloat(x) : x) as float; }
function idiv(a: int, b: int): int {
  if (b === 0) throw new Error("ZeroDivisionError: division by zero");
  return Math.floor(a / b) as int;   // Python floor semantics
}
function imod(a: int, b: int): int {
  if (b === 0) throw new Error("ZeroDivisionError: modulo by zero");
  return (((a % b) + b) % b) as int; // Python floor semantics
}
function isin(x: any, xs: any): boolean { return xs instanceof Map ? xs.has(x) : xs.includes(x); }
function isnotin(x: any, xs: any): boolean { return !isin(x, xs); }
function isdigit(s: string): boolean { return /^\\d+$/.test(s); }
function mapGet<T>(d: Map<string, T>, k: string, def: T): T { return d.has(k) ? d.get(k)! : def; }
function mapIndex<T>(d: Map<string, T>, k: string): T {
  if (!d.has(k)) throw new Error("KeyError: " + k);
  return d.get(k)!;
}
function mapSet<T>(d: Map<string, T>, k: string, v: T): void { d.set(k, v); }
function mapPop<T>(d: Map<string, T>, k: string): T {
  if (!d.has(k)) throw new Error("KeyError: " + k);
  const v = d.get(k)!;
  d.delete(k);
  return v;
}
function listClear<T>(xs: T[]): void { xs.length = 0; }
const pySort = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);
//</ouro-prelude>`;

// Identifiers that are legal Python names but reserved in TypeScript/JS.
const TS_RESERVED = new Set([
  'let', 'const', 'var', 'function', 'class', 'extends', 'implements', 'interface',
  'new', 'switch', 'case', 'default', 'do', 'typeof', 'instanceof', 'of', 'undefined',
  'package', 'private', 'protected', 'public', 'static', 'super', 'this', 'void',
  'with', 'enum', 'await', 'yield', 'debugger', 'delete', 'throw', 'constructor',
  'declare', 'namespace', 'abstract', 'readonly', 'satisfies', 'asserts', 'keyof',
  'infer', 'as',
]);

function err(msg: string): never {
  throw new TranspileError(msg, 'ts', null);
}

/** Identifier guard: fail loudly on TS-reserved names instead of emitting broken code. */
function ident(name: string): string {
  if (TS_RESERVED.has(name)) err(`'${name}' is a reserved word in TypeScript — rename it in the source`);
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function emitTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int';
    case 'float': return 'float';
    case 'bool': return 'boolean';
    case 'string': return 'string';
    case 'void': return 'void';
    case 'list': return `${emitTy(t.elem)}[]`;
    case 'map': return `Map<string, ${emitTy(t.val)}>`;
    case 'class': return t.name;
    case 'any': err("unresolved 'any' type reached the backend (inferencer bug)");
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Parenthesize compound operands so re-parsing yields the same IR tree. */
function wrap(e: Expr): string {
  return e.k === 'bin' || e.k === 'un' ? `(${emitExpr(e)})` : emitExpr(e);
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function emitMethod(e: Extract<Expr, { k: 'method' }>): string {
  const o = emitExpr(e.obj);
  const a = e.args.map(emitExpr);
  if (e.objTy?.k === 'class') return `${o}.${e.name}(${a.join(', ')})`;
  switch (e.name) {
    case 'append': case 'push': return `${o}.push(${a[0]})`;
    case 'pop':
      return a.length === 1 ? `mapPop(${o}, ${a[0]})` : `${o}.pop()`;
    case 'index': case 'find': case 'indexOf': return `${o}.indexOf(${a[0]})`;
    case 'sort': return `${o}.sort(pySort)`;
    case 'reverse': return `${o}.reverse()`;
    case 'clear': return `listClear(${o})`;
    case 'join': return `${a[0]}.join(${o})`;      // IR: sep.join(xs) -> TS-native xs.join(sep)
    case 'upper': return `${o}.toUpperCase()`;
    case 'lower': return `${o}.toLowerCase()`;
    case 'strip': case 'trim': return `${o}.trim()`;
    case 'replace': return `${o}.replaceAll(${a[0]}, ${a[1]})`;
    case 'split': return `${o}.split(${a[0]})`;
    case 'startswith': return `${o}.startsWith(${a[0]})`;
    case 'endswith': return `${o}.endsWith(${a[0]})`;
    case 'isdigit': return `isdigit(${o})`;
    case 'get': return `mapGet(${o}, ${a[0]}, ${a[1]})`;
    case 'keys': return `Array.from(${o}.keys())`;
    case 'values': return `Array.from(${o}.values())`;
    default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
  }
}

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'float': return Number.isInteger(e.v) ? e.v.toFixed(1) : String(e.v);
    case 'bool': return e.v ? 'true' : 'false';
    case 'str': return JSON.stringify(e.v);
    case 'null': err('null reached the backend (inferencer bug)');
    case 'var': return ident(e.name);
    case 'this': return 'this';
    case 'bin': return emitBin(e);
    case 'un': return `${e.op}${wrap(e.e)}`;
    case 'call': return `${e.name}(${e.args.map(emitExpr).join(', ')})`;
    case 'method': return emitMethod(e);
    case 'field': return `${emitExpr(e.obj)}.${e.name}`;
    case 'index':
      return e.objTy?.k === 'map'
        ? `mapIndex(${emitExpr(e.obj)}, ${emitExpr(e.idx)})`
        : `${wrap(e.obj)}[${emitExpr(e.idx)}]`;
    case 'list': return `[${e.elems.map(emitExpr).join(', ')}]`;
    case 'map':
      return `new Map<string, ${emitTy(e.valTy ?? null)}>([${
        e.entries.map(en => `[${JSON.stringify(en.key)}, ${emitExpr(en.val)}]`).join(', ')
      }])`;
    case 'new': return `new ${e.cls}(${e.args.map(emitExpr).join(', ')})`;
    case 'interp':
      return '`' + e.parts.map(p => typeof p === 'string' ? escapeTemplate(p) : `\${${emitExpr(p)}}`).join('') + '`';
  }
}

function emitBin(e: Extract<Expr, { k: 'bin' }>): string {
  switch (e.op) {
    case '//': return `idiv(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '%': return `imod(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case 'in': return `isin(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case 'notin': return `isnotin(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    default: return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;   // TS '/' is already true division
  }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** C-style update for forrange: direction comes from the step's static shape. */
function forrangeUpdate(step: Expr): { cmp: '<' | '>'; delta: string } {
  if (step.k === 'int') {
    if (step.v === 0) err('forrange step cannot be 0');
    return { cmp: '<', delta: step.v === 1 ? '++' : `+= ${step.v}` };
  }
  if (step.k === 'un' && step.op === '-') {
    const inner = step.e;
    if (inner.k === 'int') {
      if (inner.v === 0) err('forrange step cannot be 0');
      return { cmp: '>', delta: inner.v === 1 ? '--' : `-= ${inner.v}` };
    }
    return { cmp: '>', delta: `-= ${emitExpr(inner)}` };
  }
  err(`forrange with dynamic step is not supported in v1 (literal or negated-literal step required)`);
}

/** foreach iteration source: lists iterate directly, maps iterate keys. */
function foreachIter(s: Extract<Stmt, { k: 'foreach' }>): string {
  if (s.iterTy?.k === 'map') {
    if (s.iter.k === 'method' && (s.iter.name === 'keys' || s.iter.name === 'values')) {
      return `Array.from(${emitExpr(s.iter.obj)}.${s.iter.name}())`;
    }
    return `Array.from(${emitExpr(s.iter)}.keys())`;
  }
  return emitExpr(s.iter);
}

function emitStmt(s: Stmt, out: string[], ind: number): void {
  const pad = '  '.repeat(ind);
  switch (s.k) {
    case 'vardecl':
      out.push(`${pad}let ${ident(s.name)}: ${emitTy(s.ty)} = ${emitExpr(s.init)};`);
      break;
    case 'assign': {
      const t = s.target;
      if (t.k === 'var') out.push(`${pad}${ident(t.name)} = ${emitExpr(s.value)};`);
      else if (t.k === 'field') out.push(`${pad}${emitExpr(t.obj)}.${t.name} = ${emitExpr(s.value)};`);
      else if (t.k === 'index') {
        if (t.objTy?.k === 'map') {
          out.push(`${pad}mapSet(${emitExpr(t.obj)}, ${emitExpr(t.idx)}, ${emitExpr(s.value)});`);
        } else {
          out.push(`${pad}${wrap(t.obj)}[${emitExpr(t.idx)}] = ${emitExpr(s.value)};`);
        }
      } else err('unsupported assignment target reached the backend (inferencer bug)');
      break;
    }
    case 'expr':
      out.push(`${pad}${emitExpr(s.e)};`);
      break;
    case 'return':
      out.push(s.v ? `${pad}return ${emitExpr(s.v)};` : `${pad}return;`);
      break;
    case 'if': {
      out.push(`${pad}if (${emitExpr(s.cond)}) {`);
      emitBody(s.then, out, ind + 1);
      for (const el of s.elifs) {
        out.push(`${pad}} else if (${emitExpr(el.cond)}) {`);
        emitBody(el.body, out, ind + 1);
      }
      if (s.els) {
        out.push(`${pad}} else {`);
        emitBody(s.els, out, ind + 1);
      }
      out.push(`${pad}}`);
      break;
    }
    case 'while':
      out.push(`${pad}while (${emitExpr(s.cond)}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    case 'forrange': {
      const upd = forrangeUpdate(s.step);
      out.push(`${pad}for (let ${ident(s.varName)} = ${emitExpr(s.start)}; ${s.varName} ${upd.cmp} ${emitExpr(s.stop)}; ${s.varName} ${upd.delta}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    }
    case 'foreach':
      out.push(`${pad}for (const ${ident(s.varName)} of ${foreachIter(s)}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    case 'break': out.push(`${pad}break;`); break;
    case 'continue': out.push(`${pad}continue;`); break;
    case 'print':
      out.push(`${pad}print(${s.args.map(emitExpr).join(', ')});`);
      break;
  }
}

function emitBody(body: Stmt[], out: string[], ind: number): void {
  for (const s of body) emitStmt(s, out, ind);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function emitFun(f: FunDecl, out: string[]): void {
  const params = f.params.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
  out.push(`function ${ident(f.name)}(${params}): ${emitTy(f.ret)} {`);
  emitBody(f.body, out, 1);
  out.push('}', '');
}

function emitClass(c: ClassDecl, out: string[]): void {
  out.push(`class ${ident(c.name)} {`);
  for (const f of c.fields) out.push(`  ${ident(f.name)}: ${emitTy(f.ty)};`);
  if (c.ctor) {
    const params = c.ctor.params.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
    if (c.fields.length) out.push('');
    out.push(`  constructor(${params}) {`);
    emitBody(c.ctor.body, out, 2);
    out.push('  }', '');
  }
  for (const meth of c.methods) {
    const params = meth.params.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
    out.push(`  ${ident(meth.name)}(${params}): ${emitTy(meth.ret)} {`);
    emitBody(meth.body, out, 2);
    out.push('  }', '');
  }
  out.push('}', '');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function emitTs(m: Module): string {
  const out: string[] = [PRELUDE, ''];
  let main: FunDecl | undefined;
  for (const item of m.items) {
    if ('fields' in item) {
      emitClass(item, out);
    } else if (item.name === 'main') {
      main = item;   // emitted last (implicit main becomes top-level statements)
    } else {
      emitFun(item, out);
    }
  }
  if (main) {
    if (m.implicitMain) {
      out.push('// --- main (module-level statements) ---');
      emitBody(main.body, out, 0);
    } else {
      emitFun(main, out);
      // py/ts spell main as a plain declaration (python3 runs it only when
      // called); languages whose runtime treats main as the entry (C++ ...)
      // must actually run here
      if (m.sourceLang !== 'py' && m.sourceLang !== 'ts') out.push('main();');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
