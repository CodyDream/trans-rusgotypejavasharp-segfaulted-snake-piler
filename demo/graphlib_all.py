# graphlib port oracle — the whole program as one pure-Python file:
# the graphlib.py library + the graphlib_driver.ts driver, inlined.
# python3 runs this; the linked lib+driver must match byte-for-byte in
# every backend (rust / java / cs / ts).


class Graph:
    def __init__(self):
        self.adj: dict[str, list[str]] = {}
        self.w: dict[str, int] = {}

    def add_node(self, n: str) -> None:
        lst = self.adj.get(n, [])
        self.adj[n] = lst

    def add_edge(self, u: str, v: str, w: int) -> None:
        lst = self.adj.get(u, [])
        lst.append(v)
        self.adj[u] = lst
        self.w[u + "|" + v] = w

    def order(self) -> int:
        return len(self.adj)

    def nodes(self) -> list[str]:
        out: list[str] = []
        for u in self.adj.keys():
            out.append(u)
            for v in self.adj[u]:
                if not (v in self.adj):
                    out.append(v)
        return out

    def neighbors(self, u: str) -> list[str]:
        return self.adj.get(u, [])

    def weight(self, u: str, v: str) -> int:
        return self.w.get(u + "|" + v, 1000000)

    def bfs_path(self, start: str, goal: str) -> list[str]:
        if start == goal:
            return [start]
        prev: dict[str, str] = {}
        seen: dict[str, bool] = {}
        q: list[str] = [start]
        seen[start] = True
        qi = 0
        while qi < len(q):
            cur = q[qi]
            qi = qi + 1
            for nb in self.neighbors(cur):
                if not (nb in seen):
                    seen[nb] = True
                    prev[nb] = cur
                    q.append(nb)
        if not (goal in seen):
            return []
        path: list[str] = []
        node = goal
        while node != start:
            path.append(node)
            node = prev[node]
        path.append(start)
        path.reverse()
        return path

    def shortest_path(self, start: str, goal: str) -> list[str]:
        if start == goal:
            return [start]
        dist: dict[str, int] = {}
        prev: dict[str, str] = {}
        nodes: list[str] = self.nodes()
        for n in nodes:
            dist[n] = 1000000
        dist[start] = 0
        done: dict[str, bool] = {}
        while len(done) < len(nodes):
            best = ""
            bd = 1000000
            for k in dist.keys():
                if k in done:
                    continue
                if dist[k] < bd:
                    bd = dist[k]
                    best = k
            if best == "":
                break
            done[best] = True
            if best == goal:
                break
            for nb in self.neighbors(best):
                alt = bd + self.weight(best, nb)
                if alt < dist[nb]:
                    dist[nb] = alt
                    prev[nb] = best
        if not (goal in prev):
            return []
        path: list[str] = []
        node = goal
        while node != start:
            path.append(node)
            node = prev[node]
        path.append(start)
        path.reverse()
        return path

    def has_path(self, start: str, goal: str) -> bool:
        return start == goal or len(self.bfs_path(start, goal)) > 0

    def describe(self) -> str:
        return "graph(" + str(self.order()) + " nodes, " + str(len(self.w)) + " edges)"


g = Graph()
g.add_edge("alpha", "beta", 2)
g.add_edge("beta", "alpha", 2)
g.add_edge("beta", "gamma", 3)
g.add_edge("gamma", "beta", 3)
g.add_edge("alpha", "delta", 1)
g.add_edge("delta", "alpha", 1)
g.add_edge("delta", "gamma", 4)
g.add_edge("gamma", "delta", 4)
g.add_edge("gamma", "epsilon", 2)
g.add_edge("epsilon", "gamma", 2)
g.add_edge("delta", "epsilon", 7)
g.add_edge("epsilon", "delta", 7)
g.add_node("island")
g.add_node("kappa")
g.add_edge("kappa", "alpha", 9)

print(g.describe())
print("adj", g.adj)
print("order", g.order())
print("nodes", g.nodes())
print("neighbors delta", g.neighbors("delta"))
print("weight alpha beta", g.weight("alpha", "beta"))
print("weight island kappa", g.weight("island", "kappa"))

hops = g.bfs_path("alpha", "epsilon")
print("bfs alpha->epsilon", "->".join(hops))
sp = g.shortest_path("alpha", "epsilon")
print("dijkstra alpha->epsilon", "->".join(sp))
print("has alpha->epsilon", g.has_path("alpha", "epsilon"), "has alpha->island", g.has_path("alpha", "island"))
print("bfs island->alpha", g.bfs_path("island", "alpha"))
print("dijkstra island->alpha", g.shortest_path("island", "alpha"))
print("self path", "->".join(g.bfs_path("gamma", "gamma")))
