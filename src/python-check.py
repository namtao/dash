# Kiểm tra Python khi máy chưa cài ruff: lỗi cú pháp, tên chưa định nghĩa ở đâu trong file (F821)
# và import không dùng (F401). Chỉ dùng thư viện chuẩn. Đọc mã từ stdin, in JSON danh sách lỗi.
import ast
import builtins
import json
import re
import sys

src = sys.stdin.read()
name = sys.argv[1] if len(sys.argv) > 1 else "file.py"
out = []


def report(node, message, severity, length=None):
    line = getattr(node, "lineno", 1) or 1
    col = (getattr(node, "col_offset", 0) or 0) + 1
    end_line = getattr(node, "end_lineno", None) or line
    end_col = (getattr(node, "end_col_offset", None) or col) + 1
    if length:
        end_line, end_col = line, col + length
    out.append({"line": line, "column": col, "endLine": end_line, "endColumn": max(end_col, col + 1), "severity": severity, "message": message})


try:
    tree = ast.parse(src)
except SyntaxError as e:
    line = e.lineno or 1
    col = e.offset or 1
    print(json.dumps([{"line": line, "column": col, "endLine": e.end_lineno or line, "endColumn": max(e.end_offset or col + 1, col + 1), "severity": "error", "message": e.msg}]))
    sys.exit(0)

bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__builtins__", "__spec__", "__loader__", "__package__", "__path__", "__annotations__", "__module__", "__qualname__", "__class__", "__debug__"}
loads = []
used = set()
imports = []  # (tên, node)
dynamic = False  # import * / globals() / exec làm không biết chắc tên nào tồn tại

for node in ast.walk(tree):
    if isinstance(node, ast.Name):
        if isinstance(node.ctx, ast.Load):
            loads.append(node)
            used.add(node.id)
        else:
            bound.add(node.id)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        bound.add(node.name)
    elif isinstance(node, ast.arg):
        bound.add(node.arg)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            continue
        for alias in node.names:
            if alias.name == "*":
                dynamic = True
                continue
            local = alias.asname or alias.name.split(".")[0]
            bound.add(local)
            imports.append((local, node, alias))
    elif isinstance(node, ast.ExceptHandler) and node.name:
        bound.add(node.name)
    elif isinstance(node, (ast.Global, ast.Nonlocal)):
        bound.update(node.names)
    elif hasattr(ast, "MatchAs") and isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
        bound.add(node.name)
    elif hasattr(ast, "MatchMapping") and isinstance(node, ast.MatchMapping) and node.rest:
        bound.add(node.rest)
    elif hasattr(ast, "TypeVar") and isinstance(node, (ast.TypeVar, ast.ParamSpec, ast.TypeVarTuple)):
        bound.add(node.name)
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("globals", "locals", "exec", "eval", "vars"):
        dynamic = True
    # tên dùng trong chú thích kiểu dạng chuỗi ("List[int]") và trong __all__
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) < 200:
        used.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", node.value))

if not dynamic:
    for n in loads:
        if n.id not in bound:
            report(n, f"Undefined name `{n.id}` (F821)", "error")

if not name.endswith("__init__.py"):
    for local, node, alias in imports:
        if local not in used and not (alias.asname and alias.asname == alias.name):
            report(node, f"`{alias.name}` imported but unused (F401)", "warning")

print(json.dumps(out))
