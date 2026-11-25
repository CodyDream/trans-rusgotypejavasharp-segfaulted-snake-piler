# smoke test — exercises the v1 subset end to end


def add(a: int, b: int) -> int:
    return a + b


def fib(n: int) -> int:
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)


def shout(name: str) -> str:
    return f"HELLO, {name}!!!"


class Counter:
    count: int
    label: str

    def __init__(self, start: int):
        self.count = start
        self.label = "ctr"

    def bump(self) -> int:
        self.count = self.count + 1
        return self.count


n = 0
items: list[int] = [3, 1, 2]
bag: dict[str, int] = {"alpha": 1, "beta": 2}
c = Counter(10)

for i in range(3):
    n = n + i
    items.append(i * 10)

for w in ["alpha", "beta"]:
    print(w, len(w))

while n < 8:
    n = n + 1

if n > 5 and "al" in "alpha":
    print("big", add(2, 3), fib(10))
elif n == 5:
    print("five")
else:
    print("small")

if 20 not in items:
    print("missing")
else:
    print("found", items[1])

items.sort()
bag["gamma"] = 9
print("items", items)
print("bag", bag["alpha"] + bag["gamma"])
print(c.bump(), c.bump(), c.label)
print(shout("chain"), float(2) + 1)
