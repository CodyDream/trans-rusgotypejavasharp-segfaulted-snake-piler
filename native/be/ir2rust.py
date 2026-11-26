#!/usr/bin/env python3
"""
ir2rust.py — Ouroboros native IR -> Rust (std::arch x86_64 SSE).

Emits a self-contained crate (src/main.rs + Cargo.toml + .cargo/config.toml).
Every IR simd op maps to a real SSE intrinsic — no scalar downscaling.
Lane access on the SIMD storage uses extract/insert (const-indexed when the
IR index is a literal, match-dispatch when runtime).

Usage: python3 ir2rust.py <ir.json> <out-dir>
Build: cargo build --manifest-path <out-dir>/Cargo.toml && run target/debug/<name>
"""

import sys
import json
import os

# ---------------------------------------------------------------------------
# IR type -> Rust type
# ---------------------------------------------------------------------------

def rust_ty(ty):
    k = ty["k"]
    if k == "f32": return "f32"
    if k == "f64": return "f64"
    if k == "i32": return "i32"
    if k == "u32": return "u32"
    if k == "bool": return "bool"
    if k == "void": return "()"
    if k == "cstr": return "&'static str"
    if k == "v128f": return "__m128"
    if k == "v128i": return "__m128i"
    if k == "cls": return ty["name"]
    if k == "ref":
        return f"{'&mut ' if ty['mut'] else '&'}{rust_ty(ty['to'])}"
    if k == "fbits": return "FBits"
    raise ValueError(k)

def slug_ty(ty):
    k = ty["k"]
    if k == "cls": return ty["name"]
    if k == "ref": return slug_ty(ty["to"])
    return k

def strip_sig(name):
    """op_add@Vec4 -> op_add_Vec4; ref sigs 'mut Float4' -> 'mut_Float4'."""
    return name.replace("@", "_").replace(" ", "_")

FLT_CONSTS = {
    "FLT_MIN": "1.1754943508222875e-38f32",
    "FLT_MAX": "3.4028234663852886e+38f32",
    "FLT_EPSILON": "1.1920928955078125e-07f32",
    "FLT_TRUE_MIN": "1.401298464324817e-45f32",
    "FLT_INFINITY": "f32::INFINITY",
}

def lit_expr(e):
    """IR literal -> Rust literal text."""
    sp = e["sp"]
    ty = e.get("ty")
    if ty == "f32":
        if sp in FLT_CONSTS:
            return FLT_CONSTS[sp]
        # Rust f32 literal: ensure a '.' and f32 suffix; handle exponents
        s = sp
        if s.endswith("f") or s.endswith("F"):
            s = s[:-1]
        if "." not in s and "e" not in s.lower():
            s = s + ".0"
        if s.startswith("."):
            s = "0" + s
        if s.startswith("-."):
            s = "-0" + s[1:]
        return s + "f32"
    if ty == "u32":
        s = sp.rstrip("uU")
        if s.lower().startswith("0x") or s.lower().startswith("0b"):
            return s + "u32"
        return s + "u32"
    if ty == "bool":
        return sp
    if ty == "i32":
        s = sp.rstrip("uUlL")
        if s.lower().startswith("0x") or s.lower().startswith("0b"):
            return s + "i32"
        return s + "i32"
    return sp


class RustBackend:
    def __init__(self, ir):
        self.ir = ir
        self.lines = []
        self.ctx_locals = {}
        self.emit_hdr()
        for cls in ir["classes"]:
            self.emit_class(cls)
        for fun in ir["funs"]:
            self.emit_fun(fun)

    # ------------------------------------------------------------------ output
    def out(self, s=""):
        self.lines.append(s)

    def emit_hdr(self):
        self.out("#![allow(non_snake_case, non_camel_case_types, unused_variables,")
        self.out("        dead_code, unused_unsafe, unused_mut, unused_parens)]")
        self.out("use std::arch::x86_64::*;")
        self.out("")
        # bitcast-union support (FBits pattern: float <-> u32 view, kept in sync)
        self.out("#[derive(Clone, Copy)]")
        self.out("pub struct FBits { pub f: f32, pub u: u32 }")
        self.out("")
        self.out("impl Default for FBits {")
        self.out("    fn default() -> Self { FBits { f: 0.0f32, u: 0u32 } }")
        self.out("}")
        self.out("")
        self.out("unsafe fn lane_set_f(v: __m128, idx: usize, x: f32) -> __m128 {")
        self.out("    let mut a = [0f32; 4];")
        self.out("    _mm_storeu_ps(a.as_mut_ptr(), v);")
        self.out("    a[idx] = x;")
        self.out("    _mm_loadu_ps(a.as_ptr())")
        self.out("}")
        self.out("")
        self.out("unsafe fn lane_set_u(v: __m128i, idx: usize, x: u32) -> __m128i {")
        self.out("    let mut a = [0u32; 4];")
        self.out("    _mm_storeu_si128(a.as_mut_ptr() as *mut __m128i, v);")
        self.out("    a[idx] = x;")
        self.out("    _mm_loadu_si128(a.as_ptr() as *const __m128i)")
        self.out("}")
        self.out("")
        self.out("unsafe fn lane_get_f(v: __m128, idx: usize) -> f32 {")
        self.out("    match idx {")
        self.out("        0 => f32::from_bits(_mm_extract_ps(v, 0) as u32),")
        self.out("        1 => f32::from_bits(_mm_extract_ps(v, 1) as u32),")
        self.out("        2 => f32::from_bits(_mm_extract_ps(v, 2) as u32),")
        self.out("        3 => f32::from_bits(_mm_extract_ps(v, 3) as u32),")
        self.out("        _ => 0.0f32,")
        self.out("    }")
        self.out("}")
        self.out("")
        self.out("unsafe fn lane_get_u(v: __m128i, idx: usize) -> u32 {")
        self.out("    match idx {")
        self.out("        0 => _mm_extract_epi32(v, 0) as u32,")
        self.out("        1 => _mm_extract_epi32(v, 1) as u32,")
        self.out("        2 => _mm_extract_epi32(v, 2) as u32,")
        self.out("        3 => _mm_extract_epi32(v, 3) as u32,")
        self.out("        _ => 0u32,")
        self.out("    }")
        self.out("}")
        self.out("")

    # ------------------------------------------------------------------ classes
    def emit_class(self, cls):
        name = cls["name"]
        lane = "__m128" if name in ("Vec3", "Vec4") else "__m128i"
        if name in ("Float3", "Float4"):
            self.out("#[derive(Clone, Copy, Default)]")
            flds = ", ".join(f"pub {f['name']}: f32" for f in cls["fields"])
            self.out(f"pub struct {name} {{ {flds} }}")
        else:
            self.out("#[derive(Clone, Copy)]")
            self.out(f"pub struct {name} {{ pub mValue: {lane} }}")
            self.out(f"impl Default for {name} {{")
            z = "_mm_setzero_ps()" if lane == "__m128" else "_mm_setzero_si128()"
            self.out(f"    fn default() -> Self {{ unsafe {{ {name} {{ mValue: {z} }} }} }}")
            self.out("}")
        self.out("")
        self.out(f"impl {name} {{")
        for m in cls["methods"]:
            self.emit_method(m)
        self.out("}")
        self.out("")

    def is_mutator(self, m):
        """Non-static void methods that write through self need &mut self."""
        if m.get("static") or m["ret"]["k"] != "void" or m.get("ctor"):
            return False
        found = [False]
        def walk(x):
            if isinstance(x, dict):
                if x.get("k") == "assign":
                    t = x["target"]
                    if t.get("k") == "this":
                        found[0] = True
                    elif t.get("k") == "field":
                        o = t["obj"]
                        if o.get("k") == "this":
                            found[0] = True
                        elif o.get("k") == "deref" and o["e"].get("k") == "this":
                            found[0] = True
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(m["body"])
        return found[0]

    def emit_method(self, m):
        name = strip_sig(m["name"])
        is_ctor = m.get("ctor", False)
        params = []
        for p in m["params"]:
            if p["name"] == "self" and not is_ctor:
                params.append("&mut self" if self.is_mutator(m) else "self")
            elif p["name"] == "self":
                continue      # ctor 'this' becomes a local
            else:
                params.append(f"mut {p['name']}: {rust_ty(p['ty'])}")
        ret = m["ret"]
        ret_s = "" if ret["k"] == "void" else f" -> {rust_ty(ret)}"
        self.out(f"    pub unsafe fn {name}({', '.join(params)}){ret_s} {{")
        if is_ctor:
            self.out(f"        let mut __this: {m['cls']} = {m['cls']}::default();")
        self.ctx_locals = {p["name"]: p["ty"] for p in m["params"] if p["name"] != "self"}
        for s in m["body"]:
            try:
                for line in self.stmt(s, m):
                    self.out("        " + line)
            except Exception as ex:
                raise RuntimeError(f"method {m['origin']} stmt {json.dumps(s)[:200]}: {ex}") from ex
        if is_ctor:
            self.out("        __this")
        self.out("    }")
        self.out("")

    def emit_fun(self, f):
        name = f["name"]
        params = ", ".join(
            f"mut {p['name']}: {rust_ty(p['ty'])}" if p["ty"]["k"] != "ref" else
            f"{p['name']}: {rust_ty(p['ty'])}"
            for p in f["params"])
        if name == "main":
            self.out("fn main() {")
            self.out("    unsafe { Battery(); }")
            self.out("}")
            self.out("")
            return
        ret_s = "" if f["ret"]["k"] == "void" else f" -> {rust_ty(f['ret'])}"
        self.ctx_locals = {p["name"]: p["ty"] for p in f["params"]}
        self.out(f"pub unsafe fn {name}({params}){ret_s} {{")
        for s in f["body"]:
            for line in self.stmt(s, None):
                self.out("    " + line)
        self.out("}")
        self.out("")

    # ------------------------------------------------------------------ exprs
    def expr(self, e, ctx):
        k = e["k"]
        if k == "lit":
            if e.get("sp") == "nan":
                return "f32::NAN"
            return lit_expr(e)
        if k == "str":
            return json.dumps(e["v"])
        if k == "var":
            return e["name"]
        if k == "this":
            if ctx.get("ctor"):
                return "__this"
            return "self"
        if k == "deref":
            inner = self.expr(e["e"], ctx)
            if inner == "self":
                return "self"
            return f"(*{inner})"
        if k == "ref":
            return f"&mut {self.expr(e['e'], ctx)}"
        if k == "field":
            obj = self.expr(e["obj"], ctx)
            if obj == "self":
                return f"self.{e['name']}"
            return f"{obj}.{e['name']}"
        if k == "bitsget":
            return f"{e['var']}.{e['side']}"
        if k == "lane_get":
            lanes = self.expr(e["lanes"], ctx)
            idx = e["idx"]
            is_i = self.lanes_is_int(e["lanes"], ctx)
            if idx.get("k") == "lit":
                n = int(idx["sp"].rstrip("ul"))
                if is_i:
                    return f"_mm_extract_epi32({lanes}, {n}) as u32"
                return f"f32::from_bits(_mm_extract_ps({lanes}, {n}) as u32)"
            fn = "lane_get_u" if is_i else "lane_get_f"
            return f"{fn}({lanes}, ({self.expr(idx, ctx)}) as usize)"
        if k == "lane_set":
            lanes = self.expr(e["lanes"], ctx)
            fn = "lane_set_u" if self.lanes_is_int(e["lanes"], ctx) else "lane_set_f"
            return f"{fn}({lanes}, ({self.expr(e['idx'], ctx)}) as usize, {self.expr(e['v'], ctx)})"
        if k == "bin":
            l = self.expr(e["l"], ctx)
            r = self.expr(e["r"], ctx)
            ty = e.get("ty") or {}
            # C++ arithmetic promotion: mixed operands convert to result type
            if ty.get("k") in ("i32", "u32") and \
               e["op"] in ("&", "|", "^", "<<", ">>", "+", "-", "*", "/", "%"):
                lt = self.ir_expr_type(e["l"], ctx)
                rt = self.ir_expr_type(e["r"], ctx)
                ts = "i32" if ty["k"] == "i32" else "u32"
                if not lt or lt.get("k") != ty["k"]:
                    l = f"({l} as {ts})"
                if not rt or rt.get("k") != ty["k"]:
                    r = f"({r} as {ts})"
            if ty.get("k") == "f32" and e["op"] in ("+", "-", "*", "/"):
                lt = self.ir_expr_type(e["l"], ctx)
                rt = self.ir_expr_type(e["r"], ctx)
                if not lt or lt.get("k") != "f32":
                    l = f"({l} as f32)"
                if not rt or rt.get("k") != "f32":
                    r = f"({r} as f32)"
            return f"({l} {e['op']} {r})"
        if k == "un":
            return f"({e['op']}{self.expr(e['e'], ctx)})"
        if k == "sel":
            c = self.expr(e["cond"], ctx)
            t = self.expr(e["then"], ctx)
            f = self.expr(e["els"], ctx)
            return f"(if {c} {{ {t} }} else {{ {f} }})"
        if k == "copy":
            return self.expr(e["e"], ctx)
        if k == "ctor":
            # implicit copy-ctor call (by-value args): pure value copy
            if len(e["args"]) == 1:
                at = self.arg_ty(e["args"][0], ctx)
                if at["k"] == "cls" and at["name"] == e["cls"]:
                    return self.expr(e["args"][0], ctx)
            slug = "_".join(slug_ty(self.arg_ty(a, ctx)) for a in e["args"]) or "default"
            fname = f"ctor_{slug}"
            args = ", ".join(self.expr(a, ctx) for a in e["args"])
            return f"{e['cls']}::{fname}({args})"
        if k == "call":
            sig = self.method_sig(e.get("cls"), e["name"]) if e.get("cls") else None
            args = ", ".join(self.cast_args(e["args"], sig, ctx))
            if e.get("cls"):
                return f"{e['cls']}::{strip_sig(e['name'])}({args})"
            return f"{e['name']}({args})"
        if k == "meth":
            obj = self.expr(e["obj"], ctx)
            sig = self.method_sig(e.get("cls"), e["name"])
            args = ", ".join(self.cast_args(e["args"], sig, ctx))
            recv = "self" if obj == "self" else obj
            return f"{recv}.{strip_sig(e['name'])}({args})"
        if k == "cast":
            if e["to"]["k"] == "void":
                return "()"      # discarded-value cast (JPH_ASSERT remnants)
            return f"({self.expr(e['e'], ctx)} as {rust_ty(e['to'])})"
        if k == "arrlit":
            return "[" + ", ".join(self.expr(x, ctx) for x in e["elems"]) + "]"
        if k == "simd":
            return self.simd(e, ctx)
        if k == "intrinsic":
            a = self.expr(e["args"][0], ctx)
            n = e["name"]
            if n == "abs": return f"{a}.abs()"
            if n == "sqrt": return f"{a}.sqrt()"
            if n == "is_nan": return f"{a}.is_nan()"
            if n == "signbit": return f"{a}.is_sign_negative()"
            if n == "ctz": return f"({a} as u32).trailing_zeros() as i32"
            if n == "popcnt": return f"({a} as u32).count_ones() as i32"
        raise ValueError(f"expr kind {k}")

    def method_sig(self, cls, name):
        for c in self.ir["classes"]:
            if c["name"] == cls:
                for m in c["methods"]:
                    if m["name"] == name:
                        return m["params"]
        return None

    def cast_args(self, args, sig, ctx):
        """C++ implicit conversions: u32 -> f32 etc. at call boundaries."""
        if not sig:
            return [self.expr(a, ctx) for a in args]
        out = []
        for i, a in enumerate(args):
            e = self.expr(a, ctx)
            if i < len(sig):
                want = sig[i]["ty"]["k"]
                got = self.ir_expr_type(a, ctx)
                if want in ("f32", "i32", "u32") and got and got.get("k") != want \
                   and got.get("k") in ("f32", "i32", "u32") and got.get("k") != "cls":
                    e = f"({e} as {want})"
            out.append(e)
        return out

    def arg_ty(self, a, ctx):
        t = self.ir_expr_type(a, ctx)
        return t if t else {"k": "f32"}

    def ir_expr_type(self, e, ctx):
        k = e.get("k")
        if k == "lit": return {"k": e.get("ty", "i32")}
        if k == "var": return self.ctx_locals.get(e["name"]) or ctx.get("locals", {}).get(e["name"], {"k": "f32"})
        if k == "this": return {"k": "cls", "name": ctx.get("cls", "Vec4")}
        if k == "field":
            ot = self.ir_expr_type(e["obj"], ctx)
            if ot and ot["k"] == "cls":
                for c in self.ir["classes"]:
                    if c["name"] == ot["name"]:
                        for f in c["fields"]:
                            if f["name"] == e["name"]:
                                return f["ty"]
            return {"k": "f32"}
        if k == "copy": return self.ir_expr_type(e["e"], ctx)
        if k == "deref":
            it = self.ir_expr_type(e["e"], ctx)
            if it and it["k"] == "ref":
                return it["to"]
            return it
        if k == "ref":
            it = self.ir_expr_type(e["e"], ctx)
            return {"k": "ref", "to": it, "mut": True} if it else None
        if k == "ctor": return {"k": "cls", "name": e["cls"]}
        if k == "call": return e.get("ret") or {"k": "f32"}
        if k == "meth": return e.get("ret") or {"k": "f32"}
        if k == "simd": return e.get("ty") or {"k": "v128f"}
        if k == "bin": return e.get("ty") or {"k": "f32"}
        if k == "un": return e.get("ty") or {"k": "f32"}
        if k == "sel": return e.get("ty") or {"k": "f32"}
        if k == "lane_get": return {"k": "f32"}
        if k == "deref":
            it = self.ir_expr_type(e["e"], ctx)
            return it.get("to") if it and it.get("k") == "ref" else None
        if k == "bitsget": return {"k": "f32" if e["side"] == "f" else "u32"}
        return {"k": "f32"}

    def lanes_is_int(self, lanes, ctx):
        t = self.ir_expr_type(lanes, ctx)
        if t and t["k"] == "field":
            return True  # mValue of UVec4 — check owner
        if t and t["k"] == "v128i":
            return True
        # UVec4's mValue is v128i
        if t and t["k"] == "cls" and t["name"] == "UVec4":
            return True
        if t and t["k"] == "cls":
            for c in self.ir["classes"]:
                if c["name"] == t["name"]:
                    for f in c["fields"]:
                        if f["name"] == "mValue":
                            return f["ty"]["k"] == "v128i"
        return False

    def simd(self, e, ctx):
        name = e["name"]
        imm = e.get("imm")
        a = [self.expr(x, ctx) for x in e["args"]]
        if name == "blendv":
            return f"_mm_blendv_ps({a[0]}, {a[1]}, {a[2]})"
        if name == "shuffle":
            return f"_mm_shuffle_ps({a[0]}, {a[1]}, {imm})"
        if name == "shufflei":
            return f"_mm_shuffle_epi32({a[0]}, {imm})"
        if name == "insert":
            return f"_mm_insert_ps({a[0]}, {a[1]}, {imm})"
        if name == "blend_ps":
            return f"_mm_blend_ps({a[0]}, {a[1]}, {imm})"
        if name == "srai":
            return f"_mm_srai_epi32({a[0]}, {imm if imm is not None else a[1]})"
        if name in ("slli", "srli"):
            i = imm if imm is not None else a[1]
            f = "_mm_slli_epi32" if name == "slli" else "_mm_srli_epi32"
            return f"{f}({a[0]}, {i})"
        two = {"fadd": "_mm_add_ps", "fsub": "_mm_sub_ps", "fmul": "_mm_mul_ps",
               "fdiv": "_mm_div_ps", "fmin": "_mm_min_ps", "fmax": "_mm_max_ps",
               "fbitand": "_mm_and_ps", "fbitor": "_mm_or_ps", "fbitxor": "_mm_xor_ps",
               "fbitandnot": "_mm_andnot_ps",
               "fcmp_unord": "_mm_cmpunord_ps", "fcmp_eq": "_mm_cmpeq_ps",
               "fcmp_ne": "_mm_cmpneq_ps", "fcmp_lt": "_mm_cmplt_ps",
               "fcmp_gt": "_mm_cmpgt_ps", "fcmp_le": "_mm_cmple_ps",
               "fcmp_ge": "_mm_cmpge_ps",
               "unpacklo": "_mm_unpacklo_ps", "unpackhi": "_mm_unpackhi_ps",
               "movehl": "_mm_movehl_ps", "movelh": "_mm_movelh_ps",
               "hadd": "_mm_hadd_ps",
               "iadd": "_mm_add_epi32", "isub": "_mm_sub_epi32",
               "imin": "_mm_min_epi32", "imax": "_mm_max_epi32",
               "umin": "_mm_min_epu32", "umax": "_mm_max_epu32",
               "iunpacklo": "_mm_unpacklo_epi16", "iunpackhi": "_mm_unpackhi_epi16",
               "ishuffle": "_mm_shuffle_epi8",
               "ibitand": "_mm_and_si128", "ibitor": "_mm_or_si128",
               "ibitxor": "_mm_xor_si128", "ibitandnot": "_mm_andnot_si128",
               "icmp_eq": "_mm_cmpeq_epi32", "icmp_gt": "_mm_cmpgt_epi32",
               "icmp_lt": "_mm_cmplt_epi32", "imullo": "_mm_mullo_epi32"}
        one = {"splatf": None, "load_ss": "_mm_load_ss", "load": "_mm_loadu_ps",
               "movehdup": "_mm_movehdup_ps", "moveldup": "_mm_moveldup_ps",
               "cvtss": "_mm_cvtss_f32", "cvttps": "_mm_cvttps_epi32",
               "sqrtf4": "_mm_sqrt_ps", "i2f": "_mm_cvtepi32_ps",
               "bitcast_i": "_mm_castps_si128", "bitcast_f": "_mm_castsi128_ps",
               "movemask": "_mm_movemask_ps", "sqrtss": "_mm_sqrt_ss",
               "addss": "_mm_add_ss", "subss": "_mm_sub_ss",
               "mulss": "_mm_mul_ss", "divss": "_mm_div_ss",
               "cvt32": "_mm_cvtsi128_si32"}
        if name in two:
            return f"{two[name]}({a[0]}, {a[1]})"
        if name in one and one[name]:
            return f"{one[name]}({a[0]})"
        if name == "splatf":
            return f"_mm_set1_ps({a[0]})"
        if name == "splatu":
            return f"_mm_set1_epi32({a[0]} as i32)"
        if name == "zerof":
            return "_mm_setzero_ps()"
        if name == "zeroi":
            return "_mm_setzero_si128()"
        if name == "setss":
            return f"_mm_set_ss({a[0]})"
        if name == "set4":
            return f"_mm_setr_ps({', '.join(a)})"
        if name == "set4u":
            return f"_mm_setr_epi32({', '.join(str(x) + ' as i32' if '0x' not in x and 'u32' not in x else x for x in a)})"
        if name == "store":
            return f"_mm_storeu_ps({a[0]} as *mut f32, {a[1]})"
        if name == "store_ss":
            return f"_mm_store_ss({a[0]} as *mut f32, {a[1]})"
        raise ValueError(f"simd op {name}")

    # ------------------------------------------------------------------ stmts
    def stmt(self, s, m, indent_ctx=None):
        ctx = m or {"locals": {}, "cls": None}
        k = s["k"]
        if k == "let":
            ty = s.get("ty")
            self.ctx_locals[s["name"]] = ty
            init = s.get("init")
            cast_wrap = ""
            if init is not None and ty is not None and ty["k"] in ("i32", "u32", "f32"):
                it = self.ir_expr_type(init, ctx)
                if it and it.get("k") != ty["k"] and it.get("k") in ("i32", "u32", "f32", "cstr"):
                    if not (ty["k"] == "f32" and it["k"] == "f32"):
                        cast_wrap = f" as {ty['k']}"
            if init is None:
                if ty and ty["k"] == "fbits":
                    return [f"let mut {s['name']}: FBits = FBits::default();"]
                return [f"let mut {s['name']}: {rust_ty(ty)} = {rust_ty(ty)}::default();"]
            if init.get("k") == "copy":
                return [f"let mut {s['name']}: {rust_ty(ty)} = {self.expr(init['e'], ctx)};"]
            return [f"let mut {s['name']}: {rust_ty(ty)} = ({self.expr(init, ctx)}){cast_wrap};"]
        if k == "assign":
            target = s["target"]
            value = self.expr(s["value"], ctx)
            if target.get("k") == "this":
                cls = target.get("cls") or (m["cls"] if m else None)
                recv = "__this" if (m and m.get("ctor")) else "self"
                lines = []
                for c in self.ir["classes"]:
                    if c["name"] == cls:
                        for f in c["fields"]:
                            lines.append(f"{recv}.{f['name']} = {value}.{f['name']};")
                return lines or [f"{recv} = {value};"]
            return [f"{self.expr(target, ctx)} = {value};"]
        if k == "expr":
            return [f"{self.expr(s['e'], ctx)};"]
        if k == "emit":
            kind = s["kind"]
            if kind == "endln":
                return ["println!();"]
            if kind == "hex32":
                return [f'print!("{{:08x}}", {self.expr(s["e"], ctx)});']
            if kind == "u32":
                return [f'print!("{{}}", {self.expr(s["e"], ctx)});']
            if kind == "str":
                if "v" in s:
                    return [f'print!("{{}}", {json.dumps(s["v"])});']
                return [f'print!("{{}}", {self.expr(s["e"], ctx)});']
        if k == "emitseq":
            lines = []
            for sub in s["seq"]:
                lines.extend(self.stmt(sub, m))
            return lines
        if k == "return":
            if s.get("e") is None:
                return ["return;"]
            return [f"return {self.expr(s['e'], ctx)};"]
        if k == "if":
            cond = self.expr(s["cond"], ctx)
            lines = [f"if {cond} {{"]
            for sub in s["then"]:
                lines.extend("    " + l for l in self.stmt(sub, m))
            if s["els"]:
                lines.append("} else {")
                for sub in s["els"]:
                    lines.extend("    " + l for l in self.stmt(sub, m))
            lines.append("}")
            return lines
        if k == "for":
            var = s["var"]
            start = self.expr(s["start"], ctx)
            stop = self.expr(s["stop"], ctx)
            lines = [f"for {var} in ({start})..({stop}) {{"]
            for sub in s["body"]:
                lines.extend("    " + l for l in self.stmt(sub, m))
            lines.append("}")
            return lines
        if k == "while":
            cond = self.expr(s["cond"], ctx)
            lines = [f"while {cond} {{"]
            for sub in s["body"]:
                lines.extend("    " + l for l in self.stmt(sub, m))
            lines.append("}")
            return lines
        if k == "compound":
            # built-in compound assignment (scalars / fields)
            value = {"k": "bin", "op": s["op"], "l": s["target"], "r": s["rhs"],
                     "ty": s.get("ty")}
            return self.stmt({"k": "assign", "target": s["target"], "value": value}, m)
        raise ValueError(f"stmt kind {k}")

    def render(self):
        return "\n".join(self.lines) + "\n"


def main():
    ir_path, out_dir = sys.argv[1], sys.argv[2]
    with open(ir_path) as f:
        ir = json.load(f)
    b = RustBackend(ir)
    os.makedirs(os.path.join(out_dir, "src"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, ".cargo"), exist_ok=True)
    with open(os.path.join(out_dir, "src", "main.rs"), "w") as f:
        f.write(b.render())
    with open(os.path.join(out_dir, "Cargo.toml"), "w") as f:
        f.write("[package]\nname = \"jolt_math_rs\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n")
        f.write("[dependencies]\n\n[profile.dev]\nopt-level = 2\n")
    with open(os.path.join(out_dir, ".cargo", "config.toml"), "w") as f:
        f.write("[build]\nrustflags = [\"-C\", \"target-feature=+sse2,+sse3,+sse4.1\"]\n")
    print(f"RUST OK: {len(b.lines)} lines -> {out_dir}/src/main.rs")


if __name__ == "__main__":
    main()
