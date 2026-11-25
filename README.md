# trans-rusgotypejavasharp-segfaulted-snake-piler

A bi-directional chain transpiler. Code walks the chain and comes back.

```
PYTHON ⇄ TYPESCRIPT ⇄ C# ⇄ JAVA ⇄ GO ⇄ RUST ⇄ C++
```

6 bidirectional edges = **12 directed translations**. Start in any language,
walk in either direction. When code needs to actually *run*, everything
transpiles down-chain to **Rust** — the runtime anchor of the chain. C++ is
the terminal link: it translates, but the chain does not point back past it.

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

# single edge (12 available)
node src/cli.ts trans 'py->ts'   program.py
node src/cli.ts trans 'rust->go' main.rs

# walk the whole chain, one artifact per hop
node src/cli.ts chain program.py            # py -> ... -> cpp
node src/cli.ts chain main.rs --to py       # rust -> ... -> py

# the money shot: to the far end and back
node src/cli.ts roundtrip program.py        # py -> ts -> ... -> cpp -> ... -> py
                                            # final Python output compared to original

# run: everything transpiles down to Rust
node src/cli.ts run program.py              # needs rustc to execute; emits anyway
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

`node tests/run.ts` — 23 gold checks:

- all 12 edges emit and re-parse to structurally identical IR
- forward chain: TypeScript, Java and C++ hops are executed (node, `java`
  single-file mode, g++) and their output must equal the original Python
  program's output
- backward chain returns to Python with identical output
- non-destructive guarantee verified byte-for-byte
- unsupported syntax fails loudly, never silently

## Documented divergences (the honest section)

- `//` and `%` on negative numbers floor in Python but truncate in
  C#/Java/Go/Rust/C++ (TypeScript matches Python via `Math.floor`).
- Printing a whole map/dict may order differently per language (insertion
  order vs sorted). Scalar values are exact.
- Whole-valued floats print `2.0` in Python, `2` in TS/JS (all other
  languages match Python).
- C++ evaluates call arguments in unspecified order — the backend hoists
  side-effectful arguments into temporaries to force Python's order.
- `int` is 64-bit everywhere; Python's unbounded ints are not modeled.

## Layout

```
src/ir/         typed AST spine + printer
src/infer/      fixpoint type inferencer
src/frontends/  py (via python3 ast) ts cs java go rust cpp
src/backends/   py ts cs java go rust cpp (+ dialect preludes)
src/chain/      the 6 bidirectional edges, chain walker
src/cli.ts      ouro CLI
tests/          gold suite + demo programs
```
