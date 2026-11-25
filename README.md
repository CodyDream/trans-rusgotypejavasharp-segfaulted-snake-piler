# trans-rusgotypejavasharp-segfaulted-snake-piler

A bi-directional chain transpiler. Code walks the chain and comes back.

```
PYTHON ⇄ TYPESCRIPT ⇄ C# ⇄ JAVA ⇄ GO ⇄ RUST ⇄ C++
```

6 bidirectional edges = **12 directed translations**. Start in any language,
walk in either direction. When code needs to actually *run*, everything
transpiles down-chain to **Rust** — the runtime anchor of the chain. C++ is
the terminal link: it translates, but the chain does not point back past it.

## Status (v0.1)

Built: the IR spine + pretty-printer, the fixpoint type inferencer, the
Python frontend (real `ast`), the TypeScript frontend (parses the v1 TS
dialect — the exact shape the TS backend emits), the **TypeScript backend**
and the **Java backend** (both execution-verified), and the CLI
(`langs / status / dump / infer / norm / trans`).

`trans` works for any built frontend/backend pair — `py->ts`, `py->java`,
even `ts->ts` — because everything funnels through the same IR. The canonical
12 chain edges are adjacent pairs; a non-adjacent `trans` prints a note.

Not built yet (the rest of this README describes the v1 target): the other
five backends, the chain driver, the non-destructive writer, full chain
execution.

## The trick

There are no pairwise translators. Every language has exactly **one frontend**
(parse → IR) and **one backend** (IR → code), 14 components total. All edges
funnel through a shared typed intermediate representation (the spine), and a
type inferencer fills in Python's dynamic types before any static backend
runs. Any edge is therefore: `frontend(source) → infer → backend(target)`.

```
            ┌────────────── Layer 0: sources (read-only, sacred) ──────────────┐
            │                                                                  │
   L1 frontends   py  ts  cs  java  go  rust  cpp   (parse → IR)                │
   L2 the spine   IR (typed AST) + type inferencer + stdlib mapping             │
   L3 backends    py  ts  cs  java  go  rust  cpp   (IR → code)                 │
            │                                                                  │
            └─────────── Layer 4: chain driver + non-destructive writer ───────┘
                                Layer 5: CLI
```

## Quickstart

Requires Node >= 24 (native TypeScript) and Python 3 for the Python frontend
(it parses with the real `ast` module — no hand-rolled indentation parsing).

```bash
npm install                 # typescript for typechecking only
node src/cli.ts langs       # print the chain
node src/cli.ts infer program.py    # parse + infer, print the typed IR (py, ts)
node src/cli.ts norm program.py     # normalized IR — diff two frontends' view
node tests/run.ts           # gold suite (31 checks in v0.1)

# transpile — works today (output to stdout):
node src/cli.ts trans 'py->ts'   program.py    # run with: node out.ts
node src/cli.ts trans 'py->java' program.py    # run with: java Program.java (JDK 11+)
node src/cli.ts trans 'ts->ts'   program.ts    # self-edge round-trip

# walk the whole chain, one artifact per hop (needs the remaining backends)
node src/cli.ts chain program.py            # py -> ... -> cpp
node src/cli.ts chain main.rs --to py       # rust -> ... -> py

# the money shot: to the far end and back (needs backends)
node src/cli.ts roundtrip program.py        # final Python output vs original

# run: everything transpiles down to Rust (needs backends + rustc)
node src/cli.ts run program.py
```

## Non-destructive guarantee

Input files are opened read-only and **never** written. Every hop emits a
fresh numbered artifact under `ouro-out/`:

```
ouro-out/roundtrip_demo/
  forward/  01_ts.ts  02_cs.cs  03_java.java  04_go.go  05_rust.rs  06_cpp.cpp
  backward/ 01_rust.rs 02_go.go 03_java.java 04_cs.cs 05_ts.ts 06_py.py
```

If a target path would ever collide with an input path, the tool aborts.

## v1 language subset

Functions, classes (fields / methods / constructor), ints, floats, bools,
strings, lists, string-keyed dicts, `if/elif/else`, `while`, `for range`
(literal step), for-each, `break`/`continue`, arithmetic, comparisons,
`in` / `not in`, augmented assignment, f-strings (no format specs), `print`,
`len`/`str`/`int`/`float`, common string methods (`upper lower strip replace
split join startswith endswith find`), list methods (`append pop index sort
reverse clear`), dict ops (`d[k]`, `d.get(k, default)`, `keys values pop(k)`),
recursion.

Not supported (fails with a clear message, never silently): imports, lambdas,
closures, try/except, inheritance, decorators, None, string indexing/slicing,
tuple unpacking, comprehensions, ternaries, generics beyond list/map,
branch-declared variables used after the branch.

## Validation

`node tests/run.ts` — 31 gold checks (the v0.1 set):

- py and ts frontends parse + infer the smoke program
- py and ts frontends agree byte-for-byte on normalized IR for the same program
- **edge py->ts: the emitted TS re-parses to identical normalized IR**
- **edge ts->ts: self-edge re-parse identity**
- **execution: the chain demo's node and java outputs equal python3's output**
  (python3 is the oracle)
- dialect canonicalizations verified (`indexOf` → `index`/`find` by receiver
  type, `xs.join(sep)` → `sep.join(xs)`, `trim` → `strip`,
  `toUpperCase` → `upper`, `push` → `append`)
- forrange step forms (`i++`, `i += s`, downward `i -= s`, `i = i + s`)
- the non-destructive guarantee: parsing never modifies an input file
  (verified byte-for-byte)
- 18 unsupported-construct cases fail loudly (`TranspileError` with a line
  number at the parse layer; never silently)

Remaining for v1: all 12 edges re-parsing to identical IR and the full
forward/backward chain executed — they land with the remaining backends.

## Documented divergences (the honest section)

- `//` and `%` on negative numbers floor in Python but truncate in
  C#/Go/Rust/C++ — the built backends (TypeScript, Java) match Python anyway
  via their prelude helpers (`idiv`/`imod`, `Math.floorDiv`/`floorMod`); the
  remaining backends must do the same when they land.
- Printing a whole map/dict may order differently per language (insertion
  order vs sorted). Scalar values are exact.
- Whole-valued floats print `2.0` in Python, `2` in TS/JS (all other
  languages match Python).
- C++ evaluates call arguments in unspecified order — the backend hoists
  side-effectful arguments into temporaries to force Python's order.
- `int` is 64-bit everywhere — except the Java backend, which uses Java's
  32-bit `int` (v0.1 limitation, called out in the backend header).

## Layout

```
src/ir/         typed AST spine + printer
src/infer/      fixpoint type inferencer
src/frontends/  py (via python3 ast), ts (v1 dialect) — cs java go rust cpp planned
src/backends/   ts, java (+ preludes) — py cs go rust cpp planned
src/chain/      the 6 bidirectional edges, chain walker
src/cli.ts      ouro CLI
tests/          gold suite + demo programs
```
