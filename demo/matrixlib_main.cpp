// matrixlib driver (v1 C++ dialect) — exercises the library API.

void main() {
    Matrix a = Matrix(2, 3);
    a.set(0, 0, 1);
    a.set(0, 1, 2);
    a.set(0, 2, 3);
    a.set(1, 0, 4);
    a.set(1, 1, 5);
    a.set(1, 2, 6);
    Matrix b = Matrix(3, 2);
    b.set(0, 0, 7);
    b.set(0, 1, 8);
    b.set(1, 0, 9);
    b.set(1, 1, 10);
    b.set(2, 0, 11);
    b.set(2, 1, 12);

    print("a", show(a));
    print("a^T", show(a.transpose()));
    print("a*b", show(multiply(a, b)));
    print("trace", a.trace(), multiply(a, b).trace());
    print("scaled", show(scaled(a, 3)));
    print("rowsums", a.rowsums());
    print("get", a.get(1, 2), a.get(0, 0));
    a.set(1, 2, 60);
    print("after set", show(a), a.get(1, 2));

    print("same", same(a, multiply(a, b)), same(a, scaled(a, 1)));
    Matrix e = Matrix(2, 2);
    e.set(0, 0, 1);
    e.set(1, 1, 1);
    print("twice eye", show(added(e, e)));
    print("eye same", same(e, e), same(e, added(e, e)));

    vector<long> flat = {3, 1, 2};
    pysort(flat);
    print("sorted", flat);
    pyreverse(flat);
    print("reversed", flat);
    print("idx", pylist_index(flat, 2), pylist_index(flat, 99));
    print("len", len(flat), imod(17, 5), idiv(17, 5));
}
