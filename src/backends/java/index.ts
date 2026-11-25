/**
 * Java backend (Layer 3) — IR -> a self-contained single-file Java program.
 *
 * One public class named after the module: the prelude rides along as static
 * helper methods, IR classes become static nested classes, IR functions become
 * static methods, and the implicit main body lands inside
 * `public static void main`. Verified end to end by running the output with
 * the JDK single-file source launcher (`java <file>`, JDK 11+).
 *
 * v1 divergences (documented in the README): ints are 32-bit (Python's are
 * arbitrary precision); uninitialized class fields default to 0/null instead
 * of raising; float formatting follows Java for extreme values.
 */

import type { Module, Stmt, Expr, Ty, FunDecl, ClassDecl } from '../../ir/types.ts';
import { TranspileError } from '../../ir/types.ts';

// Identifiers that are legal Python names but reserved in Java.
const JAVA_RESERVED = new Set([
  'const', 'goto', 'var', 'record', 'yield', 'sealed', 'permits', 'module',
  'requires', 'exports', 'opens', 'native', 'transient', 'volatile',
  'synchronized', 'strictfp', 'catch', 'throw', 'throws', 'byte', 'short',
  'long', 'char', 'float', 'double', 'boolean', 'default', 'switch', 'case',
  'do', 'package', 'interface', 'implements', 'extends', 'instanceof', 'this',
  'super', 'new', 'null', 'void', 'int', 'public', 'private', 'protected',
  'static', 'abstract', 'final', 'enum',
]);

// Prelude helper names — user declarations must not shadow them.
const PRELUDE_NAMES = new Set([
  'print', 'len', 'str', 'pyInt', 'pyFloat', 'idiv', 'imod', 'isin',
  'isnotin', 'isdigit', 'mapGet', 'mapIndex', 'mapPop', 'pyKeys',
  'pyValues', 'pyMap', 'pySplit', 'pyStr', 'pyRepr',
]);

const PRELUDE = `  // ---- prelude: Python-flavored runtime helpers ----
  static void print(Object... args) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < args.length; i++) {
      if (i > 0) sb.append(' ');
      sb.append(pyStr(args[i]));
    }
    System.out.println(sb);
  }

  static String pyStr(Object x) {
    if (x instanceof Boolean b) return b ? "True" : "False";
    if (x instanceof Integer || x instanceof Long) return x.toString();
    if (x instanceof Double) return x.toString();
    if (x instanceof String) return (String) x;
    if (x instanceof java.util.List<?> l) {
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) sb.append(", ");
        sb.append(pyRepr(l.get(i)));
      }
      return sb.append(']').toString();
    }
    if (x instanceof java.util.Map<?, ?> m) {
      StringBuilder sb = new StringBuilder("{");
      boolean first = true;
      for (java.util.Map.Entry<?, ?> en : m.entrySet()) {
        if (!first) sb.append(", ");
        first = false;
        sb.append(pyRepr(en.getKey())).append(": ").append(pyRepr(en.getValue()));
      }
      return sb.append('}').toString();
    }
    return String.valueOf(x);
  }

  static String pyRepr(Object x) {
    return x instanceof String s ? "'" + s + "'" : pyStr(x);
  }

  static int len(Object x) {
    if (x instanceof String s) return s.length();
    if (x instanceof java.util.List<?> l) return l.size();
    if (x instanceof java.util.Map<?, ?> m) return m.size();
    throw new RuntimeException("len() of unsupported type");
  }

  static String str(Object x) { return pyStr(x); }

  static int pyInt(Object x) {
    if (x instanceof String s) return Integer.parseInt(s.trim());
    if (x instanceof Double d) return (int) (double) d;   // truncate toward zero, like Python
    if (x instanceof Boolean b) return b ? 1 : 0;
    if (x instanceof Number n) return n.intValue();
    throw new RuntimeException("int() of unsupported type");
  }

  static double pyFloat(Object x) {
    if (x instanceof String s) return Double.parseDouble(s.trim());
    if (x instanceof Number n) return n.doubleValue();
    throw new RuntimeException("float() of unsupported type");
  }

  static int idiv(int a, int b) { return Math.floorDiv(a, b); }   // Python floor semantics
  static int imod(int a, int b) { return Math.floorMod(a, b); }   // Python floor semantics

  static boolean isin(Object x, Object xs) {
    if (xs instanceof String s) return s.contains((String) x);
    if (xs instanceof java.util.List<?> l) return l.contains(x);
    if (xs instanceof java.util.Map<?, ?> m) return m.containsKey(x);
    throw new RuntimeException("'in' of unsupported type");
  }

  static boolean isnotin(Object x, Object xs) { return !isin(x, xs); }

  static boolean isdigit(String s) {
    return !s.isEmpty() && s.chars().allMatch(Character::isDigit);
  }

  static <T> T mapGet(java.util.Map<String, T> d, String k, T def) { return d.getOrDefault(k, def); }

  static <T> T mapIndex(java.util.Map<String, T> d, String k) {
    if (!d.containsKey(k)) throw new RuntimeException("KeyError: " + k);
    return d.get(k);
  }

  static <T> T mapPop(java.util.Map<String, T> d, String k) {
    if (!d.containsKey(k)) throw new RuntimeException("KeyError: " + k);
    return d.remove(k);
  }

  @SuppressWarnings("unchecked")
  static <V> java.util.Map<String, V> pyMap(Object... kv) {
    java.util.Map<String, V> d = new java.util.LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) d.put((String) kv[i], (V) kv[i + 1]);
    return d;
  }

  static java.util.List<String> pyKeys(java.util.Map<String, ?> d) { return new java.util.ArrayList<>(d.keySet()); }
  static <V> java.util.List<V> pyValues(java.util.Map<String, V> d) { return new java.util.ArrayList<>(d.values()); }

  static java.util.List<String> pySplit(String s, String sep) {
    if (sep.isEmpty()) throw new RuntimeException("empty separator");
    java.util.List<String> out = new java.util.ArrayList<>();
    int i = 0;
    for (;;) {
      int j = s.indexOf(sep, i);
      if (j < 0) { out.add(s.substring(i)); return out; }
      out.add(s.substring(i, j));
      i = j + sep.length();
    }
  }`;

function err(msg: string): never {
  throw new TranspileError(msg, 'java', null);
}

function ident(name: string): string {
  if (JAVA_RESERVED.has(name)) err(`'${name}' is a reserved word in Java — rename it in the source`);
  if (PRELUDE_NAMES.has(name)) err(`'${name}' collides with the Java prelude — rename it in the source`);
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Boxed form for generic type arguments (Java generics need objects). */
function boxTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'Integer';
    case 'float': return 'Double';
    case 'bool': return 'Boolean';
    case 'string': return 'String';
    case 'list': return `java.util.List<${boxTy(t.elem)}>`;
    case 'map': return `java.util.Map<String, ${boxTy(t.val)}>`;
    case 'class': return t.name;
    case 'void': case 'any': err(`type '${t.k}' cannot appear inside a generic (inferencer bug)`);
  }
}

function emitTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int';
    case 'float': return 'double';
    case 'bool': return 'boolean';
    case 'string': return 'String';
    case 'void': return 'void';
    case 'list': return `java.util.List<${boxTy(t.elem)}>`;
    case 'map': return `java.util.Map<String, ${boxTy(t.val)}>`;
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

function javaEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/** f-string -> string concatenation; expr parts go through pyStr for True/False etc. */
function emitInterp(parts: (string | Expr)[]): string {
  const segs: string[] = [];
  let buf = '"';
  for (const p of parts) {
    if (typeof p === 'string') buf += javaEscape(p);
    else {
      segs.push(`${buf}"`, `pyStr(${emitExpr(p)})`);
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
    case 'append': case 'push': return `${o}.add(${a[0]})`;
    case 'pop':
      return a.length === 1 ? `mapPop(${o}, ${a[0]})` : `${o}.remove(${o}.size() - 1)`;
    case 'index': case 'find': case 'indexOf': return `${o}.indexOf(${a[0]})`;
    case 'sort': return `java.util.Collections.sort(${o})`;
    case 'reverse': return `java.util.Collections.reverse(${o})`;
    case 'clear': return `${o}.clear()`;
    case 'join': return `String.join(${o}, ${a[0]})`;   // IR: sep.join(xs)
    case 'upper': return `${o}.toUpperCase()`;
    case 'lower': return `${o}.toLowerCase()`;
    case 'strip': case 'trim': return `${o}.trim()`;
    case 'replace': return `${o}.replace(${a[0]}, ${a[1]})`;   // literal, replaces all
    case 'split': return `pySplit(${o}, ${a[0]})`;
    case 'startswith': return `${o}.startsWith(${a[0]})`;
    case 'endswith': return `${o}.endsWith(${a[0]})`;
    case 'isdigit': return `isdigit(${o})`;
    case 'get': return `mapGet(${o}, ${a[0]}, ${a[1]})`;
    case 'keys': return `pyKeys(${o})`;
    case 'values': return `pyValues(${o})`;
    default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
  }
}

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'float': return Number.isInteger(e.v) ? `${e.v.toFixed(1)}` : String(e.v);
    case 'bool': return e.v ? 'true' : 'false';
    case 'str': return `"${javaEscape(e.v)}"`;
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
        ? `mapIndex(${emitExpr(e.obj)}, ${emitExpr(e.idx)})`
        : `${wrap(e.obj)}.get(${emitExpr(e.idx)})`;
    case 'list':
      return e.elems.length === 0
        ? `new java.util.ArrayList<>()`
        : `new java.util.ArrayList<>(java.util.List.of(${e.elems.map(emitExpr).join(', ')}))`;
    case 'map':
      return `pyMap(${e.entries.flatMap(en => [JSON.stringify(en.key), emitExpr(en.val)]).join(', ')})`;
    case 'new': return `new ${e.cls}(${e.args.map(emitExpr).join(', ')})`;
    case 'interp': return emitInterp(e.parts);
  }
}

/** Free calls: prelude names + IR built-ins; int/float need Java-safe names. */
function emitCall(name: string, args: Expr[]): string {
  const a = args.map(emitExpr);
  const jname = name === 'int' ? 'pyInt' : name === 'float' ? 'pyFloat' : name;
  return `${jname}(${a.join(', ')})`;
}

function emitBin(e: Extract<Expr, { k: 'bin' }>): string {
  switch (e.op) {
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
    if (s.iter.k === 'method' && s.iter.name === 'values') return emitExpr(s.iter); // pyValues(d)
    if (s.iter.k === 'method' && s.iter.name === 'keys') return emitExpr(s.iter);   // pyKeys(d)
    return `${emitExpr(s.iter)}.keySet()`;
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
          out.push(`${pad}${emitExpr(t.obj)}.put(${emitExpr(t.idx)}, ${emitExpr(s.value)});`);
        } else {
          out.push(`${pad}${emitExpr(t.obj)}.set(${emitExpr(t.idx)}, ${emitExpr(s.value)});`);
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
      out.push(`${pad}for (int ${ident(s.varName)} = ${emitExpr(s.start)}; ${s.varName} ${upd.cmp} ${emitExpr(s.stop)}; ${s.varName} ${upd.delta}) {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    }
    case 'foreach': {
      out.push(`${pad}for (${boxTy(s.varTy)} ${ident(s.varName)} : ${foreachIter(s)}) {`);
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
    // an explicit def main() becomes the entry point (Java needs one to run)
    out.push(`  public static void main(String[] args) {`);
    emitBody(f.body, out, 2);
    out.push('  }', '');
    return;
  }
  if (f.name === 'main') {
    err(`def main(${f.params.map(p => p.name).join(', ')}) — a 'main' with parameters cannot be a Java entry point`);
  }
  if (f.name === clsName) err(`function '${f.name}' collides with the module class name`);
  out.push(`  static ${emitTy(f.ret)} ${ident(f.name)}(${params}) {`);
  emitBody(f.body, out, 2);
  out.push('  }', '');
}

function emitClass(c: ClassDecl, out: string[], clsName: string): void {
  if (c.name === clsName) err(`class '${c.name}' collides with the module class name`);
  out.push(`  static class ${ident(c.name)} {`);
  for (const f of c.fields) out.push(`    ${emitTy(f.ty)} ${ident(f.name)};`);
  if (c.ctor) {
    const params = c.ctor.params.map(p => `${emitTy(p.ty)} ${ident(p.name)}`).join(', ');
    if (c.fields.length) out.push('');
    out.push(`    ${ident(c.name)}(${params}) {`);
    emitBody(c.ctor.body, out, 3);
    out.push('    }', '');
  }
  for (const meth of c.methods) {
    const params = meth.params.map(p => `${emitTy(p.ty)} ${ident(p.name)}`).join(', ');
    out.push(`    ${emitTy(meth.ret)} ${ident(meth.name)}(${params}) {`);
    emitBody(meth.body, out, 3);
    out.push('    }', '');
  }
  out.push('  }', '');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function emitJava(m: Module): string {
  const clsName = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/[^A-Za-z0-9_$]/g, '');
  const out: string[] = [
    `// generated by ouro (py->java) — run with: java <this-file>`,
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
    out.push('  public static void main(String[] args) {');
    if (main) emitBody(main.body, out, 2);
    // a module of only declarations runs like an imported Python module: no output
    out.push('  }');
  }
  out.push('}', '');
  return out.join('\n');
}
