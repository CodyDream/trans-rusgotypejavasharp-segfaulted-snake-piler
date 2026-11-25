/**
 * The linker (Layer 2.5) — connect modules WRITTEN IN DIFFERENT LANGUAGES
 * into one IR module. "Fully brought down", no stubs, no FFI: every file is
 * parsed by its own frontend into the same IR spine, then merged:
 *
 *  - declarations: concatenated (on a name collision the later module wins,
 *    with a note on stderr — Python's flat `from lib import *` model)
 *  - module bodies: run in import order — libraries first, entry last
 *  - the merged module is re-inferred (cross-module calls type-check here)
 *    and can then be emitted through ANY backend as one native program.
 */
import type { Module, Item, Stmt, FunDecl } from './ir/types.ts';
import { inferModule } from './infer/infer.ts';

function mainBodyOf(m: Module): Stmt[] {
  const main = m.items.find(it => it.name === 'main') as FunDecl | undefined;
  return main ? main.body : [];
}

export function linkModules(entry: Module, libs: Module[]): Module {
  const byName = new Map<string, Item>();
  const note = (name: string, winner: string): void =>
    console.error(`ouro: link note: '${name}' is defined more than once — the ${winner} version wins`);
  for (const lib of libs) {
    for (const item of lib.items) {
      if (item.name === 'main') continue;   // library bodies merge below, in order
      if (byName.has(item.name)) note(item.name, `lib '${lib.name}'`);
      byName.set(item.name, item);
    }
  }
  for (const item of entry.items) {
    if (item.name === 'main') continue;
    if (byName.has(item.name)) note(item.name, 'entry');
    byName.set(item.name, item);
  }
  const body: Stmt[] = [];
  for (const lib of libs) body.push(...mainBodyOf(lib));
  body.push(...mainBodyOf(entry));
  const main: FunDecl = { name: 'main', params: [], ret: { k: 'void' }, body };
  const merged: Module = {
    name: entry.name,
    sourceLang: entry.sourceLang,
    items: [...byName.values(), main],
    implicitMain: entry.implicitMain,
  };
  return inferModule(merged);
}
