// graphlib driver (authored in TYPESCRIPT, v1 dialect) — exercises the
// Python-authored Graph library through the linker. Must match
// graphlib_all.py (python3 oracle) byte-for-byte in every backend.

let g: Graph = new Graph();
g.add_edge("alpha", "beta", 2);
g.add_edge("beta", "alpha", 2);
g.add_edge("beta", "gamma", 3);
g.add_edge("gamma", "beta", 3);
g.add_edge("alpha", "delta", 1);
g.add_edge("delta", "alpha", 1);
g.add_edge("delta", "gamma", 4);
g.add_edge("gamma", "delta", 4);
g.add_edge("gamma", "epsilon", 2);
g.add_edge("epsilon", "gamma", 2);
g.add_edge("delta", "epsilon", 7);
g.add_edge("epsilon", "delta", 7);
g.add_node("island");
g.add_node("kappa");
g.add_edge("kappa", "alpha", 9);

print(g.describe());
print("adj", g.adj);
print("order", g.order());
print("nodes", g.nodes());
print("neighbors delta", g.neighbors("delta"));
print("weight alpha beta", g.weight("alpha", "beta"));
print("weight island kappa", g.weight("island", "kappa"));

let hops: string[] = g.bfs_path("alpha", "epsilon");
print("bfs alpha->epsilon", "->".join(hops));
let sp: string[] = g.shortest_path("alpha", "epsilon");
print("dijkstra alpha->epsilon", "->".join(sp));
print("has alpha->epsilon", g.has_path("alpha", "epsilon"), "has alpha->island", g.has_path("alpha", "island"));
print("bfs island->alpha", g.bfs_path("island", "alpha"));
print("dijkstra island->alpha", g.shortest_path("island", "alpha"));
print("self path", "->".join(g.bfs_path("gamma", "gamma")));
