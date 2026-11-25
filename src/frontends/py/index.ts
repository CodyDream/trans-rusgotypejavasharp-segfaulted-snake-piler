/**
 * Python frontend (Layer 1) — TS side.
 *
 * Spawns dumper.py (real Python `ast` parsing, zero hand-rolled indentation
 * handling) and validates its JSON into an IR Module. The dumper returns
 * module-level statements as `mainBody`; we wrap them into an implicit
 * `main()` FunDecl so every language sees the same module shape.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { basename } from 'node:path';
import type { Module, Item, Stmt, Expr, Ty, Param, Field, Method, CtorDecl } from '../../ir/types.ts';
import { TY_INT, TY_FLOAT, TY_BOOL, TY_STRING, TY_VOID, TranspileError } from '../../ir/types.ts';

const DUMPER = join(import.meta.dirname!, 'dumper.py');

/** Parse a type string from the dumper into a Ty. Returns null for absent/any. */
export function parseTy(s: string | null | undefined): Ty | null {
  if (s == null || s === 'any') return null;
  if (s === 'int') return TY_INT;
  if (s === 'float') return TY_FLOAT;
  if (s === 'bool') return TY_BOOL;
  if (s === 'string') return TY_STRING;
  if (s === 'void') return TY_VOID;
  if (s.startsWith('list[')) {
    if (!s.endsWith(']')) throw new TranspileError(`bad type string '${s}'`, 'py');
    const elem = parseTy(s.slice(5, -1));
    return { k: 'list', elem: elem ?? { k: 'any' } };
  }
  if (s.startsWith('map[string,')) {
    if (!s.endsWith(']')) throw new TranspileError(`bad type string '${s}'`, 'py');
    const val = parseTy(s.slice(11, -1));
    return { k: 'map', val: val ?? { k: 'any' } };
  }
  if (s.startsWith('class:')) return { k: 'class', name: s.slice(6) };
  throw new TranspileError(`unknown type string '${s}'`, 'py');
}

// ---------------------------------------------------------------------------
// JSON -> IR converters (light validation; dumper is trusted to emit shapes)
// ---------------------------------------------------------------------------

function fail(msg: string, lang = 'py'): never {
  throw new TranspileError(`dumper emitted invalid IR: ${msg}`, lang);
}

function convParams(j: any[]): Param[] {
  return j.map((p, i) => {
    if (typeof p.name !== 'string') fail(`param ${i} missing name`);
    return { name: p.name, ty: parseTy(p.ty) };
  });
}

function convExpr(j: any): Expr {
  if (!j || typeof j.k !== 'string') fail('expression missing kind tag');
  switch (j.k) {
    case 'int': return { k: 'int', v: j.v };
    case 'float': return { k: 'float', v: j.v };
    case 'bool': return { k: 'bool', v: j.v };
    case 'str': return { k: 'str', v: j.v };
    case 'null': return { k: 'null' };
    case 'var': return { k: 'var', name: j.name };
    case 'this': return { k: 'this' };
    case 'bin': return { k: 'bin', op: j.op, l: convExpr(j.l), r: convExpr(j.r) };
    case 'un': return { k: 'un', op: j.op, e: convExpr(j.e) };
    case 'call': return { k: 'call', name: j.name, args: j.args.map(convExpr) };
    case 'method': return { k: 'method', obj: convExpr(j.obj), name: j.name, args: j.args.map(convExpr) };
    case 'field': return { k: 'field', obj: convExpr(j.obj), name: j.name };
    case 'index': return { k: 'index', obj: convExpr(j.obj), idx: convExpr(j.idx) };
    case 'list': {
      const e: Expr = { k: 'list', elems: j.elems.map(convExpr) };
      if (j.elemTy != null) e.elemTy = parseTy(j.elemTy) ?? undefined;
      return e;
    }
    case 'map': {
      const e: Expr = { k: 'map', entries: j.entries.map((en: any) => ({ key: en.key, val: convExpr(en.val) })) };
      if (j.valTy != null) e.valTy = parseTy(j.valTy) ?? undefined;
      return e;
    }
    case 'new': return { k: 'new', cls: j.cls, args: j.args.map(convExpr) };
    case 'interp': return { k: 'interp', parts: j.parts.map((p: any) => (typeof p === 'string' ? p : convExpr(p))) };
    default: fail(`unknown expr kind '${j.k}'`);
  }
}

function convStmt(j: any): Stmt {
  if (!j || typeof j.k !== 'string') fail('statement missing kind tag');
  switch (j.k) {
    case 'vardecl': return { k: 'vardecl', name: j.name, ty: parseTy(j.ty), init: convExpr(j.init) };
    case 'assign': return { k: 'assign', target: convExpr(j.target), value: convExpr(j.value) };
    case 'expr': return { k: 'expr', e: convExpr(j.e) };
    case 'return': return { k: 'return', v: j.v == null ? null : convExpr(j.v) };
    case 'if': return {
      k: 'if', cond: convExpr(j.cond), then: j.then.map(convStmt),
      elifs: (j.elifs ?? []).map((el: any) => ({ cond: convExpr(el.cond), body: el.body.map(convStmt) })),
      els: j.els == null ? null : j.els.map(convStmt),
    };
    case 'while': return { k: 'while', cond: convExpr(j.cond), body: j.body.map(convStmt) };
    case 'forrange': return {
      k: 'forrange', varName: j.varName, start: convExpr(j.start), stop: convExpr(j.stop),
      step: convExpr(j.step), body: j.body.map(convStmt),
    };
    case 'foreach': return {
      k: 'foreach', varName: j.varName, varTy: parseTy(j.varTy), iter: convExpr(j.iter), body: j.body.map(convStmt),
    };
    case 'break': return { k: 'break' };
    case 'continue': return { k: 'continue' };
    case 'print': return { k: 'print', args: j.args.map(convExpr) };
    default: fail(`unknown stmt kind '${j.k}'`);
  }
}

function convBody(j: any[]): Stmt[] {
  return (j ?? []).map(convStmt);
}

function convItem(j: any): Item {
  if (j.k === 'fun') {
    return { name: j.name, params: convParams(j.params), ret: parseTy(j.ret), body: convBody(j.body) };
  }
  if (j.k === 'class') {
    const fields: Field[] = (j.fields ?? []).map((f: any) => ({ name: f.name, ty: parseTy(f.ty) }));
    let ctor: CtorDecl | null = null;
    if (j.ctor != null) ctor = { params: convParams(j.ctor.params), body: convBody(j.ctor.body) };
    const methods: Method[] = (j.methods ?? []).map((m: any) => ({
      name: m.name, params: convParams(m.params), ret: parseTy(m.ret), body: convBody(m.body),
    }));
    return { name: j.name, fields, ctor, methods };
  }
  fail(`unknown item kind '${j.k}'`);
}

/** Load a Python file into an IR Module. */
export function parsePyFile(filePath: string): Module {
  const r = spawnSync('python3', [DUMPER, filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new TranspileError(`failed to spawn python3: ${r.error.message}`, 'py');
  if (!r.stdout || !r.stdout.trim()) {
    throw new TranspileError(`dumper produced no output (stderr: ${(r.stderr || '').slice(0, 300)})`, 'py');
  }
  let j: any;
  try { j = JSON.parse(r.stdout); } catch {
    throw new TranspileError(`dumper output was not JSON: ${r.stdout.slice(0, 200)}`, 'py');
  }
  if (!j.ok) throw new TranspileError(`${j.error}`, 'py', j.line ?? null);
  const ir = j.ir;
  if (!ir || !Array.isArray(ir.items)) fail('missing ir.items');
  const items: Item[] = ir.items.map(convItem);
  const hasMainBody = Array.isArray(ir.mainBody) && ir.mainBody.length > 0;
  if (hasMainBody && items.some(i => !('fields' in i) && i.name === 'main')) {
    throw new TranspileError("module defines its own 'main' and has top-level statements — conflict", 'py');
  }
  if (hasMainBody) {
    items.push({ name: 'main', params: [], ret: TY_VOID, body: convBody(ir.mainBody) });
  }
  const name = basename(filePath).replace(/\.[^.]+$/, '');
  return { name, sourceLang: 'py', items };
}
