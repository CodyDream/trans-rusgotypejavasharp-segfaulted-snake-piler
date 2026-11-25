// matrixlib — a small integer-matrix library authored in C++ (v1 dialect).
// The library holds only declarations; matrixlib_main.cpp is the entry, and
// the g++ oracle compiles both against test/cpp_prelude.hpp:
//   g++ -std=c++17 -w -include test/cpp_prelude.hpp \
//     demo/matrixlib.cpp demo/matrixlib_main.cpp -o oracle
// Aliasing discipline: rows are built locally and assigned wholesale —
// the backends clone on read, so no method calls through cells[i].

class Matrix {
public:
    long rows;
    long cols;
    vector<vector<long>> cells;
    Matrix(long r, long c) {
        this->rows = r;
        this->cols = c;
        this->cells = vector<vector<long>>();
        for (long i = 0; i < r; i += 1) {
            vector<long> row = vector<long>();
            for (long j = 0; j < c; j += 1) {
                row.push_back(0);
            }
            this->cells.push_back(row);
        }
    }
    long get(long i, long j) {
        return this->cells[i][j];
    }
    void set(long i, long j, long v) {
        vector<long> row = this->cells[i];
        row[j] = v;
        this->cells[i] = row;
    }
    long trace() {
        long t = 0;
        for (long i = 0; i < this->rows; i += 1) {
            t += this->cells[i][i];
        }
        return t;
    }
    Matrix transpose() {
        Matrix out = Matrix(this->cols, this->rows);
        for (long i = 0; i < this->rows; i += 1) {
            for (long j = 0; j < this->cols; j += 1) {
                out.cells[j][i] = this->cells[i][j];
            }
        }
        return out;
    }
    vector<long> rowsums() {
        vector<long> sums = vector<long>();
        for (long i = 0; i < this->rows; i += 1) {
            long acc = 0;
            for (long j = 0; j < this->cols; j += 1) {
                acc += this->cells[i][j];
            }
            sums.push_back(acc);
        }
        return sums;
    }
};

Matrix multiply(Matrix a, Matrix b) {
    Matrix out = Matrix(a.rows, b.cols);
    for (long i = 0; i < a.rows; i += 1) {
        for (long j = 0; j < b.cols; j += 1) {
            long acc = 0;
            for (long k = 0; k < a.cols; k += 1) {
                acc += a.cells[i][k] * b.cells[k][j];
            }
            out.cells[i][j] = acc;
        }
    }
    return out;
}

Matrix scaled(Matrix m, long f) {
    Matrix out = Matrix(m.rows, m.cols);
    for (long i = 0; i < m.rows; i += 1) {
        for (long j = 0; j < m.cols; j += 1) {
            out.cells[i][j] = m.cells[i][j] * f;
        }
    }
    return out;
}

Matrix added(Matrix a, Matrix b) {
    Matrix out = Matrix(a.rows, a.cols);
    for (long i = 0; i < a.rows; i += 1) {
        for (long j = 0; j < a.cols; j += 1) {
            out.cells[i][j] = a.cells[i][j] + b.cells[i][j];
        }
    }
    return out;
}

bool same(Matrix a, Matrix b) {
    if (a.rows != b.rows || a.cols != b.cols) {
        return false;
    }
    for (long i = 0; i < a.rows; i += 1) {
        for (long j = 0; j < a.cols; j += 1) {
            if (a.cells[i][j] != b.cells[i][j]) {
                return false;
            }
        }
    }
    return true;
}

string show(Matrix m) {
    return "Matrix(" + pystr(m.rows) + "x" + pystr(m.cols) + ", " + pystr(m.cells) + ")";
}
