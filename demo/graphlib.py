# graphlib — a small pathfinding library (authored in PYTHON, v1 subset).
# Directed weighted graph: adjacency + flat weight map keyed "u|v".
# The library contains only declarations (importable); graphlib_driver.ts is
# the TypeScript entry that exercises it, and graphlib_all.py is the
# single-file python3 oracle for the linked program.


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
        # Dijkstra with linear-scan frontier; returns the min-weight path
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
