# stress library module (authored in PYTHON) — classes + free functions only,
# no module-level statements. Linked with stress_main.ts (authored in
# TYPESCRIPT) through the IR spine; the pair must behave exactly like the
# single-file stress_all.py oracle in every backend.

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
