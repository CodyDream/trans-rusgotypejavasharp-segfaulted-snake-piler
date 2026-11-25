greeting = "Hello"
target = "World"
print(f"{greeting}, {target}!")

for i in range(3):
    print(f"tick {i}")

items: list[int] = [3, 1, 2]
items.append(10)
items.sort()
print("items", items, "first", items[0])

counts: dict[str, int] = {"alpha": 5, "beta": 4}
counts["gamma"] = 5
print("counts", counts)
print("alpha has", counts.get("alpha", 0), "letters", "gamma" in counts)

print(7 // 2, -7 // 2, 7 % 3, -7 % 3)
print(str(42) + "!")
