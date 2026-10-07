#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
syfe-kernel.py —— siyuan-file-editor 的持久 Python 内核

为什么需要它(实测结论,勿删):
   思源本体 650 条内核路由里**没有任何 Python/Jupyter 执行端点**,
   ```python 代码块只做语法高亮,不会真的跑。所以「在笔记里运行 Python」这件事
   只能插件自己实现,本文件就是那个实现。

   不用 jupyter_client / ipykernel 的原因是依赖太重(整套 jupyter 协议 + zmq),
   而我们只需要:执行一段代码 → 拿到 stdout / stderr / 结果值 / 异常。
   自定义一个 4 种消息的行协议,几百行就能搞定,且零第三方依赖 ——
   用户机器上只要有个 python 就能用,不用 pip install jupyter。

宿主(TS 侧 src/utils/python-kernel.ts)通过 pty-helper 的 raw 子进程通道
以**管道**方式拉起本脚本(stdin/stdout 都是干净的字节流):
  宿主 → 内核:一行一个 JSON
  内核 → 宿主:一行一个 JSON(每个事件一行,立刻 flush)

请求类型:
  {"type":"execute","id":"..","code":"..","silent":false}   执行单元格
  {"type":"complete","id":"..","code":"..","cursor":N}      取补全候选
  {"type":"inspect","id":"..","code":"..","cursor":N,
   "kind":"hover"|"signature"|"definition"}                取悬停/签名/定义
  {"type":"reset","id":".."}                                清空命名空间
  {"type":"info","id":".."}                                 取内核信息
  {"type":"shutdown","id":".."}                             退出

事件类型:
  {"type":"stream","name":"stdout"|"stderr","text":".."}
  {"type":"execute_result","id":"..","execution_count":N,
   "data":{"text/plain":"..","text/html":".."},"metadata":{..}}
  {"type":"display_data","data":{..},"metadata":{..}}
  {"type":"error","id":"..","ename":"..","evalue":"..","traceback":[..]}
  {"type":"complete_result","id":"..","matches":[..],
   "cursor_start":N,"cursor_end":N}
  {"type":"inspect_result","id":"..","kind":"..","content":"..",
   "signature":"..","name":"..","start":N,"end":N}
  {"type":"reset_result","id":".."}
  {"type":"info_result","id":"..","version":"..","executable":".."}
  {"type":"kernel_dead","id":"..","message":".."}

中断的实现方式(重要):
   Windows 上既不能用 signal.SIGINT 打断 Python 主线程(会直接杀进程),
   也不能在同进程里另起线程去杀 GIL 中的执行。所以**中断 = 杀进程 + 重启
   + 重放历史代码**。这需要宿主侧维护一份「按 execution_order 成功执行过的代码」
   的历史,见 python-kernel.ts 的 _history / _replayOnRestart。
   代价是重启丢内存中的非代码副作用(比如 open() 的文件句柄),对笔记本场景可接受。
"""

import ast
import builtins
import io
import json
import os
import sys
import traceback

# ---------------------------------------------------------------------------
# 编码:Windows 管道下 sys.stdout 可能被设成 cp936,直接写中文/emoji 会 UnicodeEncodeError。
# 宿主侧始终按 UTF-8 解码,这里强制对齐。reconfigure 是 3.7+,老版本走 fallback。
# ---------------------------------------------------------------------------
for _stream_name in ("stdout", "stderr", "stdin"):
    _s = getattr(sys, _stream_name, None)
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace", newline="\n")
        except Exception:
            pass

_REAL_STDOUT = sys.stdout
_REAL_STDERR = sys.stderr

# 单元格伪文件名:traceback 里出现它,前端就能把帧对应回单元格
CELL_FILE = "<syfe-cell>"

# 持久命名空间 —— 索引器不参与补全/内省,否则用户会看到一堆噪音
user_ns = {
    "__name__": "__main__",
    "__doc__": None,
    "__package__": None,
    "__builtins__": builtins,
}

execution_count = 0

# stdout/stderr 重定向缓冲:代码可能连续多次 write("a") / write("b"),
# 攒成一次 emit 能显著减少管道消息数(每条消息都要 base64/JSON 编码回传)。
_pending = {"stdout": [], "stderr": []}
_last_flush = {"at": 0.0}


def _emit(event):
    """把一个事件写成一行 JSON 送回宿主。stdout 只能走**真实** stdout,
    因为 sys.stdout 已被我们换掉。"""
    try:
        _REAL_STDOUT.write(json.dumps(event, ensure_ascii=False) + "\n")
        _REAL_STDOUT.flush()
    except Exception:
        pass


def _flush_streams(force=True):
    import time
    now = time.time()
    if not force and (now - _last_flush["at"]) < 0.08:
        return
    _last_flush["at"] = now
    for name in ("stdout", "stderr"):
        chunks = _pending[name]
        if not chunks:
            continue
        _pending[name] = []
        _emit({"type": "stream", "name": name, "text": "".join(chunks)})


class _StreamProxy(object):
    """替换 sys.stdout / sys.stderr:write 立刻进缓冲,配合 80ms 节流 flush,
    既保证实时性(进度条能刷),又不至于一行一个包。"""

    def __init__(self, name):
        self._name = name

    def write(self, s):
        if not s:
            return 0
        _pending[self._name].append(s)
        _flush_streams(force=False)
        return len(s)

    def writelines(self, lines):
        for ln in lines:
            self.write(ln)

    def flush(self):
        _flush_streams(force=True)

    def isatty(self):
        # 库(tqdm/click/colorama)据此决定要不要发控制序列,这里明确不是终端,
        # 否则输出会塞满 \r 进度条垃圾。
        return False

    @property
    def encoding(self):
        return "utf-8"

    @property
    def errors(self):
        return "replace"

    def fileno(self):
        raise io.UnsupportedOperation("fileno")

    def isatty_(self):  # pragma: no cover - 占位,防某些库探测
        return False

    def __getattr__(self, item):
        # 其他属性(tty 之类)一律报"不是终端",避免库误判
        raise AttributeError(item)


def _redirect_streams():
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")


def _restore_streams():
    sys.stdout = _REAL_STDOUT
    sys.stderr = _REAL_STDERR


# ---------------------------------------------------------------------------
# 值 → 展示文本
# ---------------------------------------------------------------------------

def _safe_repr(value, limit=4096):
    try:
        text = repr(value)
    except Exception as e:
        return "<无法显示: %s 的 repr 抛错: %s>" % (type(value).__name__, e)
    if len(text) > limit:
        text = text[:limit] + "\n... (共 %d 字符,已截断)" % len(text)
    return text


def _to_text_plain(value):
    """Jupyter 的 text/plain 表示:字符串本身,其余走 repr。"""
    if value is None or isinstance(value, (bool, int, float, complex)):
        return repr(value)
    if isinstance(value, str):
        return value
    return _safe_repr(value)


def _repr_html(value):
    """尽力给一份 HTML 表示。pandas / numpy 等有 _repr_html_ 的直接用,
    否则返回 None 让前端退回纯文本。"""
    fn = getattr(value, "_repr_html_", None)
    if callable(fn):
        try:
            html = fn()
            if isinstance(html, str):
                return html
        except Exception:
            return None
    return None


def _repr_png(value):
    """matplotlib Figure / PIL Image → base64 png。"""
    # matplotlib:只取当前 figure,避免用户没调用 show 时拿到一堆陈旧 figure
    if type(value).__name__ == "Figure":
        try:
            import io as _io
            import base64
            buf = _io.BytesIO()
            value.savefig(buf, format="png", bbox_inches="tight")
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------

def _clean_traceback(exc_type, exc_value, exc_tb):
    """把 traceback 截到**第一处用户代码**为止,丢掉内核自身的框架
    (exec/compile/ast 那几层),否则前端会显示一串无意义的内部行。"""
    frames = traceback.format_exception(exc_type, exc_value, exc_tb)
    lines = []
    started = False
    for frame in frames:
        if not started:
            if CELL_FILE in frame:
                started = True
            else:
                continue
        lines.append(frame)
    if not lines:
        lines = frames[-1:]
    return [ln.rstrip("\n") for ln in lines]


def _split_trailing_expr(tree, silent):
    """把 module body's 最后一条 Expr 摘出来,返回 (前置语句列表, 末表达式)。

    **为什么要摘而不是「先 exec 整段再 eval 末表达式」**:
    那样末表达式会被执行两次 —— 一次在 exec 里,一次在 eval 里。后果:
      - `print("x")` 打印两遍
      - `items.append(1)` 这种有副作用的调用,元素会多进一个
      - `next(it)` / `f.read()` 消耗型操作结果直接错
    而 Jupyter 的语义是末表达式**只求值一次**,所以必须把它从 exec 的
    语句列表里摘出来,单独走 eval。

    silent=True 时不摘(整段照常 exec),符合 Jupyter 的 silent 语义
    (静默执行不产生显示值,但副作用照常发生一次)。
    """
    if silent:
        return list(tree.body), None
    body = list(tree.body)
    while body and isinstance(body[-1], ast.Pass):
        body.pop()
    if not body or not isinstance(body[-1], ast.Expr):
        return body, None
    return body[:-1], body[-1].value


def _has_top_level_await(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.Await, ast.AsyncFor, ast.AsyncWith, ast.AsyncFunctionDef)):
            return True
    return False


def do_execute(req):
    global execution_count
    code = req.get("code") or ""
    silent = bool(req.get("silent"))
    rid = req.get("id") or ""

    # 空单元格也要占 execution_count,和 Jupyter 行为一致(否则 In[n] 会错位)
    execution_count += 1
    count = execution_count
    _emit({"type": "status", "id": rid, "state": "busy", "execution_count": count})

    last_expr = None
    head_body = None
    try:
        tree = ast.parse(code, filename=CELL_FILE, mode="exec")
        if _has_top_level_await(tree):
            _emit({
                "type": "error", "id": rid,
                "ename": "SyntaxError",
                "evalue": "顶层 await 不受支持。请改用普通循环,或把代码封装进 async def 后再调用。",
                "traceback": ["顶层 await 不受支持"],
            })
            _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
            return
        # 末表达式要从 exec 里摘出去,否则会被执行两次(见 _split_trailing_expr)
        head_body, last_expr = _split_trailing_expr(tree, silent)
    except SyntaxError as e:
        _flush_streams(force=True)
        _emit({
            "type": "error", "id": rid,
            "ename": "SyntaxError",
            "evalue": "%s (第 %s 行)" % (e.msg, e.lineno),
            "traceback": ["  File %s, line %s" % (CELL_FILE, e.lineno),
                          "    %s" % (e.text or "").rstrip(),
                          "SyntaxError: %s" % e.msg],
        })
        _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
        return

    _redirect_streams()
    try:
        # 只 exec 前置语句,末表达式留给下面的 eval —— 保证它只求值一次
        head = ast.Module(body=head_body or [], type_ignores=[])
        ast.fix_missing_locations(head)
        exec(compile(head, CELL_FILE, "exec"), user_ns)
    except SystemExit as e:
        _flush_streams(force=True)
        _restore_streams()
        code_val = e.code
        _emit({
            "type": "error", "id": rid, "ename": "SystemExit",
            "evalue": "" if code_val is None else str(code_val),
            "traceback": ["SystemExit: %s" % ("无参数" if code_val is None else code_val)],
        })
        _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
        return
    except BaseException:
        exc_type, exc_value, exc_tb = sys.exc_info()
        _flush_streams(force=True)
        _restore_streams()
        _emit({
            "type": "error", "id": rid,
            "ename": getattr(exc_type, "__name__", str(exc_type)),
            "evalue": _safe_repr(exc_value, limit=2000),
            "traceback": _clean_traceback(exc_type, exc_value, exc_tb),
        })
        _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
        return

    # ---- 取最后一个表达式的值 ----
    # 末表达式已从上面的 exec 里摘出来(见 _split_trailing_expr),这里是它
    # **唯一**一次执行。所以它抛异常必须当错误报出去,不能静默吞掉 ——
    # 否则 `1/0` / `print(undefined_var)` 会表现为"执行成功但无输出",
    # 用户完全看不出哪里错了(这是实测抓到的真实 bug)。
    result_value = None
    has_result = False
    if last_expr is not None and not silent:
        try:
            mode = "eval"
            eval_tree = ast.Expression(body=last_expr)
            ast.fix_missing_locations(eval_tree)
            result_value = eval(compile(eval_tree, CELL_FILE, mode), user_ns)
            has_result = True
        except SystemExit as e:
            _flush_streams(force=True)
            _restore_streams()
            code_val = e.code
            _emit({
                "type": "error", "id": rid, "ename": "SystemExit",
                "evalue": "" if code_val is None else str(code_val),
                "traceback": ["SystemExit: %s" % ("无参数" if code_val is None else code_val)],
            })
            _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
            return
        except BaseException:
            # 只吞「取显示值」这一步自己引入的失败:_repr_* 之类已在上面的
            # try 外,这里捕到的都是用户表达式真正抛的异常,必须报出来。
            exc_type, exc_value, exc_tb = sys.exc_info()
            _flush_streams(force=True)
            _restore_streams()
            _emit({
                "type": "error", "id": rid,
                "ename": getattr(exc_type, "__name__", str(exc_type)),
                "evalue": _safe_repr(exc_value, limit=2000),
                "traceback": _clean_traceback(exc_type, exc_value, exc_tb),
            })
            _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})
            return
    _flush_streams(force=True)
    _restore_streams()

    if has_result:
        data = {"text/plain": _to_text_plain(result_value)}
        html = _repr_html(result_value)
        if html:
            data["text/html"] = html
        png = _repr_png(result_value)
        if png:
            data["image/png"] = png
        _emit({
            "type": "execute_result", "id": rid, "execution_count": count,
            "data": data,
            "metadata": {"_type": type(result_value).__name__},
        })
    _emit({"type": "status", "id": rid, "state": "idle", "execution_count": count})


# ---------------------------------------------------------------------------
# 补全:纯静态分析,不执行用户代码
# ---------------------------------------------------------------------------
# 为什么不直接 import jedi:
#   jedi 要编译(parso/pytree-sitter),在很多 Windows Python 环境里装不上或装很慢,
#   而笔记本场景的补全需求(自己刚定义的变量/类/导入的模块)用 AST + 符号表就够。

_BUILTIN_NAMES = set(dir(builtins))


def _collect_defined_names(tree, extra=()):
    """扫 AST 找出代码里**声明过**的名字:赋值、import、def/class、循环变量、
    with-as、except-as、comprehension 变量、参数。"""
    names = set(extra)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.alias):
            names.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
    return names


def _module_toplevel_names(mod_name):
    """静态读模块文件顶层定义(不 import —— import 有副作用且慢)。"""
    try:
        import importlib.util
        spec = importlib.util.find_spec(mod_name)
    except Exception:
        return set()
    if spec is None:
        return set()
    origin = getattr(spec, "origin", None)
    if not origin or not str(origin).endswith(".py"):
        return set()
    try:
        with io.open(origin, "r", encoding="utf-8", errors="replace") as f:
            src = f.read()
        mod_tree = ast.parse(src, filename=origin, mode="exec")
    except Exception:
        return set()
    return {n for n in _collect_defined_names(mod_tree)
            if not (n.startswith("__") and n.endswith("__"))}


def _attribute_names(obj):
    """取一个**已经存在的对象**的属性名。dir() 对未知类型最稳。"""
    try:
        return {n for n in dir(obj) if not n.startswith("_")}
    except Exception:
        return set()


def _class_member_names(cls_node):
    """静态取类体里 self.xxx = ... 与 def xxx 的名字。

    注意要递归进方法体(而不是只在 cls_node.body 里找):
    `self.name = 'x'` 写在 __init__ 里,而 __init__ 本身是 cls_node.body 的子节点,
    只看一层的话只能拿到方法名、拿不到实例属性。
    """
    names = set()
    for sub in cls_node.body:
        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(sub.name)
    # 扫所有 self.attr = / self.attr: T 的赋值(含方法体内)
    for node in ast.walk(cls_node):
        tgt = None
        if isinstance(node, ast.Assign):
            tgt = node.targets[0] if node.targets else None
        elif isinstance(node, ast.AnnAssign):
            tgt = node.target
        if (isinstance(tgt, ast.Attribute) and isinstance(tgt.value, ast.Name)
                and tgt.value.id == "self"):
            names.add(tgt.attr)
    # dunder 不给补全:__init__/__repr__ 这些用户几乎不会想补,只会污染列表
    return {n for n in names if not (n.startswith("__") and n.endswith("__"))}


def _attr_prefix_at(code, cursor):
    """取光标处的属性链与已输入前缀。返回 (chain, typed_prefix, replace_start)。

    chain 为 None 表示当前不在属性补全语境(就是顶层名字补全)。

    要处理的典型形态(typed 是用户已敲的那几个字母,replace_start 是待替换区间起点):
        "pri"            → (None,            "pri", 0)     顶层补全
        "np.ar"          → (["np"],          "ar",   3)   np 的 ar* 属性
        "Dog."           → (["Dog"],         "",     4)   光标紧跟点号(最常见!)
        "a.b.c"          → (["a","b"],       "c",   4)   二级链
        "f(x).y"         → (None,            "y",   6)   括号调用不支持,退化成顶层
    """
    # 1) 先把光标紧贴着的标识符扫出来(用户已输入的部分)
    i = cursor - 1
    while i >= 0 and (code[i].isalnum() or code[i] == "_"):
        i -= 1
    typed = code[i + 1:cursor]

    # 2) 标识符左边不是 '.' → 不是属性补全
    if i < 0 or code[i] != ".":
        return None, typed, cursor - len(typed)

    # 3) 从那个 '.' 继续往左,反复合并 `标识符 .` 直到顶头
    parts = []
    j = i  # 指向 '.'
    while j >= 0 and code[j] == ".":
        # '.' 左边必须是标识符
        k = j - 1
        while k >= 0 and (code[k].isalnum() or code[k] == "_"):
            k -= 1
        if k == j - 1:
            # '.' 左边紧跟非标识符(数字/括号/换行),链到此为止
            break
        parts.insert(0, code[k + 1:j])
        j = k
        # 跳过中间的空白(允许 "Dog . " 这种写法)
        while j >= 0 and code[j] in " \t":
            j -= 1

    if not parts:
        return None, typed, cursor - len(typed)
    return parts, typed, cursor - len(typed)


def _toplevel_pool(tree):
    """当前作用域里所有可见的顶层名字:内置 + 命名空间 + 本单元格声明 + 已 import。"""
    pool = set(_BUILTIN_NAMES)
    pool |= set(user_ns.keys()) - {"__builtins__", "__name__", "__doc__", "__package__"}
    pool |= _collect_defined_names(tree)
    # import 已写但没执行(用户敲了 import numpy 但没运行单元格)→ 补上模块名
    pool |= _user_imports(tree)
    return pool


def do_complete(req):
    rid = req.get("id") or ""
    code = req.get("code") or ""
    cursor = req.get("cursor")
    if cursor is None:
        cursor = len(code)
    try:
        cursor = int(cursor)
    except Exception:
        cursor = len(code)
    cursor = max(0, min(cursor, len(code)))

    chain, typed, cursor_start = _attr_prefix_at(code, cursor)
    # 补全的上下文只取「光标之前能 parse 的前缀」——调用时刻几乎总是代码还没写完
    _, tree = _strip_incomplete_tail(code, cursor)
    class_defs = _class_defs_in(tree)
    local_types = _infer_local_types(tree)

    if chain:
        # ---- 属性补全 ----
        pool = set()
        # 逐段解析链:`a.b.c` 要求每一段的对象都能拿到 → 若 a 是本单元格 `x = Dog()`
        # 得来的,静态推到 Dog 再取类成员。链越长静态推断越不可靠,取能推到的最远一段。
        resolved_depth = 0
        for idx, name in enumerate(chain):
            segment = set()
            # 1) 已执行的对象 → dir()
            if name in user_ns:
                segment |= _attribute_names(user_ns[name])
            # 2) 本单元格定义的类 → 静态扫类体(self.x / 方法)
            if name in class_defs:
                segment |= _class_member_names(class_defs[name])
            # 3) 本单元格里推断出的类型(如 d = Dog())→ 取那个类的成员。
            #    类定义可能在**别的单元格**里(笔记本最常见的场景:上面一格定义类、
            #    下面一格 d = Dog() 然后 d.),所以拿不到本单元格的 ClassDef 时,
            #    退回命名空间里的真实类对象 dir()。这条路径不需要代码执行过,
            #    只要那个定义单元格跑过一次就行。
            if name in local_types:
                cls_name = local_types[name]
                if cls_name in class_defs:
                    segment |= _class_member_names(class_defs[cls_name])
                elif cls_name in user_ns:
                    segment |= _attribute_names(user_ns[cls_name])
            # 4) 已 import 的模块(执行过 or 只是文本 import)→ 静态读顶层定义
            if name in _user_imports(tree) or (name in user_ns and _looks_like_module(user_ns[name])):
                segment |= _module_toplevel_names(name)
            if not segment:
                # 这一段推不出来(如 `f(x).y`、或方法返回值类型 —— AST 层面拿不到)。
                # 保留**已经推出来的上一段**结果:那至少是 base 的成员,不会误导。
                break
            pool = segment
            resolved_depth = idx + 1

        if resolved_depth < len(chain):
            # 链没能走到底(典型:`d.bark().upp` —— bark() 的返回类型纯 AST 推不出来)。
            # 静默返回空列表会让用户以为"没有可补的东西",不如把最后推出来的那段
            # 连同顶层名字一起给出,当作"我只能帮你到这里"的提示。
            # 代价是可能多出一批无关候选,但补全列表是可滚动的,优于空白。
            pool |= _toplevel_pool(tree)
        prefix_matches = sorted(n for n in pool if n.startswith(typed))
    else:
        # ---- 顶层名字补全 ----
        prefix_matches = sorted(n for n in _toplevel_pool(tree) if n.startswith(typed))

    _emit({
        "type": "complete_result", "id": rid,
        "matches": prefix_matches[:200],
        "cursor_start": cursor_start,
        "cursor_end": cursor,
    })


def _looks_like_module(obj):
    try:
        import types
        return isinstance(obj, types.ModuleType)
    except Exception:
        return False


def _user_imports(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                out.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            for a in node.names:
                if a.name != "*":
                    out.add(a.asname or a.name)
    return out


def _strip_incomplete_tail(code, cursor=None):
    """取「光标之前能 parse 的最长源码前缀」,返回 (源码, tree)。

    为什么不能直接 ast.parse(code):
        补全/内省的调用时刻几乎总是「用户刚敲了半个 token」——
        代码停在 `d.` / `json.` / `def f(` 上,整段 parse 必然 SyntaxError。
        而这些前缀里的**上下文**(前面定义好的类、import)恰恰是我们要的补全依据,
        丢了就什么都补不出来。

    为什么不能逐行砍:
        `d = Dog()` + `d.` 这种两行写法,第二行 parse 失败会连带把第一行也砍掉,
        于是 `d` 的类型线索(它是 Dog 实例)就丢了,补全退化成空。

    所以改成:以光标为界,逐字符往前退,取第一个能 parse 的前缀。
    退化保护:全都不行就返回空树(调用方要能容忍)。
    """
    end = len(code) if cursor is None else max(0, min(int(cursor), len(code)))
    for cut in range(end, -1, -1):
        chunk = code[:cut]
        # 掐掉尾部悬空的运算符/开括号,否则 `a +` `f(` 这类永远 parse 不过
        candidate = chunk.rstrip()
        while candidate and candidate[-1] in "+-*/%=<>&|^~,.:;([{":
            candidate = candidate[:-1].rstrip()
        if not candidate:
            continue
        try:
            return candidate, ast.parse(candidate, filename=CELL_FILE, mode="exec")
        except SyntaxError:
            continue
        except Exception:
            continue
    return "", ast.parse("", filename=CELL_FILE, mode="exec")


def _infer_local_types(tree):
    """静态推断本单元格里的 `名字 -> 类名`,用于「还没运行也能补全实例属性」。

    只认最常见的两种写法:
        x = Dog()        → x: Dog      (调用构造器)
        x: Dog = Dog()   → 同上(带注解)
    推断不出来就不记,绝不猜(猜错会让补全给出错误属性,比不给更糟)。
    """
    out = {}
    for node in ast.walk(tree):
        targets = []
        value = None
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            # 有注解就直接用注解,比猜准
            if isinstance(node.annotation, ast.Name):
                out[node.target.id] = node.annotation.id
            continue
        else:
            continue
        if not isinstance(value, ast.Call):
            continue
        fn = value.func
        # 形如 Dog() 的裸调用(不处理 module.Dog() —— 那是别的类型)
        if isinstance(fn, ast.Name):
            for tgt in targets:
                if isinstance(tgt, ast.Name):
                    out[tgt.id] = fn.id
    return out


def _class_defs_in(tree):
    """tree 里所有类定义:名字 -> ClassDef 节点。"""
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            out[node.name] = node
    return out
    return "\n".join(kept)


# ---------------------------------------------------------------------------
# 内省:hover / 签名 / 定义位置
# ---------------------------------------------------------------------------

def _enclosing_defs(tree, cursor_line):
    """找出包住光标的 def/class 列表(由外到内)。"""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        start = getattr(node, "lineno", 0)
        end = getattr(node, "end_lineno", None) or start
        if start <= cursor_line <= end:
            found.append((start, node))
    found.sort(key=lambda t: t[0])
    return [n for _, n in found]


def _signature_of(node):
    if isinstance(node, ast.ClassDef):
        init = None
        for sub in node.body:
            if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name == "__init__":
                init = sub
                break
        if init is not None:
            return _signature_of(init)
        bases = []
        for b in node.bases:
            try:
                bases.append(ast.unparse(b))
            except Exception:
                pass
        return "class %s(%s)" % (node.name, ", ".join(bases))
    try:
        args = ast.unparse(node.args)
    except Exception:
        args = "..."
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return "%s %s(%s)" % (prefix, node.name, args)


def _docstring_of(node):
    doc = ast.get_docstring(node)
    if not doc:
        return ""
    lines = doc.strip().split("\n")
    # 只取摘要部分:Jupyter 悬停只显示第一段
    out = []
    for ln in lines:
        if not ln.strip():
            break
        out.append(ln.strip())
    return "\n".join(out)


def do_inspect(req):
    rid = req.get("id") or ""
    code = req.get("code") or ""
    kind = req.get("kind") or "hover"
    cursor = req.get("cursor")
    if cursor is None:
        cursor = len(code)
    try:
        cursor = int(cursor)
    except Exception:
        cursor = len(code)
    cursor = max(0, min(cursor, len(code)))
    cursor_line = code.count("\n", 0, cursor) + 1

    # 与补全同源的问题:内省也常发生在代码没写完时(`add(` / `na`)。
    # 取光标之前能 parse 的前缀;行号不变(只是截断尾部),所以 cursor_line 仍有效。
    candidate, tree = _strip_incomplete_tail(code, cursor)

    defs = _enclosing_defs(tree, cursor_line)
    result = {"type": "inspect_result", "id": rid, "kind": kind, "content": ""}

    if kind == "signature":
        # 光标左边最近的 `name(` → 取该函数签名
        import re
        left = code[:cursor]
        match = re.search(r"([A-Za-z_][A-Za-z_0-9\.]*)\s*\($", left)
        if not match:
            _emit(result)
            return
        dotted = match.group(1)
        simple = dotted.split(".")[-1]

        # 先在本单元格里找 def/class(静态,不用等它执行过)
        target = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == simple:
                target = node
                break

        if target is not None:
            result["signature"] = _signature_of(target) + ":"
            result["name"] = target.name
        elif simple in user_ns and callable(user_ns[simple]):
            # 已执行过的对象 → 用 inspect.signature 拿真实签名
            result["signature"] = _safe_callable_signature(user_ns[simple], dotted)
            result["name"] = simple
        else:
            _emit(result)
            return

        result["start"] = cursor - len(dotted) - 1
        result["end"] = cursor - 1
        doc = _docstring_of(target) if target is not None else ""
        if doc:
            result["content"] = doc
        _emit(result)
        return

    if kind == "definition":
        # 光标处的标识符 → 找同名 def/class,报它在代码里的行号
        import re
        left = code[:cursor]
        m = re.search(r"([A-Za-z_][A-Za-z_0-9]*)\s*$", left)
        if not m:
            _emit(result)
            return
        ident = m.group(1)
        found = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == ident:
                found = node
                break
        if found is not None:
            start = getattr(found, "lineno", 1)
            line_text = code.split("\n")[start - 1].strip()
            result["name"] = ident
            result["signature"] = line_text
            result["content"] = "第 %d 行\n\n%s" % (start, line_text)
            result["start"] = start - 1
            result["end"] = len(code)
        else:
            result["content"] = "在当前单元格未找到 %s 的定义" % ident
        _emit(result)
        return

    # kind == "hover"
    if defs:
        node = defs[-1]
        sig = _signature_of(node)
        doc = _docstring_of(node)
        content = sig if not doc else sig + "\n\n" + doc
        result["content"] = content
        result["name"] = node.name
        result["signature"] = sig
    else:
        # 不在函数里 → 看光标处的标识符在命名空间里是什么
        import re
        left = code[:cursor]
        m = re.search(r"([A-Za-z_][A-Za-z_0-9]*)$", left)
        if m and m.group(1) in user_ns:
            obj = user_ns[m.group(1)]
            desc = "%s: %s" % (m.group(1), type(obj).__name__)
            doc = getattr(obj, "__doc__", None)
            if isinstance(doc, str) and doc.strip():
                desc += "\n\n" + doc.strip().split("\n\n")[0].strip()
            result["content"] = desc
            result["name"] = m.group(1)
    _emit(result)


def _safe_callable_signature(fn, display_name):
    try:
        import inspect
        sig = inspect.signature(fn)
        return "%s%s:" % (display_name, sig)
    except Exception:
        return "%s(...):" % display_name


# ---------------------------------------------------------------------------
# 其他请求
# ---------------------------------------------------------------------------

def do_reset(req):
    user_ns.clear()
    user_ns.update({
        "__name__": "__main__",
        "__doc__": None,
        "__package__": None,
        "__builtins__": builtins,
    })
    globals()["execution_count"] = 0
    _emit({"type": "reset_result", "id": req.get("id") or ""})


def do_info(req):
    _emit({
        "type": "info_result",
        "id": req.get("id") or "",
        "version": "%d.%d.%d" % sys.version_info[:3],
        "executable": sys.executable or "python",
    })


# ---------------------------------------------------------------------------
# 主循环:一行一个 JSON
# ---------------------------------------------------------------------------

HANDLERS = {
    "execute": do_execute,
    "complete": do_complete,
    "inspect": do_inspect,
    "reset": do_reset,
    "info": do_info,
}


def main():
    _emit({"type": "kernel_ready",
           "version": "%d.%d.%d" % sys.version_info[:3],
           "executable": sys.executable or "python",
           "pid": os.getpid()})
    while True:
        try:
            line = sys.stdin.readline()
        except (KeyboardInterrupt, EOFError):
            break
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            _emit({"type": "error", "id": "", "ename": "ProtocolError",
                   "evalue": "无法解析请求 JSON", "traceback": [line[:200]]})
            continue
        rtype = req.get("type")
        if rtype == "shutdown":
            break
        handler = HANDLERS.get(rtype)
        if handler is None:
            _emit({"type": "error", "id": req.get("id") or "", "ename": "ProtocolError",
                   "evalue": "未知请求类型: %r" % rtype, "traceback": []})
            continue
        try:
            handler(req)
        except BaseException as e:
            # 内核自身出 bug(不是用户代码的错)时不能静默死掉,
            # 要让宿主知道这个 id 失败了,否则 UI 会永远转圈。
            _flush_streams(force=True)
            _restore_streams()
            try:
                tb = _clean_traceback(*sys.exc_info())
            except Exception:
                tb = [str(e)]
            _emit({"type": "error", "id": req.get("id") or "",
                   "ename": "KernelError", "evalue": str(e), "traceback": tb})
            _emit({"type": "status", "id": req.get("id") or "", "state": "idle",
                   "execution_count": execution_count})
    try:
        _REAL_STDOUT.flush()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass