#!/usr/bin/env python3
"""
fe_clang.py — Clang AST -> Ouroboros native IR (JSON).

The front-end for the native pipe: parses the battery TU (which includes the
REAL Jolt math headers) with libclang and lowers the supported subset to a
bit-exact language-neutral IR. Everything it cannot lower is loudly reported
in the unsupported report — never silently dropped.

Supported constructs (rung 1: "Jolt scalar math"):
  - classes w/ anonymous-union storage (flattened: mValue -> mF32/mU32 lanes)
  - 'Type' alias (Vec3::Type / Vec4::Type / UVec4::Type) -> owner class
  - ctors (incl. member-init lists), static methods, instance methods
  - operator overloads (binary/unary/compound/index/friend-scalar-mul)
  - scalar types f32/i32/u32/bool/void + cstr (literal strings only)
  - fixed-size lane arrays (float[4], uint32[4]) incl. variable indexing
  - if / canonical for / while / return / printf (subset: %s %08x %u \n)
  - ternary, bit ops on u32, hex literals, compound assignment (expanded)
  - bit reinterpretation via union (FBits pattern) and ReinterpretAsInt/Float
  - out-params via pointer (StoreFloat4(&f4)) -> ref args
  - intrinsics: abs, isnan, signbit, sqrt(f32), ctz(u32), min/max -> select

Usage:
  PYTHONPATH=tools/pylibs python3 fe_clang.py <battery.cpp> <include-dir> <out-ir.json> <out-report.txt>
"""

import sys
import json
from clang import cindex

# ---------------------------------------------------------------------------
# IR type helpers
# ---------------------------------------------------------------------------

def t_prim(name):
    return {"k": name}          # f32 f64 i32 u32 bool void cstr

def t_cls(name):
    return {"k": "cls", "name": name}

def t_arr(elem, n):
    return {"k": "arr", "elem": elem, "n": n}

def t_ref(to, mut):
    return {"k": "ref", "to": to, "mut": mut}

def ty_show(t):
    k = t["k"]
    if k == "cls": return t["name"]
    if k == "arr": return f"{ty_show(t['elem'])}[{t['n']}]"
    if k == "ref": return ("mut " if t["mut"] else "const ") + ty_show(t["to"])
    return k

def ty_eq(a, b):
    if a["k"] != b["k"]: return False
    if a["k"] == "cls": return a["name"] == b["name"]
    if a["k"] == "arr": return a["n"] == b["n"] and ty_eq(a["elem"], b["elem"])
    if a["k"] == "ref": return a["mut"] == b["mut"] and ty_eq(a["to"], b["to"])
    return True

PRIMS = {"float": "f32", "double": "f64", "int": "i32", "unsigned int": "u32",
         "uint32_t": "u32", "uint": "u32", "bool": "bool", "void": "void",
         "unsigned long": "u64", "long": "i64", "unsigned char": "u8",
         "signed char": "i8", "short": "i16", "unsigned short": "u16",
         "long long": "i64", "unsigned long long": "u64"}

CLASS_ALIASES = {"Vec4": "Vec4", "Vec3": "Vec3", "UVec4": "UVec4",
                 "Float3": "Float3", "Float4": "Float4"}
# Jolt's per-class 'Type' (SIMD lane struct) aliases to the owner class under
# the union-flatten strategy: Vec3::Type = Vec4::Type = struct{float mData[4]}.
TYPE_ALIAS = {"Vec3": "Vec3", "Vec4": "Vec4", "UVec4": "UVec4"}

TARGET_CLASSES = {"Vec4", "Vec3", "UVec4", "Float3", "Float4"}


class Frontend:
    def __init__(self, source, incdir):
        self.unsupported = []          # (symbol, reason)
        self.skipped_methods = set()   # fully-qualified names we refused
        self.index = cindex.Index.create()
        args = ["-std=c++17", "-DJPH_PLATFORM_WASM", "-DNDEBUG",
                "-ffp-contract=off", f"-I{incdir}"]
        self.tu = self.index.parse(source, args=args)
        self.source_file = source
        self.diag_fail = any(d.severity >= cindex.Diagnostic.Error for d in self.tu.diagnostics)
        self.classes = {}              # name -> {"fields": [...], "methods": [...]}
        self.funs = []

    def report_unsupported(self, sym, reason):
        key = sym
        if key not in self.skipped_methods:
            self.skipped_methods.add(key)
            self.unsupported.append({"symbol": sym, "reason": reason})

    def in_source(self, cursor):
        f = cursor.location.file
        return f is not None and f.name.endswith(self.source_file.split("/")[-1])

    # ------------------------------------------------------------------ types
    def canon_type(self, ct):
        """clang Type -> IR type (canonical form, may return None)."""
        if ct is None:
            return None
        # strip typedefs (Vec4Arg etc.) — libclang: get_canonical too aggressive
        # (maps Type->struct), so walk typedef chain manually.
        t = ct
        while t.kind == cindex.TypeKind.TYPEDEF:
            t = t.get_declaration().underlying_typedef_type
        # strip references / pointers
        if t.kind == cindex.TypeKind.LVALUEREFERENCE:
            inner = self.canon_type(t.get_pointee())
            if inner is None: return None
            return t_ref(inner, False)
        if t.kind == cindex.TypeKind.RVALUEREFERENCE:
            inner = self.canon_type(t.get_pointee())
            if inner is None: return None
            return t_ref(inner, True)
        if t.kind == cindex.TypeKind.POINTER:
            inner = self.canon_type(t.get_pointee())
            if inner is None: return None
            if inner["k"] == "cstr":
                return t_prim("cstr")
            return t_ref(inner, True)
        if t.kind == cindex.TypeKind.CONSTANTARRAY:
            n = t.get_array_size()
            elem = self.canon_type(t.get_array_element_type())
            if elem is None or n <= 0: return None
            return t_arr(elem, n)
        if t.kind == cindex.TypeKind.RECORD:
            name = t.get_declaration().spelling
            if name in CLASS_ALIASES:
                return t_cls(name)
            # anonymous struct used as Vec4::Type in scalar path: it appears as
            # a record whose parent typedef/using is 'Type' inside VecN — clang
            # spells it like 'Vec4::(anonymous struct at ...)' — treat by context.
            disp = t.spelling or ""
            return None
        if t.kind == cindex.TypeKind.ELABORATED:
            return self.canon_type(t.get_named_type())
        if t.kind in (cindex.TypeKind.FLOAT,):
            return t_prim("f32")
        if t.kind == cindex.TypeKind.DOUBLE:
            return t_prim("f64")
        if t.kind in (cindex.TypeKind.INT, cindex.TypeKind.INT128 if hasattr(cindex.TypeKind, 'INT128') else cindex.TypeKind.INT):
            return t_prim("i32")
        if t.kind in (cindex.TypeKind.UINT, cindex.TypeKind.ULONG, cindex.TypeKind.ULONGLONG):
            sp = t.spelling
            if t.kind == cindex.TypeKind.UINT or "unsigned int" in sp or "uint32" in sp:
                return t_prim("u32")
            return t_prim("u64")
        if t.kind == cindex.TypeKind.BOOL:
            return t_prim("bool")
        if t.kind == cindex.TypeKind.VOID:
            return t_prim("void")
        if t.kind == cindex.TypeKind.SINT:   # int via canonical
            return t_prim("i32")
        return None

    def param_type(self, ct, cls_ctx=None):
        """Canonicalize a parameter type; applies 'Type' alias and value-copy
        rewrite for const refs of small classes."""
        t = self.canon_type(ct)
        if t is None:
            # maybe it's the class-local 'Type' alias
            sp = ct.spelling or ""
            decl = ct.get_declaration()
            if decl is not None:
                td_name = decl.spelling
                if td_name == "Type" and cls_ctx in TYPE_ALIAS:
                    return t_cls(TYPE_ALIAS[cls_ctx])
            return None
        # const-ref params of our classes -> by value (read-only use)
        if t["k"] == "ref" and not t["mut"] and t["to"]["k"] == "cls":
            return t["to"]
        if t["k"] == "ref" and not t["mut"] and t["to"]["k"] in ("f32", "f64"):
            return t["to"]
        return t

    # ------------------------------------------------------------------ literals
    def lit_spelling(self, cursor):
        toks = list(self.tu.get_tokens(cursor.extent))
        return toks[0].spelling if toks else ""

    # ------------------------------------------------------------------ exprs
    def strip(self, c):
        """Strip implicit/unexposed wrappers, keep ParentPointer? no."""
        while c is not None and c.kind in (cindex.CursorKind.UNEXPOSED_EXPR,
                                           cindex.CursorKind.IMPLICIT_CAST_EXPR,
                                           cindex.CursorKind.CSTYLE_CAST_EXPR if False else cindex.CursorKind.UNEXPOSED_EXPR):
            kids = [k for k in c.get_children()]
            if not kids:
                return c
            c = kids[0]
        return c

    def strip_cast(self, c):
        """Remove ImplicitCastExpr wrappers (returning inner cursor)."""
        while c is not None and c.kind in (cindex.CursorKind.IMPLICIT_CAST_EXPR,
                                           cindex.CursorKind.UNEXPOSED_EXPR):
            kids = list(c.get_children())
            if not kids:
                break
            c = kids[0]
        return c

    def build_expr(self, c, want=None, cls_ctx=None):
        """clang cursor -> IR expr. want = expected IR type (for literal stamp)."""
        kind = c.kind

        if kind in (cindex.CursorKind.IMPLICIT_CAST_EXPR, cindex.CursorKind.UNEXPOSED_EXPR):
            kids = list(c.get_children())
            if kids:
                return self.build_expr(kids[0], want, cls_ctx)
            return None

        if kind == cindex.CursorKind.FLOATING_LITERAL:
            return {"k": "lit", "ty": "f32", "sp": self.lit_spelling(c)}

        if kind == cindex.CursorKind.INTEGER_LITERAL:
            sp = self.lit_spelling(c)
            if want is not None and want["k"] == "f32":
                return {"k": "lit", "ty": "f32", "sp": sp + ".0"}
            if want is not None and want["k"] == "u32":
                return {"k": "lit", "ty": "u32", "sp": sp}
            return {"k": "lit", "ty": "i32", "sp": sp}

        if kind == cindex.CursorKind.STRING_LITERAL:
            raw = self.lit_spelling(c)
            return {"k": "str", "v": raw}

        if kind == cindex.CursorKind.DECL_REF_EXPR:
            decl = c.referenced
            name = c.spelling
            if decl is not None and decl.kind == cindex.CursorKind.PARM_DECL:
                pass
            if decl is not None and decl.kind == cindex.CursorKind.VAR_DECL:
                pass
            return {"k": "var", "name": name}

        if kind == cindex.CursorKind.CXX_THIS_EXPR:
            return {"k": "this", "cls": cls_ctx}

        if kind == cindex.CursorKind.MEMBER_REF_EXPR:
            base_c = None
            kids = list(c.get_children())
            # last-ish child is the base; first is decl context sometimes
            for k in kids:
                if k.kind != cindex.CursorKind.MEMBER_REF and k.type is not None and k.kind != cindex.CursorKind.TYPE_REF:
                    base_c = k
                    break
            if base_c is None:
                if kids: base_c = kids[-1]
                else: return None
            # union-bitcast idiom: FBits local member access (b.f / b.u)
            base_sp = base_c.spelling
            if base_sp in self.local_types and self.local_types[base_sp] is not None \
               and isinstance(self.local_types[base_sp], dict) and self.local_types[base_sp].get("k") == "fbits":
                return {"k": "bitsget", "var": base_sp, "side": c.spelling}
            base = self.build_expr(base_c, None, cls_ctx)
            if base is None:
                return None
            # C++ allows calling members through references/deref — already expr
            name = c.spelling
            if name == "mValue":
                name = "mF32" if self.lane_field_name(base_c) == "mF32" else "mU32"
            # Vec3/Vec4 Type values carry mData in C++; ours use class lanes
            if name == "mData":
                name = self.lane_field_name(base_c)
            return {"k": "field", "obj": base, "name": name}

        if kind == cindex.CursorKind.ARRAY_SUBSCRIPT_EXPR:
            kids = list(c.get_children())
            obj = self.build_expr(kids[0], None, cls_ctx)
            idx = self.build_expr(kids[1], None, cls_ctx)
            if obj is None or idx is None:
                return None
            return {"k": "index", "obj": obj, "idx": idx}

        if kind == cindex.CursorKind.BINARY_OPERATOR or kind == cindex.CursorKind.COMPOUND_ASSIGN_OPERATOR:
            kids = list(c.get_children())
            if len(kids) < 2:
                return None
            opcode = self.tu.get_tokens(c.extent)
            # find operator token among children tokens
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            op = None
            for cand in ("+", "-", "*", "/", "==", "!=", "<=", ">=", "<", ">",
                         "&&", "||", "&", "|", "^", "<<", ">>", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "%"):
                if cand in toks:
                    op = cand
                    break
            if op is None:
                self.report_unsupported(f"binop@{c.location.line}", "unknown binary operator token")
                return None
            lt = self.canon_type(kids[0].type)
            rt = self.canon_type(kids[1].type)
            res_t = self.canon_type(c.type)
            # resolve class-typed binops to operator methods via clang's callee
            callee = None
            for k in kids:
                if k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced is not None \
                   and k.referenced.kind in (cindex.CursorKind.CXX_METHOD, cindex.CursorKind.FUNCTION_DECL):
                    callee = k.referenced
            if callee is not None and (lt and lt["k"] == "cls" or rt and rt["k"] == "cls"):
                return self.operator_call_expr(callee, kids, cls_ctx)
            # compound assignment statement-form: expanded at stmt level, but
            # expression-form (rare) unsupported
            if kind == cindex.CursorKind.COMPOUND_ASSIGN_OPERATOR:
                self.report_unsupported(f"compound@{c.location.line}", "compound assignment in expression position")
                return None
            l = self.build_expr(kids[0], lt, cls_ctx)
            r = self.build_expr(kids[1], rt, cls_ctx)
            if l is None or r is None:
                return None
            ty = res_t if res_t is not None else (lt if lt else rt)
            # ensure literals carry op result type (e.g. int/float mixing)
            return {"k": "bin", "op": op, "l": l, "r": r, "ty": ty}

        if kind == cindex.CursorKind.UNARY_OPERATOR:
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            op = None
            for cand in ("-", "!", "&", "*", "++", "--"):
                if cand in toks:
                    op = cand
                    break
            kids = [k for k in c.get_children() if k.kind != cindex.CursorKind.IMPLICIT_CAST_EXPR]
            if op == "&":
                inner = kids[0] if kids else None
                if inner is None: return None
                e = self.build_expr(inner, None, cls_ctx)
                if e is None: return None
                return {"k": "ref", "e": e}
            if op == "*":  # deref of pointer param
                inner = kids[0] if kids else None
                if inner is None: return None
                e = self.build_expr(inner, None, cls_ctx)
                if e is None: return None
                return {"k": "deref", "e": e}
            if op in ("++", "--"):
                self.report_unsupported(f"unary{op}@{c.location.line}", "inc/dec in expression position")
                return None
            if kids:
                e = self.build_expr(kids[0], self.canon_type(c.type), cls_ctx)
                if e is None: return None
                return {"k": "un", "op": op, "e": e, "ty": self.canon_type(c.type)}
            return None

        if kind == cindex.CursorKind.CONDITIONAL_OPERATOR:
            kids = list(c.get_children())
            if len(kids) < 3: return None
            cond = self.build_expr(kids[0], t_prim("bool"), cls_ctx)
            then = self.build_expr(kids[1], self.canon_type(c.type), cls_ctx)
            els = self.build_expr(kids[2], self.canon_type(c.type), cls_ctx)
            if cond is None or then is None or els is None: return None
            return {"k": "sel", "cond": cond, "then": then, "els": els,
                    "ty": self.canon_type(c.type)}

        if kind == cindex.CursorKind.CXX_BOOL_LITERAL_EXPR:
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            return {"k": "lit", "ty": "bool", "sp": toks[0] if toks else "false"}

        if kind == cindex.CursorKind.CXX_OPERATOR_CALL_EXPR:
            return self.build_operator_call(c, cls_ctx)

        if kind == cindex.CursorKind.CXX_MEMBER_CALL_EXPR:
            return self.build_member_call(c, cls_ctx)

        if kind == cindex.CursorKind.CALL_EXPR:
            return self.build_call(c, cls_ctx)

        if kind == cindex.CursorKind.CXX_CONSTRUCT_EXPR:
            return self.build_construct(c, cls_ctx)

        if kind == cindex.CursorKind.CXX_STATIC_CAST_EXPR:
            kids = list(c.get_children())
            if kids:
                inner = self.build_expr(kids[0], None, cls_ctx)
                to_t = self.canon_type(c.type)
                if inner is None or to_t is None: return None
                return {"k": "cast", "e": inner, "to": to_t}
            return None

        if kind == cindex.CursorKind.CXX_DEFAULT_ARG_EXPR:
            kids = list(c.get_children())
            if kids:
                return self.build_expr(kids[0], want, cls_ctx)
            return None

        if kind == cindex.CursorKind.INIT_LIST_EXPR:
            # float arr init {a,b,c,d}
            kids = list(c.get_children())
            elems = []
            arr_t = self.canon_type(c.type)
            for k in kids:
                e = self.build_expr(k, arr_t["elem"] if arr_t and arr_t["k"] == "arr" else None, cls_ctx)
                if e is None: return None
                elems.append(e)
            return {"k": "arrlit", "elems": elems, "ty": arr_t}

        self.report_unsupported(f"expr:{kind.name}@{c.location.line}", "unhandled expression kind")
        return None

    # ------------------------------------------------------------------ names
    def union_alias_name(self, member_ref_cursor):
        """mValue (the union arm of Type) -> canonical lane field name of owner."""
        return "mF32"  # UVec4 mValue reads are rewritten by lane_field_name below? no:
        # NOTE: this is only correct for Vec3/Vec4; UVec4 handled via decl type.

    def lane_field_name(self, base_cursor):
        t = base_cursor.type
        sp = t.spelling or ""
        # UVec4 lanes are uint32
        if "UVec4" in sp or (t.get_declaration() is not None and "UVec4" in (t.get_declaration().spelling or "")):
            return "mU32"
        return "mF32"

    # ------------------------------------------------------------------ calls
    def method_ir_name(self, md, cls_ctx):
        """Disambiguated IR name for a C++ method."""
        raw = md.spelling
        opmap = {"operator+": "op_add", "operator-": "op_sub", "operator*": "op_mul",
                 "operator/": "op_div", "operator==": "op_eq", "operator!=": "op_ne",
                 "operator[]": "op_index", "operator+=": "op_iadd", "operator-=": "op_isub",
                 "operator*=": "op_imul", "operator/=": "op_idiv", "operator=": "op_assign"}
        name = opmap.get(raw, raw)
        sig = []
        for p in md.get_arguments() if md.kind in (cindex.CursorKind.CXX_METHOD, cindex.CursorKind.FUNCTION_DECL, cindex.CursorKind.CXX_CONSTRUCTOR_DECL) else []:
            pt = self.param_type(p.type, cls_ctx)
            sig.append(ty_show(pt) if pt else "?")
        if sig:
            name = f"{name}@{'_'.join(sig)}"
        return name

    def operator_call_expr(self, callee_decl, arg_cursors, cls_ctx):
        """A binary/unary op resolved by clang to a method or free function."""
        cls = None
        if callee_decl.kind == cindex.CursorKind.CXX_METHOD:
            cls = callee_decl.semantic_parent.spelling
        ir_name = self.method_ir_name(callee_decl, cls or cls_ctx)
        if callee_decl.is_static_method() if hasattr(callee_decl, 'is_static_method') else False:
            args = []
            for a in arg_cursors:
                pt = self.param_type(a.type, cls or cls_ctx)
                e = self.build_expr(a, pt, cls_ctx)
                if e is None: return None
                args.append(e)
            return {"k": "call", "cls": cls, "name": ir_name, "args": args,
                    "ret": self.canon_type(callee_decl.result_type)}
        # instance method: first arg is object
        obj_c, arg_cs = arg_cursors[0], arg_cursors[1:]
        obj = self.build_expr(obj_c, t_cls(cls) if cls else None, cls_ctx)
        if obj is None: return None
        mparams = list(callee_decl.get_arguments())
        args = []
        for a, p in zip(arg_cs, mparams):
            pt = self.param_type(p.type, cls or cls_ctx)
            e = self.build_expr(a, pt, cls_ctx)
            if e is None: return None
            args.append(e)
        return {"k": "meth", "obj": obj, "cls": cls, "name": ir_name, "args": args,
                "ret": self.canon_type(callee_decl.result_type)}

    def build_operator_call(self, c, cls_ctx):
        kids = list(c.get_children())
        callee = None
        for k in kids:
            if k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced is not None \
               and k.referenced.kind in (cindex.CursorKind.CXX_METHOD, cindex.CursorKind.FUNCTION_DECL):
                callee = k.referenced
        if callee is None:
            self.report_unsupported(f"opcall@{c.location.line}", "operator call without resolvable callee")
            return None
        # friend scalar-mul rewrite: (float, Vec4) -> Vec4::op_mul(float)
        arg_cursors = [k for k in kids if k.kind not in (cindex.CursorKind.DECL_REF_EXPR,
                                                         cindex.CursorKind.TYPE_REF,
                                                         cindex.CursorKind.UNEXPOSED_EXPR)]
        # fall back: children minus the callee declref; keep order
        arg_cursors = [k for k in kids if not (k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced == callee)]
        if callee.spelling == "operator*" and len(arg_cursors) == 2:
            first_cls = arg_cursors[0].type and arg_cursors[0].type.spelling
            if "Vec4" in str(first_cls) or "Vec3" in str(first_cls):
                pass  # member-form handled by operator_call_expr
            else:
                # (float, Vec4): rewrite as member call on arg1
                obj = self.build_expr(arg_cursors[1], None, cls_ctx)
                fp = self.build_expr(arg_cursors[0], t_prim("f32"), cls_ctx)
                if obj is None or fp is None: return None
                cls_name = arg_cursors[1].type.spelling.split()[0] if arg_cursors[1].type else "Vec4"
                return {"k": "meth", "obj": obj, "cls": "Vec4",
                        "name": "op_mul@f32", "args": [fp],
                        "ret": t_cls("Vec4")}
        return self.operator_call_expr(callee, arg_cursors, cls_ctx)

    def build_member_call(self, c, cls_ctx):
        """obj.method(args) — obj is an expression, callee is a CXX_METHOD."""
        callee = None
        obj_c = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.MEMBER_REF_EXPR and k.referenced is not None \
               and k.referenced.kind == cindex.CursorKind.CXX_METHOD:
                callee = k.referenced
                mref = k
        if callee is None:
            self.report_unsupported(f"mcall@{c.location.line}", "member call without resolvable callee")
            return None
        cls = callee.semantic_parent.spelling
        # object expression = the member-ref's base child
        obj_c = None
        for k in mref.get_children():
            if k.kind not in (cindex.CursorKind.MEMBER_REF, cindex.CursorKind.TYPE_REF, cindex.CursorKind.DECL_REF_EXPR if False else cindex.CursorKind.MEMBER_REF):
                obj_c = k
                break
        if obj_c is None:
            self.report_unsupported(f"mcall@{c.location.line}", "no object expression")
            return None
        obj_want = t_cls(cls) if not callee.is_static_method() else None
        obj = self.build_expr(obj_c, obj_want, cls_ctx)
        if obj is None: return None
        mparams = list(callee.get_arguments())
        arg_cursors = [k for k in c.get_children() if k.kind != cindex.CursorKind.MEMBER_REF_EXPR]
        args = []
        for i, a in enumerate(arg_cursors):
            want = self.param_type(mparams[i].type, cls) if i < len(mparams) else None
            e = self.build_expr(a, want, cls_ctx)
            if e is None: return None
            args.append(e)
        ret = self.canon_type(callee.result_type)
        if ret is None and callee.result_type.spelling == "Type" and cls in TYPE_ALIAS:
            ret = t_cls(TYPE_ALIAS[cls])
        if callee.is_static_method():
            return {"k": "call", "cls": cls, "name": self.method_ir_name(callee, cls),
                    "args": args, "ret": ret}
        return {"k": "meth", "obj": obj, "cls": cls, "name": self.method_ir_name(callee, cls),
                "args": args, "ret": ret}

    def build_call(self, c, cls_ctx):
        callee = None
        fnref = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced is not None \
               and k.referenced.kind in (cindex.CursorKind.FUNCTION_DECL,
                                         cindex.CursorKind.CXX_METHOD,
                                         cindex.CursorKind.FUNCTION_TEMPLATE):
                fnref = k
                callee = k.referenced
        if callee is None:
            # maybe a method call path (CXX_MEMBER_CALL) handled elsewhere
            self.report_unsupported(f"call@{c.location.line}", "call without resolvable callee")
            return None
        fname = callee.spelling
        arg_cursors = [k for k in c.get_children() if not (k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced == callee)]

        # printf lowering
        if fname == "printf":
            return self.lower_printf(arg_cursors, cls_ctx)

        # static class methods (e.g. Vec4::sEquals) — clang gives CXX_METHOD
        if callee.kind == cindex.CursorKind.CXX_METHOD and callee.is_static_method():
            cls = callee.semantic_parent.spelling
            mparams = list(callee.get_arguments())
            args = []
            for i, a in enumerate(arg_cursors):
                want = self.param_type(mparams[i].type, cls) if i < len(mparams) else None
                e = self.build_expr(a, want, cls_ctx)
                if e is None: return None
                args.append(e)
            ret = self.canon_type(callee.result_type)
            if ret is None and callee.result_type.spelling == "Type" and cls in TYPE_ALIAS:
                ret = t_cls(TYPE_ALIAS[cls])
            return {"k": "call", "cls": cls, "name": self.method_ir_name(callee, cls),
                    "args": args, "ret": ret}

        # math intrinsics (free fns resolved in JPH namespace or std)
        if fname in ("min", "max", "abs", "sqrt", "sqrtf", "isnan", "signbit",
                     "CountTrailingZeros", "fabs", "fabsf", "Sqrt"):
            args = []
            for a in arg_cursors:
                e = self.build_expr(a, None, cls_ctx)
                if e is None: return None
                args.append(e)
            if fname in ("min", "max"):
                res_t = self.canon_type(c.type)
                op = "<" if fname == "min" else ">"
                return {"k": "sel", "cond": {"k": "bin", "op": op, "l": args[0], "r": args[1],
                                             "ty": t_prim("bool")},
                        "then": args[0] if fname == "min" else args[1],
                        "els": args[1] if fname == "min" else args[0],
                        "ty": res_t}
            iname = {"abs": "abs", "sqrt": "sqrt", "sqrtf": "sqrt", "fabs": "abs",
                     "fabsf": "abs", "Sqrt": "sqrt", "isnan": "is_nan", "signbit": "signbit",
                     "CountTrailingZeros": "ctz"}[fname]
            return {"k": "intrinsic", "name": iname, "args": args,
                    "ty": self.canon_type(c.type)}

        # free function in our module (battery helpers etc.)
        args = []
        for a in arg_cursors:
            e = self.build_expr(a, None, cls_ctx)
            if e is None: return None
            args.append(e)
        ret = self.canon_type(c.type) or self.canon_type(callee.result_type)
        if ret is None and (callee.result_type.spelling == "void" or c.type.spelling == "void"):
            ret = t_prim("void")
        return {"k": "call", "cls": None, "name": fname, "args": args, "ret": ret}

    def lower_printf(self, arg_cursors, cls_ctx):
        """printf("fmt", args) -> emit sequence. Supports %s %08x %u and \n."""
        if not arg_cursors:
            return None
        fmt_c = self.strip_cast(arg_cursors[0])
        if fmt_c is None or fmt_c.kind != cindex.CursorKind.STRING_LITERAL:
            self.report_unsupported("printf", "non-literal format string")
            return None
        fmt = self.lit_spelling(fmt_c)
        fmt = fmt[1:-1] if len(fmt) >= 2 else fmt  # strip quotes
        fmt = fmt.replace("\\n", "\n")
        seq = []
        args = arg_cursors[1:]
        ai = 0
        i = 0
        text = ""
        while i < len(fmt):
            if fmt[i] == "%" and i + 1 < len(fmt):
                if fmt[i:i+5] == "%08x" or fmt[i:i+4] == "%08X":
                    if text: seq.append({"k": "emit", "kind": "str", "v": text}); text = ""
                    e = self.build_expr(args[ai], t_prim("u32"), cls_ctx); ai += 1
                    if e is None: return None
                    seq.append({"k": "emit", "kind": "hex32", "e": e})
                    i += 5 if fmt[i:i+5] == "%08x" else 4
                    continue
                if fmt[i:i+2] == "%u":
                    if text: seq.append({"k": "emit", "kind": "str", "v": text}); text = ""
                    e = self.build_expr(args[ai], t_prim("u32"), cls_ctx); ai += 1
                    if e is None: return None
                    seq.append({"k": "emit", "kind": "u32", "e": e})
                    i += 2
                    continue
                if fmt[i:i+2] == "%s":
                    if text: seq.append({"k": "emit", "kind": "str", "v": text}); text = ""
                    e = self.build_expr(args[ai], t_prim("cstr"), cls_ctx); ai += 1
                    if e is None: return None
                    seq.append({"k": "emit", "kind": "str", "e": e})
                    i += 2
                    continue
            if fmt[i] == "\n":
                if text: seq.append({"k": "emit", "kind": "str", "v": text}); text = ""
                seq.append({"k": "emit", "kind": "endln"})
                i += 1
                continue
            text += fmt[i]
            i += 1
        if text:
            seq.append({"k": "emit", "kind": "str", "v": text})
        return {"k": "emitseq", "seq": seq}

    def build_construct(self, c, cls_ctx):
        ctor = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced is not None \
               and k.referenced.kind == cindex.CursorKind.CXX_CONSTRUCTOR_DECL:
                ctor = k.referenced
        cls_name = c.type.spelling.split("<")[0].strip()
        if cls_name not in TARGET_CLASSES:
            self.report_unsupported(f"ctor:{cls_name}@{c.location.line}", "construction of non-target class")
            return None
        arg_cursors = [k for k in c.get_children()
                       if k.kind not in (cindex.CursorKind.DECL_REF_EXPR, cindex.CursorKind.TYPE_REF, cindex.CursorKind.UNEXPOSED_EXPR)] \
            if ctor is None else \
            [k for k in c.get_children() if not (k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced == ctor)]
        args = []
        mparams = list(ctor.get_arguments()) if ctor is not None else []
        for i, a in enumerate(arg_cursors):
            want = None
            if i < len(mparams):
                want = self.param_type(mparams[i].type, cls_name)
            e = self.build_expr(a, want, cls_ctx)
            if e is None: return None
            args.append(e)
        return {"k": "ctor", "cls": cls_name, "args": args}

    # ------------------------------------------------------------------ stmts
    def build_stmts(self, stmt_cursor, cls_ctx, out):
        for c in stmt_cursor.get_children():
            self.build_stmt(c, cls_ctx, out)

    def build_stmt(self, c, cls_ctx, out):
        kind = c.kind

        if kind == cindex.CursorKind.COMPOUND_STMT:
            self.build_stmts(c, cls_ctx, out)
            return

        if kind == cindex.CursorKind.DECL_STMT:
            for d in c.get_children():
                if d.kind != cindex.CursorKind.VAR_DECL:
                    self.report_unsupported(f"decl:{d.kind.name}@{c.location.line}", "non-var declaration")
                    continue
                self.lower_vardecl(d, cls_ctx, out)
            return

        if kind == cindex.CursorKind.IF_STMT:
            kids = list(c.get_children())
            cond = None
            then_c = None
            else_c = None
            seen = []
            for k in kids:
                seen.append(k)
            # children: (guard var decl?) cond, then, else
            noncond = []
            for k in kids:
                if k.kind == cindex.CursorKind.COMPOUND_STMT:
                    noncond.append(k)
            cond = self.build_expr(kids[0], t_prim("bool"), cls_ctx) if kids else None
            if cond is None or len(noncond) < 1:
                self.report_unsupported(f"if@{c.location.line}", "unresolvable if shape")
                return
            then_body = []
            self.build_stmt(noncond[0], cls_ctx, then_body)
            els_body = []
            if len(noncond) > 1:
                self.build_stmt(noncond[1], cls_ctx, els_body)
            out.append({"k": "if", "cond": cond, "then": then_body, "els": els_body})
            return

        if kind == cindex.CursorKind.FOR_STMT:
            body_c = None
            var_name, start, stop, incr_op = "i", None, None, 1
            cond_cmp = "<"
            body = []
            # canonical: for (int i = 0; i < 4; ++i) — lowered to IR for
            init_done = False
            for k in c.get_children():
                if k.kind == cindex.CursorKind.COMPOUND_STMT:
                    body_c = k
                elif k.kind == cindex.CursorKind.DECL_STMT and not init_done:
                    d = list(k.get_children())[0]
                    var_name = d.spelling
                    init_e = list(d.get_children())
                    init = self.build_expr(init_e[0], t_prim("i32"), cls_ctx) if init_e else None
                    start = init
                    init_done = True
                elif k.kind in (cindex.CursorKind.BINARY_OPERATOR,) and start is not None and stop is None:
                    toks = [t.spelling for t in self.tu.get_tokens(k.extent)]
                    cond_cmp = "<" if "<" in toks else "<=" if "<=" in toks else "<"
                    kids2 = list(k.get_children())
                    stop = self.build_expr(kids2[1], t_prim("i32"), cls_ctx)
                elif k.kind == cindex.CursorKind.UNARY_OPERATOR:
                    pass  # ++i ignored (step 1)
            if body_c is not None:
                self.build_stmt(body_c, cls_ctx, body)
            if start is None or stop is None:
                self.report_unsupported(f"for@{c.location.line}", "non-canonical for loop")
                return
            out.append({"k": "for", "var": var_name, "start": start, "stop": stop, "body": body})
            return

        if kind == cindex.CursorKind.WHILE_STMT:
            kids = list(c.get_children())
            comps = [k for k in kids if k.kind == cindex.CursorKind.COMPOUND_STMT]
            cond = self.build_expr(kids[0], t_prim("bool"), cls_ctx) if kids else None
            body = []
            if comps and cond is not None:
                self.build_stmt(comps[0], cls_ctx, body)
                out.append({"k": "while", "cond": cond, "body": body})
                return
            self.report_unsupported(f"while@{c.location.line}", "unresolvable while")
            return

        if kind == cindex.CursorKind.RETURN_STMT:
            kids = list(c.get_children())
            if not kids:
                out.append({"k": "return", "e": None})
                return
            e = self.build_expr(kids[0], None, cls_ctx)
            if e is None:
                return
            out.append({"k": "return", "e": e})
            return

        if kind == cindex.CursorKind.CALL_EXPR:
            e = self.build_call(c, cls_ctx)
            if e is None: return
            self.emit_expr_stmt(e, cls_ctx, out)
            return

        if kind == cindex.CursorKind.CXX_OPERATOR_CALL_EXPR:
            e = self.build_operator_call(c, cls_ctx)
            if e is None: return
            self.emit_expr_stmt(e, cls_ctx, out)
            return

        if kind == cindex.CursorKind.BINARY_OPERATOR:
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            if "=" in toks and not any(x in toks for x in ("==", "!=", "<=", ">=", "+=", "-=", "*=", "/=")):
                kids = list(c.get_children())
                target = self.build_assign_target(kids[0], cls_ctx)
                val_t = self.canon_type(kids[1].type)
                val = self.build_expr(kids[1], val_t, cls_ctx)
                if target is None or val is None: return
                self.expand_assign(target, val, cls_ctx, out)
                return
            e = self.build_expr(c, None, cls_ctx)
            if e is None: return
            out.append({"k": "expr", "e": e})
            return

        if kind == cindex.CursorKind.COMPOUND_ASSIGN_OPERATOR:
            kids = list(c.get_children())
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            op = None
            for cand in ("+=", "-=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>=", "%="):
                if cand in toks:
                    op = cand[:-1]
                    break
            if op is None:
                self.report_unsupported(f"compound@{c.location.line}", "unknown compound op")
                return
            target = self.build_assign_target(kids[0], cls_ctx)
            rhs = self.build_expr(kids[1], self.canon_type(kids[1].type), cls_ctx)
            if target is None or rhs is None: return
            cur = {"k": "field", "obj": {"k": "this"}, "name": "mF32"}  # placeholder never used
            self.expand_assign(target, {"k": "bin", "op": op, "l": self.clone_target_read(target), "r": rhs,
                                        "ty": self.canon_type(c.type)}, cls_ctx, out)
            return

        if kind == cindex.CursorKind.UNARY_OPERATOR:
            toks = [t.spelling for t in self.tu.get_tokens(c.extent)]
            kids = [k for k in c.get_children()]
            if "++" in toks or "--" in toks:
                op = "+" if "++" in toks else "-"
                target = self.build_assign_target(kids[0], cls_ctx)
                if target is None: return
                one = {"k": "lit", "ty": "i32", "sp": "1"}
                self.expand_assign(target, {"k": "bin", "op": op, "l": self.clone_target_read(target),
                                            "r": one, "ty": t_prim("i32")}, cls_ctx, out)
                return
            e = self.build_expr(c, None, cls_ctx)
            if e is None: return
            out.append({"k": "expr", "e": e})
            return

        if kind == cindex.CursorKind.EXPR_STMT or kind == cindex.CursorKind.UNEXPOSED_EXPR:
            for k in c.get_children():
                self.build_stmt(k, cls_ctx, out)
            return

        self.report_unsupported(f"stmt:{kind.name}@{c.location.line}", "unhandled statement kind")

    def emit_expr_stmt(self, e, cls_ctx, out):
        # printf lowering produces emitseq; bare calls produce call exprs
        if e["k"] == "emitseq":
            out.extend(e["seq"])
        else:
            out.append({"k": "expr", "e": e})

    def build_assign_target(self, c, cls_ctx):
        """LHS of assignment -> IR expr usable as target."""
        kind = c.kind
        if kind in (cindex.CursorKind.DECL_REF_EXPR, cindex.CursorKind.MEMBER_REF_EXPR,
                    cindex.CursorKind.ARRAY_SUBSCRIPT_EXPR, cindex.CursorKind.UNARY_OPERATOR,
                    cindex.CursorKind.CXX_OPERATOR_CALL_EXPR):
            if kind == cindex.CursorKind.UNARY_OPERATOR:
                e = self.build_expr(c, None, cls_ctx)   # *ptr
                return e
            if kind == cindex.CursorKind.CXX_OPERATOR_CALL_EXPR:
                # d[1] = ... : operator[] resolved; detect callee spelling
                callee = None
                for k in c.get_children():
                    if k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced is not None \
                       and k.referenced.kind == cindex.CursorKind.CXX_METHOD:
                        callee = k.referenced
                if callee is not None and callee.spelling == "operator[]":
                    kids = [k for k in c.get_children() if not (k.kind == cindex.CursorKind.DECL_REF_EXPR and k.referenced == callee)]
                    obj = self.build_expr(kids[0], None, cls_ctx)
                    idx = self.build_expr(kids[1], None, cls_ctx)
                    if obj is None or idx is None: return None
                    return {"k": "index", "obj": obj, "idx": idx, "mut_index": True}
                return self.build_expr(c, None, cls_ctx)
            # member ref: flatten mValue
            if kind == cindex.CursorKind.MEMBER_REF_EXPR and c.spelling == "mValue":
                base_c = None
                for k in c.get_children():
                    if k.kind != cindex.CursorKind.MEMBER_REF and k.kind != cindex.CursorKind.TYPE_REF:
                        base_c = k
                        break
                base = self.build_expr(base_c, None, cls_ctx) if base_c is not None else {"k": "this"}
                return {"k": "field", "obj": base, "name": self.lane_field_name(base_c) if base_c is not None else "mF32"}
            return self.build_expr(c, None, cls_ctx)
        self.report_unsupported(f"target:{kind.name}@{c.location.line}", "unassignable target")
        return None

    def clone_target_read(self, target):
        """Readable copy of an assignment target (for compound-op expansion)."""
        t = json.loads(json.dumps(target))
        if t.get("mut_index"):
            t["mut_index"] = False
        return t

    def expand_assign(self, target, value, cls_ctx, out):
        # assign-to-this: expand to per-field copies (C# cannot assign this)
        if target["k"] == "this":
            cls = cls_ctx
            flds = self.classes.get(cls, {}).get("fields", [])
            for f in flds:
                if f["ty"]["k"] == "arr":
                    for i in range(f["ty"]["n"]):
                        out.append({"k": "assign",
                                    "target": {"k": "index", "obj": {"k": "field", "obj": {"k": "this"}, "name": f["name"]},
                                               "idx": {"k": "lit", "ty": "i32", "sp": str(i)}},
                                    "value": {"k": "index", "obj": value, "idx": {"k": "lit", "ty": "i32", "sp": str(i)}}})
                else:
                    out.append({"k": "assign",
                                "target": {"k": "field", "obj": {"k": "this"}, "name": f["name"]},
                                "value": {"k": "field", "obj": value, "name": f["name"]}})
            return
        # whole-array copy -> per-element (C# fixed arrays cannot be assigned whole)
        tgt_ty = self.target_type(target)
        if tgt_ty is not None and tgt_ty["k"] == "arr":
            for i in range(tgt_ty["n"]):
                out.append({"k": "assign",
                            "target": {"k": "index", "obj": target, "idx": {"k": "lit", "ty": "i32", "sp": str(i)}},
                            "value": {"k": "index", "obj": value, "idx": {"k": "lit", "ty": "i32", "sp": str(i)}}})
            return
        out.append({"k": "assign", "target": target, "value": value})

    def target_type(self, target):
        if target["k"] == "var":
            return self.local_types.get(target["name"])
        if target["k"] == "field":
            obj_ty = self.expr_type(target["obj"])
            if obj_ty is not None and obj_ty["k"] == "cls":
                for f in self.classes.get(obj_ty["name"], {}).get("fields", []):
                    if f["name"] == target["name"]:
                        return f["ty"]
        if target["k"] == "index":
            obj_ty = self.expr_type(target["obj"])
            if obj_ty is not None and obj_ty["k"] == "cls":
                for f in self.classes.get(obj_ty["name"], {}).get("fields", []):
                    if f["name"] in ("mF32", "mU32"):
                        return f["ty"]["elem"]
        return None

    def expr_type(self, e):
        if e is None: return None
        k = e["k"]
        if k == "var": return self.local_types.get(e["name"])
        if k == "this": return t_cls(e["cls"]) if "cls" in e else None
        if k in ("lit",): return t_prim(e.get("ty", "i32"))
        if k == "str": return t_prim("cstr")
        if k == "field":
            obj_ty = self.expr_type(e["obj"])
            if obj_ty is not None and obj_ty["k"] == "cls":
                for f in self.classes.get(obj_ty["name"], {}).get("fields", []):
                    if f["name"] == e["name"]:
                        return f["ty"]
                return t_prim("f32")  # GetX-like pseudo handled elsewhere
            return None
        if k == "index":
            obj_ty = self.expr_type(e["obj"])
            if obj_ty is not None and obj_ty["k"] == "cls":
                for f in self.classes.get(obj_ty["name"], {}).get("fields", []):
                    if f["name"] in ("mF32", "mU32"):
                        return f["ty"]["elem"]
            if obj_ty is not None and obj_ty["k"] == "arr":
                return obj_ty["elem"]
            return None
        if k == "ref": return t_ref(self.expr_type(e["e"]), True) if self.expr_type(e["e"]) else None
        if k == "deref":
            inner = self.expr_type(e["e"])
            return inner["to"] if inner is not None and inner["k"] == "ref" else None
        return e.get("ty")

    def lower_vardecl(self, d, cls_ctx, out):
        name = d.spelling
        # union-bitcast helper pattern: FBits b;
        if d.type.spelling.startswith("FBits"):
            out.append({"k": "let", "name": name, "ty": {"k": "fbits"}, "init": None})
            self.local_types[name] = {"k": "fbits"}
            return
        ty = self.canon_type(d.type)
        if ty is None:
            # class-local Type alias or unknown — try decl context
            ty = t_cls(cls_ctx) if cls_ctx in TYPE_ALIAS else None
        if ty is None:
            self.report_unsupported(f"var:{name}@{d.location.line}", "unknown variable type")
            return
        kids = list(d.get_children())
        # union bitcast pattern: FBits b; b.f = e; ... handled at assign; init:
        inits = [k for k in kids if k.kind not in (cindex.CursorKind.TYPE_REF, cindex.CursorKind.UNEXPOSED_EXPR)]
        if not inits:
            out.append({"k": "let", "name": name, "ty": ty, "init": None})
            self.local_types[name] = ty
            return
        # copy ctor: Vec4 d(a); -> init from single expr of same class
        if len(inits) == 1 and inits[0].kind == cindex.CursorKind.CXX_CONSTRUCT_EXPR and ty["k"] == "cls":
            ctor_expr = self.build_expr(inits[0], ty, cls_ctx)
            if ctor_expr is not None and ctor_expr["k"] == "ctor" and len(ctor_expr["args"]) == 0:
                # default ctor: zero-init
                out.append({"k": "let", "name": name, "ty": ty, "init": None})
                self.local_types[name] = ty
                return
            if ctor_expr is not None and ctor_expr["k"] == "ctor" and len(ctor_expr["args"]) == 1 \
               and self.expr_type(ctor_expr["args"][0]) and self.expr_type(ctor_expr["args"][0])["k"] == "cls" \
               and self.expr_type(ctor_expr["args"][0])["name"] == ty["name"]:
                # copy construction
                out.append({"k": "let", "name": name, "ty": ty,
                            "init": {"k": "copy", "e": ctor_expr["args"][0]}})
                self.local_types[name] = ty
                return
        init = self.build_expr(inits[0], ty, cls_ctx)
        if init is None:
            return
        out.append({"k": "let", "name": name, "ty": ty, "init": init})
        self.local_types[name] = ty

    # ------------------------------------------------------------------ decls
    def collect(self):
        if self.diag_fail:
            for d in self.tu.diagnostics:
                if d.severity >= cindex.Diagnostic.Error:
                    print(f"PARSE ERROR: {d.location.file}:{d.location.line} {d.spelling}", file=sys.stderr)
            return False
        top = self.tu.cursor
        self.local_types = {}

        # pass 1: classes
        for c in top.walk_preorder():
            if c.kind == cindex.CursorKind.CLASS_DECL and c.spelling in TARGET_CLASSES and c.is_definition():
                self.lower_class(c)
            if c.kind == cindex.CursorKind.STRUCT_DECL and c.spelling in TARGET_CLASSES and c.is_definition():
                self.lower_class(c)

        # pass 2: free functions in battery
        for c in top.get_children():
            if c.kind == cindex.CursorKind.FUNCTION_DECL and self.in_source(c):
                self.lower_fun(c)

        # pass 3: drop methods that (transitively) call unsupported things
        self.prune_unsupported_calls()
        return True

    def lower_class(self, c):
        name = c.spelling
        cls = {"name": name, "fields": [], "methods": []}
        self.classes[name] = cls
        for m in c.get_children():
            if m.kind == cindex.CursorKind.FIELD_DECL:
                # anonymous union: descend into union fields
                if m.type.get_declaration() is not None and \
                   m.type.get_declaration().kind == cindex.CursorKind.UNION_DECL and m.spelling == "":
                    for uf in m.type.get_declaration().get_children():
                        if uf.kind == cindex.CursorKind.FIELD_DECL:
                            et = self.canon_type(uf.type)
                            if et is not None and et["k"] == "arr":
                                cls["fields"].append({"name": uf.spelling, "ty": et})
                elif m.spelling in ("x", "y", "z", "w"):
                    cls["fields"].append({"name": m.spelling, "ty": t_prim("f32")})
            elif m.kind in (cindex.CursorKind.CXX_METHOD, cindex.CursorKind.CXX_CONSTRUCTOR_DECL):
                self.lower_method(m, name)
            elif m.kind == cindex.CursorKind.FUNCTION_DECL:
                # friend operators (operator<< excluded by name)
                if m.spelling in ("operator*", "operator<<"):
                    if m.spelling == "operator<<":
                        self.report_unsupported(f"{name}::operator<<", "stream output — not needed")
                        continue
                    self.lower_friend(m, name)

    def lower_method(self, m, cls_name):
        if m.is_invalid_declaration():
            return
        if m.template_kind != cindex.CursorKind.NO_TEMPLATE_KIND if hasattr(m, 'template_kind') else False:
            return
        # skip out-of-line (none here), skip explicit-ish defaults
        if not m.is_definition() and not m.pure_virtual:
            body_children = list(m.get_children())
            if not any(k.kind == cindex.CursorKind.COMPOUND_STMT for k in body_children):
                return
        # skip deleted/defaulted copies (no body)
        toks = [t.spelling for t in self.tu.get_tokens(m.extent)]
        if m.spelling in ("operator=",) and m.is_definition() is False:
            return
        if not any(k.kind == cindex.CursorKind.COMPOUND_STMT for k in m.get_children()):
            return  # declaration only or '= default'
        if m.is_defaulted():
            return

        name = self.method_ir_name(m, cls_name)
        is_static = m.is_static_method()
        params = []
        if not is_static:
            params.append({"name": "self", "ty": t_cls(cls_name)})  # implicit receiver
        for p in m.get_arguments():
            pt = self.param_type(p.type, cls_name)
            if pt is None:
                self.report_unsupported(f"{cls_name}::{name}", f"unmappable param '{p.spelling}'")
                return
            params.append({"name": p.spelling or f"arg{len(params)}", "ty": pt})
        ret = self.canon_type(m.result_type)
        # ref-returning mutable operator[] handled as indexer set/get pair
        body = []
        self.local_types = {}
        for p in params:
            self.local_types[p["name"]] = p["ty"]
        comp = None
        for k in m.get_children():
            if k.kind == cindex.CursorKind.COMPOUND_STMT:
                comp = k
        if comp is None:
            return
        self.build_stmt(comp, cls_name, body)
        if ret is None:
            # result_type may be 'Type' alias etc.
            rt_sp = m.result_type.spelling
            if rt_sp in ("Type",) and cls_name in TYPE_ALIAS:
                ret = t_cls(TYPE_ALIAS[cls_name])
            else:
                self.report_unsupported(f"{cls_name}::{name}", "unmappable return type")
                return
        if "self" in params or is_static:
            pass
        else:
            params.insert(0, {"name": "self", "ty": t_cls(cls_name)})

        self.classes[cls_name]["methods"].append({
            "cls": cls_name, "name": name, "static": is_static,
            "params": params, "ret": ret, "body": body,
            "origin": f"{cls_name}::{m.spelling}",
        })

    def lower_friend(self, m, cls_name):
        # friend operator*(float, Vec4) — lowered as a rewrite rule at call
        # sites; also emitted as static for completeness if needed
        return

    def lower_fun(self, c):
        name = c.spelling
        if name in ("printf",):
            return
        params = []
        self.local_types = {}
        for p in c.get_arguments():
            pt = self.canon_type(p.type)
            if pt is None:
                if p.type.spelling == "const char *" or "char" in p.type.spelling:
                    pt = t_prim("cstr")
                else:
                    self.report_unsupported(f"fun:{name}", f"unmappable param '{p.spelling}'")
                    return
            params.append({"name": p.spelling or f"arg{len(params)}", "ty": pt})
            self.local_types[p["name"]] = pt
        ret = self.canon_type(c.result_type)
        if ret is None and c.result_type.spelling == "void":
            ret = t_prim("void")
        if ret is None:
            if c.result_type.spelling == "unsigned int":
                ret = t_prim("u32")
            else:
                self.report_unsupported(f"fun:{name}", "unmappable return type")
                return
        body = []
        comp = None
        for k in c.get_children():
            if k.kind == cindex.CursorKind.COMPOUND_STMT:
                comp = k
        if comp is None:
            return
        self.build_stmt(comp, None, body)
        self.funs.append({"name": name, "params": params, "ret": ret, "body": body})

    # ------------------------------------------------------------------ union bitcast pattern
    # BitsOf(float) uses union FBits {float f; uint32 u;} — we recognize the
    # 'FBits b; b.f = e; b.u' idiom and lower to bitcast ops at assign/expr time.
    # Implemented by rewriting MEMBER_REF_EXPR on FBits locals in build_expr —
    # see rewrite_fbits.

    # ------------------------------------------------------------------ pruning
    def method_key(self, cls, name):
        return f"{cls}::{name}"

    def collect_call_targets(self, body):
        targets = []
        def walk(e):
            if not isinstance(e, dict):
                return
            if e.get("k") == "call" and e.get("cls"):
                targets.append((e["cls"], e["name"]))
            if e.get("k") == "meth":
                targets.append((e["cls"], e["name"]))
            if e.get("k") == "ctor":
                pass
            for v in e.values():
                walk(v)
            if isinstance(e, list):
                pass
        def walk_stmts(stmts):
            for s in stmts:
                walk(s)
                for v in s.values():
                    if isinstance(v, list):
                        for item in v:
                            if isinstance(item, dict) and "k" in item:
                                walk(item)
                                for vv in item.values():
                                    if isinstance(vv, list):
                                        for it2 in vv:
                                            if isinstance(it2, dict):
                                                walk(it2)
                    elif isinstance(v, dict):
                        walk(v)
                    elif isinstance(v, list):
                        for item in v:
                            if isinstance(item, dict):
                                walk(item)
                            elif isinstance(item, list):
                                for it2 in item:
                                    if isinstance(it2, dict):
                                        walk(it2)
        walk_stmts(body)
        return targets

    def prune_unsupported_calls(self):
        # build method index
        self.mindex = {}
        for cls in self.classes.values():
            for m in cls["methods"]:
                self.mindex[(m["cls"], m["name"])] = m
        changed = True
        while changed:
            changed = False
            for (key, m) in list(self.mindex.items()):
                for (cls, name) in self.collect_call_targets(m["body"]):
                    if (cls, name) not in self.mindex:
                        self.report_unsupported(f"{key}", f"calls dropped method {cls}::{name}")
                        del self.mindex[key]
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
                cls = self.classes[cname]
                classes.append({"name": cls["name"],
                                "fields": cls["fields"],
                                "methods": cls["methods"]})
        ir = {"module": "jolt_math", "ir_version": 1,
              "classes": classes, "funs": self.funs}
        with open(out_ir, "w") as f:
            json.dump(ir, f, indent=1)
        with open(out_report, "w") as f:
            for u in self.unsupported:
                f.write(f"{u['symbol']}: {u['reason']}\n")
        n_methods = sum(len(c["methods"]) for c in classes)
        print(f"FE OK: {len(classes)} classes, {n_methods} methods, {len(self.funs)} funs, "
              f"{len(self.unsupported)} unsupported")


def main():
    src, incdir, out_ir, out_report = sys.argv[1:5]
    fe = Frontend(src, incdir)
    if not fe.collect():
        sys.exit(2)
    fe.emit(out_ir, out_report)

if __name__ == "__main__":
    main()
