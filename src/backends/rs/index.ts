/**
 * Rust backend (Layer 3) — IR -> a single-file, 100% native Rust program.
 *
 * No FFI, no C ABI, no extern blocks: pure `std` + the in-file prelude, so
 * `rustc out.rs` produces a self-contained native binary that runs like any
 * hand-written Rust program. Classes become `struct` + `impl` with `fn new`
 * constructors; free functions become free `fn`s; the entry point is `fn main`.
 *
 * Python fidelity, same contract as the other backends:
 *  - i64 ints with exact floor `//`/`%` (idiv/imod), `/` widens to f64
 *  - insertion-ordered PyDict (HashMap alone loses Python's order)
 *  - PyStr formatting: True/False, [a, b], {k: v}, 2.0, InvariantStyle floats
 *  - slot-copy emission: every assignment/argument/return of a non-Copy value
 *    clones, because Python strings/lists/dicts copy on bind — without it Rust
 *    would move and reject later uses
 *
 * v1 divergences (documented in the README): binding a list/dict/class to a
 * second name deep-copies instead of aliasing (in-place method mutation is
 * faithful); int() on a bad string panics instead of raising (still loud);
 * isdigit() accepts ASCII digits only; 32-bit tools aside, this is the same
 * contract the Java/C# backends document in their headers.
 */

import type { Module, Stmt, Expr, Ty, FunDecl, ClassDecl } from '../../ir/types.ts';
import { TranspileError } from '../../ir/types.ts';

// Identifiers that are legal Python names but reserved in Rust.
const RS_RESERVED = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
  'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where',
  'while', 'async', 'await', 'abstract', 'become', 'box', 'do', 'final',
  'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield',
  'try', 'gen', 'union',
]);

// Prelude names — user declarations must not shadow them.
const PRELUDE_NAMES = new Set([
  'print', 'PyVal', 'PyDict', 'PyToInt', 'PyToF', 'pyint', 'pyfloat',
  'idiv', 'imod', 'pyfloat_str', 'pylist_index', 'pystr_find', 'pysplit',
  'pyisdigit', 'pymap', 'main',
]);

const PRELUDE = `// ---- prelude: Python-flavored runtime (pure std, no FFI) ----

#[derive(Clone)]
struct PyDict<V> {
    d: std::collections::HashMap<String, V>,
    order: Vec<String>,   // Python dicts preserve insertion order
}

impl<V> PyDict<V> {
    fn new() -> PyDict<V> { PyDict { d: std::collections::HashMap::new(), order: Vec::new() } }
    fn has(&self, k: &str) -> bool { self.d.contains_key(k) }
    fn get(&self, k: &str, def: V) -> V where V: Clone { self.d.get(k).cloned().unwrap_or(def) }
    fn index(&self, k: &str) -> V where V: Clone {
        match self.d.get(k) { Some(v) => v.clone(), None => panic!("KeyError: {}", k) }
    }
    fn set(&mut self, k: &str, v: V) {
        if !self.d.contains_key(k) { self.order.push(k.to_string()); }
        self.d.insert(k.to_string(), v);
    }
    fn pop(&mut self, k: &str) -> V where V: Clone {
        match self.d.remove(k) {
            Some(v) => { self.order.retain(|x| x != k); v }
            None => panic!("KeyError: {}", k),
        }
    }
    fn keys(&self) -> Vec<String> { self.order.clone() }
    fn values(&self) -> Vec<V> where V: Clone {
        self.order.iter().map(|k| self.d[k].clone()).collect()
    }
}

trait PyVal {
    fn py_str(&self) -> String;
    fn py_repr(&self) -> String { self.py_str() }
    fn py_len(&self) -> i64 { unreachable!("len() of a scalar") }
}

impl PyVal for str {
    fn py_str(&self) -> String { self.to_string() }
    fn py_repr(&self) -> String { format!("'{}'", self) }
    fn py_len(&self) -> i64 { self.chars().count() as i64 }
}

impl PyVal for String {
    fn py_str(&self) -> String { self.clone() }
    fn py_repr(&self) -> String { format!("'{}'", self) }
    fn py_len(&self) -> i64 { self.chars().count() as i64 }
}

impl PyVal for i64 {
    fn py_str(&self) -> String { self.to_string() }
}

impl PyVal for f64 {
    fn py_str(&self) -> String { pyfloat_str(*self) }
}

impl PyVal for bool {
    fn py_str(&self) -> String { if *self { "True".to_string() } else { "False".to_string() } }
}

impl<T: PyVal> PyVal for Vec<T> {
    fn py_str(&self) -> String {
        let parts: Vec<String> = self.iter().map(|e| e.py_repr()).collect();
        format!("[{}]", parts.join(", "))
    }
    fn py_len(&self) -> i64 { self.len() as i64 }
}

impl<T: PyVal> PyVal for PyDict<T> {
    fn py_str(&self) -> String {
        let parts: Vec<String> = self.order.iter().map(|k| {
            let v = self.d.get(k).expect("order/key mismatch");
            format!("{}: {}", PyVal::py_repr(k), v.py_repr())
        }).collect();
        format!("{{{}}}", parts.join(", "))
    }
    fn py_len(&self) -> i64 { self.d.len() as i64 }
}

impl<'a, T: PyVal + ?Sized> PyVal for &'a T {
    fn py_str(&self) -> String { T::py_str(self) }
    fn py_repr(&self) -> String { T::py_repr(self) }
    fn py_len(&self) -> i64 { T::py_len(self) }
}

fn print(args: &[&dyn PyVal]) {
    let parts: Vec<String> = args.iter().map(|a| (*a).py_str()).collect();
    println!("{}", parts.join(" "));
}

fn pyfloat_str(d: f64) -> String {
    if d.is_nan() { return "nan".to_string(); }
    if d.is_infinite() { return if d > 0.0 { "inf".to_string() } else { "-inf".to_string() }; }
    if d == d.floor() && d.abs() < 1e15 { format!("{:.1}", d) } else { format!("{}", d) }
}

trait PyToInt { fn pyint(&self) -> i64; }
impl PyToInt for str { fn pyint(&self) -> i64 { self.trim().parse::<i64>().expect("ValueError: int() invalid literal") } }
impl PyToInt for String { fn pyint(&self) -> i64 { self.trim().parse::<i64>().expect("ValueError: int() invalid literal") } }
impl PyToInt for f64 { fn pyint(&self) -> i64 { *self as i64 } }   // truncate toward zero, like Python
impl PyToInt for i64 { fn pyint(&self) -> i64 { *self } }
impl PyToInt for bool { fn pyint(&self) -> i64 { if *self { 1 } else { 0 } } }

trait PyToF { fn pyfloat(&self) -> f64; }
impl PyToF for str { fn pyfloat(&self) -> f64 { self.trim().parse::<f64>().expect("ValueError: float() invalid literal") } }
impl PyToF for String { fn pyfloat(&self) -> f64 { self.trim().parse::<f64>().expect("ValueError: float() invalid literal") } }
impl PyToF for f64 { fn pyfloat(&self) -> f64 { *self } }
impl PyToF for i64 { fn pyfloat(&self) -> f64 { *self as f64 } }
impl PyToF for bool { fn pyfloat(&self) -> f64 { if *self { 1.0 } else { 0.0 } } }

fn idiv(a: i64, b: i64) -> i64 {
    if b == 0 { panic!("division by zero"); }
    let q = a / b;                                   // truncates toward zero
    if a % b != 0 && (a < 0) != (b < 0) { q - 1 } else { q }   // Python floors
}

fn imod(a: i64, b: i64) -> i64 {
    if b == 0 { panic!("modulo by zero"); }
    ((a % b) + b) % b   // Python floor semantics (result takes divisor's sign)
}

fn pylist_index<T: PartialEq>(xs: &Vec<T>, v: &T) -> i64 {
    xs.iter().position(|e| e == v).map(|p| p as i64).unwrap_or(-1)
}

fn pystr_find(s: &str, n: &str) -> i64 {
    s.find(n).map(|p| p as i64).unwrap_or(-1)
}

fn pysplit(s: &str, sep: &str) -> Vec<String> {
    if sep.is_empty() { panic!("ValueError: empty separator"); }
    s.split(sep).map(|p| p.to_string()).collect()
}

fn pyisdigit(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn pymap<V: Clone>(kv: &[(&str, V)]) -> PyDict<V> {
    let mut d = PyDict::new();
    for (k, v) in kv { d.set(k, v.clone()); }
    d
}`;

function err(msg: string): never {
  throw new TranspileError(msg, 'rust', null);
}

function ident(name: string): string {
  if (RS_RESERVED.has(name)) err(`'${name}' is a reserved word in Rust — rename it in the source`);
  if (PRELUDE_NAMES.has(name)) err(`'${name}' collides with the Rust prelude — rename it in the source`);
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function boxTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'i64';
    case 'float': return 'f64';
    case 'bool': return 'bool';
    case 'string': return 'String';
    case 'list': return `Vec<${boxTy(t.elem)}>`;
    case 'map': return `PyDict<${boxTy(t.val)}>`;
    case 'class': return t.name;
    case 'void': case 'any': err(`type '${t.k}' cannot appear inside a generic (inferencer bug)`);
  }
}

function emitTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'i64';
    case 'float': return 'f64';
    case 'bool': return 'bool';
    case 'string': return 'String';
    case 'void': return '()';
    case 'list': return `Vec<${boxTy(t.elem)}>`;
    case 'map': return `PyDict<${boxTy(t.val)}>`;
    case 'class': return t.name;
    case 'any': err("unresolved 'any' type reached the backend (inferencer bug)");
  }
}

/** Rust Copy-ness decides where Rust would move and Python would copy. */
function isCopyTy(t: Ty | null): boolean {
  return t != null && (t.k === 'int' || t.k === 'float' || t.k === 'bool');
}

function isLiteralExpr(e: Expr): boolean {
  return e.k === 'int' || e.k === 'float' || e.k === 'bool' || e.k === 'str'
    || e.k === 'list' || e.k === 'map' || e.k === 'new';
}

/**
 * Emit a value going into a "slot" of type slotTy (variable, field, argument,
 * return). Python copies on bind; Rust moves — non-Copy non-literal values
 * need .clone(), string literals need .to_string() to become owned.
 */
function slotVal(e: Expr, slotTy: Ty | null): string {
  const raw = emitExpr(e);
  if (slotTy == null || isCopyTy(slotTy)) return raw;
  if (slotTy.k === 'string') {
    return e.k === 'str' ? `${raw}.to_string()` : `${raw}.clone()`;
  }
  if (isLiteralExpr(e)) return raw;
  return `${raw}.clone()`;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function wrap(e: Expr): string {
  return e.k === 'bin' || e.k === 'un' ? `(${emitExpr(e)})` : emitExpr(e);
}

function rsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/** f-string -> format!(); literal braces must be doubled for format! */
function emitInterp(parts: (string | Expr)[]): string {
  let lit = '';
  const exprs: string[] = [];
  for (const p of parts) {
    if (typeof p === 'string') lit += p.replace(/{/g, '{{').replace(/}/g, '}}');
    else { lit += '{}'; exprs.push(`${wrap(p)}.py_str()`); }
  }
  if (exprs.length === 0) return `"${rsEscape(parts.filter(p => typeof p === 'string').join(''))}"`;
  return `format!("${rsEscape(lit)}", ${exprs.join(', ')})`;
}

/** A value consumed by reference in print(): borrow it, parenthesizing ops. */
function printArg(e: Expr): string {
  return `&${wrap(e)}`;
}

function emitMethod(e: Extract<Expr, { k: 'method' }>): string {
  const o = emitExpr(e.obj);
  const a = e.args;
  if (e.objTy?.k === 'class') {
    const args = a.map((x, i) => slotVal(x, e.argTys?.[i] ?? null)).join(', ');
    return `${o}.${e.name}(${args})`;
  }
  if (e.objTy?.k === 'list') {
    const elem = e.objTy.elem;
    switch (e.name) {
      case 'append': case 'push': return `${o}.push(${slotVal(a[0], elem)})`;
      case 'pop':
        return a.length === 0
          ? `${o}.pop().expect("IndexError: pop from empty list")`
          : err('pop(i) is not supported in v1');
      case 'index': return `pylist_index(&${o}, &${emitExpr(a[0])})`;
      case 'sort':
        return elem?.k === 'float'
          ? `${o}.sort_by(|x, y| x.partial_cmp(y).expect("cannot compare NaN"))`
          : `${o}.sort()`;
      case 'reverse': return `${o}.reverse()`;
      case 'clear': return `${o}.clear()`;
      case 'join': return `${o}.join(&${emitExpr(a[0])})`;   // IR: sep.join(xs) -> xs.join(sep)
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  if (e.objTy?.k === 'string') {
    switch (e.name) {
      case 'upper': return `${o}.to_uppercase()`;
      case 'lower': return `${o}.to_lowercase()`;
      case 'strip': case 'trim': return `${o}.trim().to_string()`;
      case 'replace': return `${o}.replace(&${emitExpr(a[0])}, &${emitExpr(a[1])})`;
      case 'split': return `pysplit(&${o}, ${emitExpr(a[0])})`;
      case 'startswith': return `${o}.starts_with(${emitExpr(a[0])})`;
      case 'endswith': return `${o}.ends_with(${emitExpr(a[0])})`;
      case 'find': return `pystr_find(&${o}, ${emitExpr(a[0])})`;
      case 'isdigit': return `pyisdigit(&${o})`;
      case 'join': return `${o}.join(&${emitExpr(a[0])})`;
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  if (e.objTy?.k === 'map') {
    const val = e.objTy.val;
    switch (e.name) {
      case 'get': return `${o}.get(&${emitExpr(a[0])}, ${slotVal(a[1], val)})`;
      case 'keys': return `${o}.keys()`;
      case 'values': return `${o}.values()`;
      case 'pop': return `${o}.pop(&${emitExpr(a[0])})`;
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  err('untyped receiver reached the backend (inferencer bug)');
}

/** Free calls: prelude conversions ride the traits, user fns slot-copy args. */
function emitCall(e: Extract<Expr, { k: 'call' }>): string {
  const a = e.args;
  if (e.name === 'print') return `print(&[${a.map(printArg).join(', ')}])`;
  if (e.name === 'len') return `${wrap(a[0])}.py_len()`;
  if (e.name === 'str') return `${wrap(a[0])}.py_str()`;
  if (e.name === 'int') return `(${wrap(a[0])}).pyint()`;
  if (e.name === 'float') return `(${wrap(a[0])}).pyfloat()`;
  if (e.name === 'main') return 'main()';
  const args = a.map((x, i) => slotVal(x, e.argTys?.[i] ?? null)).join(', ');
  return `${ident(e.name)}(${args})`;
}

function emitBin(e: Extract<Expr, { k: 'bin' }>): string {
  switch (e.op) {
    case '/': return `((${emitExpr(e.l)}) as f64 / (${emitExpr(e.r)}) as f64)`;   // Python true division
    case '//': return `idiv(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '%': return `imod(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '+':
      if (e.rty?.k === 'string' || e.l.k === 'str' && e.r.k === 'str') {
        return `format!("{}{}", ${emitExpr(e.l)}, ${emitExpr(e.r)})`;
      }
      return `${wrap(e.l)} + ${wrap(e.r)}`;
    case 'in': case 'notin': {
      const r = emitExpr(e.r);
      const l = emitExpr(e.l);
      const inner = e.rty?.k === 'string' ? `${r}.contains(&${l})`
        : e.rty?.k === 'list' ? `${r}.contains(&${l})`
        : e.rty?.k === 'map' ? `${r}.has(&${l})`
        : err("'in' without a container type (inferencer bug)");
      return e.op === 'notin' ? `!(${inner})` : inner;
    }
    default: return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
  }
}

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'float': return Number.isInteger(e.v) ? `${e.v.toFixed(1)}` : String(e.v);
    case 'bool': return e.v ? 'true' : 'false';
    case 'str': return `"${rsEscape(e.v)}"`;
    case 'null': err('null reached the backend (inferencer bug)');
    case 'var': return ident(e.name);
    case 'this': return ctxThis;
    case 'bin': return emitBin(e);
    case 'un': return `${e.op}${wrap(e.e)}`;
    case 'call': return emitCall(e);
    case 'method': return emitMethod(e);
    case 'field': return `${emitExpr(e.obj)}.${e.name}`;
    case 'index':
      return e.objTy?.k === 'map'
        ? `${emitExpr(e.obj)}.index(&${emitExpr(e.idx)})`
        : `${wrap(e.obj)}[${emitExpr(e.idx)}].clone()`;
    case 'list':
      return e.elems.length === 0
        ? `Vec::new()`
        : `vec![${e.elems.map(x => emitExpr(x)).join(', ')}]`;
    case 'map':
      return `pymap(&[${e.entries.map(en => `("${rsEscape(en.key)}", ${emitExpr(en.val)})`).join(', ')}])`;
    case 'new': {
      // ctor args are always literals or fresh values (new/method calls) in v1
      const args = e.args.map(x => emitExpr(x)).join(', ');
      return `${e.cls}::new(${args})`;
    }
    case 'interp': return emitInterp(e.parts);
  }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function forrangeHead(s: Extract<Stmt, { k: 'forrange' }>): string {
  const v = ident(s.varName);
  const start = emitExpr(s.start);
  const stop = emitExpr(s.stop);
  const step = s.step;
  if (step.k === 'int') {
    if (step.v === 0) err('forrange step cannot be 0');
    if (step.v === 1) return `for ${v} in (${start})..(${stop}) {`;
    return `for ${v} in ((${start})..(${stop})).step_by(${step.v}) {`;
  }
  if (step.k === 'un' && step.op === '-' && step.e.k === 'int') {
    const n = step.e.v;
    if (n === 0) err('forrange step cannot be 0');
    // range(start, stop, -n) yields start down to stop+1: (stop+n..=start).rev()
    const nStr = n === 1 ? '1' : String(n);
    const head = `((${stop}) + ${nStr}..=(${start})).rev()`;
    return `for ${v} in ${n === 1 ? head : `${head}.step_by(${n})`} {`;
  }
  err('forrange with dynamic step is not supported in v1 (literal or negated-literal step required)');
}

function foreachHead(s: Extract<Stmt, { k: 'foreach' }>): string {
  const it = s.iterTy?.k === 'map'
    ? (s.iter.k === 'method' && (s.iter.name === 'keys' || s.iter.name === 'values') ? emitExpr(s.iter) : `${emitExpr(s.iter)}.keys()`)
    : emitExpr(s.iter);
  return `for ${ident(s.varName)} in ${it}.iter().cloned() {`;
}

/** Statement-level calls that produce values must not warn (must_use). */
const VOID_CALLEES = new Set(['print', 'append', 'push', 'sort', 'reverse', 'clear', 'set']);

function emitStmt(s: Stmt, out: string[], ind: number): void {
  const pad = '    '.repeat(ind);
  switch (s.k) {
    case 'vardecl':
      out.push(`${pad}let mut ${ident(s.name)}: ${emitTy(s.ty)} = ${slotVal(s.init, s.ty)};`);
      break;
    case 'assign': {
      const t = s.target;
      if (t.k === 'var') out.push(`${pad}${ident(t.name)} = ${slotVal(s.value, s.valueTy ?? null)};`);
      else if (t.k === 'field') out.push(`${pad}${emitExpr(t.obj)}.${t.name} = ${slotVal(s.value, s.valueTy ?? null)};`);
      else if (t.k === 'index') {
        if (t.objTy?.k === 'map') {
          out.push(`${pad}${emitExpr(t.obj)}.set(&${emitExpr(t.idx)}, ${slotVal(s.value, s.valueTy ?? null)});`);
        } else {
          out.push(`${pad}${emitExpr(t.obj)}[${emitExpr(t.idx)}] = ${slotVal(s.value, s.valueTy ?? null)};`);
        }
      } else err('unsupported assignment target reached the backend (inferencer bug)');
      break;
    }
    case 'expr': {
      const e = s.e;
      const valueful = (e.k === 'call' && !VOID_CALLEES.has(e.name))
        || (e.k === 'method' && !VOID_CALLEES.has(e.name));
      out.push(`${pad}${valueful ? 'let _ = ' : ''}${emitExpr(e)};`);
      break;
    }
    case 'return': {
      if (!s.v) { out.push(`${pad}return;`); break; }
      out.push(`${pad}return ${slotVal(s.v, ctxRetTy ?? null)};`);
      break;
    }
    case 'if': {
      out.push(`${pad}if ${emitExpr(s.cond)} {`);
      emitBody(s.then, out, ind + 1);
      for (const el of s.elifs) {
        out.push(`${pad}} else if ${emitExpr(el.cond)} {`);
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
      out.push(`${pad}while ${emitExpr(s.cond)} {`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    case 'forrange':
      out.push(`${pad}${forrangeHead(s)}`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    case 'foreach':
      out.push(`${pad}${foreachHead(s)}`);
      emitBody(s.body, out, ind + 1);
      out.push(`${pad}}`);
      break;
    case 'break': out.push(`${pad}break;`); break;
    case 'continue': out.push(`${pad}continue;`); break;
    case 'print':
      out.push(`${pad}print(&[${s.args.map(printArg).join(', ')}]);`);
      break;
  }
}

function emitBody(body: Stmt[], out: string[], ind: number): void {
  for (const s of body) emitStmt(s, out, ind);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** Default field initializer per type (documented divergence: no runtime error). */
function fieldDefault(t: Ty | null): string {
  switch (t?.k) {
    case 'int': return '0';
    case 'float': return '0.0';
    case 'bool': return 'false';
    case 'string': return 'String::new()';
    case 'list': return 'Vec::new()';
    case 'map': return 'PyDict::new()';
    default: err(`field type '${t ? t.k : 'null'}' cannot be default-initialized in the Rust backend`);
  }
}

function emitClass(c: ClassDecl, out: string[], clsName: string): void {
  if (c.name === clsName) err(`class '${c.name}' collides with the module struct name`);
  for (const meth of c.methods) {
    if (meth.name === 'new') err(`method 'new' collides with the generated constructor — rename it`);
  }
  out.push(`#[derive(Clone)]`);
  out.push(`struct ${ident(c.name)} {`);
  for (const f of c.fields) out.push(`    ${ident(f.name)}: ${emitTy(f.ty)},`);
  out.push(`}`, '');
  out.push(`impl ${ident(c.name)} {`);
  // constructor: type-default every field, then run the IR ctor body against `obj`
  const ctorParams = c.ctor?.params ?? [];
  const params = ctorParams.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
  out.push(`    fn new(${params}) -> ${ident(c.name)} {`);
  out.push(`        let mut obj = ${ident(c.name)} {`);
  for (const f of c.fields) out.push(`            ${ident(f.name)}: ${fieldDefault(f.ty)},`);
  out.push(`        };`);
  if (c.ctor) {
    ctxRetTy = null;
    ctxThis = 'obj';
    emitBody(c.ctor.body, out, 2);
    ctxThis = 'self';
  }
  out.push(`        obj`);
  out.push(`    }`, '');
  for (const meth of c.methods) {
    const ps = meth.params.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
    const ret = meth.ret?.k === 'void' ? '' : ` -> ${emitTy(meth.ret)}`;
    out.push(`    fn ${ident(meth.name)}(&mut self${ps ? ', ' + ps : ''})${ret} {`);
    ctxRetTy = meth.ret ?? null;
    emitBody(meth.body, out, 2);
    ctxRetTy = null;
    out.push(`    }`, '');
  }
  out.push(`}`, '');
}

function emitFun(f: FunDecl, out: string[], clsName: string): void {
  if (f.name === 'main') {
    if (f.params.length > 0) err(`def main(${f.params.map(p => p.name).join(', ')}) — a 'main' with parameters cannot be a Rust entry point`);
    out.push(`fn main() {`);
    ctxRetTy = null;
    emitBody(f.body, out, 1);
    out.push(`}`, '');
    return;
  }
  if (f.name === clsName) err(`function '${f.name}' collides with the module struct name`);
  const ps = f.params.map(p => `${ident(p.name)}: ${emitTy(p.ty)}`).join(', ');
  const ret = f.ret?.k === 'void' ? '' : ` -> ${emitTy(f.ret)}`;
  out.push(`fn ${ident(f.name)}(${ps})${ret} {`);
  ctxRetTy = f.ret ?? null;
  emitBody(f.body, out, 1);
  ctxRetTy = null;
  out.push(`}`, '');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let ctxRetTy: Ty | null = null;   // current function's return type (slot-copy on return)
let ctxThis = 'self';             // receiver name inside ctor bodies ('obj')

export function emitRs(m: Module): string {
  ctxRetTy = null;
  ctxThis = 'self';
  const clsName = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/[^A-Za-z0-9_$]/g, '');
  const out: string[] = [
    `// generated by ouro — 100% native Rust, no FFI / C ABI (run: rustc <this-file>)`,
    `// the full prelude ships even when a program only uses part of it`,
    `#![allow(dead_code, unused_mut, unused_variables, unused_parens)]`,
    PRELUDE,
    '',
  ];
  let mainSeen = false;
  for (const item of m.items) {
    if ('fields' in item) emitClass(item, out, clsName);
    else emitFun(item, out, clsName);
    if (item.name === 'main') mainSeen = true;
  }
  if (!mainSeen) {
    out.push(`fn main() {}   // a module of only declarations runs like an imported module: no output`);
    out.push('');
  }
  return out.join('\n');
}
