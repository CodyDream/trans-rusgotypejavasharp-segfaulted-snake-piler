#!/usr/bin/env python3
"""
fe_clang.py — Clang AST -> Ouroboros native IR (JSON). SIMD-first design.

Parses the battery TU (which includes the REAL Jolt math headers, SSE path)
with libclang and lowers the supported subset to a bit-exact, language-neutral
IR. SSE intrinsics (_mm_*) are mapped through an explicit intrinsic table to
IR simd ops — backends emit native SIMD (C# Vector128, Rust std::arch SSE).
Everything not lowerable is loudly reported — never silently dropped.

IR types: f32 i32 u32 bool void cstr fbits v128f v128i cls{name} ref{to,mut}

Usage:
  PYTHONPATH=tools/pylibs python3 fe_clang.py <battery.cpp> <incdir> <out-ir.json> <out-report.txt>
"""

import sys
import os
import json
from clang import cindex

# ---------------------------------------------------------------------------
# IR types
# ---------------------------------------------------------------------------

def t(name):                       # primitive / lane / special type
    return {"k": name}

def t_cls(name):
    return {"k": "cls", "name": name}

def t_ref(to, mut):
    return {"k": "ref", "to": to, "mut": mut}

def ty_show(ty):
    k = ty["k"]
    if k == "cls": return ty["name"]
    if k == "ref": return ("mut " if ty["mut"] else "const ") + ty_show(ty["to"])
    return k

TARGET_CLASSES = {"Vec4", "Vec3", "UVec4", "Float3", "Float4"}

# Vec3::Type = Vec4::Type = __m128 ; UVec4::Type = __m128i  (SSE path)
TYPE_ALIAS = {"Vec3": "v128f", "Vec4": "v128f", "UVec4": "v128i"}

# ---------------------------------------------------------------------------
# SSE intrinsic -> IR simd op mapping table
# ---------------------------------------------------------------------------

SSE_TABLE = {
    "_mm_add_ps":      ("fadd", 2, "v128f"),
    "_mm_sub_ps":      ("fsub", 2, "v128f"),
    "_mm_mul_ps":      ("fmul", 2, "v128f"),
    "_mm_div_ps":      ("fdiv", 2, "v128f"),
    "_mm_min_ps":      ("fmin", 2, "v128f"),
    "_mm_max_ps":      ("fmax", 2, "v128f"),
    "_mm_and_ps":      ("fbitand", 2, "v128f"),
    "_mm_or_ps":       ("fbitor", 2, "v128f"),
    "_mm_xor_ps":      ("fbitxor", 2, "v128f"),
    "_mm_andnot_ps":   ("fbitandnot", 2, "v128f"),
    "_mm_set1_ps":     ("splatf", 1, "v128f"),
    "_mm_setzero_ps":  ("zerof", 0, "v128f"),
    "_mm_set_ss":      ("setss", 1, "v128f"),
    "_mm_load_ss":     ("load_ss", 1, "v128f"),
    "_mm_loadu_ps":    ("load", 1, "v128f"),
    "_mm_load_ps":     ("load", 1, "v128f"),
    "_mm_storeu_ps":   ("store", 2, "void"),
    "_mm_unpacklo_ps": ("unpacklo", 2, "v128f"),
    "_mm_unpackhi_ps": ("unpackhi", 2, "v128f"),
    "_mm_shuffle_ps":  ("shuffle", 3, "v128f"),
    "_mm_movehdup_ps": ("movehdup", 1, "v128f"),
    "_mm_moveldup_ps": ("moveldup", 1, "v128f"),
    "_mm_movehl_ps":   ("movehl", 2, "v128f"),
    "_mm_hadd_ps":     ("hadd", 2, "v128f"),
    "_mm_cvtss_f32":   ("cvtss", 1, "f32"),
    "_mm_cvttps_epi32": ("cvttps", 1, "v128i"),
    "_mm_sqrt_ps":     ("sqrtf4", 1, "v128f"),
    "_mm_cvtepi32_ps": ("i2f", 1, "v128f"),
    "_mm_shuffle_epi32": ("shufflei", 2, "v128i"),
    "_mm_srai_epi32":  ("srai", 2, "v128i"),
    "_mm_mullo_epi32": ("imullo", 2, "v128i"),
    "_mm_store_ss":    ("store_ss", 2, "void"),
    "_mm_movelh_ps":   ("movelh", 2, "v128f"),
    "_mm_sqrt_ss":     ("sqrtss", 1, "v128f"),
    "_mm_add_ss":      ("addss", 2, "v128f"),
    "_mm_sub_ss":      ("subss", 2, "v128f"),
    "_mm_mul_ss":      ("mulss", 2, "v128f"),
    "_mm_div_ss":      ("divss", 2, "v128f"),
    "_mm_cmpunord_ps": ("fcmp_unord", 2, "v128f"),
    "_mm_cmpeq_ps":    ("fcmp_eq", 2, "v128f"),
    "_mm_cmpneq_ps":   ("fcmp_ne", 2, "v128f"),
    "_mm_cmplt_ps":    ("fcmp_lt", 2, "v128f"),
    "_mm_cmpgt_ps":    ("fcmp_gt", 2, "v128f"),
    "_mm_cmple_ps":    ("fcmp_le", 2, "v128f"),
    "_mm_cmpge_ps":    ("fcmp_ge", 2, "v128f"),
    "_mm_castps_si128": ("bitcast_i", 1, "v128i"),
    "_mm_castsi128_ps": ("bitcast_f", 1, "v128f"),
    "_mm_movemask_ps": ("movemask", 1, "i32"),
    "_mm_insert_ps":   ("insert", 3, "v128f"),
    "_mm_extract_ps":  ("extract", 2, "i32"),
    "_mm_blendv_ps":   ("blendv", 3, "v128f"),
    "_mm_add_epi32":   ("iadd", 2, "v128i"),
    "_mm_sub_epi32":   ("isub", 2, "v128i"),
    "_mm_min_epi32":   ("imin", 2, "v128i"),
    "_mm_max_epi32":   ("imax", 2, "v128i"),
    "_mm_min_epu32":   ("umin", 2, "v128i"),
    "_mm_max_epu32":   ("umax", 2, "v128i"),
    "_mm_and_si128":   ("ibitand", 2, "v128i"),
    "_mm_or_si128":    ("ibitor", 2, "v128i"),
    "_mm_xor_si128":   ("ibitxor", 2, "v128i"),
    "_mm_andnot_si128": ("ibitandnot", 2, "v128i"),
    "_mm_set1_epi32":  ("splatu", 1, "v128i"),
    "_mm_setzero_si128": ("zeroi", 0, "v128i"),
    "_mm_set_epi32":   ("set4u", 4, "v128i"),
    "_mm_setr_epi32":  ("set4u", 4, "v128i"),
    "_mm_setr_ps":     ("set4", 4, "v128f"),
    "_mm_set_ps":      ("set4", 4, "v128f"),
    "_mm_cmpeq_epi32": ("icmp_eq", 2, "v128i"),
    "_mm_cmpgt_epi32": ("icmp_gt", 2, "v128i"),
    "_mm_cmplt_epi32": ("icmp_lt", 2, "v128i"),
    "_mm_slli_epi32":  ("slli", 2, "v128i"),
    "_mm_srli_epi32":  ("srli", 2, "v128i"),
    "_mm_unpacklo_epi16": ("iunpacklo", 2, "v128i"),
    "_mm_unpackhi_epi16": ("iunpackhi", 2, "v128i"),
    "_mm_shuffle_epi8": ("ishuffle", 2, "v128i"),
    "_mm_cvtsi128_si32": ("cvt32", 1, "i32"),
}

OPMAP = {"operator+": "op_add", "operator-": "op_sub", "operator*": "op_mul",
         "operator/": "op_div", "operator==": "op_eq", "operator!=": "op_ne",
         "operator[]": "op_index", "operator+=": "op_iadd", "operator-=": "op_isub",
         "operator*=": "op_imul", "operator/=": "op_idiv", "operator=": "op_assign"}

GXX_INCLUDES = [
    "/usr/include/c++/14",
    "/usr/include/x86_64-linux-gnu/c++/14",
    "/usr/include/c++/14/backward",
    "/usr/lib/gcc/x86_64-linux-gnu/14/include",
    "/usr/local/include",
    "/usr/include/x86_64-linux-gnu",
    "/usr/include",
]


class Frontend:
    def __init__(self, source, incdir):
        self.unsupported = []
        self.reported = set()
        self.index = cindex.Index.create()
        shim = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sse_shim.h")
        args = ["-std=c++17", "-DNDEBUG", "-ffp-contract=off", "-msse4.1",
                f"-I{incdir}", "-include", shim]
        for inc in GXX_INCLUDES:
            args.append(f"-isystem{inc}")
        self.tu = self.index.parse(source, args=args)
        self.source_name = source.split("/")[-1]
        self.diag_fail = any(d.severity >= cindex.Diagnostic.Error for d in self.tu.diagnostics)
        self.classes = {}
        self.funs = []
        self.local_types = {}
        self.poisoned = False
        self._file_cache = {}

    def report(self, sym, reason):
        if sym not in self.reported:
            self.reported.add(sym)
            self.unsupported.append({"symbol": sym, "reason": reason})

    def poison(self, sym, reason):
        """A semantic drop that would silently corrupt codegen — the whole
        function is refused."""
        self.report(sym, reason)
        self.poisoned = True

    def in_source(self, cur):
        f = cur.location.file
        return f is not None and os.path.basename(f.name) == self.source_name

    # ------------------------------------------------------------------ types
    def canon(self, ct):
        if ct is None:
            return None
        ty = ct
        # resolve typedefs/using-aliases via canonical type (handles Jolt's
        # 'using uint32 = uint32_t' style aliases)
        if ty.kind == cindex.TypeKind.TYPEDEF:
            try:
                cc = ty.get_canonical()
                if cc.kind != ty.kind:
                    return self.canon(cc)
            except Exception:
                pass
        seen = 0
        while ty.kind == cindex.TypeKind.TYPEDEF and seen < 8:
            d = ty.get_declaration()
            if d is None:
                return None
            try:
                ty = d.underlying_typedef_type
            except Exception:
                return None
            seen += 1
        k = ty.kind
        if k == cindex.TypeKind.ELABORATED:
            return self.canon(ty.get_named_type())
        if k in (cindex.TypeKind.LVALUEREFERENCE, cindex.TypeKind.RVALUEREFERENCE):
            inner = self.canon(ty.get_pointee())
            return t_ref(inner, False) if inner else None
        if k == cindex.TypeKind.POINTER:
            inner = self.canon(ty.get_pointee())
            if inner is None:
                return None
            if inner["k"] == "cstr":
                return t("cstr")
            return t_ref(inner, True)
        if k == cindex.TypeKind.CONSTANTARRAY:
            n = ty.get_array_size()
            elem = self.canon(ty.get_array_element_type())
            if elem is None or n <= 0:
                return None
            return {"k": "arr", "elem": elem, "n": n}
        if k == cindex.TypeKind.RECORD:
            d = ty.get_declaration()
            name = d.spelling or ""
            if name in TARGET_CLASSES:
                return t_cls(name)
            return None
        if k == cindex.TypeKind.FLOAT:
            return t("f32")
        if k == cindex.TypeKind.DOUBLE:
            return t("f64")
        if k == cindex.TypeKind.INT:
            return t("i32")
        if k == cindex.TypeKind.UINT:
            return t("u32")
        if k == cindex.TypeKind.BOOL:
            return t("bool")
        if k == cindex.TypeKind.VOID:
            return t("void")
        return None

    def param_ty(self, ct, cls_ctx):
        """Parameter canonicalization: Type alias + const-ref -> by value."""
        d = ct.get_declaration() if ct is not None else None
        if d is not None and d.spelling == "Type" and cls_ctx in TYPE_ALIAS:
            return t(TYPE_ALIAS[cls_ctx])
        ty = self.canon(ct)
        if ty is None:
            return None
        if ty["k"] == "ref" and not ty["mut"]:
            to = ty["to"]
            if to["k"] == "cls" or to["k"] in ("f32", "f64", "i32", "u32", "cstr"):
                return to
        return ty

    # ------------------------------------------------------------------ tokens
    def spelling_of(self, cur):
        toks = list(cur.get_tokens())
        sp = toks[0].spelling if toks else ""
        if sp:
            return sp
        # macro-expanded literals report empty token spellings — slice the file
        try:
            f = cur.location.file
            if f is not None:
                path = str(f.name)
                if path not in self._file_cache:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        self._file_cache[path] = fh.read()
                text = self._file_cache[path]
                return text[cur.extent.start.offset:cur.extent.end.offset].strip()
        except Exception:
            pass
        return ""

    def op_token(self, cur, cands):
        """Pick the operator: depth-0 tokens only (sub-expressions are nested
        in parens/brackets), then candidate priority order."""
        depth = 0
        found = []
        for tk in cur.get_tokens():
            sp = tk.spelling
            if sp in ("(", "["):
                depth += 1
            elif sp in (")", "]"):
                depth -= 1
            elif depth == 0 and sp in cands:
                found.append(sp)
        for cand in cands:
            if cand in found:
                return cand
        return None

    # ------------------------------------------------------------------ const eval
    def const_eval_int(self, cur):
        # macro-invocation extents have no usable tokens — evaluate
        # _MM_SHUFFLE(z, y, x, w) straight from the source text
        try:
            sp = self.spelling_of(cur)
            if "_MM_SHUFFLE" in sp:
                import re
                nums = re.findall(r"-?\d+", sp)
                if len(nums) >= 4:
                    z, y, x, w = (int(n) for n in nums[:4])
                    return (z << 6) | (y << 4) | (x << 2) | w
        except Exception:
            pass
        try:
            return self._const_eval_int(cur)
        except Exception:
            return None

    def _const_eval_int(self, cur):
        cur = self.strip(cur)
        k = cur.kind
        if k in (cindex.CursorKind.CSTYLE_CAST_EXPR, cindex.CursorKind.CXX_STATIC_CAST_EXPR,
                 cindex.CursorKind.CXX_FUNCTIONAL_CAST_EXPR):
            kids = list(cur.get_children())
            return self._const_eval_int(kids[0]) if kids else None
        if k == cindex.CursorKind.INTEGER_LITERAL:
            sp = self.spelling_of(cur).lower().rstrip("ul")
            if sp.startswith("0x"):
                return int(sp[2:], 16)
            if sp.startswith("0b"):
                return int(sp[2:], 2)
            return int(sp)
        if k == cindex.CursorKind.UNARY_OPERATOR:
            kids = list(cur.get_children())
            toks = [tk.spelling for tk in cur.get_tokens()]
            if kids:
                v = self.const_eval_int(kids[0])
                if v is not None:
                    return -v if "-" in toks else v
            return None
        if k == cindex.CursorKind.BINARY_OPERATOR:
            op = self.op_token(cur, ("|", "&", "^", "<<", ">>", "+", "-", "*", "/"))
            kids = list(cur.get_children())
            if op is None or len(kids) < 2:
                return None
            a = self.const_eval_int(kids[0])
            b = self.const_eval_int(kids[1])
            if a is None or b is None:
                return None
            return {"|": a | b, "&": a & b, "^": a ^ b, "<<": a << b, ">>": a >> b,
                    "+": a + b, "-": a - b, "*": a * b, "/": a // b}[op]
        return None

    # ------------------------------------------------------------------ helpers
    def strip(self, cur):
        while cur is not None and cur.kind in (cindex.CursorKind.UNEXPOSED_EXPR,
                                               cindex.CursorKind.PAREN_EXPR):
            kids = list(cur.get_children())
            if not kids:
                break
            cur = kids[0]
        return cur

    def callee_of(self, cur, depth=0):
        """Callee decl + its ref cursor for a CALL_EXPR (clang 18 style).
        Constructor calls carry the callee on the CALL_EXPR itself; builtin
        calls hide their DECL_REF_EXPR under UNEXPOSED_EXPR wrappers; implicit
        conversions wrap the real ctor call one level deeper.
        Returns (decl, ref_cursor-or-None)."""
        if depth > 3:
            return None, None
        for k in cur.get_children():
            ref = k.referenced
            if ref is not None and \
               k.kind in (cindex.CursorKind.DECL_REF_EXPR, cindex.CursorKind.MEMBER_REF_EXPR) and \
               ref.kind in (cindex.CursorKind.FUNCTION_DECL, cindex.CursorKind.CXX_METHOD,
                            cindex.CursorKind.FUNCTION_TEMPLATE, cindex.CursorKind.CONSTRUCTOR):
                return ref, k
            if k.kind == cindex.CursorKind.UNEXPOSED_EXPR:
                for k2 in k.get_children():
                    ref2 = k2.referenced
                    if ref2 is not None and \
                       k2.kind in (cindex.CursorKind.DECL_REF_EXPR, cindex.CursorKind.MEMBER_REF_EXPR) and \
                       ref2.kind in (cindex.CursorKind.FUNCTION_DECL, cindex.CursorKind.CXX_METHOD,
                                     cindex.CursorKind.FUNCTION_TEMPLATE, cindex.CursorKind.CONSTRUCTOR):
                        return ref2, k2
        # constructor calls with no explicit callee child (spelling == class)
        ref = cur.referenced
        if ref is not None and ref.kind == cindex.CursorKind.CONSTRUCTOR and \
           cur.spelling == ref.semantic_parent.spelling:
            return ref, None
        # last resort: descend into nested call wrappers
        for k in cur.get_children():
            if k.kind == cindex.CursorKind.CALL_EXPR:
                r2, k2 = self.callee_of(k, depth + 1)
                if r2 is not None:
                    return r2, k2
        return None, None

    def call_args(self, cur, callee_ref, skip_types=False, callee=None):
        args = []
        for k in cur.get_children():
            if callee_ref is not None and (k == callee_ref or
                    (k.referenced is not None and callee_ref.referenced is not None
                     and k.referenced == callee_ref.referenced)):
                continue
            if callee is not None and k.referenced is not None and k.referenced == callee:
                continue
            # constructor calls: TYPE_REFs are conversion remnants, not arguments
            if (callee_ref is None or skip_types) and k.kind == cindex.CursorKind.TYPE_REF:
                continue
            args.append(k)
        return args

    # ------------------------------------------------------------------ exprs
    def expr(self, cur, want=None, cls_ctx=None):
        kind = cur.kind

        if kind in (cindex.CursorKind.UNEXPOSED_EXPR, cindex.CursorKind.PAREN_EXPR):
            kids = list(cur.get_children())
            return self.expr(kids[0], want, cls_ctx) if kids else None

        if kind == cindex.CursorKind.FLOATING_LITERAL:
            return {"k": "lit", "ty": "f32", "sp": self.spelling_of(cur)}

        if kind == cindex.CursorKind.INTEGER_LITERAL:
            sp = self.spelling_of(cur)
            if not sp:
                sp = "0"      # disabled-macro remnants have no tokens
            if want is not None and want["k"] == "f32":
                return {"k": "lit", "ty": "f32", "sp": sp.rstrip("ul") + ".0"}
            if want is not None and want["k"] == "u32":
                return {"k": "lit", "ty": "u32", "sp": sp}
            return {"k": "lit", "ty": "i32", "sp": sp}

        if kind == cindex.CursorKind.STRING_LITERAL:
            raw = self.spelling_of(cur)
            if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
                raw = raw[1:-1]
            return {"k": "str", "v": raw}

        if kind == cindex.CursorKind.CXX_BOOL_LITERAL_EXPR:
            toks = [tk.spelling for tk in cur.get_tokens()]
            return {"k": "lit", "ty": "bool", "sp": toks[0] if toks else "false"}

        if kind == cindex.CursorKind.CXX_THIS_EXPR:
            return {"k": "this", "cls": cls_ctx}

        if kind == cindex.CursorKind.DECL_REF_EXPR:
            return {"k": "var", "name": cur.spelling}

        if kind == cindex.CursorKind.MEMBER_REF_EXPR:
            base_c = None
            for k in cur.get_children():
                if k.kind not in (cindex.CursorKind.MEMBER_REF, cindex.CursorKind.TYPE_REF):
                    base_c = k
                    break
            if base_c is None:
                return None
            bt = self.local_types.get(base_c.spelling)
            if bt is not None and isinstance(bt, dict) and bt.get("k") == "fbits":
                return {"k": "bitsget", "var": base_c.spelling, "side": cur.spelling}
            base = self.expr(base_c, None, cls_ctx)
            if base is None:
                return None
            name = cur.spelling
            if name in ("mF32", "mU32"):
                name = "mValue"      # union arm -> canonical SIMD storage
            return {"k": "field", "obj": base, "name": name}

        if kind == cindex.CursorKind.ARRAY_SUBSCRIPT_EXPR:
            kids = list(cur.get_children())
            obj = self.expr(kids[0], None, cls_ctx)
            idx = self.expr(kids[1], None, cls_ctx)
            if obj is None or idx is None:
                return None
            return {"k": "lane_get", "lanes": obj, "idx": idx, "ty": self.canon(cur.type)}

        if kind == cindex.CursorKind.BINARY_OPERATOR:
            return self.binop(cur, cls_ctx)

        if kind == cindex.CursorKind.COMPOUND_ASSIGNMENT_OPERATOR:
            op = self.op_token(cur, ("+=", "-=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>=", "%="))
            kids = list(cur.get_children())
            if op is None or len(kids) < 2:
                self.report(f"compound@{cur.location.line}", "unknown compound op")
                return None
            target = self.assign_target(kids[0], cls_ctx)
            if target is None:
                return None
            rhs = self.expr(kids[1], self.canon(kids[1].type), cls_ctx)
            if rhs is None:
                return None
            return {"k": "compound", "op": op[:-1], "target": target, "rhs": rhs,
                    "ty": self.canon(cur.type)}

        if kind == cindex.CursorKind.UNARY_OPERATOR:
            op = self.op_token(cur, ("-", "!", "&", "*", "++", "--"))
            kids = list(cur.get_children())
            if op == "&":
                if not kids:
                    return None
                e = self.expr(kids[0], None, cls_ctx)
                return {"k": "ref", "e": e} if e else None
            if op == "*":
                if not kids:
                    return None
                e = self.expr(kids[0], None, cls_ctx)
                return {"k": "deref", "e": e} if e else None
            if op in ("++", "--"):
                self.report(f"unary{op}@{cur.location.line}", "inc/dec in expression position")
                return None
            if kids:
                e = self.expr(kids[0], self.canon(cur.type), cls_ctx)
                if e is None:
                    return None
                return {"k": "un", "op": op, "e": e, "ty": self.canon(cur.type)}
            return None

        if kind == cindex.CursorKind.CONDITIONAL_OPERATOR:
            kids = list(cur.get_children())
            if len(kids) < 3:
                return None
            cond = self.expr(kids[0], t("bool"), cls_ctx)
            then = self.expr(kids[1], self.canon(cur.type), cls_ctx)
            els = self.expr(kids[2], self.canon(cur.type), cls_ctx)
            if cond is None or then is None or els is None:
                return None
            return {"k": "sel", "cond": cond, "then": then, "els": els,
                    "ty": self.canon(cur.type)}

        if kind in (cindex.CursorKind.CXX_STATIC_CAST_EXPR, cindex.CursorKind.CSTYLE_CAST_EXPR,
                    cindex.CursorKind.CXX_FUNCTIONAL_CAST_EXPR, cindex.CursorKind.CXX_CONST_CAST_EXPR,
                    cindex.CursorKind.CXX_REINTERPRET_CAST_EXPR):
            to_ty = self.canon(cur.type)
            if to_ty is not None and to_ty["k"] == "ref":
                # pointer reinterpretation across lane types — rung 2
                self.poison(f"refcast@{cur.location.line}", "pointer cast between lane types")
                return None
            kids = [k for k in cur.get_children() if k.kind != cindex.CursorKind.TYPE_REF]
            if not kids:
                return None
            inner = self.expr(kids[0], None, cls_ctx)
            if inner is None or to_ty is None:
                return None
            return {"k": "cast", "e": inner, "to": to_ty}

        if kind == cindex.CursorKind.INIT_LIST_EXPR:
            kids = list(cur.get_children())
            arr_t = self.canon(cur.type)
            elems = []
            for k in kids:
                e = self.expr(k, arr_t["elem"] if arr_t and arr_t["k"] == "arr" else None, cls_ctx)
                if e is None:
                    return None
                elems.append(e)
            return {"k": "arrlit", "elems": elems, "ty": arr_t}

        if kind == cindex.CursorKind.CALL_EXPR:
            e = self.call(cur, cls_ctx)
            if e is None:
                return None
            if e["k"] == "assignexpr":
                # assignment expressions are only valid as whole statements;
                # nested in an expression (a = b = c) -> unsupported here
                self.report(f"assignexpr@{cur.location.line}", "assignment nested in expression")
                return None
            return e

        self.report(f"expr:{kind.name}@{cur.location.line}", "unhandled expression kind")
        return None

    # ------------------------------------------------------------------ binop
    def binop(self, cur, cls_ctx):
        kids = list(cur.get_children())
        if len(kids) < 2:
            return None
        op = self.op_token(cur, ("+", "-", "*", "/", "==", "!=", "<=", ">=",
                                 "<", ">", "&&", "||", "&", "|", "^", "<<", ">>", "%"))
        if op is None:
            self.report(f"binop@{cur.location.line}", "unknown binary operator")
            return None
        l = self.expr(kids[0], self.canon(kids[0].type), cls_ctx)
        r = self.expr(kids[1], self.canon(kids[1].type), cls_ctx)
        if l is None or r is None:
            return None
        return {"k": "bin", "op": op, "l": l, "r": r, "ty": self.canon(cur.type)}

    # ------------------------------------------------------------------ calls
    def call(self, cur, cls_ctx):
        callee, callee_ref = self.callee_of(cur)
        if callee is None:
            self.report(f"call@{cur.location.line}", "call without resolvable callee")
            return None

        if callee.kind == cindex.CursorKind.CONSTRUCTOR:
            cls_name = callee.semantic_parent.spelling
            if cls_name not in TARGET_CLASSES:
                self.report(f"ctor:{cls_name}@{cur.location.line}", "ctor of non-target class")
                return None
            args = []
            mparams = list(callee.get_arguments())
            for i, a in enumerate(self.call_args(cur, callee_ref, skip_types=True)):
                w = self.param_ty(mparams[i].type, cls_name) if i < len(mparams) else None
                e = self.expr(a, w, cls_ctx)
                if e is None:
                    return None
                args.append(e)
            return {"k": "ctor", "cls": cls_name, "args": args, "nargs": len(args)}

        name = callee.spelling

        # member template Swizzle<X, Y, Z, W>() -> shuffle + 1-arg ctor
        if name == "Swizzle" and callee.kind == cindex.CursorKind.CXX_METHOD:
            cls_name = callee.semantic_parent.spelling
            toks = [tk.spelling for tk in cur.get_tokens()]
            if "<" in toks and ">" in toks:
                ids = toks[toks.index("<") + 1:toks.index(">")]
                tbl = {"SWIZZLE_X": 0, "SWIZZLE_Y": 1, "SWIZZLE_Z": 2, "SWIZZLE_W": 3,
                       "SWIZZLE_UNUSED": 0}
                vals = [tbl.get(tk) for tk in ids if tk != ","]
                if len(vals) == 4 and all(v is not None for v in vals):
                    X, Y, Z, W = vals
                    imm = (W << 6) | (Z << 4) | (Y << 2) | X
                    base_c = None
                    for k in callee_ref.get_children():
                        ts = k.type.spelling or "" if k.type else ""
                        if k.kind == cindex.CursorKind.CXX_THIS_EXPR or "Vec" in ts:
                            base_c = k
                            break
                    obj = self.expr(base_c, None, cls_ctx) if base_c is not None \
                        else {"k": "this", "cls": cls_name}
                    if obj is not None and obj.get("k") != "field":
                        obj = {"k": "field", "obj": obj, "name": "mValue"}
                    lane_t = "v128i" if cls_name == "UVec4" else "v128f"
                    sop = "shufflei" if cls_name == "UVec4" else "shuffle"
                    shuf = {"k": "simd", "name": sop, "args": [obj, obj],
                            "imm": imm, "ty": t(lane_t)}
                    return {"k": "ctor", "cls": cls_name, "args": [shuf], "nargs": 1}
            self.poison(f"swizzle@{cur.location.line}", "unresolvable swizzle")
            return None

        # built-in copy assignment surfaces as an overloaded operator= call
        if name == "operator=" and callee.kind == cindex.CursorKind.CXX_METHOD and \
           callee.semantic_parent.spelling in TARGET_CLASSES:
            cls_name = callee.semantic_parent.spelling
            acs = self.call_args(cur, callee_ref)
            if callee_ref.kind == cindex.CursorKind.MEMBER_REF_EXPR:
                base_c = [k for k in callee_ref.get_children()
                          if k.kind not in (cindex.CursorKind.MEMBER_REF, cindex.CursorKind.TYPE_REF)][0]
                target = self.expr(base_c, t_cls(cls_name), cls_ctx)
            else:
                target = self.expr(acs[0], t_cls(cls_name), cls_ctx)
                acs = acs[1:]
            if target is None or not acs:
                return None
            value = self.expr(acs[0], t_cls(cls_name), cls_ctx)
            if value is None:
                return None
            return {"k": "assignexpr", "target": target, "value": value}

        if callee.kind == cindex.CursorKind.FUNCTION_TEMPLATE:
            self.report(f"tmplcall:{name}@{cur.location.line}", "unresolved template function call")
            return None

        if name == "printf":
            return self.lower_printf(self.call_args(cur, callee_ref), cls_ctx)

        if name in SSE_TABLE:
            opname, arity, rk = SSE_TABLE[name]
            acs = self.call_args(cur, callee_ref)
            # immediate-operand intrinsics: last arg must fold to a constant
            if opname in ("shuffle", "insert", "shufflei", "srai", "slli", "srli", "blend_ps"):
                if len(acs) < 3 and opname != "shufflei" or opname == "shufflei" and len(acs) != 2:
                    self.report(f"sse:{name}@{cur.location.line}", f"bad {opname} shape")
                    return None
                imm_n = 2 if opname == "shufflei" else 3
                args_c = acs[:imm_n - 1]
                imm = self.const_eval_int(acs[imm_n - 1])
                if imm is None:
                    self.report(f"sse:{opname}@{cur.location.line}", "non-constant imm")
                    return None
                args = []
                for a in args_c:
                    e = self.expr(a, None, cls_ctx)
                    if e is None:
                        return None
                    args.append(e)
                ret_ty = self.canon(cur.type) or t(rk)
                return {"k": "simd", "name": opname, "args": args, "imm": imm, "ty": ret_ty}
            # _mm_set_ps / _mm_set_epi32 take args in reversed order
            if opname in ("set4", "set4u") and name in ("_mm_set_ps", "_mm_set_epi32"):
                acs = list(reversed(acs))
            if arity == 0:
                return {"k": "simd", "name": opname, "args": [], "ty": t(rk)}
            args = []
            for a in acs[:arity]:
                e = self.expr(a, None, cls_ctx)
                if e is None:
                    return None
                args.append(e)
            ret_ty = self.canon(cur.type) if rk != "void" else t("void")
            if ret_ty is None:
                ret_ty = t(rk)
            return {"k": "simd", "name": opname, "args": args, "ty": ret_ty}

        if callee.kind == cindex.CursorKind.FUNCTION_DECL and \
           name in ("min", "max", "abs", "sqrt", "sqrtf", "fabs", "fabsf", "Sqrt",
                    "isnan", "signbit", "CountTrailingZeros", "CountBits"):
            args = []
            for a in self.call_args(cur, callee_ref):
                e = self.expr(a, None, cls_ctx)
                if e is None:
                    return None
                args.append(e)
            if name in ("min", "max"):
                op = "<" if name == "min" else ">"
                l, r = args[0], args[1]
                return {"k": "sel",
                        "cond": {"k": "bin", "op": op, "l": l, "r": r, "ty": t("bool")},
                        "then": l if name == "min" else r,
                        "els": r if name == "min" else l,
                        "ty": self.canon(cur.type)}
            iname = {"abs": "abs", "fabs": "abs", "fabsf": "abs", "sqrt": "sqrt",
                     "sqrtf": "sqrt", "Sqrt": "sqrt", "isnan": "is_nan",
                     "signbit": "signbit", "CountTrailingZeros": "ctz",
                     "CountBits": "popcnt"}[name]
            return {"k": "intrinsic", "name": iname, "args": args, "ty": self.canon(cur.type)}

        # class methods: static via DECL_REF_EXPR; instance via MEMBER_REF_EXPR base
        if callee.kind == cindex.CursorKind.CXX_METHOD and \
           callee.semantic_parent.spelling in TARGET_CLASSES:
            cls_name = callee.semantic_parent.spelling
            ret = self.canon(callee.result_type)
            if ret is None and (callee.result_type.spelling == "Type" or callee.result_type.spelling.endswith("::Type")) and cls_name in TYPE_ALIAS:
                ret = t(TYPE_ALIAS[cls_name])
            if ret is None and "unsigned" in callee.result_type.spelling:
                ret = t("u32")
            mparams = list(callee.get_arguments())
            acs = self.call_args(cur, callee_ref)
            if callee.is_static_method():
                args = []
                for i in range(len(mparams)):
                    if i < len(acs):
                        a = acs[i]
                    else:
                        defaults = list(mparams[i].get_children())
                        if not defaults:
                            break
                        a = defaults[0]      # materialized default arg
                    w = self.param_ty(mparams[i].type, cls_name)
                    e = self.expr(a, w, cls_ctx)
                    if e is None:
                        return None
                    args.append(e)
                return {"k": "call", "cls": cls_name,
                        "name": self.ir_method_name(callee, cls_name), "args": args, "ret": ret}
            # instance call
            if callee_ref.kind == cindex.CursorKind.DECL_REF_EXPR:
                # e.g. d[2] via operator[]: object arrives as first arg
                if not acs:
                    self.report(f"mcall:{name}@{cur.location.line}", "no object arg")
                    return None
                obj = self.expr(acs[0], t_cls(cls_name), cls_ctx)
                rest = acs[1:]
            else:
                base_c = None
                for k in callee_ref.get_children():
                    if k.kind not in (cindex.CursorKind.MEMBER_REF, cindex.CursorKind.TYPE_REF):
                        base_c = k
                        break
                if base_c is not None:
                    obj = self.expr(base_c, t_cls(cls_name), cls_ctx)
                else:
                    obj = {"k": "this", "cls": cls_name}   # implicit this
                rest = acs
            if obj is None:
                return None
            args = []
            for i in range(len(mparams)):
                if i < len(rest):
                    a = rest[i]
                else:
                    defaults = list(mparams[i].get_children())
                    if not defaults:
                        break
                    a = defaults[0]          # materialized default arg
                w = self.param_ty(mparams[i].type, cls_name)
                e = self.expr(a, w, cls_ctx)
                if e is None:
                    return None
                args.append(e)
            return {"k": "meth", "obj": obj, "cls": cls_name,
                    "name": self.ir_method_name(callee, cls_name), "args": args, "ret": ret}

        # friend operator*(float, class) -> member call rewrite (commutative)
        if callee.kind == cindex.CursorKind.FUNCTION_DECL and name == "operator*":
            acs = self.call_args(cur, callee_ref, callee=callee)
            if len(acs) == 2 and "Vec" not in acs[0].type.spelling:
                obj = self.expr(acs[1], None, cls_ctx)
                fp = self.expr(acs[0], t("f32"), cls_ctx)
                if obj is None or fp is None:
                    return None
                cls_name = acs[1].type.spelling.split()[0]
                # match the member overload's IR name (const marker)
                mname = "op_mul@f32"
                for mm in self.classes.get(cls_name, {}).get("methods", []):
                    if mm["name"].startswith("op_mul@f32"):
                        mname = mm["name"]
                        break
                return {"k": "meth", "obj": obj, "cls": cls_name,
                        "name": mname, "args": [fp], "ret": t_cls(cls_name)}

        # free function in module (battery helpers, BitsOf, ...)
        if name == "quiet_NaN":
            return {"k": "lit", "ty": "f32", "sp": "nan"}
        if name == "operator*":
            self.report(f"friendmul@{cur.location.line}", "unhandled friend operator* shape")
            return None
        args = []
        for a in self.call_args(cur, callee_ref, callee=callee):
            e = self.expr(a, None, cls_ctx)
            if e is None:
                return None
            args.append(e)
        ret = self.canon(callee.result_type) or self.canon(cur.type)
        if ret is None and callee.result_type.spelling == "void":
            ret = t("void")
        return {"k": "call", "cls": None, "name": name, "args": args, "ret": ret}

    # ------------------------------------------------------------------ printf
    def lower_printf(self, acs, cls_ctx):
        if not acs:
            return None
        fmt_c = self.strip(acs[0])
        if fmt_c.kind != cindex.CursorKind.STRING_LITERAL:
            self.report("printf", "non-literal format string")
            return None
        fmt = self.spelling_of(fmt_c)[1:-1].replace("\\n", "\n")
        seq = []
        args = acs[1:]
        text = ""
        ai, i = 0, 0
        while i < len(fmt):
            if fmt[i] == "%" and i + 1 < len(fmt):
                if fmt[i:i+5] in ("%08x", "%08X"):
                    if text:
                        seq.append({"k": "emit", "kind": "str", "v": text})
                        text = ""
                    e = self.expr(args[ai], t("u32"), cls_ctx)
                    ai += 1
                    if e is None:
                        return None
                    seq.append({"k": "emit", "kind": "hex32", "e": e})
                    i += 5
                    continue
                if fmt[i:i+2] == "%u":
                    if text:
                        seq.append({"k": "emit", "kind": "str", "v": text})
                        text = ""
                    e = self.expr(args[ai], t("u32"), cls_ctx)
                    ai += 1
                    if e is None:
                        return None
                    seq.append({"k": "emit", "kind": "u32", "e": e})
                    i += 2
                    continue
                if fmt[i:i+2] == "%s":
                    if text:
                        seq.append({"k": "emit", "kind": "str", "v": text})
                        text = ""
                    e = self.expr(args[ai], t("cstr"), cls_ctx)
                    ai += 1
                    if e is None:
                        return None
                    seq.append({"k": "emit", "kind": "str", "e": e})
                    i += 2
                    continue
            if fmt[i] == "\n":
                if text:
                    seq.append({"k": "emit", "kind": "str", "v": text})
                    text = ""
                seq.append({"k": "emit", "kind": "endln"})
                i += 1
                continue
            text += fmt[i]
            i += 1
        if text:
            seq.append({"k": "emit", "kind": "str", "v": text})
        return {"k": "emitseq", "seq": seq}

    # ------------------------------------------------------------------ names
    def ir_method_name(self, md, cls_ctx):
        raw = md.spelling
        name = OPMAP.get(raw, raw)
        sig = []
        for p in md.get_arguments():
            pt = self.param_ty(p.type, cls_ctx)
            sig.append(ty_show(pt) if pt else "?")
        # const/non-const overloads share the same signature — disambiguate
        try:
            if md.is_const_method():
                sig.append("c")
        except Exception:
            pass
        if sig:
            name = f"{name}@{'_'.join(sig)}"
        return name

    # ------------------------------------------------------------------ statements
    def stmts(self, cur, cls_ctx, out):
        for k in cur.get_children():
            self.stmt(k, cls_ctx, out)

    def sub_stmts(self, child, cls_ctx, out):
        """Lower a control-flow body: compound or single statement."""
        if child.kind == cindex.CursorKind.COMPOUND_STMT:
            self.stmts(child, cls_ctx, out)
        else:
            self.stmt(child, cls_ctx, out)

    def stmt(self, cur, cls_ctx, out):
        kind = cur.kind

        if kind == cindex.CursorKind.COMPOUND_STMT:
            self.stmts(cur, cls_ctx, out)
            return

        if kind == cindex.CursorKind.DECL_STMT:
            for d in cur.get_children():
                if d.kind == cindex.CursorKind.VAR_DECL:
                    self.vardecl(d, cls_ctx, out)
            return

        if kind == cindex.CursorKind.IF_STMT:
            kids = list(cur.get_children())
            # shape: [cond-expr, then-stmt, else-stmt?]
            if len(kids) < 2:
                self.report(f"if@{cur.location.line}", "unresolvable if shape")
                return
            cond = self.expr(kids[0], t("bool"), cls_ctx)
            if cond is None:
                self.poison(f"if@{cur.location.line}", "if condition failed to lower")
                return
            then, els = [], []
            self.sub_stmts(kids[1], cls_ctx, then)
            if len(kids) > 2:
                self.sub_stmts(kids[2], cls_ctx, els)
            out.append({"k": "if", "cond": cond, "then": then, "els": els})
            return

        if kind == cindex.CursorKind.FOR_STMT:
            kids = list(cur.get_children())
            var_name, start, stop = None, None, None
            for k in kids:
                if k.kind == cindex.CursorKind.DECL_STMT and start is None:
                    d = list(k.get_children())[0]
                    var_name = d.spelling
                    inits = list(d.get_children())
                    start = self.expr(inits[0], t("i32"), cls_ctx) if inits else None
                elif k.kind == cindex.CursorKind.BINARY_OPERATOR and stop is None and start is not None:
                    kids2 = list(k.get_children())
                    stop = self.expr(kids2[-1], t("i32"), cls_ctx)
            body_c = kids[-1] if kids else None
            body = []
            if body_c is not None and body_c.kind != cindex.CursorKind.DECL_STMT:
                self.sub_stmts(body_c, cls_ctx, body)
            if var_name is None or start is None or stop is None:
                self.poison(f"for@{cur.location.line}", "non-canonical for loop")
                return
            out.append({"k": "for", "var": var_name, "start": start, "stop": stop, "body": body})
            return

        if kind == cindex.CursorKind.WHILE_STMT:
            kids = list(cur.get_children())
            if len(kids) < 2:
                self.report(f"while@{cur.location.line}", "unresolvable while")
                return
            cond = self.expr(kids[0], t("bool"), cls_ctx)
            if cond is None:
                return
            body = []
            self.sub_stmts(kids[1], cls_ctx, body)
            out.append({"k": "while", "cond": cond, "body": body})
            return

        if kind == cindex.CursorKind.RETURN_STMT:
            kids = list(cur.get_children())
            if not kids:
                out.append({"k": "return", "e": None})
                return
            if self.ref_ret:
                # mutator epilogue `return *this;` -> dropped; a lane read
                # (op_index) keeps its value
                e0 = self.strip(kids[0])
                if e0 is not None and e0.kind in (cindex.CursorKind.CXX_THIS_EXPR,
                                                 cindex.CursorKind.UNARY_OPERATOR):
                    return
            e = self.expr(kids[0], None, cls_ctx)
            if e is None:
                self.poison(f"ret@{cur.location.line}", "return value failed to lower")
                return
            out.append({"k": "return", "e": e})
            return

        if kind == cindex.CursorKind.CALL_EXPR:
            e = self.call(cur, cls_ctx)
            if e is None:
                return
            if e["k"] == "emitseq":
                out.extend(e["seq"])
            elif e["k"] == "assignexpr":
                self.expand_assign(e["target"], e["value"], cls_ctx, out)
            else:
                out.append({"k": "expr", "e": e})
            return

        if kind == cindex.CursorKind.BINARY_OPERATOR:
            toks = [tk.spelling for tk in cur.get_tokens()]
            if "=" in toks and not any(x in toks for x in
                                       ("==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>=")):
                kids = list(cur.get_children())
                target = self.assign_target(kids[0], cls_ctx)
                val = self.expr(kids[1], self.canon(kids[1].type), cls_ctx)
                if target is None or val is None:
                    self.poison(f"assign@{cur.location.line}", "assignment failed to lower")
                    return
                self.expand_assign(target, val, cls_ctx, out)
                return
            e = self.expr(cur, None, cls_ctx)
            if e is not None:
                out.append({"k": "expr", "e": e})
            return

        if kind == cindex.CursorKind.COMPOUND_ASSIGNMENT_OPERATOR:
            e = self.expr(cur, cls_ctx)
            if e is None:
                return
            self.expand_compound(e, cls_ctx, out)
            return

        if kind == cindex.CursorKind.UNARY_OPERATOR:
            op = self.op_token(cur, ("-", "!", "&", "*", "++", "--"))
            kids = list(cur.get_children())
            if op in ("++", "--") and kids:
                target = self.assign_target(kids[0], cls_ctx)
                if target is None:
                    return
                one = {"k": "lit", "ty": "i32", "sp": "1"}
                self.expand_assign(target,
                                   {"k": "bin", "op": "+" if op == "++" else "-",
                                    "l": self.target_read(target), "r": one, "ty": t("i32")},
                                   cls_ctx, out)
                return
            e = self.expr(cur, None, cls_ctx)
            if e is not None:
                out.append({"k": "expr", "e": e})
            return

        # last resort: expression statements (clang 18 has no EXPR_STMT kind)
        e = self.expr(cur, None, cls_ctx)
        if e is not None:
            if e["k"] == "emitseq":
                out.extend(e["seq"])
            else:
                out.append({"k": "expr", "e": e})
            return

        self.report(f"stmt:{kind.name}@{cur.location.line}", "unhandled statement kind")

    # ------------------------------------------------------------------ assignment targets
    def lane_wrap(self, obj, cls_ctx):
        """Class-typed object -> its SIMD lanes field (mValue)."""
        ot = self.expr_type(obj)
        if ot is not None and ot["k"] == "cls" and ot["name"] in ("Vec3", "Vec4", "UVec4"):
            return {"k": "field", "obj": obj, "name": "mValue"}
        return obj

    def assign_target(self, cur, cls_ctx):
        kind = cur.kind
        if kind == cindex.CursorKind.CALL_EXPR:
            callee, ref = self.callee_of(cur)
            if callee is not None and callee.spelling == "operator[]":
                acs = self.call_args(cur, ref)
                if len(acs) >= 2:
                    if ref.kind == cindex.CursorKind.DECL_REF_EXPR:
                        obj = self.expr(acs[0], None, cls_ctx)
                        idx_c = acs[1]
                    else:
                        base_c = None
                        for k in ref.get_children():
                            if k.kind not in (cindex.CursorKind.MEMBER_REF, cindex.CursorKind.TYPE_REF):
                                base_c = k
                                break
                        idx_c = acs[0] if len(acs) > 0 else None
                        obj = self.expr(base_c, None, cls_ctx) if base_c is not None \
                            else {"k": "this", "cls": cls_ctx}
                    if obj is not None and idx_c is not None:
                        obj = self.lane_wrap(obj, cls_ctx)
                        idx = self.expr(idx_c, None, cls_ctx)
                        return {"k": "lane_get", "lanes": obj, "idx": idx,
                                "ty": {"k": "f32"}, "mut": True}
            self.report(f"target:call@{cur.location.line}", "call not assignable")
            return None
        if kind == cindex.CursorKind.ARRAY_SUBSCRIPT_EXPR:
            kids = list(cur.get_children())
            obj = self.expr(kids[0], None, cls_ctx)
            idx = self.expr(kids[1], None, cls_ctx)
            if obj is None or idx is None:
                return None
            obj = self.lane_wrap(obj, cls_ctx)
            return {"k": "lane_get", "lanes": obj, "idx": idx,
                    "ty": {"k": "f32"}, "mut": True}
        return self.expr(cur, None, cls_ctx)

    def target_read(self, target):
        tt = json.loads(json.dumps(target))
        tt.pop("mut", None)
        return tt

    def expand_assign(self, target, value, cls_ctx, out):
        if target["k"] == "this":
            for f in self.classes.get(cls_ctx, {}).get("fields", []):
                out.append({"k": "assign",
                            "target": {"k": "field", "obj": {"k": "this", "cls": cls_ctx},
                                       "name": f["name"]},
                            "value": {"k": "field", "obj": value, "name": f["name"]}})
            return
        if target["k"] == "lane_get" and target.get("mut"):
            out.append({"k": "assign",
                        "target": target["lanes"],
                        "value": {"k": "lane_set", "lanes": target["lanes"],
                                  "idx": target["idx"], "v": value,
                                  "ty": target.get("ty")}})
            return
        out.append({"k": "assign", "target": target, "value": value})

    def expand_compound(self, e, cls_ctx, out):
        value = {"k": "bin", "op": e["op"], "l": self.target_read(e["target"]),
                 "r": e["rhs"], "ty": e.get("ty")}
        self.expand_assign(e["target"], value, cls_ctx, out)

    # ------------------------------------------------------------------ var decls
    def vardecl(self, d, cls_ctx, out):
        name = d.spelling
        if d.type.spelling.startswith("FBits"):
            out.append({"k": "let", "name": name, "ty": {"k": "fbits"}, "init": None})
            self.local_types[name] = {"k": "fbits"}
            return
        ty = self.canon(d.type)
        if ty is None:
            for tok in d.get_tokens():
                if tok.spelling == "Type":
                    if cls_ctx in TYPE_ALIAS:
                        ty = t(TYPE_ALIAS[cls_ctx])
                    break
        if ty is None:
            self.poison(f"var:{name}@{d.location.line}", "unknown variable type")
            return
        kids = [c for c in d.get_children() if c.kind != cindex.CursorKind.TYPE_REF]
        if not kids:
            out.append({"k": "let", "name": name, "ty": ty, "init": None})
            self.local_types[name] = ty
            return
        init = self.expr(kids[0], ty, cls_ctx)
        if init is None:
            self.poison(f"var:{name}@{d.location.line}", "initializer failed to lower")
            return
        if init["k"] == "ctor" and len(init["args"]) == 0:
            out.append({"k": "let", "name": name, "ty": ty, "init": None})
            self.local_types[name] = ty
            return
        if init["k"] == "ctor" and len(init["args"]) == 1 and ty["k"] == "cls" and \
           self.expr_type(init["args"][0]) and self.expr_type(init["args"][0])["k"] == "cls" and \
           self.expr_type(init["args"][0])["name"] == ty["name"]:
            out.append({"k": "let", "name": name, "ty": ty,
                        "init": {"k": "copy", "e": init["args"][0]}})
            self.local_types[name] = ty
            return
        out.append({"k": "let", "name": name, "ty": ty, "init": init})
        self.local_types[name] = ty

    # ------------------------------------------------------------------ expr type
    def expr_type(self, e):
        if e is None:
            return None
        k = e["k"]
        if k == "var":
            return self.local_types.get(e["name"])
        if k == "this":
            return t_cls(e["cls"]) if e.get("cls") else None
        if k == "lit":
            return t(e.get("ty", "i32"))
        if k == "str":
            return t("cstr")
        if k == "field":
            obj_ty = self.expr_type(e["obj"])
            if obj_ty is not None and obj_ty["k"] == "cls":
                for f in self.classes.get(obj_ty["name"], {}).get("fields", []):
                    if f["name"] == e["name"]:
                        return f["ty"]
                return t("f32")
            return None
        if k == "lane_get":
            return t("f32")
        if k == "ref":
            inner = self.expr_type(e["e"])
            return t_ref(inner, True) if inner else None
        if k == "deref":
            inner = self.expr_type(e["e"])
            if inner is not None and inner["k"] == "ref":
                return inner["to"]
            if inner is not None and inner["k"] == "cls":
                return inner
            return None
        return e.get("ty")

    # ------------------------------------------------------------------ collection
    def collect(self):
        if self.diag_fail:
            for d in self.tu.diagnostics:
                if d.severity >= cindex.Diagnostic.Error:
                    loc = d.location
                    print(f"PARSE ERROR: {loc.file}:{loc.line} {d.spelling}", file=sys.stderr)
            return False
        self.local_types = {}

        for c in self.tu.cursor.walk_preorder():
            if c.kind == cindex.CursorKind.CLASS_DECL and c.spelling in TARGET_CLASSES and c.is_definition():
                self.lower_class_fields(c)
            if c.kind == cindex.CursorKind.STRUCT_DECL and c.spelling in TARGET_CLASSES and c.is_definition():
                self.lower_class_fields(c)

        seen = set()
        for c in self.tu.cursor.walk_preorder():
            if c.kind == cindex.CursorKind.CXX_METHOD and c.is_definition():
                parent = c.semantic_parent.spelling if c.semantic_parent else ""
                if parent in TARGET_CLASSES:
                    key = (parent, c.spelling, c.location.line)
                    if key not in seen:
                        seen.add(key)
                        self.lower_method(c, parent)
            if c.kind == cindex.CursorKind.CONSTRUCTOR and c.is_definition():
                parent = c.semantic_parent.spelling if c.semantic_parent else ""
                if parent in TARGET_CLASSES:
                    key = (parent, "<ctor>", c.location.line)
                    if key not in seen:
                        seen.add(key)
                        self.lower_ctor(c, parent)

        for c in self.tu.cursor.walk_preorder():
            if c.kind == cindex.CursorKind.FUNCTION_DECL and c.is_definition() \
               and self.in_source(c):
                self.lower_fun(c)

        self.prune()
        return True

    def lower_class_fields(self, c):
        name = c.spelling
        cls = self.classes.setdefault(name, {"name": name, "fields": [], "methods": []})
        if cls["fields"]:
            return
        for m in c.get_children():
            if m.kind != cindex.CursorKind.FIELD_DECL and \
               m.kind != cindex.CursorKind.UNION_DECL:
                continue
            if m.spelling in ("x", "y", "z", "w"):
                cls["fields"].append({"name": m.spelling, "ty": t("f32")})
            elif m.spelling == "mValue":
                lane_t = "v128f" if name in ("Vec3", "Vec4") else "v128i"
                cls["fields"].append({"name": "mValue", "ty": t(lane_t)})
            elif m.kind == cindex.CursorKind.UNION_DECL:
                # anonymous union { __m128 mValue; float mF32[4]; } / { __m128i mValue; uint32 mU32[4]; }
                for uf in m.get_children():
                    if uf.kind == cindex.CursorKind.FIELD_DECL and uf.spelling == "mValue":
                        lane_t = "v128f" if name in ("Vec3", "Vec4") else "v128i"
                        cls["fields"].append({"name": "mValue", "ty": t(lane_t)})

    def lower_method(self, m, cls_name):
        if m.spelling in ("operator=", "operator new", "operator new[]",
                          "operator delete", "operator delete[]",
                          # transcendental: bit-exact cross-language needs a
                          # libm/Cephes port — capability rung 3
                          "SinCos", "Tan", "ASin", "ACos", "ATan", "sATan2"):
            return
        try:
            if m.is_defaulted():
                return
        except Exception:
            pass
        # member templates surface as FUNCTION_TEMPLATE cursors, never plain
        # CXX_METHOD — nothing to check here in this libclang version
        if not any(k.kind == cindex.CursorKind.COMPOUND_STMT for k in m.get_children()):
            return

        is_static = m.is_static_method()
        name = self.ir_method_name(m, cls_name)
        params = []
        self.local_types = {}
        if not is_static:
            params.append({"name": "self", "ty": t_cls(cls_name)})
            self.local_types["self"] = t_cls(cls_name)
        for p in m.get_arguments():
            pt = self.param_ty(p.type, cls_name)
            if pt is None:
                self.report(f"{cls_name}::{name}", f"unmappable param '{p.spelling}'")
                return
            pname = p.spelling or f"arg{len(params)}"
            params.append({"name": pname, "ty": pt})
            self.local_types[pname] = pt

        ret = self.canon(m.result_type)
        if ret is None and (m.result_type.spelling == "Type" or
                            m.result_type.spelling.endswith("::Type")) and cls_name in TYPE_ALIAS:
            ret = t(TYPE_ALIAS[cls_name])
        if ret is None:
            rt_sp = m.result_type.spelling
            if "unsigned" in rt_sp:
                ret = t("u32")
            elif rt_sp == "int":
                ret = t("i32")
        if ret is None:
            self.report(f"{cls_name}::{name}", f"unmappable return '{m.result_type.spelling}'")
            return

        # ref-returning methods: operator[] keeps its lane-read return (pointee
        # type); compound-assignment mutators become void (`return *this` dropped)
        self.ref_ret = ret["k"] == "ref"
        if self.ref_ret:
            ret = ret["to"] if m.spelling == "operator[]" else t("void")

        body = []
        comp = None
        for k in m.get_children():
            if k.kind == cindex.CursorKind.COMPOUND_STMT:
                comp = k
        self.poisoned = False
        self.stmt(comp, cls_name, body)
        if self.poisoned:
            # lane setters have one deterministic semantics: lane N = scalar,
            # other lanes unchanged — emit it canonically (identical bits)
            lane_ix = {"SetX": 0, "SetY": 1, "SetZ": 2, "SetW": 3}.get(m.spelling)
            if cls_name in ("Vec3", "Vec4") and lane_ix is not None and params:
                tgt = {"k": "field", "obj": {"k": "this", "cls": cls_name}, "name": "mValue"}
                body = [{"k": "assign", "target": tgt,
                         "value": {"k": "lane_set", "lanes": tgt,
                                   "idx": {"k": "lit", "ty": "i32", "sp": str(lane_ix)},
                                   "v": {"k": "var", "name": params[-1]["name"]},
                                   "ty": {"k": "f32"}}}]
                self.report(f"{cls_name}::{name}", "poisoned — canonical lane-setter emitted")
            else:
                self.report(f"{cls_name}::{name}", "poisoned body — refused")
                return

        self.classes[cls_name]["methods"].append({
            "cls": cls_name, "name": name, "static": is_static,
            "params": params, "ret": ret, "body": body,
            "origin": f"{cls_name}::{m.spelling}",
        })

    def lower_ctor(self, c, cls_name):
        try:
            if c.is_default_constructor() or c.is_copy_constructor():
                return
        except Exception:
            pass
        params = []
        self.local_types = {}
        for p in c.get_arguments():
            pt = self.param_ty(p.type, cls_name)
            if pt is None:
                self.report(f"{cls_name}::<ctor>", f"unmappable param '{p.spelling}'")
                return
            pname = p.spelling or f"arg{len(params)}"
            params.append({"name": pname, "ty": pt})
            self.local_types[pname] = pt
        body = []
        comp = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.COMPOUND_STMT:
                comp = k
        if comp is None:
            self.report(f"{cls_name}::<ctor>", "no body")
            return
        self.poisoned = False
        self.stmt(comp, cls_name, body)
        if self.poisoned:
            self.report(f"{cls_name}::<ctor>@{c.location.line}", "poisoned body — refused")
            return

        # member initializers (mValue(...)) prepended — shape: MEMBER_REF + init-expr
        children = list(c.get_children())
        for i, k in enumerate(children):
            if k.kind == cindex.CursorKind.MEMBER_REF and i + 1 < len(children):
                nxt = children[i + 1]
                if nxt.kind in (cindex.CursorKind.UNEXPOSED_EXPR, cindex.CursorKind.CALL_EXPR,
                                cindex.CursorKind.DECL_REF_EXPR, cindex.CursorKind.MEMBER_REF_EXPR):
                    fname = k.spelling
                    if fname == "mValue":
                        e = self.expr(nxt, None, cls_name)
                        if e is not None:
                            body.insert(0, {"k": "assign",
                                            "target": {"k": "field",
                                                       "obj": {"k": "this", "cls": cls_name},
                                                       "name": fname},
                                            "value": e})
        sig = "_".join(ty_show(p["ty"]).replace("const ", "").replace("mut ", "") for p in params) or "default"
        name = f"ctor@{sig}"
        self.classes[cls_name]["methods"].append({
            "cls": cls_name, "name": name, "static": False, "ctor": True,
            "params": params, "ret": t_cls(cls_name), "body": body,
            "origin": f"{cls_name}::{cls_name}",
        })

    def lower_fun(self, c):
        name = c.spelling
        params = []
        self.local_types = {}
        for p in c.get_arguments():
            pt = self.param_ty(p.type, None)
            if pt is None:
                if "char" in p.type.spelling:
                    pt = t("cstr")
                elif "unsigned" in p.type.spelling:
                    pt = t("u32")
                else:
                    self.report(f"fun:{name}", f"unmappable param '{p.spelling}'")
                    return
            pname = p.spelling or f"arg{len(params)}"
            params.append({"name": pname, "ty": pt})
            self.local_types[pname] = pt
        ret = self.canon(c.result_type)
        if ret is None and c.result_type.spelling == "void":
            ret = t("void")
        if ret is None:
            self.report(f"fun:{name}", "unmappable return type")
            return
        body = []
        comp = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.COMPOUND_STMT:
                comp = k
        if comp is None:
            return
        self.poisoned = False
        self.stmt(comp, None, body)
        if self.poisoned:
            self.report(f"fun:{name}", "poisoned body — refused")
            return
        self.funs.append({"name": name, "params": params, "ret": ret, "body": body})

    # ------------------------------------------------------------------ pruning
    def call_targets(self, node):
        found = []
        def walk(x):
            if isinstance(x, dict):
                if x.get("k") in ("call", "meth") and x.get("cls"):
                    found.append((x["cls"], x["name"]))
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(node)
        return found

    def prune(self):
        mindex = {}
        for cls in self.classes.values():
            for m in cls["methods"]:
                mindex[(m["cls"], m["name"])] = m
        changed = True
        while changed:
            changed = False
            for key, m in list(mindex.items()):
                for (cls, name) in self.call_targets(m["body"]):
                    if (cls, name) not in mindex:
                        self.report(f"{key}", f"calls dropped method {cls}::{name}")
                        del mindex[key]
                        cls_obj = self.classes.get(m["cls"])
                        if cls_obj:
                            cls_obj["methods"] = [x for x in cls_obj["methods"] if x is not m]
                        changed = True
                        break

    # ------------------------------------------------------------------ emit
    def emit(self, out_ir, out_report):
        classes = []
        for cname in ("Float3", "Float4", "Vec4", "Vec3", "UVec4"):
            if cname in self.classes:
                classes.append(self.classes[cname])
        ir = {"module": "jolt_math", "ir_version": 2, "dialect": "simd",
              "classes": classes, "funs": self.funs}
        with open(out_ir, "w") as f:
            json.dump(ir, f, indent=1)
        with open(out_report, "w") as f:
            for u in self.unsupported:
                f.write(f"{u['symbol']}: {u['reason']}\n")
        n_methods = sum(len(c["methods"]) for c in classes)
        print(f"FE OK: {len(classes)} classes, {n_methods} methods, {len(self.funs)} funs, "
              f"{len(self.unsupported)} unsupported entries")


def main():
    src, incdir, out_ir, out_report = sys.argv[1:5]
    fe = Frontend(src, incdir)
    if not fe.collect():
        sys.exit(2)
    fe.emit(out_ir, out_report)


if __name__ == "__main__":
    main()
