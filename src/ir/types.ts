/**
 * Ouroboros IR — the shared typed AST spine (Layer 2).
 *
 * Every frontend lowers its language to these nodes; every backend lifts
 * these nodes into its language. The ring topology lives in the ring driver;
 * inside, all edges funnel through this spine.
 *
 * Design rules:
 *  - All node types are plain interfaces + literal-union tags (erasable TS).
 *  - `Ty` with k:'any' means "not yet inferred" — only legal between the
 *    Python frontend and the inferencer. Backends must never see it.
 *  - Map keys are strings only in v1. No generics beyond list/map.
 */

// ---------------------------------------------------------------------------
// Type model
// ---------------------------------------------------------------------------

export type Ty =
  | { k: 'int' }
  | { k: 'float' }
  | { k: 'bool' }
  | { k: 'string' }
  | { k: 'void' }
  | { k: 'list'; elem: Ty }
  | { k: 'map'; val: Ty }            // keys always string
  | { k: 'class'; name: string }
  | { k: 'any' };                    // unresolved — inferencer input only

export const TY_INT: Ty = { k: 'int' };
export const TY_FLOAT: Ty = { k: 'float' };
export const TY_BOOL: Ty = { k: 'bool' };
export const TY_STRING: Ty = { k: 'string' };
export const TY_VOID: Ty = { k: 'void' };

export function tyEq(a: Ty, b: Ty): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'list' && b.k === 'list') return tyEq(a.elem, b.elem);
  if (a.k === 'map' && b.k === 'map') return tyEq(a.val, b.val);
  if (a.k === 'class' && b.k === 'class') return a.name === b.name;
  return true;
}

export function tyShow(t: Ty): string {
  switch (t.k) {
    case 'int': return 'int';
    case 'float': return 'float';
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'void': return 'void';
    case 'list': return `list<${tyShow(t.elem)}>`;
    case 'map': return `map<string,${tyShow(t.val)}>`;
    case 'class': return `class<${t.name}>`;
    case 'any': return 'any';
  }
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type BinOp =
  | '+' | '-' | '*' | '/' | '//' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||'
  | 'in' | 'notin';

export type UnOp = '-' | '!';

// '/'  = float division (Python semantics: always produces float)
// '//' = integer division (truncating; negative-operand caveat documented)

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string }
  | { k: 'null' }
  | { k: 'var'; name: string }
  | { k: 'this' }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { k: 'un'; op: UnOp; e: Expr }
  | { k: 'call'; name: string; args: Expr[] }               // free fn / conversion / len()
  | { k: 'method'; obj: Expr; name: string; args: Expr[] }
  | { k: 'field'; obj: Expr; name: string }
  | { k: 'index'; obj: Expr; idx: Expr }
  | { k: 'list'; elems: Expr[]; elemTy?: Ty }
  | { k: 'map'; entries: { key: string; val: Expr }[]; valTy?: Ty }
  | { k: 'new'; cls: string; args: Expr[] }                 // constructor call
  | { k: 'interp'; parts: (string | Expr)[] };              // f-string / interpolation

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Stmt =
  | { k: 'vardecl'; name: string; ty: Ty | null; init: Expr }
  | { k: 'assign'; target: Expr; value: Expr }              // target: var | field | index
  | { k: 'expr'; e: Expr }
  | { k: 'return'; v: Expr | null }
  | { k: 'if'; cond: Expr; then: Stmt[]; elifs: { cond: Expr; body: Stmt[] }[]; els: Stmt[] | null }
  | { k: 'while'; cond: Expr; body: Stmt[] }
  | { k: 'forrange'; varName: string; start: Expr; stop: Expr; step: Expr; body: Stmt[] }
  | { k: 'foreach'; varName: string; varTy: Ty | null; iter: Expr; body: Stmt[] }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'print'; args: Expr[] };                            // space-joined args + newline

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface Param { name: string; ty: Ty | null }
export interface Field { name: string; ty: Ty | null }

export interface Method {
  name: string;
  params: Param[];      // receiver/self is implicit; use {k:'this'}
  ret: Ty | null;
  body: Stmt[];
}

export interface CtorDecl {
  params: Param[];
  body: Stmt[];
}

export interface ClassDecl {
  name: string;
  fields: Field[];
  methods: Method[];
  ctor: CtorDecl | null;
}

export interface FunDecl {
  name: string;
  params: Param[];
  ret: Ty | null;
  body: Stmt[];
}

export type Item = FunDecl | ClassDecl;

export interface Module {
  name: string;          // module/file name (no extension)
  sourceLang: string;    // 'py' | 'cs' | 'java' | 'go' | 'rust' | 'cpp'
  items: Item[];
}

// ---------------------------------------------------------------------------
// Builder helpers (keep frontends terse)
// ---------------------------------------------------------------------------

export const eInt = (v: number): Expr => ({ k: 'int', v });
export const eFloat = (v: number): Expr => ({ k: 'float', v });
export const eBool = (v: boolean): Expr => ({ k: 'bool', v });
export const eStr = (v: string): Expr => ({ k: 'str', v });
export const eNull = (): Expr => ({ k: 'null' });
export const eVar = (name: string): Expr => ({ k: 'var', name });
export const eThis = (): Expr => ({ k: 'this' });
export const eBin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
export const eUn = (op: UnOp, e: Expr): Expr => ({ k: 'un', op, e });
export const eCall = (name: string, args: Expr[]): Expr => ({ k: 'call', name, args });
export const eMethod = (obj: Expr, name: string, args: Expr[]): Expr => ({ k: 'method', obj, name, args });
export const eField = (obj: Expr, name: string): Expr => ({ k: 'field', obj, name });
export const eIndex = (obj: Expr, idx: Expr): Expr => ({ k: 'index', obj, idx });
export const eNew = (cls: string, args: Expr[]): Expr => ({ k: 'new', cls, args });
export const eInterp = (parts: (string | Expr)[]): Expr => ({ k: 'interp', parts });

export const sVardecl = (name: string, ty: Ty | null, init: Expr): Stmt => ({ k: 'vardecl', name, ty, init });
export const sAssign = (target: Expr, value: Expr): Stmt => ({ k: 'assign', target, value });
export const sExpr = (e: Expr): Stmt => ({ k: 'expr', e });
export const sReturn = (v: Expr | null): Stmt => ({ k: 'return', v });
export const sIf = (cond: Expr, then: Stmt[], elifs: { cond: Expr; body: Stmt[] }[], els: Stmt[] | null): Stmt =>
  ({ k: 'if', cond, then, elifs, els });
export const sWhile = (cond: Expr, body: Stmt[]): Stmt => ({ k: 'while', cond, body });
export const sForrange = (varName: string, start: Expr, stop: Expr, step: Expr, body: Stmt[]): Stmt =>
  ({ k: 'forrange', varName, start, stop, step, body });
export const sForeach = (varName: string, varTy: Ty | null, iter: Expr, body: Stmt[]): Stmt =>
  ({ k: 'foreach', varName, varTy, iter, body });
export const sBreak = (): Stmt => ({ k: 'break' });
export const sContinue = (): Stmt => ({ k: 'continue' });
export const sPrint = (args: Expr[]): Stmt => ({ k: 'print', args });

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TranspileError extends Error {
  lang: string;      // language stage where it happened
  line: number | null;

  constructor(msg: string, lang: string, line: number | null = null) {
    super(line != null ? `[${lang}] line ${line}: ${msg}` : `[${lang}] ${msg}`);
    this.name = 'TranspileError';
    this.lang = lang;
    this.line = line;
  }
}
