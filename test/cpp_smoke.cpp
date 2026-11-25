// cpp dialect smoke — exercises the frontend surface: classes, ctor, methods,
// forrange, foreach, map/list literals, helpers, print.

class Counter {
public:
    long total;
    string label;
    PyDict<long> hits;
    Counter(string lbl) {
        this->total = 0;
        this->label = lbl;
        this->hits = PyDict<long>();
    }
    long bump(long by) {
        this->total += by;
        pyin("a", this->hits);
        this->hits.set("a", idiv(this->total, 2));
        long last = 0;
        for (long i = 0; i < by; i += 1) {
            last = i;
        }
        return last;
    }
};

long sum_to(long n) {
    long acc = 0;
    for (long i = 0; i < n; i += 1) {
        acc += i;
    }
    return acc;
}

vector<long> evens(vector<long> xs) {
    vector<long> out = vector<long>();
    for (const auto& x : xs) {
        if (imod(x, 2) == 0) {
            out.push_back(x);
        }
    }
    return out;
}

void main() {
    Counter c = Counter("demo");
    print(c.bump(5), c.total, c.label);
    print(sum_to(10));
    vector<long> xs = {1, 2, 3, 4, 5, 6};
    print(evens(xs));
    PyDict<string> names = {{"k", "v"}, {"n", "m"}};
    print(names);
    print(pyin("k", names), pynotin("z", names));
    print(pystr(42), pyfloat(2.5), len(xs));
}
