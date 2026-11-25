#!/usr/bin/env node
/**
 * ouro CLI (Layer 5).
 *
 * Commands:
 *   langs                 print the chain
 *   status                which frontends / backends exist right now
 *   dump <file>           parse to IR (pre-inference) and print it
 *   infer <file>          parse, infer types, print the typed IR
 *   norm <file>           parse, infer, print normalized IR (cross-hop diff form)
 *   trans <a->b> <file>   translate one edge (loud error if a side is not built)
 *   chain / roundtrip / run   not built yet in v0.1 — loud error, never silent
 *
 * Input files are opened read-only; the CLI never writes to an input path.
 */

import { parsePyFile } from './frontends/py/index.ts';
import { parseTsFile } from './frontends/ts/index.ts';
import { parseCppFile } from './frontends/cpp/index.ts';
import { emitTs } from './backends/ts/index.ts';
import { emitJava } from './backends/java/index.ts';
import { emitCs } from './backends/cs/index.ts';
import { emitRs } from './backends/rs/index.ts';
import { emitGo } from './backends/go/index.ts';
import { linkModules } from './link.ts';
import { inferModule } from './infer/infer.ts';
import { dumpModule, dumpNormalized } from './ir/show.ts';
import { TranspileError } from './ir/types.ts';
import type { Module } from './ir/types.ts';

export const CHAIN = ['py', 'ts', 'cs', 'java', 'go', 'rust', 'cpp'] as const;

export const EXT: Record<string, string> = {
  py: '.py', ts: '.ts', cs: '.cs', java: '.java', go: '.go', rust: '.rs', cpp: '.cpp',
};

/** Layer 1 registry: language -> parser. Grows one entry per new frontend. */
const FRONTENDS: Record<string, (path: string) => Module> = {
  py: parsePyFile,
  ts: parseTsFile,
  cpp: parseCppFile,
};

/** Layer 3 registry: language -> code emitter. */
const BACKENDS: Record<string, (m: Module) => string> = {
  ts: emitTs,
  java: emitJava,
  cs: emitCs,
  rust: emitRs,
  go: emitGo,
};

function langOf(path: string): string {
  for (const [lang, ext] of Object.entries(EXT)) {
    if (path.endsWith(ext)) return lang;
  }
  throw new TranspileError(
    `cannot determine language from file name '${path}' (known extensions: ${Object.values(EXT).join(' ')})`,
    'cli',
  );
}

function load(path: string): Module {
  const lang = langOf(path);
  const fe = FRONTENDS[lang];
  if (fe == null) {
    throw new TranspileError(
      `no frontend for '${lang}' yet (built: ${Object.keys(FRONTENDS).join(', ') || 'none'})`,
      'cli',
    );
  }
  return fe(path);
}

function loadTyped(path: string): Module {
  return inferModule(load(path));   // both frontends need it: py for typing, ts for stamps
}

function parseEdge(spec: string): { src: string; dst: string } {
  const i = spec.indexOf('->');
  if (i < 0) {
    throw new TranspileError(`bad edge spec '${spec}' — expected the form py->ts`, 'cli');
  }
  const src = spec.slice(0, i).trim();
  const dst = spec.slice(i + 2).trim();
  for (const lang of [src, dst]) {
    if (!(CHAIN as readonly string[]).includes(lang)) {
      throw new TranspileError(`unknown language '${lang}' in edge '${spec}' (chain: ${CHAIN.join(' ')})`, 'cli');
    }
  }
  const si = (CHAIN as readonly string[]).indexOf(src);
  const di = (CHAIN as readonly string[]).indexOf(dst);
  if (Math.abs(si - di) > 1) {
    console.error(`ouro: note: '${src}->${dst}' skips chain hops — the canonical 12 edges are adjacent pairs, but any built frontend/backend pair funnels through the same IR`);
  }
  return { src, dst };
}

function usage(): string {
  return [
    'ouro — bi-directional chain transpiler (v0.1)',
    '',
    '  langs                    print the chain',
    '  status                   which frontends / backends exist',
    '  dump <file>              parse to IR (pre-inference) and print it',
    '  infer <file>             parse, infer types, print the typed IR',
    '  norm <file>              parse, infer, print normalized IR (diff form)',
    "  trans <a->b> <file>      translate one edge",
    '  link <out> <libs...> <entry>  merge multi-language modules into ONE program',
    '',
    '  chain / roundtrip / run  planned — not built yet (loud error)',
  ].join('\n');
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'langs': {
      console.log(CHAIN.join(' ⇄ '));
      console.log(`${CHAIN.length - 1} bidirectional edges = ${2 * (CHAIN.length - 1)} directed translations`);
      return 0;
    }
    case 'status': {
      console.log(`chain:     ${CHAIN.join(' ⇄ ')}`);
      console.log(`frontends: ${Object.keys(FRONTENDS).join(', ') || '(none)'}`);
      console.log(`backends:  ${Object.keys(BACKENDS).join(', ') || '(none yet — v0.1 spine)'}`);
      return 0;
    }
    case 'dump': {
      needFile(rest);
      console.log(dumpModule(load(rest[0])));
      return 0;
    }
    case 'infer': {
      needFile(rest);
      console.log(dumpModule(loadTyped(rest[0])));
      return 0;
    }
    case 'norm': {
      needFile(rest);
      console.log(dumpNormalized(loadTyped(rest[0])));
      return 0;
    }
    case 'trans': {
      const [spec, file] = rest;
      if (spec == null || file == null) {
        throw new TranspileError("usage: ouro trans 'py->ts' <file>", 'cli');
      }
      const { src, dst } = parseEdge(spec);
      const m = load(file);
      if (m.sourceLang !== src) {
        throw new TranspileError(
          `edge '${src}->${dst}' needs a ${src} file, got '${file}' (${m.sourceLang})`,
          'cli',
        );
      }
      const typed = inferModule(m);
      const be = BACKENDS[dst];
      if (be == null) {
        throw new TranspileError(
          `no backend for '${dst}' yet (built: ${Object.keys(BACKENDS).join(', ') || 'none'}) — the IR is ready, the printer is not`,
          'cli',
        );
      }
      console.log(be(typed));
      return 0;
    }
    case 'link': {
      // usage: link <outFile> <lib1> [<lib2> ...] <entry> — the LAST file is the entry
      const [outFile, ...files] = rest;
      if (outFile == null || files.length === 0) {
        throw new TranspileError("usage: ouro link <out.rs> <lib1.py> [<lib2.ts> ...] <entry>", 'cli');
      }
      const mods = files.map(f => load(f));
      const merged = linkModules(mods[mods.length - 1], mods.slice(0, -1));
      const be = BACKENDS[langOf(outFile)];
      if (be == null) {
        throw new TranspileError(
          `no backend for '${langOf(outFile)}' yet (built: ${Object.keys(BACKENDS).join(', ') || 'none'})`,
          'cli',
        );
      }
      console.log(be(merged));
      return 0;
    }
    case 'chain':
    case 'roundtrip':
    case 'run':
      throw new TranspileError(
        `'${cmd}' needs backends and the chain driver — not built yet in v0.1 (see README: Layer 3/4)`,
        'cli',
      );
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(usage());
      return cmd == null ? 2 : 0;
    default:
      throw new TranspileError(`unknown command '${cmd}' — try 'ouro help'`, 'cli');
  }
}

function needFile(rest: string[]): void {
  if (rest.length === 0 || rest[0] == null) {
    throw new TranspileError('missing <file> argument', 'cli');
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`ouro: ${msg}`);
  process.exitCode = 1;
}
