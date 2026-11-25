#!/usr/bin/env node
/**
 * Gold test suite — the checks runnable in v0.1.
 *
 * As backends land, the execution/round-trip checks described in the README
 * slot in next to these; the harness (check/expectLoudFailure) stays.
 *
 *   - both frontends agree byte-for-byte on normalized IR for the smoke program
 *   - unsupported constructs fail LOUDLY (TranspileError, line number, never silent)
 *   - dialect canonicalizations (indexOf -> index/find, xs.join(sep) -> sep.join(xs),
 *     trim -> strip, ...) produce the documented IR shapes
 *   - forrange step forms, including downward loops
 *   - the non-destructive guarantee: parsing never modifies an input file
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePyFile } from '../src/frontends/py/index.ts';
import { parseTsFile } from '../src/frontends/ts/index.ts';
import { emitTs } from '../src/backends/ts/index.ts';
import { emitJava } from '../src/backends/java/index.ts';
import { emitCs } from '../src/backends/cs/index.ts';
import { emitRs } from '../src/backends/rs/index.ts';
import { linkModules } from '../src/link.ts';
import type { Module } from '../src/ir/types.ts';
import { inferModule } from '../src/infer/infer.ts';
import { dumpNormalized } from '../src/ir/show.ts';
import { TranspileError } from '../src/ir/types.ts';

const SMOKE_PY = join(import.meta.dirname!, '..', 'test', 'smoke.py');
const SMOKE_TS = join(import.meta.dirname!, '..', 'test', 'smoke.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`FAIL  ${name}: ${msg}`);
  }
}

// -- helpers ----------------------------------------------------------------

function parseTyped(lang: 'py' | 'ts', path: string): string {
  const m = inferModule(lang === 'py' ? parsePyFile(path) : parseTsFile(path));
  return dumpNormalized(m);
}

function parseSrc(lang: 'py' | 'ts', src: string): { norm: string } | { error: TranspileError } {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-gold-'));
  const file = join(dir, `case.${lang}`);
  writeFileSync(file, src);
  try {
    return { norm: parseTyped(lang, file) };
  } catch (e) {
    if (e instanceof TranspileError) return { error: e };
    throw e;
  }
}

function expectLoudFailure(name: string, lang: 'py' | 'ts', src: string, mustInclude: string): void {
  const r = parseSrc(lang, src);
  if (!('error' in r)) {
    throw new Error(`expected a loud failure containing "${mustInclude}", but it parsed cleanly`);
  }
  const msg = r.error.message;
  if (!msg.includes(mustInclude)) {
    throw new Error(`error message is missing "${mustInclude}": ${msg}`);
  }
  // parse-layer errors must carry a line number; infer-stage errors are
  // line-free until IR nodes track positions
  if (r.error.lang === lang && r.error.line == null) {
    throw new Error(`frontend error carries no line number: ${msg}`);
  }
}

function expectShape(lang: 'py' | 'ts', src: string, ...substrings: string[]): void {
  const r = parseSrc(lang, src);
  if ('error' in r) throw new Error(`unexpected failure: ${r.error.message}`);
  for (const s of substrings) {
    if (!r.norm.includes(s)) throw new Error(`normalized IR is missing "${s}"\n${r.norm}`);
  }
}

function firstDiff(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}: py=${JSON.stringify(la[i])} ts=${JSON.stringify(lb[i])}`;
  }
  return 'no diff';
}

// -- the suite ---------------------------------------------------------------

console.log('ouro gold suite (v0.1 runnable checks)\n');

check('py frontend parses + infers the smoke program', () => {
  const norm = parseTyped('py', SMOKE_PY);
  if (!norm.includes('fun main()') || !norm.includes('class Counter:')) {
    throw new Error('smoke IR is missing expected items');
  }
});

check('ts frontend parses + infers the smoke program', () => {
  const norm = parseTyped('ts', SMOKE_TS);
  if (!norm.includes('fun main()') || !norm.includes('class Counter:')) {
    throw new Error('smoke IR is missing expected items');
  }
});

check('py and ts frontends agree byte-for-byte on the smoke program', () => {
  const py = parseTyped('py', SMOKE_PY);
  const ts = parseTyped('ts', SMOKE_TS);
  if (py !== ts) throw new Error(firstDiff(py, ts));
});

check('forrange step forms: i++ / i += 2 / downward i -= 3 / i = i + 1', () => {
  expectShape('ts', [
    'function f(): void {',
    '  for (let i = 0; i < 9; i++) { print(i); }',
    '  for (let i = 0; i < 9; i += 2) { print(i); }',
    '  for (let i = 9; i > 0; i -= 3) { print(i); }',
    '  for (let i = 0; i < 9; i = i + 1) { print(i); }',
    '}',
    '',
  ].join('\n'), 'step int(1)', 'step int(2)', 'step un(-, int(3))');
});

check('indexOf canonicalizes: .index on lists, .find on strings', () => {
  expectShape('ts', [
    'function f(xs: int[], s: string): int {',
    '  return xs.indexOf(1) + s.indexOf("b");',
    '}',
    '',
  ].join('\n'), '.index(int(1))', '.find(str("b"))');
});

check('join canonicalizes: xs.join(sep) -> sep.join(xs)', () => {
  expectShape('ts', [
    'function f(xs: string[]): string {',
    '  return xs.join("-");',
    '}',
    '',
  ].join('\n'), 'method(str("-"), .join(var(xs)))');
});

check('method names canonicalize: trim->strip, toUpperCase->upper, push->append', () => {
  expectShape('ts', [
    'function f(s: string, xs: int[]): string {',
    '  xs.push(1);',
    '  return s.trim().toUpperCase();',
    '}',
    '',
  ].join('\n'), '.append(int(1))', 'method(method(var(s), .strip()), .upper())');
});

check('dialect helpers map to IR ops: isin/isnotin/idiv/imod, templates -> interp', () => {
  expectShape('ts', [
    'function f(s: string, xs: int[]): string {',
    '  let a = isin(1, xs);',
    '  let b = isnotin(1, xs);',
    '  let c = idiv(10, 3);',
    '  let d = imod(10, 3);',
    '  return `v=${s}`;',
    '}',
    '',
  ].join('\n'), 'bin(in, int(1), var(xs))', 'bin(notin, int(1), var(xs))',
  'bin(//, int(10), int(3))', 'bin(%, int(10), int(3))', 'interp("v=", var(s))');
});

check('non-destructive guarantee: parsing never modifies an input file', () => {
  for (const [lang, path] of [['py', SMOKE_PY], ['ts', SMOKE_TS]] as const) {
    const before = readFileSync(path);
    parseTyped(lang, path);
    const after = readFileSync(path);
    if (!before.equals(after)) throw new Error(`${path} changed on disk`);
  }
});

// -- transpile edges (Layer 3) -------------------------------------------------

const DEMO_CHAIN = join(import.meta.dirname!, '..', 'demo', 'hello_chain.py');
const HAS_JAVA = spawnSync('java', ['--version'], { encoding: 'utf8' }).status === 0;

// dotnet may be on PATH or installed rootlessly at the workspace path
function findDotnet(): string | null {
  for (const cmd of ['dotnet', '/home/z/my-project/.dotnet/dotnet']) {
    if (spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0) return cmd;
  }
  return null;
}
const DOTNET = findDotnet();

function run(cmd: string, args: string[], env?: Record<string, string>): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return r.stdout;
}

check('edge py->ts: emitted TS re-parses to identical normalized IR', () => {
  const m = inferModule(parsePyFile(DEMO_CHAIN));
  const dir = mkdtempSync(join(tmpdir(), 'ouro-edge-'));
  const tsPath = join(dir, 'hello_chain.ts');
  writeFileSync(tsPath, emitTs(m));
  const pyNorm = dumpNormalized(m);
  const tsNorm = parseTyped('ts', tsPath);
  if (pyNorm !== tsNorm) throw new Error(firstDiff(pyNorm, tsNorm));
});

check('edge ts->ts: self-edge re-parse identity', () => {
  const m = inferModule(parseTsFile(SMOKE_TS));   // parse no longer infers (linker requirement)
  const dir = mkdtempSync(join(tmpdir(), 'ouro-edge-'));
  const tsPath = join(dir, 'smoke_self.ts');
  writeFileSync(tsPath, emitTs(m));
  if (parseTyped('ts', tsPath) !== dumpNormalized(m)) throw new Error('self-edge IR diverged');
});

check('edge py->ts executes: node output equals python3 output (chain demo)', () => {
  const expected = run('python3', [DEMO_CHAIN]);
  const dir = mkdtempSync(join(tmpdir(), 'ouro-exec-'));
  const tsPath = join(dir, 'hello_chain.ts');
  writeFileSync(tsPath, emitTs(inferModule(parsePyFile(DEMO_CHAIN))));
  const actual = run(process.execPath, [tsPath]);
  if (actual !== expected) throw new Error(`node:\n${actual}\npython:\n${expected}`);
});

if (HAS_JAVA) {
  check('edge py->java executes: java output equals python3 output (chain demo)', () => {
    const expected = run('python3', [DEMO_CHAIN]);
    const dir = mkdtempSync(join(tmpdir(), 'ouro-exec-'));
    const javaPath = join(dir, 'HelloChain.java');
    writeFileSync(javaPath, emitJava(inferModule(parsePyFile(DEMO_CHAIN))));
    const actual = run('java', [javaPath]);
    if (actual !== expected) throw new Error(`java:\n${actual}\npython:\n${expected}`);
  });
} else {
  console.log('skip  py->java executes (no JDK on PATH)');
}

if (DOTNET) {
  check('edge py->cs executes: dotnet output equals python3 output (chain demo)', () => {
    const expected = run('python3', [DEMO_CHAIN]);
    const dir = mkdtempSync(join(tmpdir(), 'ouro-exec-'));
    const csPath = join(dir, 'HelloChain.cs');
    writeFileSync(csPath, emitCs(inferModule(parsePyFile(DEMO_CHAIN))));
    const actual = run(DOTNET, ['run', csPath], DOTNET.startsWith('/') ? { DOTNET_ROOT: '/home/z/my-project/.dotnet' } : undefined);
    if (actual !== expected) throw new Error(`dotnet:\n${actual}\npython:\n${expected}`);
  });
} else {
  console.log('skip  py->cs executes (no .NET SDK available)');
}

// rustc may be on PATH or installed rootlessly at the workspace path (the
// .cargo/bin binary is a rustup proxy and needs RUSTUP_HOME)
function findRustc(): string | null {
  for (const cmd of ['rustc', '/home/z/my-project/.cargo/bin/rustc']) {
    if (spawnSync(cmd, ['--version'], { encoding: 'utf8', env: { ...process.env, RUSTUP_HOME: '/home/z/my-project/.rustup' } }).status === 0) return cmd;
  }
  return null;
}
const RUSTC = findRustc();
const RUST_ENV = { RUSTUP_HOME: '/home/z/my-project/.rustup' };

if (RUSTC) {
  check('edge py->rust executes: rustc output equals python3 output (chain demo)', () => {
    const expected = run('python3', [DEMO_CHAIN]);
    const dir = mkdtempSync(join(tmpdir(), 'ouro-exec-'));
    const rsPath = join(dir, 'hello_chain.rs');
    writeFileSync(rsPath, emitRs(inferModule(parsePyFile(DEMO_CHAIN))));
    const prog = join(dir, 'chain_rs');
    const c = spawnSync(RUSTC, ['-O', rsPath, '-o', prog], { encoding: 'utf8', env: { ...process.env, ...RUST_ENV } });
    if (c.status !== 0) throw new Error(`rustc failed: ${(c.stderr || '').slice(0, 400)}`);
    const actual = run(prog, []);
    if (actual !== expected) throw new Error(`rust:\n${actual}\npython:\n${expected}`);
  });
} else {
  console.log('skip  py->rust executes (no rustc available)');
}

// -- the linker: multi-language modules merged through the IR spine -----------

const STRESS_LIB = join(import.meta.dirname!, '..', 'demo', 'stress_lib.py');
const STRESS_MAIN = join(import.meta.dirname!, '..', 'demo', 'stress_main.ts');
const STRESS_ALL = join(import.meta.dirname!, '..', 'demo', 'stress_all.py');

function linkStress(): Module {
  const merged = linkModules(parseTsFile(STRESS_MAIN), [parsePyFile(STRESS_LIB)]);
  return inferModule(merged);
}

check('link: merged multi-language module emits TS that re-parses to identical IR', () => {
  const merged = linkStress();
  const dir = mkdtempSync(join(tmpdir(), 'ouro-link-'));
  const tsPath = join(dir, 'stress.ts');
  writeFileSync(tsPath, emitTs(merged));
  const reparsed = inferModule(parseTsFile(tsPath));
  if (dumpNormalized(reparsed) !== dumpNormalized(merged)) {
    throw new Error('link up-down identity diverged');
  }
});

const STRESS_ORACLE = (): string => run('python3', [STRESS_ALL]);

if (RUSTC) {
  check('link: py lib + ts entry linked -> rust binary equals python3 oracle', () => {
    const expected = STRESS_ORACLE();
    const dir = mkdtempSync(join(tmpdir(), 'ouro-linkexec-'));
    const rsPath = join(dir, 'stress.rs');
    writeFileSync(rsPath, emitRs(linkStress()));
    const prog = join(dir, 'stress_rs');
    const c = spawnSync(RUSTC, ['-O', rsPath, '-o', prog], { encoding: 'utf8', env: { ...process.env, ...RUST_ENV } });
    if (c.status !== 0) throw new Error(`rustc failed: ${(c.stderr || '').slice(0, 400)}`);
    if (run(prog, []) !== expected) throw new Error('rust linked output diverged from python3');
  });
} else {
  console.log('skip  link->rust executes (no rustc available)');
}

if (HAS_JAVA) {
  check('link: py lib + ts entry linked -> java equals python3 oracle', () => {
    const expected = STRESS_ORACLE();
    const dir = mkdtempSync(join(tmpdir(), 'ouro-linkexec-'));
    const javaPath = join(dir, 'stress_main.java');
    writeFileSync(javaPath, emitJava(linkStress()));
    if (run('java', [javaPath]) !== expected) throw new Error('java linked output diverged from python3');
  });
} else {
  console.log('skip  link->java executes (no JDK)');
}

if (DOTNET) {
  check('link: py lib + ts entry linked -> dotnet equals python3 oracle', () => {
    const expected = STRESS_ORACLE();
    const dir = mkdtempSync(join(tmpdir(), 'ouro-linkexec-'));
    const csPath = join(dir, 'stress.cs');
    writeFileSync(csPath, emitCs(linkStress()));
    const actual = run(DOTNET, ['run', csPath], DOTNET.startsWith('/') ? { DOTNET_ROOT: '/home/z/my-project/.dotnet' } : undefined);
    if (actual !== expected) throw new Error('cs linked output diverged from python3');
  });
} else {
  console.log('skip  link->cs executes (no .NET SDK)');
}

check('link: py lib + ts entry linked -> node equals python3 oracle', () => {
  const expected = STRESS_ORACLE();
  const dir = mkdtempSync(join(tmpdir(), 'ouro-linkexec-'));
  const tsPath = join(dir, 'stress.ts');
  writeFileSync(tsPath, emitTs(linkStress()));
  if (run(process.execPath, [tsPath]) !== expected) throw new Error('ts linked output diverged from python3');
});


// -- loud failures ------------------------------------------------------------

const LOUD: [string, 'py' | 'ts', string, string][] = [
  ['py: imports', 'py', 'import os\n', 'imports not supported'],
  ['py: lambdas', 'py', 'f = lambda x: x\n', "expression 'Lambda' not supported"],
  ['py: try/except', 'py', 'try:\n    x = 1\nexcept Exception:\n    x = 2\n', "statement 'Try' not supported"],
  ['py: None literal', 'py', 'x = None\n', 'not supported in v1'],
  ['py: slicing', 'py', 's = "abc"\ny = s[1:2]\n', 'slicing not supported'],
  ['py: inheritance', 'py', 'class A(B):\n    pass\n', 'inheritance'],
  ['py: default parameters', 'py', 'def f(a: int = 1) -> int:\n    return a\n', 'default parameter values'],
  ['py: string indexing', 'py', 'def f(s: str) -> str:\n    return s[0]\n', 'string indexing unsupported'],
  ['ts: arrow functions', 'ts', 'let f = (x: int) => x;\n', 'arrow functions / lambdas'],
  ['ts: console.*', 'ts', 'console.log("x");\n', 'console'],
  ['ts: null literal', 'ts', 'let x = null;\n', 'null is not supported'],
  ['ts: number type', 'ts', 'let a: number = 1;\n', "not 'number'"],
  ['ts: string indexing', 'ts', 'function f(s: string): string {\n  return s[0];\n}\n', 'string indexing unsupported'],
  ['ts: bare let without initializer', 'ts', 'let x: int;\n', 'declaration without initializer'],
  ['ts: class field initializer', 'ts', 'class C {\n  x: int = 3;\n}\n', 'field initializers'],
  ['ts: generics beyond Map', 'ts', 'let p = new Box<int>(1);\n', 'generics beyond list/map'],
  ['ts: top-level import', 'ts', 'import { readFileSync } from "node:fs";\n', 'top level is not supported'],
  ['ts: for-in', 'ts', 'for (const k in [1, 2]) {\n  print(k);\n}\n', 'for-in is not part of the dialect'],
];

for (const [name, lang, src, must] of LOUD) {
  check(name, () => expectLoudFailure(name, lang, src, must));
}

// -- summary ------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('all gold checks green — backends/round-trip checks land as layers are built');
}

// keep spawnSync referenced for future execution checks (node/java/g++ runners)
void spawnSync;
