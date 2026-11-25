# stress oracle — the whole stress program as one pure-Python file.
# python3 runs this; the linked stress_lib.py + stress_main.ts program must
# produce byte-identical output in every backend (rust / java / cs / ts).
# NOTE: whole-valued floats are never printed (TS/JS prints them without
# the trailing .0 — documented divergence); dict.keys()/values() are never
# printed directly (python3 prints dict_keys/dict_values wrappers).

class Item:
    def __init__(self, name: str, count: int):
        self.name = name
        self.count = count
    def bump(self, by: int) -> int:
        self.count = self.count + by
        return self.count
    def label(self) -> str:
        return self.name + " x" + str(self.count)

class Shelf:
    def __init__(self, title: str):
        self.title = title
        self.items: list[Item] = []
        self.index: dict[str, int] = {}
    def add(self, it: Item) -> int:
        self.items.append(it)
        self.index[it.name] = it.count
        return len(self.items)

def summarize(words: list[str]) -> str:
    return ",".join(words)

def clamp(v: int, lo: int, hi: int) -> int:
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v

greeting = "stress"
widths: list[int] = [12, 7, 30, 3]
widths.append(21)
widths.sort()
print("widths", widths, "first", widths[0], "last", widths[len(widths) - 1])
widths.reverse()
print("desc", widths)
pos = widths.index(30)
widths.pop()
print("pos", pos, "after pop", widths)

labels: dict[str, int] = {"alpha": 5, "beta": 4}
labels["gamma"] = 9
labels["beta"] = 6
print("labels", labels)
print("beta", labels.get("beta", 0), "delta", labels.get("delta", -1))
print("has alpha", "alpha" in labels, "has omega", "omega" in labels)
ks: list[str] = []
for k in labels.keys():
    ks.append(k)
print("keys", ks)
vs: list[int] = []
for v in labels.values():
    vs.append(v)
print("values", vs)
gone = labels.pop("alpha")
print("popped", gone, "left", labels)

words: list[str] = ["pear", "Fig", "DATE"]
words.sort()
print("words", words)
joined = ",".join(words)
print("joined", joined)
parts = joined.split(",")
print("parts", parts, "count", len(parts))
shout = parts[0].upper()
print("shout", shout, "lower", shout.lower(), "len", len(shout))
print("starts", shout.startswith("D"), "ends", shout.endswith("E"))
swapped = shout.replace("DATE", "date!")
print("swapped", swapped, "digits", "123".isdigit(), "no", "12a".isdigit())
print("find", "banana".find("na"), "miss", "banana".find("zz"))
stripme = "  pad  "
print("stripped", stripme.strip(), "len", len(stripme.strip()))

it = Item("bolt", 4)
print(it.label(), it.bump(6), it.count)
shelf = Shelf("wall")
print("size", shelf.add(it), shelf.add(Item("nut", 11)))
print("shelf", shelf.title, shelf.index)
print("lookup", shelf.index.get("bolt", 0), "nut in", "nut" in shelf.index)
print("summarize", summarize(["b", "a", "c"]), clamp(99, 3, 30), clamp(-2, 3, 30))

total = 0
for i in range(0, 10, 3):
    total = total + i
print("total", total)
down = 0
for i in range(10, 0, -4):
    down = down + i
print("down", down)

n = 5
while n > 0:
    n = n - 2
print("n", n)

marks = [8, 3, 9]
if marks[0] > marks[1] and len(marks) == 3:
    print("cond", marks[0])
elif marks[0] == 8:
    print("elif")
else:
    print("else")

print("floor", 17 // 5, -17 // 5, 17 % 5, -17 % 5)
print("div", 17 / 5, 20 / 8)
print("conv", int("42"), int(7.9), float("2.5"), str(99) + "!")
x = 2.5
print("mix", x * 1.5, x / 4)
print("neg", -x, not (x > 3))
print("fstr", f"item {it.name} has {it.count} units, floor {17 // 5}, name {shelf.title}")
