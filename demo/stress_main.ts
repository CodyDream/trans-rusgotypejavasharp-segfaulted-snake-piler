// stress main module (authored in TYPESCRIPT, v1 dialect) — the statements
// half of the stress program. Linked with stress_lib.py (authored in PYTHON)
// through the IR spine; the merged program must match stress_all.py exactly
// in every backend. Whole-valued floats are never printed (TS divergence).

let widths: int[] = [12, 7, 30, 3];
widths.push(21);
widths.sort();
print("widths", widths, "first", widths[0], "last", widths[len(widths) - 1]);
widths.reverse();
print("desc", widths);
let pos: int = widths.indexOf(30);
widths.pop();
print("pos", pos, "after pop", widths);

let labels: Map<string, int> = new Map<string, int>([["alpha", 5], ["beta", 4]]);
mapSet(labels, "gamma", 9);
mapSet(labels, "beta", 6);
print("labels", labels);
print("beta", mapGet(labels, "beta", 0), "delta", mapGet(labels, "delta", -1));
print("has alpha", isin("alpha", labels), "has omega", isin("omega", labels));
let ks: string[] = [];
for (const k of labels.keys()) {
  ks.push(k);
}
print("keys", ks);
let vs: int[] = [];
for (const v of labels.values()) {
  vs.push(v);
}
print("values", vs);
let gone: int = mapPop(labels, "alpha");
print("popped", gone, "left", labels);

let words: string[] = ["pear", "Fig", "DATE"];
words.sort();
print("words", words);
let joined: string = words.join(",");
print("joined", joined);
let parts: string[] = joined.split(",");
print("parts", parts, "count", len(parts));
let shout: string = parts[0].toUpperCase();
print("shout", shout, "lower", shout.toLowerCase(), "len", len(shout));
print("starts", shout.startsWith("D"), "ends", shout.endsWith("E"));
let swapped: string = shout.replace("DATE", "date!");
print("swapped", swapped, "digits", isdigit("123"), "no", isdigit("12a"));
print("find", "banana".indexOf("na"), "miss", "banana".indexOf("zz"));
let stripme: string = "  pad  ";
print("stripped", stripme.trim(), "len", len(stripme.trim()));

let it: Item = new Item("bolt", 4);
print(it.label(), it.bump(6), it.count);
let shelf: Shelf = new Shelf("wall");
print("size", shelf.add(it), shelf.add(new Item("nut", 11)));
print("shelf", shelf.title, shelf.index);
print("lookup", mapGet(shelf.index, "bolt", 0), "nut in", isin("nut", shelf.index));
print("summarize", summarize(["b", "a", "c"]), clamp(99, 3, 30), clamp(-2, 3, 30));

let total: int = 0;
for (let i = 0; i < 10; i += 3) {
  total = total + i;
}
print("total", total);
let down: int = 0;
for (let i = 10; i > 0; i -= 4) {
  down = down + i;
}
print("down", down);

let n: int = 5;
while (n > 0) {
  n = n - 2;
}
print("n", n);

let marks: int[] = [8, 3, 9];
if (marks[0] > marks[1] && len(marks) == 3) {
  print("cond", marks[0]);
} else if (marks[0] == 8) {
  print("elif");
} else {
  print("else");
}

print("floor", idiv(17, 5), idiv(-17, 5), imod(17, 5), imod(-17, 5));
print("div", 17 / 5, 20 / 8);
print("conv", int("42"), int(7.9), float("2.5"), str(99) + "!");
let x: float = 2.5;
print("mix", x * 1.5, x / 4);
print("neg", -x, !(x > 3));
print("fstr", `item ${it.name} has ${it.count} units, floor ${idiv(17, 5)}, name ${shelf.title}`);
