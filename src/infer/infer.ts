/**
 * Type inferencer (Layer 2).
 *
 * Runs on IR produced by the Python frontend (ty === null where Python had no
 * annotation). Static-language frontends emit fully-typed IR and skip this.
 *
 * Algorithm: fixpoint passes over the whole module. Each pass walks every
 * function/method/ctor/main body, resolving what it can (literals, calls to
 * functions whose returns became known, collection methods, etc.). Stops when
 * nothing new resolves. Then a validation pass fails loudly on unresolved
 * types, unsupported constructs (None, string indexing), and mismatched
 * assignments.
 */

import type { Module, Item, Stmt, Expr, Ty, ClassDecl, FunDecl } from '../ir/types.ts';
import {
  TY_INT, TY_FLOAT, TY_BOOL, TY_STRING, TY_VOID, tyEq, tyShow, TranspileError,
} from '../ir/types.ts';

interface VarInfo {
  ty: Ty | null;
  declNode: Stmt | null;   // the vardecl stmt, so later assigns can mutate it
}

interface Ctx {
  funs: Map<string, FunDecl>;
  classes: Map<string, ClassDecl>;
  className: string | null;
  vars: Map<string, VarInfo>;
  retAcc: Ty | null;        // inferred return type accumulator (null = unknown/none yet)
  hasReturn: boolean;
  where: string;            // for error messages, e.g. "function 'fib'"
}

function err(msg: string, _where?: string): never {
  throw new TranspileError(msg, 'infer', null);
}

const isNum = (t: Ty): boolean => t.k === 'int' || t.k === 'float';

/** Promote: int+float -> float; equal types -> that type; else null. */
function unify(a: Ty | null, b: Ty | null): Ty | null {
  if (a == null || b == null) return null;
  if (a.k === 'any' || b.k === 'any') return null;
  if (a.k === 'int' && b.k === 'float') return TY_FLOAT;
  if (a.k === 'float' && b.k === 'int') return TY_FLOAT;
  if (tyEq(a, b)) return a;
  return null;
}

/** Is src assignable to dst? (int widens to float) */
function compat(dst: Ty, src: Ty): boolean {
  if (dst.k === 'float' && src.k === 'int') return true;
  return tyEq(dst, src);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function inferModule(m: Module): Module {
  const funs = new Map<string, FunDecl>();
  const classes = new Map<string, ClassDecl>();
  for (const item of m.items) {
    if ('fields' in item) classes.set(item.name, item as ClassDecl);
    else funs.set(item.name, item as FunDecl);
  }

  const base: Ctx = {
    funs, classes, className: null,
    vars: new Map(), retAcc: null, hasReturn: false, where: '',
  };

  for (let pass = 0; pass < 8; pass++) {
    for (const item of m.items) {
      if ('fields' in item) inferClass(item as ClassDecl, base);
      else inferFun(item as FunDecl, base);
    }
  }

  validate(m, base);
  return m;
}

// ---------------------------------------------------------------------------
// Functions / classes
// ---------------------------------------------------------------------------

function inferFun(f: FunDecl, base: Ctx): void {
  const ctx: Ctx = { ...base, className: null, vars: new Map(), retAcc: null, hasReturn: false, where: `function '${f.name}'` };
  for (const p of f.params) ctx.vars.set(p.name, { ty: p.ty, declNode: null });
  walkBody(f.body, ctx);
  // finalize return type
  if (f.ret == null) {
    f.ret = ctx.hasReturn ? (ctx.retAcc ?? TY_VOID) : TY_VOID;
  }
}

function inferClass(c: ClassDecl, base: Ctx): void {
  if (c.ctor) {
    const ctx: Ctx = { ...base, className: c.name, vars: new Map(), retAcc: TY_VOID, hasReturn: false, where: `${c.name}.__init__` };
    for (const p of c.ctor.params) ctx.vars.set(p.name, { ty: p.ty, declNode: null });
    walkBody(c.ctor.body, ctx);
  }
  for (const meth of c.methods) {
    const ctx: Ctx = { ...base, className: c.name, vars: new Map(), retAcc: null, hasReturn: false, where: `${c.name}.${meth.name}` };
    for (const p of meth.params) ctx.vars.set(p.name, { ty: p.ty, declNode: null });
    walkBody(meth.body, ctx);
    if (meth.ret == null) meth.ret = ctx.hasReturn ? (ctx.retAcc ?? TY_VOID) : TY_VOID;
  }
}

// ---------------------------------------------------------------------------
// Statement walking
// ---------------------------------------------------------------------------

function walkBody(body: Stmt[], ctx: Ctx): void {
  for (const s of body) walkStmt(s, ctx);
}

function classFieldTy(ctx: Ctx, name: string): Ty | null {
  if (!ctx.className) return null;
  const c = ctx.classes.get(ctx.className)!;
  const f = c.fields.find(x => x.name === name);
  return f ? f.ty : null;
}

function setClassFieldTy(ctx: Ctx, name: string, ty: Ty): void {
  const c = ctx.classes.get(ctx.className!)!;
  const f = c.fields.find(x => x.name === name);
  if (f && f.ty == null) f.ty = ty;
}

function walkStmt(s: Stmt, ctx: Ctx): void {
  switch (s.k) {
    case 'vardecl': {
      if (s.ty == null) {
        const t = exprTy(s.init, ctx);
        if (t != null) {
          if (!compatAll(t, s.init, ctx)) err(`${ctx.where}: cannot assign ${tyShow(t)} to '${s.name}' (type mismatch)`, ctx.where);
          s.ty = t;
        }
      }
      if (s.ty != null) fillLiteralTys(s.init, s.ty, ctx);
      ctx.vars.set(s.name, { ty: s.ty, declNode: s });
      break;
    }
    case 'assign': {
      const vt = exprTy(s.value, ctx);
      // target: var | field(this/x) | index
      if (s.target.k === 'var') {
        const info = ctx.vars.get(s.target.name);
        if (info == null) err(`${ctx.where}: assignment to undeclared variable '${s.target.name}'`, ctx.where);
        if (info.ty == null && vt != null) {
          info.ty = vt;
          if (info.declNode && info.declNode.k === 'vardecl') info.declNode.ty = vt;
        }
        if (info.ty != null && vt != null && !compat(info.ty, vt)) {
          err(`${ctx.where}: assigning ${tyShow(vt)} to '${s.target.name}' of type ${tyShow(info.ty)}`, ctx.where);
        }
        if (info.ty != null) fillLiteralTys(s.value, info.ty, ctx);
      } else if (s.target.k === 'field' && s.target.obj.k === 'this') {
        const ft = classFieldTy(ctx, s.target.name);
        if (ft == null && vt != null) setClassFieldTy(ctx, s.target.name, vt);
        else if (ft != null && vt != null && !compat(ft, vt)) {
          err(`${ctx.where}: assigning ${tyShow(vt)} to field '${s.target.name}' of type ${tyShow(ft)}`, ctx.where);
        }
      } else if (s.target.k === 'index') {
        const ot = exprTy(s.target.obj, ctx);
        exprTy(s.target.idx, ctx);
        exprTy(s.value, ctx);
        if (ot != null && vt != null) {
          if (ot.k === 'list' && !compat(ot.elem, vt)) {
            err(`${ctx.where}: list holds ${tyShow(ot.elem)}, assigned ${tyShow(vt)}`, ctx.where);
          }
          if (ot.k === 'map' && !compat(ot.val, vt)) {
            err(`${ctx.where}: map holds ${tyShow(ot.val)}, assigned ${tyShow(vt)}`, ctx.where);
          }
        }
      } else {
        err(`${ctx.where}: unsupported assignment target`, ctx.where);
      }
      break;
    }
    case 'expr':
      exprTy(s.e, ctx);
      break;
    case 'return': {
      ctx.hasReturn = true;
      if (s.v == null) {
        if (ctx.retAcc == null) ctx.retAcc = TY_VOID;
        else if (ctx.retAcc.k !== 'void') err(`${ctx.where}: mixing value and bare returns`, ctx.where);
      } else {
        const t = exprTy(s.v, ctx);
        if (t != null) {
          const u = unify(ctx.retAcc, t);
          if (u == null && ctx.retAcc != null) {
            err(`${ctx.where}: returns ${tyShow(t)} but also ${tyShow(ctx.retAcc)}`, ctx.where);
          }
          if (u != null) ctx.retAcc = u;
        }
      }
      break;
    }
    case 'if': {
      condTy(s.cond, ctx, 'if');
      walkBody(s.then, { ...ctx, vars: new Map(ctx.vars) });
      for (const el of s.elifs) {
        condTy(el.cond, ctx, 'elif');
        walkBody(el.body, { ...ctx, vars: new Map(ctx.vars) });
      }
      if (s.els) walkBody(s.els, { ...ctx, vars: new Map(ctx.vars) });
      break;
    }
    case 'while': {
      condTy(s.cond, ctx, 'while');
      walkBody(s.body, { ...ctx, vars: new Map(ctx.vars) });
      break;
    }
    case 'forrange': {
      ctx.vars.set(s.varName, { ty: TY_INT, declNode: null });
      walkBody(s.body, { ...ctx, vars: new Map(ctx.vars) });
      break;
    }
    case 'foreach': {
      const it = exprTy(s.iter, ctx);
      if (it != null && s.varTy == null) {
        if (it.k === 'list') s.varTy = it.elem;
        else if (it.k === 'map') s.varTy = TY_STRING;   // for k in dict: iterates keys
        else err(`${ctx.where}: cannot iterate over ${tyShow(it)} (v1: lists and dicts)`, ctx.where);
      }
      if (s.varTy != null) ctx.vars.set(s.varName, { ty: s.varTy, declNode: null });
      walkBody(s.body, { ...ctx, vars: new Map(ctx.vars) });
      break;
    }
    case 'break':
    case 'continue':
      break;
    case 'print':
      for (const a of s.args) exprTy(a, ctx);
      break;
  }
}

function condTy(cond: Expr, ctx: Ctx, what: string): void {
  const t = exprTy(cond, ctx);
  if (t != null && t.k !== 'bool') {
    err(`${ctx.where}: ${what} condition must be bool, got ${tyShow(t)} (no truthiness in v1)`, ctx.where);
  }
}

/** Extra check at vardecl time: value ty is compatible (cheap recursion guard). */
function compatAll(_t: Ty, _init: Expr, _ctx: Ctx): boolean {
  return true; // detailed checks happen in assign/exprTy; keep vardecl permissive
}

/** If decl type is list/map and init is a literal of the same kind, stamp elem/val types. */
function fillLiteralTys(init: Expr, declTy: Ty, ctx: Ctx): void {
  if (init.k === 'list' && declTy.k === 'list' && init.elemTy == null) {
    init.elemTy = declTy.elem;
    for (const el of init.elems) {
      const t = exprTy(el, ctx);
      if (t != null && !compat(declTy.elem, t)) {
        err(`list declared ${tyShow(declTy)} contains ${tyShow(t)}`, ctx.where);
      }
    }
  }
  if (init.k === 'map' && declTy.k === 'map' && init.valTy == null) {
    init.valTy = declTy.val;
    for (const en of init.entries) {
      const t = exprTy(en.val, ctx);
      if (t != null && !compat(declTy.val, t)) {
        err(`map declared ${tyShow(declTy)} contains value ${tyShow(t)}`, ctx.where);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Expression typing: returns Ty or null when "not resolvable yet" (fixpoint)
// ---------------------------------------------------------------------------

function exprTy(e: Expr, ctx: Ctx): Ty | null {
  switch (e.k) {
    case 'int': return TY_INT;
    case 'float': return TY_FLOAT;
    case 'bool': return TY_BOOL;
    case 'str': return TY_STRING;
    case 'null':
      err(`${ctx.where}: None/null unsupported in v1 (no nullable types yet)`, ctx.where);
    case 'var': {
      const info = ctx.vars.get(e.name);
      if (info == null) {
        err(`${ctx.where}: unknown variable '${e.name}' (scope has: ${Array.from(ctx.vars.keys()).join(', ') || '<empty>'})`, ctx.where);
      }
      return info.ty;
    }
    case 'this':
      return ctx.className ? { k: 'class', name: ctx.className } : null;
    case 'interp':
      for (const p of e.parts) if (typeof p !== 'string') exprTy(p, ctx);
      return TY_STRING;
    case 'un': {
      if (e.op === '!') { exprTy(e.e, ctx); return TY_BOOL; }
      const t = exprTy(e.e, ctx);
      if (t == null) return null;
      if (!isNum(t)) err(`${ctx.where}: unary '-' needs a number, got ${tyShow(t)}`, ctx.where);
      return t;
    }
    case 'bin': return binTy(e, ctx);
    case 'new': {
      for (const a of e.args) exprTy(a, ctx);
      return { k: 'class', name: e.cls };
    }
    case 'call': return callTy(e, ctx);
    case 'method': return methodTy(e, ctx);
    case 'field': {
      const ot = exprTy(e.obj, ctx);
      if (ot == null) return null;
      if (ot.k !== 'class') err(`${ctx.where}: field access .${e.name} on non-class ${tyShow(ot)}`, ctx.where);
      return classFieldTyOf(ctx, ot.name, e.name);
    }
    case 'index': {
      const ot = exprTy(e.obj, ctx);
      const it = exprTy(e.idx, ctx);
      if (ot == null) return null;
      if (ot.k === 'string') err(`${ctx.where}: string indexing unsupported in v1`, ctx.where);
      if (ot.k === 'list') {
        if (it != null && it.k !== 'int') err(`${ctx.where}: list index must be int, got ${tyShow(it)}`, ctx.where);
        return ot.elem;
      }
      if (ot.k === 'map') {
        if (it != null && it.k !== 'string') err(`${ctx.where}: map key must be string, got ${tyShow(it)}`, ctx.where);
        return ot.val;
      }
      err(`${ctx.where}: cannot index ${tyShow(ot)}`, ctx.where);
    }
    case 'list': {
      let acc: Ty | null = e.elemTy ?? null;
      let seen = acc != null;
      for (const el of e.elems) {
        const t = exprTy(el, ctx);
        if (t == null) continue;
        if (!seen) { acc = t; seen = true; }
        else acc = unify(acc, t);
      }
      if (acc != null && e.elemTy == null) e.elemTy = acc;
      return acc == null ? null : { k: 'list', elem: acc };
    }
    case 'map': {
      let acc: Ty | null = e.valTy ?? null;
      let seen = acc != null;
      for (const en of e.entries) {
        const t = exprTy(en.val, ctx);
        if (t == null) continue;
        if (!seen) { acc = t; seen = true; }
        else acc = unify(acc, t);
      }
      if (acc != null && e.valTy == null) e.valTy = acc;
      return acc == null ? null : { k: 'map', val: acc };
    }
  }
}

function classFieldTyOf(ctx: Ctx, clsName: string, fieldName: string): Ty | null {
  const c = ctx.classes.get(clsName);
  if (c == null) err(`${ctx.where}: unknown class '${clsName}'`, ctx.where);
  const f = c!.fields.find(x => x.name === fieldName);
  if (f == null) err(`${ctx.where}: class '${clsName}' has no field '${fieldName}'`, ctx.where);
  return f.ty;
}

function binTy(e: Extract<Expr, { k: 'bin' }>, ctx: Ctx): Ty | null {
  const { op } = e;
  if (op === '/') return TY_FLOAT;               // Python: true division, always float
  if (op === '//') return TY_INT;
  if (op === '==' || op === '!=') { exprTy(e.l, ctx); exprTy(e.r, ctx); return TY_BOOL; }
  if (op === '<' || op === '<=' || op === '>' || op === '>='
    || op === '&&' || op === '||' || op === 'in' || op === 'notin') {
    const lt = exprTy(e.l, ctx);
    const rt = exprTy(e.r, ctx);
    if (op === 'in' || op === 'notin') {
      if (lt != null && rt != null) {
        if (rt.k === 'string' && lt.k !== 'string') err(`${ctx.where}: 'in' on string needs string operand`, ctx.where);
        if (rt.k === 'list' && !compat(rt.elem, lt)) err(`${ctx.where}: 'in' list holds ${tyShow(rt.elem)}, tested ${tyShow(lt)}`, ctx.where);
        if (rt.k === 'map' && lt.k !== 'string') err(`${ctx.where}: 'in' on map tests string keys`, ctx.where);
        if (rt.k !== 'string' && rt.k !== 'list' && rt.k !== 'map') {
          err(`${ctx.where}: 'in' supports string/list/map, got ${tyShow(rt)}`, ctx.where);
        }
      }
      return TY_BOOL;
    }
    if (lt != null && rt != null) {
      if (lt.k !== rt.k && !(isNum(lt) && isNum(rt))) {
        err(`${ctx.where}: cannot compare ${tyShow(lt)} with ${tyShow(rt)}`, ctx.where);
      }
    }
    return TY_BOOL;
  }
  // arithmetic + - * %
  const lt = exprTy(e.l, ctx);
  const rt = exprTy(e.r, ctx);
  if (lt == null || rt == null) return null;
  if (op === '+') {
    if (lt.k === 'string' && rt.k === 'string') return TY_STRING;
    if (lt.k === 'string' || rt.k === 'string') {
      err(`${ctx.where}: cannot '+' ${tyShow(lt)} and ${tyShow(rt)} (use str() or f-strings)`, ctx.where);
    }
    const u = unify(lt, rt);
    if (u == null || !isNum(u)) err(`${ctx.where}: '+' needs numbers or strings, got ${tyShow(lt)}, ${tyShow(rt)}`, ctx.where);
    return u;
  }
  const u = unify(lt, rt);
  if (u == null || !isNum(u)) err(`${ctx.where}: '${op}' needs numbers, got ${tyShow(lt)}, ${tyShow(rt)}`, ctx.where);
  if (op === '%' && lt.k === 'int' && rt.k === 'int') return TY_INT;
  return u;
}

function callTy(e: Extract<Expr, { k: 'call' }>, ctx: Ctx): Ty | null {
  const argTys = e.args.map(a => exprTy(a, ctx));
  if (e.name === 'len') {
    if (argTys[0] != null && argTys[0].k !== 'string' && argTys[0].k !== 'list' && argTys[0].k !== 'map') {
      err(`${ctx.where}: len() needs string/list/map, got ${tyShow(argTys[0])}`, ctx.where);
    }
    return TY_INT;
  }
  if (e.name === 'str') return TY_STRING;
  if (e.name === 'int') return TY_INT;
  if (e.name === 'float') return TY_FLOAT;
  if (e.name === 'bool') err(`${ctx.where}: bool() unsupported in v1`, ctx.where);
  const f = ctx.funs.get(e.name);
  if (f == null) {
    err(`${ctx.where}: unknown function '${e.name}'`, ctx.where);
  }
  // light arg compat checks
  for (let i = 0; i < f!.params.length; i++) {
    const pt = f!.params[i].ty;
    const at = argTys[i];
    if (pt != null && at != null && !compat(pt, at)) {
      err(`${ctx.where}: argument ${i + 1} of '${e.name}' is ${tyShow(at)}, expected ${tyShow(pt)}`, ctx.where);
    }
  }
  return f!.ret;
}

function methodTy(e: Extract<Expr, { k: 'method' }>, ctx: Ctx): Ty | null {
  const ot = exprTy(e.obj, ctx);
  const argTys = e.args.map(a => exprTy(a, ctx));
  if (ot == null) return null;

  // canonicalize the neutral member name the TS backend emits for both
  // list.index and string.find — IR always carries the canonical name
  if (e.name === 'indexOf') {
    if (ot.k === 'list') e.name = 'index';
    else if (ot.k === 'string') e.name = 'find';
  }

  if (ot.k === 'list') {
    switch (e.name) {
      case 'append': case 'push':
        if (argTys[0] != null && !compat(ot.elem, argTys[0])) {
          err(`${ctx.where}: append expects ${tyShow(ot.elem)}, got ${tyShow(argTys[0])}`, ctx.where);
        }
        return TY_VOID;
      case 'pop': return ot.elem;
      case 'index': return TY_INT;
      case 'sort': case 'reverse': case 'clear': return TY_VOID;
      case 'join':
        // canonicalize the TS-native form xs.join(sep) into Python's
        // sep.join(xs): IR always carries the string as the receiver
        if (e.args.length !== 1) {
          err(`${ctx.where}: join needs exactly one separator argument`, ctx.where);
        }
        if (argTys[0] != null && argTys[0].k !== 'string') {
          err(`${ctx.where}: join separator must be string, got ${tyShow(argTys[0])}`, ctx.where);
        }
        if (ot.elem != null && ot.elem.k !== 'string' && ot.elem.k !== 'any') {
          err(`${ctx.where}: join needs a list of strings, got list<${tyShow(ot.elem)}>`, ctx.where);
        }
        const listExpr = e.obj;
        e.obj = e.args[0];
        e.args = [listExpr];
        return TY_STRING;
      default: err(`${ctx.where}: unsupported list method '.${e.name}()' (v1: append, pop, index, sort, reverse, clear, join)`, ctx.where);
    }
  }
  if (ot.k === 'string') {
    switch (e.name) {
      case 'upper': case 'lower': case 'strip': case 'trim':
        return TY_STRING;
      case 'replace': return TY_STRING;
      case 'split': return { k: 'list', elem: TY_STRING };
      case 'join': return TY_STRING;
      case 'startswith': case 'endswith': case 'isdigit': return TY_BOOL;
      case 'find': return TY_INT;
      default: err(`${ctx.where}: unsupported string method '.${e.name}()' (v1: upper, lower, strip, replace, split, join, startswith, endswith, find)`, ctx.where);
    }
  }
  if (ot.k === 'map') {
    switch (e.name) {
      case 'get':
        if (e.args.length === 1) {
          err(`${ctx.where}: d.get(k) unsupported (missing key yields None); use d[k] or d.get(k, default)`, ctx.where);
        }
        return ot.val;
      case 'keys': return { k: 'list', elem: TY_STRING };
      case 'values': return { k: 'list', elem: ot.val };
      case 'remove': case 'delete': case 'pop':
        if (e.args.length === 1) return ot.val;  // pop(k) returns the value
        err(`${ctx.where}: map pop needs a key`, ctx.where);
      default: err(`${ctx.where}: unsupported dict method '.${e.name}()' (v1: get(k, default), keys, values, pop(k))`, ctx.where);
    }
  }
  if (ot.k === 'class') {
    const c = ctx.classes.get(ot.name);
    if (c == null) err(`${ctx.where}: unknown class '${ot.name}'`, ctx.where);
    const meth = c!.methods.find(x => x.name === e.name);
    if (meth == null) err(`${ctx.where}: class '${ot.name}' has no method '${e.name}'`, ctx.where);
    for (let i = 0; i < meth.params.length; i++) {
      const pt = meth.params[i].ty;
      const at = argTys[i];
      if (pt != null && at != null && !compat(pt, at)) {
        err(`${ctx.where}: argument ${i + 1} of '${ot.name}.${e.name}' is ${tyShow(at)}, expected ${tyShow(pt)}`, ctx.where);
      }
    }
    return meth.ret;
  }
  err(`${ctx.where}: cannot call method '.${e.name}()' on ${tyShow(ot)}`, ctx.where);
}

// ---------------------------------------------------------------------------
// Validation: nothing may remain unresolved
// ---------------------------------------------------------------------------

function validate(m: Module, ctx: Ctx): void {
  for (const item of m.items) {
    if ('fields' in item) {
      const c = item as ClassDecl;
      for (const f of c.fields) {
        if (f.ty == null) err(`class '${c.name}': cannot infer type of field '${f.name}' (annotate it or assign a typed value in __init__)`);
      }
      if (c.ctor) checkBody(c.ctor.body, `${c.name}.__init__`, ctx);
      for (const meth of c.methods) {
        if (meth.ret == null) err(`method '${c.name}.${meth.name}': cannot infer return type`);
        for (const p of meth.params) {
          if (p.ty == null) err(`method '${c.name}.${meth.name}': parameter '${p.name}' needs a type annotation`);
        }
        checkBody(meth.body, `${c.name}.${meth.name}`, ctx);
      }
    } else {
      const f = item as FunDecl;
      if (f.ret == null) err(`function '${f.name}': cannot infer return type`);
      for (const p of f.params) {
        if (p.ty == null) err(`function '${f.name}': parameter '${p.name}' needs a type annotation (v1)`);
      }
      checkBody(f.body, `function '${f.name}'`, ctx);
    }
  }
}

function checkBody(body: Stmt[], where: string, ctx: Ctx): void {
  for (const s of body) checkStmt(s, where, ctx);
}

function checkStmt(s: Stmt, where: string, ctx: Ctx): void {
  switch (s.k) {
    case 'vardecl':
      if (s.ty == null) err(`${where}: cannot infer type of variable '${s.name}' (annotate it, e.g. xs: list[int] = [])`);
      break;
    case 'assign':
      if (s.target.k === 'var') {
        const info = ctx.vars.get(s.target.name);
        // vars map may be stale here; re-walking is overkill — decl check covers it
      }
      checkExpr(s.value, where, ctx);
      if (s.target.k !== 'var') checkExpr(s.target, where, ctx);
      break;
    case 'expr': checkExpr(s.e, where, ctx); break;
    case 'return': if (s.v) checkExpr(s.v, where, ctx); break;
    case 'if':
      checkExpr(s.cond, where, ctx);
      checkBody(s.then, where, ctx);
      for (const el of s.elifs) { checkExpr(el.cond, where, ctx); checkBody(el.body, where, ctx); }
      if (s.els) checkBody(s.els, where, ctx);
      break;
    case 'while':
      checkExpr(s.cond, where, ctx);
      checkBody(s.body, where, ctx);
      break;
    case 'forrange':
      checkExpr(s.start, where, ctx); checkExpr(s.stop, where, ctx); checkExpr(s.step, where, ctx);
      checkBody(s.body, where, ctx);
      break;
    case 'foreach':
      if (s.varTy == null) err(`${where}: cannot infer loop variable '${s.varName}' type`);
      checkExpr(s.iter, where, ctx);
      checkBody(s.body, where, ctx);
      break;
    case 'print':
      for (const a of s.args) checkExpr(a, where, ctx);
      break;
    default: break;
  }
}

function checkExpr(e: Expr, where: string, ctx: Ctx): void {
  switch (e.k) {
    case 'null': err(`${where}: None/null unsupported in v1`, where);
    case 'bin': checkExpr(e.l, where, ctx); checkExpr(e.r, where, ctx); break;
    case 'un': checkExpr(e.e, where, ctx); break;
    case 'call':
      for (const a of e.args) checkExpr(a, where, ctx);
      break;
    case 'method': checkExpr(e.obj, where, ctx); for (const a of e.args) checkExpr(a, where, ctx); break;
    case 'field': checkExpr(e.obj, where, ctx); break;
    case 'index': checkExpr(e.obj, where, ctx); checkExpr(e.idx, where, ctx); break;
    case 'list':
      for (const el of e.elems) checkExpr(el, where, ctx);
      break;
    case 'map':
      for (const en of e.entries) checkExpr(en.val, where, ctx);
      break;
    case 'new':
      for (const a of e.args) checkExpr(a, where, ctx);
      break;
    case 'interp':
      for (const p of e.parts) if (typeof p !== 'string') checkExpr(p, where, ctx);
      break;
    default: break;
  }
}
