/**
 * IR pretty-printer (Layer 2).
 * Used for: debugging, `ouro --verbose`, and structural round-trip checks
 * (parse → IR → dump, compare dumps after a hop round-trip).
 */

import type { Module, Item, FunDecl, ClassDecl, Stmt, Expr, Ty } from './types.ts';
import { tyShow } from './types.ts';

function optTy(t: Ty | null | undefined): string {
  return t ? `: ${tyShow(t)}` : '';
}

function dumpExpr(e: Expr, out: string[]): void {
  switch (e.k) {
    case 'int': out.push(`int(${e.v})`); break;
    case 'float': out.push(`float(${e.v})`); break;
    case 'bool': out.push(`bool(${e.v})`); break;
    case 'str': out.push(`str(${JSON.stringify(e.v)})`); break;
    case 'null': out.push('null'); break;
    case 'var': out.push(`var(${e.name})`); break;
    case 'this': out.push('this'); break;
    case 'bin': {
      out.push(`bin(${e.op}, `);
      dumpExpr(e.l, out);
      out.push(', ');
      dumpExpr(e.r, out);
      out.push(')');
      break;
    }
    case 'un': {
      out.push(`un(${e.op}, `);
      dumpExpr(e.e, out);
      out.push(')');
      break;
    }
    case 'call': {
      out.push(`call(${e.name}(`);
      e.args.forEach((a, i) => { if (i > 0) out.push(', '); dumpExpr(a, out); });
      out.push('))');
      break;
    }
    case 'method': {
      out.push('method(');
      dumpExpr(e.obj, out);
      out.push(`, .${e.name}(`);
      e.args.forEach((a, i) => { if (i > 0) out.push(', '); dumpExpr(a, out); });
      out.push('))');
      break;
    }
    case 'field': {
      out.push('field(');
      dumpExpr(e.obj, out);
      out.push(`, .${e.name})`);
      break;
    }
    case 'index': {
      out.push('index(');
      dumpExpr(e.obj, out);
      out.push(', [');
      dumpExpr(e.idx, out);
      out.push('])');
      break;
    }
    case 'list': {
      out.push(`list${optTy(e.elemTy)}([`);
      e.elems.forEach((x, i) => { if (i > 0) out.push(', '); dumpExpr(x, out); });
      out.push('])');
      break;
    }
    case 'map': {
      out.push(`map${optTy(e.valTy)}({`);
      e.entries.forEach((en, i) => {
        if (i > 0) out.push(', ');
        out.push(`${JSON.stringify(en.key)}: `);
        dumpExpr(en.val, out);
      });
      out.push('})');
      break;
    }
    case 'new': {
      out.push(`new(${e.cls}(`);
      e.args.forEach((a, i) => { if (i > 0) out.push(', '); dumpExpr(a, out); });
      out.push('))');
      break;
    }
    case 'interp': {
      out.push('interp(');
      e.parts.forEach((p, i) => {
        if (i > 0) out.push(', ');
        if (typeof p === 'string') out.push(JSON.stringify(p));
        else dumpExpr(p, out);
      });
      out.push(')');
      break;
    }
  }
}

function dumpStmts(body: Stmt[], depth: number, out: string[]): void {
  if (body.length === 0) { out.push('  '.repeat(depth) + '<empty>\n'); return; }
  for (const s of body) dumpStmt(s, depth, out);
}

function dumpStmt(s: Stmt, depth: number, out: string[]): void {
  const ind = '  '.repeat(depth);
  switch (s.k) {
    case 'vardecl': {
      out.push(`${ind}vardecl ${s.name}${optTy(s.ty)} = `);
      dumpExpr(s.init, out); out.push('\n');
      break;
    }
    case 'assign': {
      out.push(`${ind}assign `);
      dumpExpr(s.target, out); out.push(' = ');
      dumpExpr(s.value, out); out.push('\n');
      break;
    }
    case 'expr': {
      out.push(`${ind}expr `);
      dumpExpr(s.e, out); out.push('\n');
      break;
    }
    case 'return': {
      out.push(`${ind}return`);
      if (s.v) { out.push(' '); dumpExpr(s.v, out); }
      out.push('\n');
      break;
    }
    case 'if': {
      out.push(`${ind}if `);
      dumpExpr(s.cond, out); out.push(':\n');
      dumpStmts(s.then, depth + 1, out);
      for (const el of s.elifs) {
        out.push(`${ind}elif `);
        dumpExpr(el.cond, out); out.push(':\n');
        dumpStmts(el.body, depth + 1, out);
      }
      if (s.els) {
        out.push(`${ind}else:\n`);
        dumpStmts(s.els, depth + 1, out);
      }
      break;
    }
    case 'while': {
      out.push(`${ind}while `);
      dumpExpr(s.cond, out); out.push(':\n');
      dumpStmts(s.body, depth + 1, out);
      break;
    }
    case 'forrange': {
      out.push(`${ind}forrange ${s.varName} `);
      dumpExpr(s.start, out); out.push('..');
      dumpExpr(s.stop, out); out.push(' step ');
      dumpExpr(s.step, out); out.push(':\n');
      dumpStmts(s.body, depth + 1, out);
      break;
    }
    case 'foreach': {
      out.push(`${ind}foreach ${s.varName}${optTy(s.varTy)} in `);
      dumpExpr(s.iter, out); out.push(':\n');
      dumpStmts(s.body, depth + 1, out);
      break;
    }
    case 'break': out.push(`${ind}break\n`); break;
    case 'continue': out.push(`${ind}continue\n`); break;
    case 'print': {
      out.push(`${ind}print(`);
      s.args.forEach((a, i) => { if (i > 0) out.push(', '); dumpExpr(a, out); });
      out.push(')\n');
      break;
    }
  }
}

function dumpItem(item: Item, out: string[]): void {
  if (item.name === undefined) return; // never
  if ('fields' in item) {
    const c = item as ClassDecl;
    out.push(`class ${c.name}:\n`);
    for (const f of c.fields) out.push(`  field ${f.name}${optTy(f.ty)}\n`);
    if (c.ctor) {
      out.push(`  ctor(` +
        c.ctor.params.map(p => `${p.name}${optTy(p.ty)}`).join(', ') + `):\n`);
      dumpStmts(c.ctor.body, 2, out);
    }
    for (const m of c.methods) {
      out.push(`  method ${m.name}(` +
        m.params.map(p => `${p.name}${optTy(p.ty)}`).join(', ') +
        `)${optTy(m.ret)}:\n`);
      dumpStmts(m.body, 2, out);
    }
  } else {
    const f = item as FunDecl;
    out.push(`fun ${f.name}(` +
      f.params.map(p => `${p.name}${optTy(p.ty)}`).join(', ') +
      `)${optTy(f.ret)}:\n`);
    dumpStmts(f.body, 1, out);
  }
}

export function dumpModule(m: Module): string {
  const out: string[] = [`module ${m.name} (from ${m.sourceLang}):\n`];
  for (const item of m.items) dumpItem(item, out);
  return out.join('');
}

/**
 * Language-independent normalization for cross-hop comparison: the item order
 * is a source-order artifact (C#/Java force classes and functions into
 * different syntactic zones), so item order is sorted before dumping.
 */
export function dumpNormalized(m: Module): string {
  const sorted: Module = {
    ...m,
    items: [...m.items].sort((a, b) => {
      const ka = 'fields' in a ? 0 : 1;
      const kb = 'fields' in b ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }),
  };
  const out: string[] = ['module X (from X):\n'];
  for (const item of sorted.items) dumpItem(item, out);
  return out.join('');
}
