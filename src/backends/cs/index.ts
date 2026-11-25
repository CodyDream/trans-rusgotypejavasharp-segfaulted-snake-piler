/**
 * C# backend (Layer 3) — IR -> a self-contained single-file C# program.
 *
 * One public class named after the module: the prelude rides along as static
 * helper methods plus an insertion-ordered PyDict<V> (Dictionary does not
 * guarantee order; Python dicts do), IR classes become nested classes, IR
 * functions become static methods, and the implicit main body lands inside
 * `static void Main`. Verified end to end with the .NET SDK
 * (`dotnet run <file>.cs`, .NET 10 file-based apps).
 *
 * v1 divergences (documented in the README): int is 32-bit (Python's are
 * arbitrary precision); uninitialized class fields default to 0/null instead
 * of raising; float formatting follows .NET for extreme values; shadowing a
 * variable name in an inner scope fails C# compilation (CS0136) — loud, not
 * silent.
 */

import type { Module, Stmt, Expr, Ty, FunDecl, ClassDecl } from '../../ir/types.ts';
import { TranspileError } from '../../ir/types.ts';

// Identifiers that are legal Python names but reserved in C#.
const CS_RESERVED = new Set([
  'as', 'base', 'bool', 'byte', 'case', 'catch', 'char', 'checked', 'class',
  'const', 'decimal', 'default', 'delegate', 'do', 'double', 'enum', 'event',
  'explicit', 'extern', 'fixed', 'float', 'goto', 'implicit', 'int',
  'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'object',
  'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc',
  'static', 'string', 'struct', 'switch', 'this', 'throw', 'typeof', 'uint',
  'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void',
  'volatile', 'Main',
]);

// Prelude helper names — user declarations must not shadow them.
const PRELUDE_NAMES = new Set([
  'print', 'len', 'str', 'pyInt', 'pyFloat', 'idiv', 'imod', 'isin',
  'isnotin', 'isdigit', 'PyMap', 'PySplit', 'PyStr', 'PyRepr', 'PyFloatStr',
  'PyDict', 'IPyDict', 'Main',
]);

const PRELUDE = `  // ---- prelude: Python-flavored runtime helpers ----

  interface IPyDict {
    bool Has(string k);
    int Count { get; }
  }

  class PyDict<V> : IPyDict {
    Dictionary<string, V> d = new Dictionary<string, V>();
    List<string> order = new List<string>();   // Python dicts preserve insertion order
    public bool Has(string k) { return d.ContainsKey(k); }
    public int Count { get { return d.Count; } }
    public V Get(string k, V def) { return d.ContainsKey(k) ? d[k] : def; }
    public V Index(string k) {
      if (!d.ContainsKey(k)) throw new Exception("KeyError: " + k);
      return d[k];
    }
    public void Set(string k, V v) {
      if (!d.ContainsKey(k)) order.Add(k);
      d[k] = v;
    }
    public V Pop(string k) {
      if (!d.ContainsKey(k)) throw new Exception("KeyError: " + k);
      V v = d[k];
      d.Remove(k);
      order.Remove(k);
      return v;
    }
    public List<string> Keys() { return new List<string>(order); }
    public List<V> Values() {
      List<V> l = new List<V>();
      foreach (string k in order) l.Add(d[k]);
      return l;
    }
    public override string ToString() {
      StringBuilder sb = new StringBuilder("{");
      for (int i = 0; i < order.Count; i++) {
        if (i > 0) sb.Append(", ");
        sb.Append(PyRepr(order[i])).Append(": ").Append(PyRepr(d[order[i]]));
      }
      return sb.Append('}').ToString();
    }
  }

  static void print(params object[] args) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < args.Length; i++) {
      if (i > 0) sb.Append(' ');
      sb.Append(PyStr(args[i]));
    }
    Console.WriteLine(sb);
  }

  static string PyStr(object x) {
    if (x is bool b) return b ? "True" : "False";
    if (x is int i) return i.ToString(CultureInfo.InvariantCulture);
    if (x is long l) return l.ToString(CultureInfo.InvariantCulture);
    if (x is double d) return PyFloatStr(d);
    if (x is string s) return s;
    if (x is System.Collections.IList list) {
      StringBuilder sb = new StringBuilder("[");
      for (int j = 0; j < list.Count; j++) {
        if (j > 0) sb.Append(", ");
        sb.Append(PyRepr(list[j]));
      }
      return sb.Append(']').ToString();
    }
    return x != null ? x.ToString() : "None";
  }

  static string PyRepr(object x) {
    return x is string s ? "'" + s + "'" : PyStr(x);
  }

  static string PyFloatStr(double d) {
    if (double.IsNaN(d)) return "nan";
    if (double.IsPositiveInfinity(d)) return "inf";
    if (double.IsNegativeInfinity(d)) return "-inf";
    if (d == Math.Floor(d) && Math.Abs(d) < 1e15) return d.ToString("0.0", CultureInfo.InvariantCulture);
    return d.ToString("R", CultureInfo.InvariantCulture);
  }

  static int len(object x) {
    if (x is string s) return s.Length;
    if (x is System.Collections.ICollection c) return c.Count;
    if (x is IPyDict p) return p.Count;
    throw new Exception("len() of unsupported type");
  }

  static string str(object x) { return PyStr(x); }

  static int pyInt(object x) {
    if (x is string s) return int.Parse(s.Trim(), CultureInfo.InvariantCulture);
    if (x is double d) return (int)d;   // truncate toward zero, like Python
    if (x is bool b) return b ? 1 : 0;
    if (x is int i) return i;
    throw new Exception("int() of unsupported type");
  }

  static double pyFloat(object x) {
    if (x is string s) return double.Parse(s.Trim(), CultureInfo.InvariantCulture);
    if (x is int i) return i;
    if (x is double d) return d;
    throw new Exception("float() of unsupported type");
  }

  static int idiv(int a, int b) {
    if (b == 0) throw new DivideByZeroException("division by zero");
    int q = a / b;                                   // truncates toward zero
    if (a % b != 0 && (a < 0) != (b < 0)) q -= 1;    // Python floors
    return q;
  }

  static int imod(int a, int b) {
    if (b == 0) throw new DivideByZeroException("modulo by zero");
    return ((a % b) + b) % b;   // Python floor semantics (result takes divisor's sign)
  }

  static bool isin(object x, object xs) {
    if (xs is string s) return s.Contains((string)x);
    if (xs is System.Collections.IList list) return list.Contains(x);
    if (xs is IPyDict p) return p.Has((string)x);
    throw new Exception("'in' of unsupported type");
  }

  static bool isnotin(object x, object xs) { return !isin(x, xs); }

  static bool isdigit(string s) {
    if (s.Length == 0) return false;
    foreach (char c in s) if (!char.IsDigit(c)) return false;
    return true;
  }

  static PyDict<V> PyMap<V>(params object[] kv) {
    PyDict<V> d = new PyDict<V>();
    for (int i = 0; i + 1 < kv.Length; i += 2) d.Set((string)kv[i], (V)kv[i + 1]);
    return d;
  }

  static List<string> PySplit(string s, string sep) {
    if (sep.Length == 0) throw new Exception("empty separator");
    List<string> parts = new List<string>();
    int i = 0;
    for (;;) {
      int j = s.IndexOf(sep, i, StringComparison.Ordinal);
      if (j < 0) { parts.Add(s.Substring(i)); return parts; }
      parts.Add(s.Substring(i, j - i));
      i = j + sep.Length;
    }
  }`;

let csRetTy: Ty | null = null;   // current function/method return type (typed list/map returns)

function err(msg: string): never {
  throw new TranspileError(msg, 'cs', null);
}

function ident(name: string): string {
  // C# verbatim identifiers let any keyword stay a variable/field/method name
  if (CS_RESERVED.has(name)) return `@${name}`;
  if (PRELUDE_NAMES.has(name)) err(`'${name}' collides with the C# prelude — rename it in the source`);
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Boxed form for generic type arguments (List<T> etc. need objects). */
function boxTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int';
    case 'float': return 'double';
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'list': return `List<${boxTy(t.elem)}>`;
    case 'map': return `PyDict<${boxTy(t.val)}>`;
    case 'class': return t.name;
    case 'void': case 'any': err(`type '${t.k}' cannot appear inside a generic (inferencer bug)`);
  }
}

function emitTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int';
    case 'float': return 'double';
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'void': return 'void';
    case 'list': return `List<${boxTy(t.elem)}>`;
    case 'map': return `PyDict<${boxTy(t.val)}>`;
    case 'class': return t.name;
    case 'any': err("unresolved 'any' type reached the backend (inferencer bug)");
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function wrap(e: Expr): string {
  return e.k === 'bin' || e.k === 'un' ? `(${emitExpr(e)})` : emitExpr(e);
}

function csEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/** f-string -> string concatenation; expr parts go through PyStr for True/False etc. */
function emitInterp(parts: (string | Expr)[]): string {
  const segs: string[] = [];
  let buf = '"';
  for (const p of parts) {
    if (typeof p === 'string') buf += csEscape(p);
    else {
      segs.push(`${buf}"`, `PyStr(${emitExpr(p)})`);
      buf = '"';
    }
  }
  segs.push(`${buf}"`);
  return segs.join(' + ');
}

function emitMethod(e: Extract<Expr, { k: 'method' }>): string {
  const o = emitExpr(e.obj);
  const a = e.args.map(emitExpr);
  if (e.objTy?.k === 'class') return `${o}.${e.name}(${a.join(', ')})`;
  switch (e.name) {
    case 'append': case 'push': return `${o}.Add(${a[0]})`;
    case 'pop':
      return a.length === 1 ? `${o}.Pop(${a[0]})` : `${o}.RemoveAt(${o}.Count - 1)`;
    case 'index': case 'find': case 'indexOf': return `${o}.IndexOf(${a[0]})`;
    case 'sort': return `${o}.Sort()`;
    case 'reverse': return `${o}.Reverse()`;
    case 'clear': return `${o}.Clear()`;
    case 'join': return `string.Join(${o}, ${a[0]})`;   // IR: sep.join(xs)
    case 'upper': return `${o}.ToUpperInvariant()`;
    case 'lower': return `${o}.ToLowerInvariant()`;
    case 'strip': case 'trim': return `${o}.Trim()`;
    case 'replace': return `${o}.Replace(${a[0]}, ${a[1]})`;   // literal, replaces all
    case 'split': return `PySplit(${o}, ${a[0]})`;
    case 'startswith': return `${o}.StartsWith(${a[0]}, StringComparison.Ordinal)`;
    case 'endswith': return `${o}.EndsWith(${a[0]}, StringComparison.Ordinal)`;
    case 'isdigit': return `isdigit(${o})`;
    case 'get': return `${o}.Get(${a[0]}, ${a[1]})`;
    case 'keys': return `${o}.Keys()`;
    case 'values': return `${o}.Values()`;
    default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
  }
}

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'float': return Number.isInteger(e.v) ? `${e.v.toFixed(1)}` : String(e.v);
    case 'bool': return e.v ? 'true' : 'false';
    case 'str': return `"${csEscape(e.v)}"`;
    case 'null': err('null reached the backend (inferencer bug)');
    case 'var': return ident(e.name);
    case 'this': return 'this';
    case 'bin': return emitBin(e);
    case 'un': return `${e.op}${wrap(e.e)}`;
    case 'call': return emitCall(e.name, e.args);
    case 'method': return emitMethod(e);
    case 'field': return `${emitExpr(e.obj)}.${e.name}`;
    case 'index':
      return e.objTy?.k === 'map'
        ? `${emitExpr(e.obj)}.Index(${emitExpr(e.idx)})`
        : `${wrap(e.obj)}[${emitExpr(e.idx)}]`;
    case 'list':
      return e.elems.length === 0
        ? `new ${emitTy({ k: 'list', elem: e.elemTy ?? { k: 'int' } })}()`
        : `new ${emitTy({ k: 'list', elem: e.elemTy ?? { k: 'int' } })} { ${e.elems.map(emitExpr).join(', ')} }`;
    case 'map':
      return `PyMap<${boxTy(e.valTy ?? null)}>(${e.entries.flatMap(en => [JSON.stringify(en.key), emitExpr(en.val)]).join(', ')})`;
    case 'new': return `new ${e.cls}(${e.args.map(emitExpr).join(', ')})`;
    case 'interp': return emitInterp(e.parts);
  }
}

/** Free calls: prelude names + IR built-ins; int/float need C#-safe names. */
function emitCall(name: string, args: Expr[]): string {
  const a = args.map(emitExpr);
  const jname = name === 'int' ? 'pyInt' : name === 'float' ? 'pyFloat' : name === 'main' ? 'Main' : name;
  return `${jname}(${a.join(', ')})`;
}

function emitBin(e: Extract<Expr, { k: 'bin' }>): string {
  switch (e.op) {
    case '/': return `((double)(${emitExpr(e.l)}) / (${emitExpr(e.r)}))`;   // Python true division
    case '//': return `idiv(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '%': return `imod(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case 'in': return `isin(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case 'notin': return `isnotin(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    default: return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
  }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

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

function foreachIter(s: Extract<Stmt, { k: 'foreach' }>): string {
  if (s.iterTy?.k === 'map') {
    if (s.iter.k === 'method' && (s.iter.name === 'keys' || s.iter.name === 'values')) return emitExpr(s.iter);
    return `${emitExpr(s.iter)}.Keys()`;
  }
  return emitExpr(s.iter);
}

function emitStmt(s: Stmt, out: string[], ind: number): void {
  const pad = '    '.repeat(ind);
  switch (s.k) {
    case 'vardecl':
      out.push(`${pad}${emitTy(s.ty)} ${ident(s.name)} = ${emitExpr(s.init)};`);
      break;
    case 'assign': {
      const t = s.target;
      if (t.k === 'var') out.push(`${pad}${ident(t.name)} = ${emitExpr(s.value)};`);
      else if (t.k === 'field') out.push(`${pad}${emitExpr(t.obj)}.${t.name} = ${emitExpr(s.value)};`);
      else if (t.k === 'index') {
        if (t.objTy?.k === 'map') {
          out.push(`${pad}${emitExpr(t.obj)}.Set(${emitExpr(t.idx)}, ${emitExpr(s.value)});`);
        } else {
          out.push(`${pad}${emitExpr(t.obj)}[${emitExpr(t.idx)}] = ${emitExpr(s.value)};`);
        }
      } else err('unsupported assignment target reached the backend (inferencer bug)');
      break;
    }
    case 'expr':
      out.push(`${pad}${emitExpr(s.e)};`);
      break;
    case 'return': {
      if (!s.v) { out.push(`${pad}return;`); break; }
      // list/map literals in a return take the FUNCTION's element type —
      // `return []` cannot fall back to int (Java gets this via target typing)
      let e = emitExpr(s.v);
      if (s.v.k === 'list' && csRetTy?.k === 'list') {
        e = s.v.elems.length === 0
          ? `new ${emitTy(csRetTy)}()`
          : `new ${emitTy(csRetTy)} { ${s.v.elems.map(x => emitExpr(x)).join(', ')} }`;
      } else if (s.v.k === 'map' && csRetTy?.k === 'map') {
        e = `PyMap<${boxTy(csRetTy.val)}>(${s.v.entries.flatMap(en => [JSON.stringify(en.key), emitExpr(en.val)]).join(', ')})`;
      }
      out.push(`${pad}return ${e};`);
      break;
    }
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
      out.push(`${pad}for (int ${ident(s.varName)} = ${emitExpr(s.start)}; ${s.varName} ${upd.cmp} ${emitExpr(s.stop)}; ${s.varName} ${upd.delta}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    }
    case 'foreach': {
      out.push(`${pad}foreach (${boxTy(s.varTy)} ${ident(s.varName)} in ${foreachIter(s)}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    }
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

function emitFun(f: FunDecl, out: string[], clsName: string): void {
  const params = f.params.map(p => `${emitTy(p.ty)} ${ident(p.name)}`).join(', ');
  if (f.name === 'main' && f.params.length === 0) {
    // an explicit def main() becomes the entry point (C# needs one to run)
    out.push(`    public static void Main() {`);
    emitBody(f.body, out, 3);
    out.push('    }', '');
    return;
  }
  if (f.name === 'main') {
    err(`def main(${f.params.map(p => p.name).join(', ')}) — a 'main' with parameters cannot be a C# entry point`);
  }
  if (f.name === clsName) err(`function '${f.name}' collides with the module class name`);
  out.push(`    static ${emitTy(f.ret)} ${ident(f.name)}(${params}) {`);
  csRetTy = f.ret ?? null;
  emitBody(f.body, out, 3);
  csRetTy = null;
  out.push('    }', '');
}

function emitClass(c: ClassDecl, out: string[], clsName: string): void {
  if (c.name === clsName) err(`class '${c.name}' collides with the module class name`);
  out.push(`    class ${ident(c.name)} {`);
  for (const f of c.fields) out.push(`        public ${emitTy(f.ty)} ${ident(f.name)};`);   // public: sibling nested classes read each other's fields
  if (c.ctor) {
    const params = c.ctor.params.map(p => `${emitTy(p.ty)} ${ident(p.name)}`).join(', ');
    if (c.fields.length) out.push('');
    out.push(`        public ${ident(c.name)}(${params}) {`);
    emitBody(c.ctor.body, out, 4);
    out.push('        }', '');
  }
  for (const meth of c.methods) {
    const params = meth.params.map(p => `${emitTy(p.ty)} ${ident(p.name)}`).join(', ');
    out.push(`        public ${emitTy(meth.ret)} ${ident(meth.name)}(${params}) {`);
    csRetTy = meth.ret ?? null;
    emitBody(meth.body, out, 4);
    csRetTy = null;
    out.push('        }', '');
  }
  out.push('    }', '');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function emitCs(m: Module): string {
  const clsName = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/[^A-Za-z0-9_$]/g, '');
  const out: string[] = [
    `// generated by ouro (py->cs) — run with: dotnet run <this-file> (.NET 10+)`,
    `#nullable disable`,
    `using System;`,
    `using System.Collections.Generic;`,
    `using System.Globalization;`,
    `using System.Text;`,
    '',
    `public class ${clsName} {`,
    PRELUDE,
    '',
  ];
  let entryDone = false;
  let main: FunDecl | undefined;
  for (const item of m.items) {
    if ('fields' in item) emitClass(item, out, clsName);
    else if (item.name === 'main') {
      if (m.implicitMain) main = item;   // body goes into the generated entry
      else { emitFun(item, out, clsName); entryDone = true; }   // explicit def main() IS the entry
    } else emitFun(item, out, clsName);
  }
  if (!entryDone) {
    out.push('    public static void Main() {');
    if (main) emitBody(main.body, out, 3);
    // a module of only declarations runs like an imported Python module: no output
    out.push('    }');
  }
  out.push('}', '');
  return out.join('\n');
}
