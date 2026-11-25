/**
 * Go backend (Layer 3) — IR -> a single-file, 100% native Go program.
 *
 * No cgo, no FFI: pure standard library + the in-file prelude, so
 * `go run out.go` (or `go build`) produces a self-contained native program.
 * Classes become `type X struct` with pointer-receiver methods and `NewX`
 * constructors; free functions become package-level funcs; the entry point
 * is `func main`.
 *
 * Python fidelity, same contract as the other backends:
 *  - int64 ints with exact floor `//`/`%` (idiv/imod), `/` widens to float64
 *  - insertion-ordered PyDict (Go maps alone lose Python's order)
 *  - PyStr formatting: True/False, [a, b], {k: v}, 2.0 — Python-style floats
 *  - slot-copy emission: Go slices/maps/pointers share backing storage on
 *    assignment, Python copies on bind — every slot of a non-scalar value
 *    clones (slices.Clone / PyDict.Clone / class Clone), list and dict
 *    literals slot their ELEMENTS the same way
 *  - `==` is reflect.DeepEqual for lists/maps (Python's deep equality);
 *    identity for class pointers; native for scalars
 *  - Go rejects unused locals, so unread vardecls emit `var _ = x`; an
 *    unused foreach variable collapses to `for range xs`
 *
 * v1 divergences (documented in the README): shallow copy on bind (inner
 * slices/dicts inside a cloned value still share, like the Java/C# backends);
 * int() on a bad string panics instead of raising (still loud); isdigit()
 * accepts ASCII digits only; pyin/pypop on float lists need `comparable`
 * constraint workaround — not supported.
 */

import type { Module, Stmt, Expr, Ty, FunDecl, ClassDecl } from '../../ir/types.ts';
import { TranspileError } from '../../ir/types.ts';

// Identifiers that are legal dialect names but reserved in Go — no verbatim
// escape exists, so these fail loudly (same contract as the Rust backend).
const GO_RESERVED = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'interface', 'map',
  'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
  'true', 'false', 'iota', 'nil', 'any', 'append', 'len', 'make', 'new',
  'cap', 'copy', 'delete', 'panic', 'recover', 'print', 'println', 'error',
  'byte', 'rune', 'string', 'int', 'int64', 'float64', 'bool',
]);

// Prelude names — user declarations must not shadow them.
const PRELUDE_NAMES = new Set([
  'print', 'pystr', 'pyrepr', 'pyreprReflect', 'pyfloat_str', 'pyeq',
  'PyVal', 'PyDict', 'PyKV', 'NewPyDict', 'pymap', 'pyclone',
  'idiv', 'imod', 'pyin', 'pypop', 'pysort', 'pyreverse', 'pyjoin',
  'pylist_index', 'pysplit', 'pyupper', 'pylower', 'pystrip', 'pyreplace',
  'pystartswith', 'pyendswith', 'pystr_find', 'pyisdigit',
  'pyint_str', 'pyint_f64', 'pyint_bool', 'pyint_i64',
  'pyfloat_str_parse', 'pyfloat_f64', 'pyfloat_bool', 'pyfloat_i64',
  'pyconcat', 'main',
]);

const PRELUDE = `// ---- prelude: Python-flavored runtime (pure std, no cgo) ----

type PyVal interface {
	PyStr() string
	PyRepr() string
}

// PyDict[V]: insertion-ordered dict (Go maps alone lose Python's order).
type PyDict[V any] struct {
	order []string
	d     map[string]V
}

func NewPyDict[V any]() PyDict[V] {
	return PyDict[V]{order: []string{}, d: map[string]V{}}
}

func (p PyDict[V]) Has(k string) bool {
	_, ok := p.d[k]
	return ok
}

func (p PyDict[V]) Get(k string, def V) V {
	if v, ok := p.d[k]; ok {
		return v
	}
	return def
}

func (p PyDict[V]) Index(k string) V {
	v, ok := p.d[k]
	if !ok {
		panic("KeyError: " + k)
	}
	return v
}

func (p *PyDict[V]) Set(k string, v V) {
	if _, ok := p.d[k]; !ok {
		p.order = append(p.order, k)
	}
	p.d[k] = v
}

func (p *PyDict[V]) Pop(k string) V {
	v, ok := p.d[k]
	if !ok {
		panic("KeyError: " + k)
	}
	delete(p.d, k)
	for i, kk := range p.order {
		if kk == k {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
	return v
}

func (p PyDict[V]) Keys() []string { return p.order }

func (p PyDict[V]) Values() []V {
	vs := make([]V, 0, len(p.order))
	for _, k := range p.order {
		vs = append(vs, p.d[k])
	}
	return vs
}

func (p PyDict[V]) Len() int64 { return int64(len(p.d)) }

func (p PyDict[V]) Clone() PyDict[V] {
	q := NewPyDict[V]()
	q.order = append([]string(nil), p.order...)
	q.d = make(map[string]V, len(p.d))
	for k, v := range p.d {
		q.d[k] = v
	}
	return q
}

func (p PyDict[V]) PyRepr() string {
	parts := []string{}
	for _, k := range p.order {
		parts = append(parts, pyrepr(k)+": "+pyrepr(p.d[k]))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func (p PyDict[V]) PyStr() string { return p.PyRepr() }

// PyKV[V]: one entry of a dict literal.
type PyKV[V any] struct {
	K string
	V V
}

func pymap[V any](kv []PyKV[V]) PyDict[V] {
	d := NewPyDict[V]()
	for _, e := range kv {
		d.Set(e.K, e.V)
	}
	return d
}

// ---- repr/str: Python-flavored formatting ----------------------------------

func pyrepr(v any) string {
	switch x := v.(type) {
	case string:
		return "'" + x + "'"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return pyfloat_str(x)
	case PyVal:
		return x.PyRepr()
	}
	return pyreprReflect(reflect.ValueOf(v))
}

func pyreprReflect(rv reflect.Value) string {
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		parts := []string{}
		for i := 0; i < rv.Len(); i++ {
			parts = append(parts, pyrepr(rv.Index(i).Interface()))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case reflect.Pointer:
		if rv.IsNil() {
			return "None"
		}
		return pyreprReflect(rv.Elem())
	case reflect.Interface:
		return pyrepr(rv.Elem().Interface())
	}
	return fmt.Sprintf("%v", rv.Interface())
}

func pystr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return pyrepr(v)
}

func pyfloat_str(d float64) string {
	if math.IsNaN(d) {
		return "nan"
	}
	if math.IsInf(d, 1) {
		return "inf"
	}
	if math.IsInf(d, -1) {
		return "-inf"
	}
	if d == math.Trunc(d) && math.Abs(d) < 1e15 {
		return strconv.FormatFloat(d, 'f', 1, 64)
	}
	return strconv.FormatFloat(d, 'g', -1, 64)
}

func print(args ...any) {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = pystr(a)
	}
	fmt.Println(strings.Join(parts, " "))
}

func pyconcat(a any, b any) string { return pystr(a) + pystr(b) }

// pyeq: Python's == — deep for lists/dicts, native for scalars. Untyped Go
// int constants box to plain int while IR ints are int64, so normalize first.
func pyeq(a any, b any) bool {
	if ai, ok := asInt64(a); ok {
		if bi, ok2 := asInt64(b); ok2 {
			return ai == bi
		}
	}
	return reflect.DeepEqual(a, b)
}

func asInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	}
	return 0, false
}

// ---- arithmetic with Python floor semantics ---------------------------------

func idiv(a int64, b int64) int64 {
	if b == 0 {
		panic("division by zero")
	}
	q := a / b // truncates toward zero
	if a%b != 0 && (a < 0) != (b < 0) {
		q -= 1 // Python floors
	}
	return q
}

func imod(a int64, b int64) int64 {
	if b == 0 {
		panic("modulo by zero")
	}
	return ((a % b) + b) % b // result takes the divisor's sign
}

// ---- membership / list helpers ----------------------------------------------

func pyin[T comparable](v T, xs []T) bool {
	for _, e := range xs {
		if e == v {
			return true
		}
	}
	return false
}

func pypop[T any](xs *[]T) T {
	a := *xs
	if len(a) == 0 {
		panic("IndexError: pop from empty list")
	}
	v := a[len(a)-1]
	*xs = a[:len(a)-1]
	return v
}

func pysort[T cmp.Ordered](xs []T) { slices.Sort(xs) }

func pyreverse[T any](xs []T) {
	for i, j := 0, len(xs)-1; i < j; i, j = i+1, j-1 {
		xs[i], xs[j] = xs[j], xs[i]
	}
}

func pyjoin[T any](sep string, xs []T) string {
	parts := make([]string, len(xs))
	for i, e := range xs {
		parts[i] = pystr(e)
	}
	return strings.Join(parts, sep)
}

func pylist_index[T comparable](xs []T, v T) int64 {
	for i, e := range xs {
		if e == v {
			return int64(i)
		}
	}
	return -1
}

// ---- string helpers ----------------------------------------------------------

func pysplit(s string, sep string) []string {
	if sep == "" {
		panic("ValueError: empty separator")
	}
	return strings.Split(s, sep)
}

func pyupper(s string) string { return strings.ToUpper(s) }
func pylower(s string) string { return strings.ToLower(s) }
func pystrip(s string) string { return strings.TrimSpace(s) }

func pyreplace(s string, a string, b string) string {
	if a == "" { // Python inserts between every char (and at both ends)
		out := ""
		for _, c := range s {
			out += b + string(c)
		}
		return out + b
	}
	out := ""
	for {
		j := strings.Index(s, a)
		if j < 0 {
			return out + s
		}
		out += s[:j] + b
		s = s[j+len(a):]
	}
}

func pystartswith(s string, p string) bool { return strings.HasPrefix(s, p) }
func pyendswith(s string, p string) bool   { return strings.HasSuffix(s, p) }

func pystr_find(s string, n string) int64 {
	i := strings.Index(s, n)
	if i < 0 {
		return -1
	}
	return int64(i)
}

func pyisdigit(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ---- conversions --------------------------------------------------------------

func pyint_str(s string) int64 {
	t := strings.TrimSpace(s)
	v, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		panic("ValueError: int() invalid literal for '" + s + "'")
	}
	return v
}

func pyint_f64(d float64) int64  { return int64(d) } // truncate toward zero
func pyint_bool(b bool) int64 { if b { return 1 }; return 0 }
func pyint_i64(v int64) int64    { return v }

func pyfloat_str_parse(s string) float64 {
	t := strings.TrimSpace(s)
	v, err := strconv.ParseFloat(t, 64)
	if err != nil {
		panic("ValueError: float() invalid literal for '" + s + "'")
	}
	return v
}

func pyfloat_f64(v float64) float64 { return v }
func pyfloat_bool(b bool) float64   { if b { return 1.0 }; return 0.0 }
func pyfloat_i64(v int64) float64   { return float64(v) }`;

function err(msg: string): never {
  throw new TranspileError(msg, 'go', null);
}

function ident(name: string): string {
  if (GO_RESERVED.has(name)) err(`'${name}' is a reserved word in Go — rename it in the source`);
  if (PRELUDE_NAMES.has(name)) err(`'${name}' collides with the Go prelude — rename it in the source`);
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function boxTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int64';
    case 'float': return 'float64';
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'list': return `[]${boxTy(t.elem)}`;
    case 'map': return `PyDict[${boxTy(t.val)}]`;
    case 'class': return `*${t.name}`;
    case 'void': case 'any': err(`type '${t.k}' cannot appear inside a generic (inferencer bug)`);
  }
}

function emitTy(t: Ty | null): string {
  if (t == null) err('unresolved type reached the backend (inferencer bug)');
  switch (t.k) {
    case 'int': return 'int64';
    case 'float': return 'float64';
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'void': return '';
    case 'list': return `[]${boxTy(t.elem)}`;
    case 'map': return `PyDict[${boxTy(t.val)}]`;
    case 'class': return `*${t.name}`;
    case 'any': err("unresolved 'any' type reached the backend (inferencer bug)");
  }
}

/** Scalars are Go value types; everything else shares storage and must clone. */
function isScalarTy(t: Ty | null): boolean {
  return t != null && (t.k === 'int' || t.k === 'float' || t.k === 'bool' || t.k === 'string');
}

function isLiteralExpr(e: Expr): boolean {
  return e.k === 'int' || e.k === 'float' || e.k === 'bool' || e.k === 'str'
    || e.k === 'list' || e.k === 'map' || e.k === 'new';
}

/**
 * Emit a value going into a "slot" of type slotTy (variable, field, argument,
 * return). Python copies on bind; Go slices/maps/pointers share — non-scalar
 * non-literal values clone, list/map literals slot their ELEMENTS.
 */
function slotVal(e: Expr, slotTy: Ty | null): string {
  if (slotTy == null || isScalarTy(slotTy)) return emitExpr(e);
  if (slotTy.k === 'list' && e.k === 'list') {
    return e.elems.length === 0
      ? `[]${boxTy(slotTy.elem)}{}`
      : `[]${boxTy(slotTy.elem)}{${e.elems.map(el => slotVal(el, slotTy.elem)).join(', ')}}`;
  }
  if (slotTy.k === 'map' && e.k === 'map') {
    if (e.entries.length === 0) return `NewPyDict[${boxTy(slotTy.val)}]()`;
    return `pymap([]PyKV[${boxTy(slotTy.val)}]{${e.entries.map(en => `{K: "${goEscape(en.key)}", V: ${slotVal(en.val, slotTy.val)}}`).join(', ')}})`;
  }
  if (slotTy.k === 'class' && e.k === 'new') return emitExpr(e);
  if (isLiteralExpr(e)) return emitExpr(e);
  switch (slotTy.k) {
    case 'list': return `slices.Clone(${emitExpr(e)})`;
    case 'map': case 'class': return `${emitExpr(e)}.Clone()`;
    default: return emitExpr(e);
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function wrap(e: Expr): string {
  return e.k === 'bin' || e.k === 'un' ? `(${emitExpr(e)})` : emitExpr(e);
}

function goEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/** f-string -> pystr-concatenation chain (Go has no interpolation). */
function emitInterp(parts: (string | Expr)[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(`"${goEscape(p)}"`);
    else out.push(`pystr(${wrap(p)})`);
  }
  if (out.length === 0) return '""';
  return out.join(' + ');
}

function emitMethod(e: Extract<Expr, { k: 'method' }>): string {
  const o = emitExpr(e.obj);
  const a = e.args;
  if (e.objTy?.k === 'class') {
    const args = a.map((x, i) => slotVal(x, e.argTys?.[i] ?? null)).join(', ');
    return `${o}.${ident(e.name)}(${args})`;
  }
  if (e.objTy?.k === 'list') {
    const elem = e.objTy.elem;
    switch (e.name) {
      case 'append': case 'push':
        // Go append returns a new header — only valid as a statement; emitStmt
        // rewrites it into an assignment, expression use fails loudly
        err("'append' reached the Go backend as an expression (statement use only)");
      case 'pop':
        return a.length === 0
          ? `pypop(&${o})`
          : err('pop(i) is not supported in v1');
      case 'index': return `pylist_index(${o}, ${slotVal(a[0], elem)})`;
      case 'sort':
        if (elem?.k === 'float') err("pysort on floats is not supported in v1 (NaN ordering)");
        return `pysort(${o})`;
      case 'reverse': return `pyreverse(${o})`;
      case 'clear': return err("'clear' reached the Go backend as an expression (statement use only)");
      case 'join': return `pyjoin(${emitExpr(a[0])}, ${o})`;   // IR: sep.join(xs) -> xs.join(sep)
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  if (e.objTy?.k === 'string') {
    switch (e.name) {
      case 'upper': return `pyupper(${o})`;
      case 'lower': return `pylower(${o})`;
      case 'strip': case 'trim': return `pystrip(${o})`;
      case 'replace': return `pyreplace(${o}, ${emitExpr(a[0])}, ${emitExpr(a[1])})`;
      case 'split': return `pysplit(${o}, ${emitExpr(a[0])})`;
      case 'startswith': return `pystartswith(${o}, ${emitExpr(a[0])})`;
      case 'endswith': return `pyendswith(${o}, ${emitExpr(a[0])})`;
      case 'find': return `pystr_find(${o}, ${emitExpr(a[0])})`;
      case 'isdigit': return `pyisdigit(${o})`;
      case 'join': return `pyjoin(${emitExpr(a[0])}, ${o})`;   // IR: sep.join(xs) -> xs.join(sep)
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  if (e.objTy?.k === 'map') {
    const val = e.objTy.val;
    switch (e.name) {
      case 'get': return `${o}.Get(${emitExpr(a[0])}, ${slotVal(a[1], val)})`;
      case 'keys': return `${o}.Keys()`;
      case 'values': return `${o}.Values()`;
      case 'pop': return `${o}.Pop(${emitExpr(a[0])})`;
      case 'index': return `${o}.Index(${emitExpr(a[0])})`;
      default: err(`unsupported method '${e.name}' reached the backend (inferencer bug)`);
    }
  }
  err('untyped receiver reached the backend (inferencer bug)');
}

/** Free calls: prelude conversions typed by argument, user fns slot-copy. */
function emitCall(e: Extract<Expr, { k: 'call' }>): string {
  const a = e.args;
  if (e.name === 'print') return `print(${a.map(x => emitExpr(x)).join(', ')})`;
  if (e.name === 'len') {
    const t = e.argTys?.[0] ?? null;
    if (t?.k === 'map') return `${emitExpr(a[0])}.Len()`;
    return `int64(len(${emitExpr(a[0])}))`;
  }
  if (e.name === 'str') return `pystr(${emitExpr(a[0])})`;
  if (e.name === 'int') {
    const t = e.argTys?.[0] ?? null;
    const x = emitExpr(a[0]);
    if (t?.k === 'string') return `pyint_str(${x})`;
    if (t?.k === 'float') return `pyint_f64(${x})`;
    if (t?.k === 'bool') return `pyint_bool(${x})`;
    return x;
  }
  if (e.name === 'float') {
    const t = e.argTys?.[0] ?? null;
    const x = emitExpr(a[0]);
    if (t?.k === 'string') return `pyfloat_str_parse(${x})`;
    if (t?.k === 'bool') return `pyfloat_bool(${x})`;
    if (t?.k === 'int') return `pyfloat_i64(${x})`;
    return x;
  }
  if (e.name === 'main') return 'main()';
  const args = a.map((x, i) => slotVal(x, e.argTys?.[i] ?? null)).join(', ');
  return `${ident(e.name)}(${args})`;
}

function emitBin(e: Extract<Expr, { k: 'bin' }>): string {
  switch (e.op) {
    case '/': return `(float64(${emitExpr(e.l)}) / float64(${emitExpr(e.r)}))`;   // Python true division
    case '//': return `idiv(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '%': return `imod(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '+':
      if (e.rty?.k === 'string' || e.lty?.k === 'string') {
        return `pyconcat(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
      }
      return emitDefaultBin(e);
    case '==':
      if (e.lty?.k === 'class') return `${emitExpr(e.l)} == ${emitExpr(e.r)}`;
      return `pyeq(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case '!=':
      if (e.lty?.k === 'class') return `${emitExpr(e.l)} != ${emitExpr(e.r)}`;
      return `!pyeq(${emitExpr(e.l)}, ${emitExpr(e.r)})`;
    case 'in': case 'notin': {
      const inner = e.rty?.k === 'string' ? `strings.Contains(${emitExpr(e.r)}, ${emitExpr(e.l)})`
        : e.rty?.k === 'list' ? `pyin(${emitExpr(e.l)}, ${emitExpr(e.r)})`
        : e.rty?.k === 'map' ? `${emitExpr(e.r)}.Has(${emitExpr(e.l)})`
        : err("'in' without a container type (inferencer bug)");
      return e.op === 'notin' ? `!(${inner})` : inner;
    }
    default: return emitDefaultBin(e);
  }
}

/** Numeric bin: mixed int/float widens the int side (Python semantics). */
function emitDefaultBin(e: Extract<Expr, { k: 'bin' }>): string {
  const lf = e.lty?.k === 'float';
  const rf = e.rty?.k === 'float';
  if (lf !== rf && (e.lty?.k === 'int' || e.lty?.k === 'float') && (e.rty?.k === 'int' || e.rty?.k === 'float')) {
    const l = lf ? emitExpr(e.l) : `float64(${emitExpr(e.l)})`;
    const r = rf ? emitExpr(e.r) : `float64(${emitExpr(e.r)})`;
    return `(${l} ${e.op} ${r})`;
  }
  return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
}

function emitExpr(e: Expr): string {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'float': return Number.isInteger(e.v) ? `${e.v.toFixed(1)}` : String(e.v);
    case 'bool': return e.v ? 'true' : 'false';
    case 'str': return `"${goEscape(e.v)}"`;
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
        ? `${emitExpr(e.obj)}.Index(${emitExpr(e.idx)})`
        : `${wrap(e.obj)}[${emitExpr(e.idx)}]`;
    case 'list': {
      const elem = e.elemTy ?? TY_INT;
      if (e.elems.length === 0) return `[]${boxTy(elem)}{}`;
      return `[]${boxTy(elem)}{${e.elems.map(x => emitExpr(x)).join(', ')}}`;
    }
    case 'map':
      if (e.entries.length === 0) return `NewPyDict[${boxTy(e.valTy ?? TY_INT)}]()`;
      return `pymap([]PyKV[${boxTy(e.valTy ?? TY_INT)}]{${e.entries.map(en => `{K: "${goEscape(en.key)}", V: ${emitExpr(en.val)}}`).join(', ')}})`;
    case 'new': {
      // ctor args slot-copy by the class's declared parameter types
      const params = clsParams.get(e.cls);
      const args = e.args.map((x, i) => slotVal(x, params?.[i]?.ty ?? null)).join(', ');
      return `New${e.cls}(${args})`;
    }
    case 'interp': return emitInterp(e.parts);
  }
}

const TY_INT: Ty = { k: 'int' };

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function forrangeHead(s: Extract<Stmt, { k: 'forrange' }>): string {
  const v = ident(s.varName);
  const start = emitExpr(s.start);
  const stop = emitExpr(s.stop);
  const cmp = s.step.k === 'un' && s.step.op === '-' ? '>' : '<';
  let delta = s.step;
  if (delta.k === 'un') delta = delta.e;
  if (delta.k !== 'int' || delta.v === 0) err('forrange step must be a nonzero int literal in the Go backend');
  // int64(start): an untyped literal would infer Go `int`, not int64
  return `for ${v} := int64(${start}); ${v} ${cmp} ${stop}; ${v} ${cmp === '<' ? '+' : '-'}= ${delta.v} {`;
}

function foreachHead(s: Extract<Stmt, { k: 'foreach' }>): string {
  const it = s.iterTy?.k === 'map'
    ? (s.iter.k === 'method' && (s.iter.name === 'keys' || s.iter.name === 'values') ? emitExpr(s.iter) : `${emitExpr(s.iter)}.Keys()`)
    : emitExpr(s.iter);
  // Go rejects unused range variables; collapse to `for range`
  const reads = collectReads(s.body);
  if (!reads.has(s.varName)) return `for range ${it} {`;
  return `for _, ${ident(s.varName)} := range ${it} {`;
}

/** Variables read anywhere in a statement list (for the unused-local guard). */
function collectReads(body: Stmt[], acc = new Set<string>()): Set<string> {
  const walkStmt = (s: Stmt): void => {
    const walkExpr = (e: Expr): void => {
      switch (e.k) {
        case 'var': acc.add(e.name); return;
        case 'bin': walkExpr(e.l); walkExpr(e.r); return;
        case 'un': walkExpr(e.e); return;
        case 'call': e.args.forEach(walkExpr); return;
        case 'method': walkExpr(e.obj); e.args.forEach(walkExpr); return;
        case 'field': walkExpr(e.obj); return;
        case 'index': walkExpr(e.obj); walkExpr(e.idx); return;
        case 'list': e.elems.forEach(walkExpr); return;
        case 'map': e.entries.forEach(en => walkExpr(en.val)); return;
        case 'new': e.args.forEach(walkExpr); return;
        case 'interp': for (const p of e.parts) if (typeof p !== 'string') walkExpr(p); return;
        default: return;
      }
    };
    switch (s.k) {
      case 'vardecl': walkExpr(s.init); return;
      case 'assign': walkExpr(s.target); walkExpr(s.value); return;
      case 'expr': walkExpr(s.e); return;
      case 'return': if (s.v) walkExpr(s.v); return;
      case 'print': s.args.forEach(walkExpr); return;
      case 'if': walkExpr(s.cond); s.then.forEach(walkStmt); s.elifs.forEach(el => { walkExpr(el.cond); el.body.forEach(walkStmt); }); if (s.els) s.els.forEach(walkStmt); return;
      case 'while': walkExpr(s.cond); s.body.forEach(walkStmt); return;
      case 'forrange': walkExpr(s.start); walkExpr(s.stop); walkExpr(s.step); s.body.forEach(walkStmt); return;
      case 'foreach': walkExpr(s.iter); s.body.forEach(walkStmt); return;
      default: return;   // break / continue / print handled where emitted
    }
  };
  body.forEach(walkStmt);
  return acc;
}

function emitStmt(s: Stmt, out: string[], ind: number): void {
  const pad = '\t'.repeat(ind);
  switch (s.k) {
    case 'vardecl': {
      const redeclared = scopeHas(s.name);
      const rhs = slotVal(s.init, s.ty);
      if (redeclared) {
        out.push(`${pad}${ident(s.name)} = ${rhs}`);
      } else {
        declareScope(s.name);
        out.push(`${pad}var ${ident(s.name)} ${emitTy(s.ty)} = ${rhs}`);
        if (!collectReads(fnBodyRemaining()).has(s.name)) {
          // Go rejects unused locals — keep the value alive with a blank var
          out.push(`${pad}var _ = ${ident(s.name)}`);
        }
      }
      break;
    }
    case 'assign': {
      const t = s.target;
      if (t.k === 'var') out.push(`${pad}${ident(t.name)} = ${slotVal(s.value, s.valueTy ?? null)}`);
      else if (t.k === 'field') out.push(`${pad}${emitExpr(t.obj)}.${t.name} = ${slotVal(s.value, s.valueTy ?? null)}`);
      else if (t.k === 'index') {
        if (t.objTy?.k === 'map') {
          out.push(`${pad}${emitExpr(t.obj)}.Set(${emitExpr(t.idx)}, ${slotVal(s.value, s.valueTy ?? null)})`);
        } else {
          out.push(`${pad}${emitExpr(t.obj)}[${emitExpr(t.idx)}] = ${slotVal(s.value, s.valueTy ?? null)}`);
        }
      } else err('unsupported assignment target reached the backend (inferencer bug)');
      break;
    }
    case 'expr': {
      const e = s.e;
      if (e.k === 'method' && e.objTy?.k === 'list' && (e.name === 'append' || e.name === 'push')) {
        out.push(`${pad}${emitExpr(e.obj)} = append(${emitExpr(e.obj)}, ${slotVal(e.args[0], e.objTy.elem)})`);
        break;
      }
      if (e.k === 'method' && e.objTy?.k === 'list' && e.name === 'clear') {
        out.push(`${pad}${emitExpr(e.obj)} = ${emitExpr(e.obj)}[:0]`);
        break;
      }
      out.push(`${pad}${emitExpr(e)}`);
      break;
    }
    case 'return': {
      if (!s.v) { out.push(`${pad}return`); break; }
      out.push(`${pad}return ${slotVal(s.v, ctxRetTy ?? null)}`);
      break;
    }
    case 'if': {
      out.push(`${pad}if ${emitExpr(s.cond)} {`);
      pushScope();
      emitBody(s.then, out, ind + 1);
      popScope();
      for (const el of s.elifs) {
        out.push(`${pad}} else if ${emitExpr(el.cond)} {`);
        pushScope();
        emitBody(el.body, out, ind + 1);
        popScope();
      }
      if (s.els) {
        out.push(`${pad}} else {`);
        pushScope();
        emitBody(s.els, out, ind + 1);
        popScope();
      }
      out.push(`${pad}}`);
      break;
    }
    case 'while':
      out.push(`${pad}for ${emitExpr(s.cond)} {`);
      pushScope();
      emitBody(s.body, out, ind + 1);
      popScope();
      out.push(`${pad}}`);
      break;
    case 'forrange':
      out.push(`${pad}${forrangeHead(s)}`);
      pushScope();
      emitBody(s.body, out, ind + 1);
      popScope();
      out.push(`${pad}}`);
      break;
    case 'foreach':
      out.push(`${pad}${foreachHead(s)}`);
      pushScope();
      emitBody(s.body, out, ind + 1);
      popScope();
      out.push(`${pad}}`);
      break;
    case 'break': out.push(`${pad}break`); break;
    case 'continue': out.push(`${pad}continue`); break;
    case 'print':
      out.push(`${pad}print(${s.args.map(x => emitExpr(x)).join(', ')})`);
      break;
  }
}

function emitBody(body: Stmt[], out: string[], ind: number): void {
  const saved = fnBody;
  fnBody = body;
  for (const s of body) emitStmt(s, out, ind);
  fnBody = saved;
}

// -- scope tracking (Go rejects redeclaration and unused locals) --------------

let scopes: Set<string>[] = [];
let fnBody: Stmt[] = [];

function pushScope(): void { scopes.push(new Set()); }
function popScope(): void { scopes.pop(); }
function declareScope(name: string): void {
  if (scopes.length === 0) scopes.push(new Set());
  scopes[scopes.length - 1].add(name);
}
function scopeHas(name: string): boolean {
  // Go redeclaration is an error only in the SAME block; inner scopes may
  // shadow outer names freely, so check the innermost scope alone
  if (scopes.length === 0) return false;
  return scopes[scopes.length - 1].has(name);
}
function fnBodyRemaining(): Stmt[] { return fnBody; }

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** Default field initializer per type (documented divergence: no runtime error). */
function fieldDefault(t: Ty | null): string {
  switch (t?.k) {
    case 'int': return '0';
    case 'float': return '0.0';
    case 'bool': return 'false';
    case 'string': return '""';
    case 'list': return `[]${boxTy(t.elem)}{}`;
    case 'map': return `NewPyDict[${boxTy(t.val)}]()`;
    case 'class': return 'nil';
    default: err(`field type '${t ? t.k : 'null'}' cannot be default-initialized in the Go backend`);
  }
}

/** How a field of type t clones inside a generated class Clone. */
function fieldClone(t: Ty | null, name: string): string {
  switch (t?.k) {
    case 'int': case 'float': case 'bool': case 'string': return `x.${name}`;
    case 'list': return `slices.Clone(x.${name})`;
    case 'map': return `x.${name}.Clone()`;
    case 'class': return `x.${name}.Clone()`;
    default: return `x.${name}`;
  }
}

function emitClass(c: ClassDecl, out: string[], clsName: string): void {
  if (c.name === clsName) err(`class '${c.name}' collides with the module struct name`);
  for (const meth of c.methods) {
    if (meth.name === 'Clone') err(`method 'Clone' collides with the generated copy — rename it`);
  }
  out.push(`type ${ident(c.name)} struct {`);
  for (const f of c.fields) out.push(`\t${ident(f.name)} ${emitTy(f.ty)}`);
  out.push(`}`, '');
  // Clone: Python binds copies; Go pointers share — classes clone per field
  out.push(`func (x *${ident(c.name)}) Clone() *${ident(c.name)} {`);
  out.push(`\tobj := &${ident(c.name)}{}`);
  for (const f of c.fields) out.push(`\tobj.${ident(f.name)} = ${fieldClone(f.ty, ident(f.name))}`);
  out.push(`\treturn obj`, `}`, '');
  // PyVal (value receivers: both X and *X satisfy the interface)
  out.push(`func (x ${ident(c.name)}) PyStr() string {`);
  if (c.fields.length === 0) {
    out.push(`\treturn "${ident(c.name)}{}"`);
  } else {
    const fieldParts = c.fields.map(f => `"${ident(f.name)}: " + pyrepr(x.${ident(f.name)})`);
    out.push(`\treturn "${ident(c.name)}{" + ${fieldParts.join(' + ", " + ')} + "}"`);
  }
  out.push(`}`, '');
  out.push(`func (x ${ident(c.name)}) PyRepr() string { return x.PyStr() }`, '');
  // constructor
  const ctorParams = c.ctor?.params ?? [];
  const params = ctorParams.map(p => `${ident(p.name)} ${emitTy(p.ty)}`).join(', ');
  out.push(`func New${ident(c.name)}(${params}) *${ident(c.name)} {`);
  out.push(`\tobj := &${ident(c.name)}{`);
  for (const f of c.fields) out.push(`\t\t${ident(f.name)}: ${fieldDefault(f.ty)},`);
  out.push(`\t}`);
  if (c.ctor) {
    ctxRetTy = null;
    ctxThis = 'obj';
    scopes = [new Set()];
    for (const p of ctorParams) declareScope(p.name);
    emitBody(c.ctor.body, out, 1);
    ctxThis = 'x';
  }
  out.push(`\treturn obj`);
  out.push(`}`, '');
  for (const meth of c.methods) {
    const ps = meth.params.map(p => `${ident(p.name)} ${emitTy(p.ty)}`).join(', ');
    const ret = meth.ret?.k === 'void' ? '' : ` ${emitTy(meth.ret)}`;
    out.push(`func (x *${ident(c.name)}) ${ident(meth.name)}(${ps})${ret} {`);
    ctxRetTy = meth.ret ?? null;
    scopes = [new Set(['x'])];
    for (const p of meth.params) declareScope(p.name);
    emitBody(meth.body, out, 1);
    ctxRetTy = null;
    out.push(`}`, '');
  }
  out.push('');
}

function emitFun(f: FunDecl, out: string[], clsName: string): void {
  if (f.name === 'main') {
    if (f.params.length > 0) err(`def main(${f.params.map(p => p.name).join(', ')}) — a 'main' with parameters cannot be a Go entry point`);
    out.push(`func main() {`);
    ctxRetTy = null;
    scopes = [new Set()];
    emitBody(f.body, out, 1);
    out.push(`}`, '');
    return;
  }
  if (f.name === clsName) err(`function '${f.name}' collides with the module struct name`);
  const ps = f.params.map(p => `${ident(p.name)} ${emitTy(p.ty)}`).join(', ');
  const ret = f.ret?.k === 'void' ? '' : ` ${emitTy(f.ret)}`;
  out.push(`func ${ident(f.name)}(${ps})${ret} {`);
  ctxRetTy = f.ret ?? null;
  scopes = [new Set()];
  for (const p of f.params) declareScope(p.name);
  emitBody(f.body, out, 1);
  ctxRetTy = null;
  out.push(`}`, '');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let ctxRetTy: Ty | null = null;   // current function's return type (slot-copy on return)
let ctxThis = 'x';                // receiver name inside ctor bodies ('obj')
let clsParams: Map<string, { name: string; ty: Ty | null }[]>;   // ctor param types for slot-copy

export function emitGo(m: Module): string {
  ctxRetTy = null;
  ctxThis = 'x';
  scopes = [new Set()];
  fnBody = [];
  clsParams = new Map();
  for (const item of m.items) {
    if ('fields' in item && item.ctor) clsParams.set(item.name, item.ctor.params);
  }
  const clsName = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/[^A-Za-z0-9_$]/g, '');
  const out: string[] = [
    `// generated by ouro — 100% native Go, no cgo (run: go run <this-file>)`,
    `// the full prelude ships even when a program only uses part of it`,
    `package main`,
    '',
    `import (`,
    `\t"fmt"`,
    `\t"math"`,
    `\t"reflect"`,
    `\t"slices"`,
    `\t"cmp"`,
    `\t"strconv"`,
    `\t"strings"`,
    `)`,
    '',
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
    out.push(`func main() {}   // a module of only declarations runs like an imported module: no output`);
    out.push('');
  }
  return out.join('\n');
}
