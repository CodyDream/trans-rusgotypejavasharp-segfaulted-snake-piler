#!/usr/bin/env python3
"""Python frontend (Layer 1) — parse the v1 subset with the REAL ast module.

Why spawn python instead of hand-parsing: indentation-sensitive grammars are
where toy parsers die. CPython's own parser does it perfectly, for free.

Emits a JSON IR on stdout: {"ok": true, "ir": {...}} or {"ok": false, "error": ..., "line": N}.

v1 subset (everything else fails LOUDLY, never silently):
  top-level functions & classes, module-level statements -> implicit main
  if/elif/else, while, for-range (literal step), for-each
  ints/floats/bools/strings, lists, string-keyed dicts, f-strings (no specs)
  classes: AnnAssign fields, __init__, methods; no inheritance/decorators/defaults
  print, len/str/int/float, append/pop/index/sort/reverse/clear,
  d[k], d.get(k, default), keys/values, break/continue, augmented assignment
"""
import ast
import json
import sys


class Unsupported(Exception):
    def __init__(self, msg, line=None):
        super().__init__(msg)
        self.msg = msg
        self.line = line


def line_of(node):
    return getattr(node, "lineno", None)


# ---------------------------------------------------------------------------
# Type annotations -> IR type strings
# ---------------------------------------------------------------------------

def ann_str(node):
    if node is None:
        return None
    if isinstance(node, ast.Constant) and node.value is None:
        return "void"          # -> None
    if isinstance(node, ast.Name):
        m = {"int": "int", "float": "float", "bool": "bool", "str": "string"}
        if node.id in m:
            return m[node.id]
        return "class:" + node.id
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        base = node.value.id
        if base == "list":
            return "list[" + ann_str(node.slice) + "]"
        if base == "dict":
            if not (isinstance(node.slice, ast.Tuple) and len(node.slice.elts) == 2):
                raise Unsupported("dict annotation must be dict[str, V]", line_of(node))
            kt = ann_str(node.slice.elts[0])
            if kt != "string":
                raise Unsupported("dict keys must be str in v1", line_of(node))
            return "map[string," + ann_str(node.slice.elts[1]) + "]"
    raise Unsupported(f"unsupported type annotation '{ast.unparse(node)}'", line_of(node))


# ---------------------------------------------------------------------------
# Expressions
# ---------------------------------------------------------------------------

BIN_OPS = {
    ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.FloorDiv: "//",
    ast.Mod: "%",
}
CMP_OPS = {
    ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=",
    ast.Gt: ">", ast.GtE: ">=", ast.In: "in", ast.NotIn: "notin",
}


def exp(node, ctx):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return {"k": "bool", "v": node.value}
        if isinstance(node.value, int):
            return {"k": "int", "v": node.value}
        if isinstance(node.value, float):
            return {"k": "float", "v": node.value}
        if isinstance(node.value, str):
            return {"k": "str", "v": node.value}
        raise Unsupported(f"constant '{node.value!r}' not supported in v1", line_of(node))

    if isinstance(node, ast.Name):
        if node.id == "self" and ctx.get("in_method"):
            return {"k": "this"}
        if node.id == "True":
            return {"k": "bool", "v": True}
        if node.id == "False":
            return {"k": "bool", "v": False}
        return {"k": "var", "name": node.id}

    if isinstance(node, ast.JoinedStr):            # f-string
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(v.value)
            elif isinstance(v, ast.FormattedValue):
                if v.format_spec is not None:
                    raise Unsupported("f-string format specs not supported in v1", line_of(node))
                parts.append(exp(v.value, ctx))
            else:
                raise Unsupported("f-string part not supported", line_of(node))
        return {"k": "interp", "parts": parts}

    if isinstance(node, ast.FormattedValue):
        raise Unsupported("bare FormattedValue", line_of(node))

    if isinstance(node, ast.List):
        return {"k": "list", "elems": [exp(e, ctx) for e in node.elts]}

    if isinstance(node, ast.Dict):
        entries = []
        for k, v in zip(node.keys, node.values):
            if k is None or not isinstance(k, ast.Constant) or not isinstance(k.value, str):
                raise Unsupported("dict keys must be string literals in v1", line_of(node))
            entries.append({"key": k.value, "val": exp(v, ctx)})
        return {"k": "map", "entries": entries}

    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.USub):
            return {"k": "un", "op": "-", "e": exp(node.operand, ctx)}
        if isinstance(node.op, ast.Not):
            return {"k": "un", "op": "!", "e": exp(node.operand, ctx)}
        raise Unsupported(f"unary op {type(node.op).__name__} not supported", line_of(node))

    if isinstance(node, ast.BoolOp):
        op = "&&" if isinstance(node.op, ast.And) else "||"
        vals = [exp(v, ctx) for v in node.values]
        acc = vals[0]
        for v in vals[1:]:
            acc = {"k": "bin", "op": op, "l": acc, "r": v}
        return acc

    if isinstance(node, ast.BinOp):
        op = BIN_OPS.get(type(node.op))
        if op is None:
            raise Unsupported(f"operator '{type(node.op).__name__}' not supported in v1", line_of(node))
        return {"k": "bin", "op": op, "l": exp(node.left, ctx), "r": exp(node.right, ctx)}

    if isinstance(node, ast.Compare):
        if len(node.ops) != 1:
            raise Unsupported("chained comparisons not supported in v1", line_of(node))
        op = CMP_OPS.get(type(node.ops[0]))
        if op is None:
            raise Unsupported(f"comparison '{type(node.ops[0]).__name__}' not supported", line_of(node))
        return {"k": "bin", "op": op, "l": exp(node.left, ctx), "r": exp(node.comparators[0], ctx)}

    if isinstance(node, ast.Attribute):
        obj = exp(node.value, ctx)
        return {"k": "field", "obj": obj, "name": node.attr}

    if isinstance(node, ast.Subscript):
        if isinstance(node.slice, ast.Slice):
            raise Unsupported("slicing not supported in v1", line_of(node))
        return {"k": "index", "obj": exp(node.value, ctx), "idx": exp(node.slice, ctx)}

    if isinstance(node, ast.Call):
        return call(node, ctx)

    if isinstance(node, ast.IfExp):
        raise Unsupported("ternary expressions not supported in v1", line_of(node))

    raise Unsupported(f"expression '{type(node).__name__}' not supported in v1", line_of(node))


def call(node, ctx):
    f = node.func
    if node.keywords:
        raise Unsupported("keyword arguments not supported in v1", line_of(node))

    # class constructor: Point(...)
    if isinstance(f, ast.Name) and f.id in ctx["classes"] and f.id != "print":
        return {"k": "new", "cls": f.id, "args": [exp(a, ctx) for a in node.args]}

    # method call: obj.m(...)
    if isinstance(f, ast.Attribute):
        return {"k": "method", "obj": exp(f.value, ctx), "name": f.attr,
                "args": [exp(a, ctx) for a in node.args]}

    if isinstance(f, ast.Name):
        name = f.id
        if name in ("len", "str", "int", "float", "abs"):
            if name == "abs":
                raise Unsupported("abs() not supported in v1", line_of(node))
            if len(node.args) != 1:
                raise Unsupported(f"{name}() takes exactly one argument", line_of(node))
            return {"k": "call", "name": name, "args": [exp(node.args[0], ctx)]}
        if name in ctx["classes"]:
            return {"k": "new", "cls": name, "args": [exp(a, ctx) for a in node.args]}
        return {"k": "call", "name": name, "args": [exp(a, ctx) for a in node.args]}

    raise Unsupported("only plain named calls and method calls are supported in v1", line_of(node))


# ---------------------------------------------------------------------------
# Statements
# ---------------------------------------------------------------------------

def target_of(node, ctx):
    if isinstance(node, ast.Name):
        return {"k": "var", "name": node.id}
    if isinstance(node, ast.Attribute):
        obj = node.value
        if isinstance(obj, ast.Name) and obj.id == "self" and ctx.get("in_method"):
            return {"k": "field", "obj": {"k": "this"}, "name": node.attr}
        raise Unsupported("only self.attr assignment is supported in v1", line_of(node))
    if isinstance(node, ast.Subscript):
        return {"k": "index", "obj": exp(node.value, ctx), "idx": exp(node.slice, ctx)}
    raise Unsupported("unsupported assignment target", line_of(node))


class Scope:
    """Tracks declared names so Assign -> vardecl vs assign is correct."""
    def __init__(self, parent=None):
        self.names = set()
        self.parent = parent

    def declare(self, n):
        self.names.add(n)

    def has(self, n):
        s = self
        while s:
            if n in s.names:
                return True
            s = s.parent
        return False


def stmt(node, ctx, scope):
    ln = line_of(node)

    if isinstance(node, ast.AnnAssign):
        if not isinstance(node.target, ast.Name):
            raise Unsupported("annotated assignment target must be a name", ln)
        ty = ann_str(node.annotation)
        if node.value is None:
            raise Unsupported("annotated declaration without value not supported in v1 "
                              "(write `x: T = ...`)", ln)
        scope.declare(node.target.id)
        return {"k": "vardecl", "name": node.target.id, "ty": ty, "init": exp(node.value, ctx)}

    if isinstance(node, ast.Assign):
        if len(node.targets) != 1:
            raise Unsupported("chained assignment not supported in v1", ln)
        t = node.targets[0]
        val = exp(node.value, ctx)
        if isinstance(t, ast.Name):
            if scope.has(t.id):
                return {"k": "assign", "target": {"k": "var", "name": t.id}, "value": val}
            scope.declare(t.id)
            return {"k": "vardecl", "name": t.id, "ty": None, "init": val}
        return {"k": "assign", "target": target_of(t, ctx), "value": val}

    if isinstance(node, ast.AugAssign):
        t = target_of(node.target, ctx)
        op = BIN_OPS.get(type(node.op))
        if op is None:
            raise Unsupported(f"augmented operator '{type(node.op).__name__}' not supported", ln)
        return {"k": "assign", "target": t,
                "value": {"k": "bin", "op": op, "l": t, "r": exp(node.value, ctx)}}

    if isinstance(node, ast.Expr):
        v = node.value
        if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "print":
            return {"k": "print", "args": [exp(a, ctx) for a in v.args]}
        return {"k": "expr", "e": exp(v, ctx)}

    if isinstance(node, ast.Return):
        return {"k": "return", "v": None if node.value is None else exp(node.value, ctx)}

    if isinstance(node, ast.Pass):
        return {"k": "expr", "e": {"k": "int", "v": 0}}  # no-op; rarely needed

    if isinstance(node, ast.Break):
        return {"k": "break"}
    if isinstance(node, ast.Continue):
        return {"k": "continue"}

    if isinstance(node, ast.If):
        cond = exp(node.test, ctx)
        then = body(node.body, ctx, Scope(scope))
        elifs = []
        els = None
        cur = node
        while isinstance(cur.orelse, list) and len(cur.orelse) == 1 and isinstance(cur.orelse[0], ast.If):
            cur = cur.orelse[0]
            elifs.append({"cond": exp(cur.test, ctx),
                          "body": body(cur.body, ctx, Scope(scope))})
        if cur.orelse:
            els = body(cur.orelse, ctx, Scope(scope))
        return {"k": "if", "cond": cond, "then": then, "elifs": elifs, "els": els}

    if isinstance(node, ast.While):
        if node.orelse:
            raise Unsupported("while/else not supported in v1", ln)
        return {"k": "while", "cond": exp(node.test, ctx),
                "body": body(node.body, ctx, Scope(scope))}

    if isinstance(node, ast.For):
        if node.orelse:
            raise Unsupported("for/else not supported in v1", ln)
        if not isinstance(node.target, ast.Name):
            raise Unsupported("for-loop target must be a single name", ln)
        # range(...) -> forrange ; everything else -> foreach
        if isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name) \
                and node.iter.func.id == "range":
            args = node.iter.args
            if node.iter.keywords or not (1 <= len(args) <= 3):
                raise Unsupported("range() takes 1-3 positional args", ln)
            vals = [exp(a, ctx) for a in args]
            if len(vals) == 1:
                start, stop, step = {"k": "int", "v": 0}, vals[0], {"k": "int", "v": 1}
            elif len(vals) == 2:
                start, stop, step = vals[0], vals[1], {"k": "int", "v": 1}
            else:
                start, stop, step = vals[0], vals[1], vals[2]
            if not (isinstance(step, dict) and step.get("k") == "int"):
                raise Unsupported("range step must be an integer literal in v1", ln)
            scope.declare(node.target.id)
            return {"k": "forrange", "varName": node.target.id, "start": start,
                    "stop": stop, "step": step,
                    "body": body(node.body, ctx, Scope(scope))}
        it = exp(node.iter, ctx)
        scope.declare(node.target.id)
        return {"k": "foreach", "varName": node.target.id, "varTy": None,
                "iter": it, "body": body(node.body, ctx, Scope(scope))}

    raise Unsupported(f"statement '{type(node).__name__}' not supported in v1", ln)


def body(stmts, ctx, scope):
    return [stmt(s, ctx, scope) for s in stmts]


# ---------------------------------------------------------------------------
# Declarations
# ---------------------------------------------------------------------------

def params_of(fd, ctx, is_method):
    a = fd.args
    for bad, what in ((a.vararg, "*args"), (a.kwarg, "**kwargs")):
        if bad is not None:
            raise Unsupported(f"{what} not supported in v1", line_of(fd))
    if a.defaults or a.kw_defaults:
        raise Unsupported("default parameter values not supported in v1", line_of(fd))
    if a.kwonlyargs:
        raise Unsupported("keyword-only parameters not supported in v1", line_of(fd))
    pos = list(a.posonlyargs) + list(a.args)
    if is_method:
        if not pos or pos[0].arg != "self":
            raise Unsupported("methods must take self as first parameter", line_of(fd))
        pos = pos[1:]
    out = []
    for p in pos:
        if p.annotation is None:
            raise Unsupported(f"parameter '{p.arg}' needs a type annotation in v1", line_of(fd))
        out.append({"name": p.arg, "ty": ann_str(p.annotation)})
    return out


def function(fd, ctx, is_method, scope_parent):
    if fd.decorator_list:
        raise Unsupported("decorators not supported in v1", line_of(fd))
    params = params_of(fd, ctx, is_method)
    ret = ann_str(fd.returns)
    scope = Scope(scope_parent)
    for p in params:
        scope.declare(p["name"])
    saved = ctx["in_method"]
    ctx["in_method"] = is_method
    try:
        body_s = body(fd.body, ctx, scope)
    finally:
        ctx["in_method"] = saved
    item = {"k": "fun", "name": fd.name, "params": params, "ret": ret, "body": body_s}
    if is_method and fd.name == "__init__":
        return ("ctor", {"params": params, "body": body_s})
    return ("fun", item)


def klass(cd, ctx):
    if cd.bases or cd.keywords or cd.decorator_list:
        raise Unsupported("inheritance/decorators on classes not supported in v1", line_of(cd))
    fields = []
    ctor = None
    methods = []
    inner = Scope(ctx["scope"])
    inner.names.update({f["name"] for f in fields})
    for st in cd.body:
        ln = line_of(st)
        if isinstance(st, ast.AnnAssign):
            if not isinstance(st.target, ast.Name):
                raise Unsupported("class attribute target must be a name", ln)
            fields.append({"name": st.target.id, "ty": ann_str(st.annotation)})
            continue
        if isinstance(st, ast.Assign):
            raise Unsupported("class-level assignments not supported in v1 "
                              "(declare fields with annotations)", ln)
        if isinstance(st, ast.FunctionDef):
            kind, item = function(st, ctx, True, inner)
            if kind == "ctor":
                ctor = item
                # fields assigned in __init__ but never declared: declare them
                for s2 in item["body"]:
                    if s2["k"] == "assign" and s2["target"]["k"] == "field":
                        fname = s2["target"]["name"]
                        if not any(f["name"] == fname for f in fields):
                            fields.append({"name": fname, "ty": None})
            else:
                methods.append(item)
            continue
        raise Unsupported(f"statement '{type(st).__name__}' not supported inside class", ln)
    return {"k": "class", "name": cd.name, "fields": fields, "ctor": ctor, "methods": methods}


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------

def is_main_guard(st):
    """The `if __name__ == "__main__": main()` entry marker — skip on re-parse."""
    if not isinstance(st, ast.If) or st.orelse:
        return False
    t = st.test
    return (isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == "__name__"
            and len(t.ops) == 1 and isinstance(t.ops[0], ast.Eq)
            and len(t.comparators) == 1 and isinstance(t.comparators[0], ast.Constant)
            and t.comparators[0].value == "__main__")


def dump_module(tree, module_name):
    classes = {n.name for n in tree.body if isinstance(n, ast.ClassDef)}
    ctx = {"classes": classes, "in_method": False, "scope": Scope()}
    items = []
    main_body = []
    for st in tree.body:
        if isinstance(st, ast.FunctionDef):
            if st.decorator_list:
                raise Unsupported("decorators not supported in v1", line_of(st))
            kind, item = function(st, ctx, False, ctx["scope"])
            items.append(item)
        elif isinstance(st, ast.ClassDef):
            items.append(klass(st, ctx))
        elif isinstance(st, (ast.Import, ast.ImportFrom)):
            raise Unsupported("imports not supported in v1", line_of(st))
        elif is_main_guard(st):
            continue
        else:
            main_body.append(stmt(st, ctx, ctx["scope"]))
    return {"name": module_name, "items": items, "mainBody": main_body}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: dumper.py <file.py>"}))
        return 2
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            src = fh.read()
        tree = ast.parse(src, filename=path)
        import os
        module_name = os.path.splitext(os.path.basename(path))[0]
        ir = dump_module(tree, module_name)
        print(json.dumps({"ok": True, "ir": ir}))
        return 0
    except Unsupported as e:
        print(json.dumps({"ok": False, "error": e.msg, "line": e.line}))
        return 0
    except SyntaxError as e:
        print(json.dumps({"ok": False, "error": f"python syntax error: {e.msg}", "line": e.lineno}))
        return 0


if __name__ == "__main__":
    sys.exit(main())
