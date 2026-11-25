// smoke test — the same program as test/smoke.py, spelled in the TS dialect.
// Both frontends must produce identical normalized IR (see `ouro norm`).

function add(a: int, b: int): int {
  return a + b;
}

function fib(n: int): int {
  if (n <= 1) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

function shout(name: string): string {
  return `HELLO, ${name}!!!`;
}

class Counter {
  count: int;
  label: string;

  constructor(start: int) {
    this.count = start;
    this.label = "ctr";
  }

  bump(): int {
    this.count = this.count + 1;
    return this.count;
  }
}

let n = 0;
let items: int[] = [3, 1, 2];
let bag: Map<string, int> = new Map<string, int>([["alpha", 1], ["beta", 2]]);
let c = new Counter(10);

for (let i = 0; i < 3; i++) {
  n = n + i;
  items.append(i * 10);
}

for (const w of ["alpha", "beta"]) {
  print(w, len(w));
}

while (n < 8) {
  n = n + 1;
}

if (n > 5 && isin("al", "alpha")) {
  print("big", add(2, 3), fib(10));
} else if (n == 5) {
  print("five");
} else {
  print("small");
}

if (isnotin(20, items)) {
  print("missing");
} else {
  print("found", items[1]);
}

items.sort();
bag["gamma"] = 9;
print("items", items);
print("bag", bag["alpha"] + bag["gamma"]);
print(c.bump(), c.bump(), c.label);
print(shout("chain"), float(2) + 1);
