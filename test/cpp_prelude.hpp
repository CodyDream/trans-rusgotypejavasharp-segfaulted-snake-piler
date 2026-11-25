// test/cpp_prelude.hpp — the v1 C++ dialect prelude (oracle header).
// Pure-std C++17; the dialect files compile with `g++ -include` this header.
// The C++ backend (when built) must emit this same code inside
// //<ouro-prelude> — keep the two in sync.
#pragma once

#include <string>
#include <vector>
#include <utility>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <stdexcept>

using std::string;
using std::vector;

// ---- PyDict<V>: insertion-ordered dict (linear scan; demo sizes) ----------
template<class V>
class PyDict {
public:
    vector<std::pair<string, V>> entries;
    bool has(const string& k) const {
        for (const auto& kv : entries) if (kv.first == k) return true;
        return false;
    }
    V get(const string& k, V def) const {
        for (const auto& kv : entries) if (kv.first == k) return kv.second;
        return def;
    }
    V index(const string& k) const {
        for (const auto& kv : entries) if (kv.first == k) return kv.second;
        throw std::runtime_error("KeyError: " + k);
    }
    void set(const string& k, V v) {
        for (auto& kv : entries) if (kv.first == k) { kv.second = v; return; }
        entries.push_back({k, v});
    }
    V pop(const string& k) {
        for (size_t i = 0; i < entries.size(); i++) {
            if (entries[i].first == k) {
                V v = entries[i].second;
                entries.erase(entries.begin() + static_cast<long>(i));
                return v;
            }
        }
        throw std::runtime_error("KeyError: " + k);
    }
    vector<string> keys() const {
        vector<string> ks;
        for (const auto& kv : entries) ks.push_back(kv.first);
        return ks;
    }
    vector<V> values() const {
        vector<V> vs;
        for (const auto& kv : entries) vs.push_back(kv.second);
        return vs;
    }
    long size() const { return static_cast<long>(entries.size()); }
};

// ---- float formatting (Python str(): 2.0 -> "2.0", whole and < 1e15) ------
inline string pyfloat_str(double d) {
    char buf[64];
    if (std::isnan(d)) return "nan";
    if (std::isinf(d)) return d > 0 ? "inf" : "-inf";
    if (d == std::floor(d) && std::fabs(d) < 1e15) {
        std::snprintf(buf, sizeof(buf), "%.1f", d);
        return string(buf);
    }
    std::snprintf(buf, sizeof(buf), "%.17g", d);
    return string(buf);
}

// ---- pyrepr (quotes strings) / pystr (plain) ------------------------------
inline string pyrepr(const string& s) { return "'" + s + "'"; }
inline string pyrepr(bool b) { return b ? "True" : "False"; }
inline string pyrepr(long v) { return std::to_string(v); }
inline string pyrepr(double d) { return pyfloat_str(d); }

template<class T>
string pyrepr(const vector<T>& xs) {
    string out = "[";
    for (size_t i = 0; i < xs.size(); i++) {
        if (i) out += ", ";
        out += pyrepr(xs[i]);
    }
    return out + "]";
}

template<class V>
string pyrepr(const PyDict<V>& d) {
    string out = "{";
    for (size_t i = 0; i < d.entries.size(); i++) {
        if (i) out += ", ";
        out += pyrepr(d.entries[i].first) + ": " + pyrepr(d.entries[i].second);
    }
    return out + "}";
}

inline string pystr(const string& s) { return s; }
template<class T> string pystr(const T& x) { return pyrepr(x); }

// ---- print: space-joined args + newline -----------------------------------
inline void print() { std::cout << "\n"; }
template<class T, class... Rest>
void print(const T& head, const Rest&... rest) {
    std::cout << pystr(head);
    if (sizeof...(rest) > 0) { std::cout << ' '; print(rest...); }
    else std::cout << "\n";
}

// ---- len -------------------------------------------------------------------
inline long len(const string& s) { return static_cast<long>(s.size()); }
template<class T> long len(const vector<T>& xs) { return static_cast<long>(xs.size()); }
template<class V> long len(const PyDict<V>& d) { return static_cast<long>(d.entries.size()); }

// ---- arithmetic with Python floor semantics --------------------------------
inline long idiv(long a, long b) {
    if (b == 0) throw std::runtime_error("division by zero");
    long q = a / b;
    if (a % b != 0 && (a < 0) != (b < 0)) q -= 1;   // Python floors
    return q;
}
inline long imod(long a, long b) {
    if (b == 0) throw std::runtime_error("modulo by zero");
    return ((a % b) + b) % b;   // result takes the divisor's sign
}

// ---- membership ------------------------------------------------------------
inline bool pyin(const string& x, const string& s) { return s.find(x) != string::npos; }
template<class T> bool pyin(const T& x, const vector<T>& xs) {
    for (const auto& e : xs) if (e == x) return true;
    return false;
}
template<class V> bool pyin(const string& k, const PyDict<V>& d) { return d.has(k); }
template<class... A> bool pynotin(const A&... a) { return !pyin(a...); }

// ---- string helpers --------------------------------------------------------
inline vector<string> pysplit(const string& s, const string& sep) {
    if (sep.empty()) throw std::runtime_error("ValueError: empty separator");
    vector<string> parts;
    size_t i = 0;
    for (;;) {
        size_t j = s.find(sep, i);
        if (j == string::npos) { parts.push_back(s.substr(i)); return parts; }
        parts.push_back(s.substr(i, j - i));
        i = j + sep.size();
    }
}
inline string pyjoin(const string& sep, const vector<string>& xs) {
    string out;
    for (size_t i = 0; i < xs.size(); i++) { if (i) out += sep; out += xs[i]; }
    return out;
}
inline string pyupper(const string& s) {
    string out = s;
    for (char& c : out) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return out;
}
inline string pylower(const string& s) {
    string out = s;
    for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}
inline string pystrip(const string& s) {
    const char* ws = " \t\n\r\f\v";
    size_t a = s.find_first_not_of(ws);
    if (a == string::npos) return "";
    size_t b = s.find_last_not_of(ws);
    return s.substr(a, b - a + 1);
}
inline string pyreplace(const string& s, const string& a, const string& b) {
    if (a.empty()) {   // Python inserts between every char (and at both ends)
        string out;
        for (char c : s) { out += b; out += c; }
        out += b;
        return out;
    }
    string out;
    size_t i = 0;
    for (;;) {
        size_t j = s.find(a, i);
        if (j == string::npos) { out += s.substr(i); return out; }
        out += s.substr(i, j - i) + b;
        i = j + a.size();
    }
}
inline bool pystartswith(const string& s, const string& p) { return s.rfind(p, 0) == 0; }
inline bool pyendswith(const string& s, const string& p) {
    if (p.size() > s.size()) return false;
    return s.compare(s.size() - p.size(), p.size(), p) == 0;
}
inline bool pyisdigit(const string& s) {
    if (s.empty()) return false;
    for (char c : s) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    return true;
}
inline long pystr_find(const string& s, const string& n) {
    size_t p = s.find(n);
    return p == string::npos ? -1 : static_cast<long>(p);
}

// ---- list helpers -----------------------------------------------------------
template<class T> void pysort(vector<T>& xs) { std::sort(xs.begin(), xs.end()); }
template<class T> void pyreverse(vector<T>& xs) { std::reverse(xs.begin(), xs.end()); }
template<class T> T pypop(vector<T>& xs) {
    if (xs.empty()) throw std::runtime_error("IndexError: pop from empty list");
    T v = xs.back();
    xs.pop_back();
    return v;
}
template<class T> long pylist_index(const vector<T>& xs, const T& v) {
    for (size_t i = 0; i < xs.size(); i++) if (xs[i] == v) return static_cast<long>(i);
    return -1;
}

// ---- conversions ------------------------------------------------------------
inline long pyint(const string& s) {
    string t = pystrip(s);
    try {
        size_t pos = 0;
        long v = std::stol(t, &pos);
        if (pos != t.size()) throw std::invalid_argument("trailing");
        return v;
    } catch (...) {
        throw std::runtime_error("ValueError: int() invalid literal for '" + s + "'");
    }
}
inline long pyint(double d) { return static_cast<long>(d); }   // truncate toward zero
inline long pyint(bool b) { return b ? 1 : 0; }
inline long pyint(long v) { return v; }
inline double pyfloat(const string& s) {
    string t = pystrip(s);
    try {
        size_t pos = 0;
        double v = std::stod(t, &pos);
        if (pos != t.size()) throw std::invalid_argument("trailing");
        return v;
    } catch (...) {
        throw std::runtime_error("ValueError: float() invalid literal for '" + s + "'");
    }
}
inline double pyfloat(long v) { return static_cast<double>(v); }
inline double pyfloat(bool b) { return b ? 1.0 : 0.0; }
inline double pyfloat(double v) { return v; }
