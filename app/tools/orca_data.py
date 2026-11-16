#!/usr/bin/env python3
"""Fetch OrcaSlicer setting metadata and printer profiles at runtime.

BicuSlicer is MIT licensed; OrcaSlicer's option definitions, UI layout and
vendor profiles are AGPL-3.0.  So the repository does not ship any of that
data.  Instead this script downloads it straight from the OrcaSlicer GitHub
repository for a given tag and writes, into an output directory:

  catalog.json   every print / filament / printer option with its metadata
                 (label, tooltip, type, limits, mode, enum values, default),
                 which keys belong to which preset type, and the desktop
                 app's page / group layout of the settings tabs.
  profiles/      a mirror of resources/profiles/**.json (vendor index files
                 and the machine / process / filament presets).

The metadata is extracted from C++ sources (PrintConfig.cpp, Preset.cpp,
Tab.cpp, ...) with a tiny best-effort C++ interpreter: it understands the
statement shapes Orca uses (straight-line `def->x = ...` blocks, range-for
loops over literal lists, small lambdas, helper methods, if/else on known
values) and ignores everything else.

Usage:
    python3 orca_data.py --tag v2.5.1 --out data/orca

Standard library only.  The output is built in <out>.tmp and renamed into
place at the end, so re-running is safe and readers never see a half-written
directory.  Set GITHUB_TOKEN to raise the GitHub API rate limit if needed.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = "OrcaSlicer/OrcaSlicer"
RAW_URL = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
API_TREE_URL = "https://api.github.com/repos/{repo}/git/trees/{sha}"
USER_AGENT = "BicuSlicer-orca-data"
PROFILES_PREFIX = "resources/profiles/"
WORKERS = 16

# Sources the catalog is built from.  Optional ones only add detail (enum
# values from MaterialType, the printer tab's retraction rows, ...) and may
# not exist in older tags.
REQUIRED_SOURCES = {
    "PrintConfig.cpp": "src/libslic3r/PrintConfig.cpp",
    "Preset.cpp": "src/libslic3r/Preset.cpp",
    "Tab.cpp": "src/slic3r/GUI/Tab.cpp",
    "Config.hpp": "src/libslic3r/Config.hpp",
}
OPTIONAL_SOURCES = {
    "PublishSettings.hpp": "src/libslic3r/PublishSettings.hpp",
    "PublishSettings.cpp": "src/libslic3r/PublishSettings.cpp",
    "MaterialType.hpp": "src/libslic3r/MaterialType.hpp",
    "MaterialType.cpp": "src/libslic3r/MaterialType.cpp",
}

# Entry points of the settings tabs in Tab.cpp.
LAYOUT_ENTRY_POINTS = {
    "process": "TabPrint::build",
    "filament": "TabFilament::build",
    "machine": "TabPrinter::build_fff",
}

CO_TYPES = {  # ConfigOptionType -> (catalog type, is vector)
    "coFloat": ("float", False), "coFloats": ("float", True),
    "coInt": ("int", False), "coInts": ("int", True),
    "coBool": ("bool", False), "coBools": ("bool", True),
    "coString": ("string", False), "coStrings": ("string", True),
    "coPercent": ("percent", False), "coPercents": ("percent", True),
    "coFloatOrPercent": ("float_or_percent", False),
    "coFloatsOrPercents": ("float_or_percent", True),
    "coEnum": ("enum", False), "coEnums": ("enum", True),
    "coPoint": ("point", False), "coPoints": ("points", False),
    "coPoint3": ("other", False), "coPointsGroups": ("other", True),
}
MODES = {"comSimple": "simple", "comAdvanced": "advanced", "comExpert": "expert", "comDevelop": "develop"}


class FetchError(Exception):
    def __init__(self, url: str, reason: str, status: int | None = None):
        super().__init__(f"{url}: {reason}")
        self.status = status


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http_get(url: str, retries: int = 3, timeout: float = 60) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    if url.startswith("https://api.github.com/"):
        headers["Accept"] = "application/vnd.github+json"
        if os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    reason, status = "unknown error", None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            reason, status = f"HTTP {e.code} {e.reason}", e.code
            if e.code == 403 and e.headers.get("X-RateLimit-Remaining") == "0":
                reason += " (GitHub API rate limit exceeded; set GITHUB_TOKEN)"
                break
            if e.code in (401, 403, 404, 410, 422):
                break
        except (urllib.error.URLError, OSError) as e:  # DNS, refused, timeouts, resets
            reason = str(getattr(e, "reason", e))
        if attempt + 1 < retries:
            time.sleep(1.5 * (attempt + 1))
    raise FetchError(url, reason, status)


def raw_url(tag: str, path: str) -> str:
    return RAW_URL.format(repo=REPO, ref=urllib.parse.quote(tag, safe=""),
                          path=urllib.parse.quote(path, safe="/"))


def fetch_sources(tag: str, local_dir: Path | None) -> dict[str, str]:
    """Download the C++ sources (or read them from --source-dir)."""
    wanted = {**{k: (v, True) for k, v in REQUIRED_SOURCES.items()},
              **{k: (v, False) for k, v in OPTIONAL_SOURCES.items()}}
    out: dict[str, str] = {}

    def get(name: str) -> tuple[str, str | None]:
        path, required = wanted[name]
        if local_dir and (local_dir / name).is_file():
            return name, (local_dir / name).read_text(encoding="utf-8", errors="replace")
        try:
            return name, http_get(raw_url(tag, path)).decode("utf-8", errors="replace")
        except FetchError as e:
            if not required and e.status == 404:
                return name, None
            raise

    with cf.ThreadPoolExecutor(max_workers=len(wanted)) as pool:
        for name, text in pool.map(get, wanted):
            if text is None:
                log(f"  {name}: not present in this tag (optional, skipped)")
            else:
                out[name] = text
                log(f"  {name}: {len(text) // 1024} KiB")
    return out


# --------------------------------------------------------------------------
# C++ lexing
# --------------------------------------------------------------------------

_COMMENT_RE = re.compile(
    r'(?P<raw>(?<![A-Za-z0-9_])(?:u8|u|U|L)?R"(?P<d>[^()\\\s]{0,16})\(.*?\)(?P=d)")'
    r'|(?P<str>"(?:\\.|[^"\\\n])*")'
    r"|(?P<chr>'(?:\\.|[^'\\\n])*')"
    r'|(?P<line>//[^\n]*)'
    r'|(?P<block>/\*.*?\*/)', re.S)


def strip_comments(src: str) -> str:
    """Blank out comments (keeping offsets and newlines), leave literals alone."""
    def repl(m: re.Match) -> str:
        if m.lastgroup in ("line", "block"):
            return re.sub(r"[^\n]", " ", m.group(0))
        return m.group(0)
    return _COMMENT_RE.sub(repl, src)


def preprocess(src: str) -> str:
    """Drop preprocessor lines and inactive #if 0 / #else branches.

    Unknown conditions keep their first branch.  Line numbers are preserved.
    """
    lines = src.split("\n")
    out: list[str] = []
    stack: list[tuple[bool, bool]] = []  # (parent active, a branch was taken)
    active = True
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s.startswith("#"):
            out.append(lines[i] if active else "")
            i += 1
            continue
        full, n = s, 1
        while full.endswith("\\") and i + n < len(lines):
            full = full[:-1] + lines[i + n]
            n += 1
        m = re.match(r"#\s*(\w+)\s*(.*)", full)
        directive, arg = (m.group(1), m.group(2).strip()) if m else ("", "")
        if directive in ("if", "ifdef", "ifndef"):
            take = not (directive == "if" and arg in ("0", "false"))
            stack.append((active, take))
            active = active and take
        elif directive == "elif" and stack:
            parent, taken = stack[-1]
            take = not taken and arg not in ("0", "false")
            stack[-1] = (parent, taken or take)
            active = parent and take
        elif directive == "else" and stack:
            parent, taken = stack[-1]
            stack[-1] = (parent, True)
            active = parent and not taken
        elif directive == "endif" and stack:
            active = stack.pop()[0]
        out.extend([""] * n)
        i += n
    return "\n".join(out)


_TOKEN_RE = re.compile(r"""
  (?P<ws>\s+)
| (?P<str>(?:u8|u|U|L)?R"(?P<d>[^()\\\s]{0,16})\(.*?\)(?P=d)"|(?:u8|u|U|L)?"(?:\\.|[^"\\\n])*")
| (?P<chr>(?:u8|u|U|L)?'(?:\\.|[^'\\\n])+')
| (?P<num>(?:0[xX][0-9a-fA-F']+|(?:\d[\d']*\.?[\d']*|\.\d[\d']*)(?:[eE][+-]?\d+)?)[uUlLfF]*)
| (?P<id>[A-Za-z_]\w*)
| (?P<op>::|->|\+\+|--|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|\.\.\.|[-+*/%<>=!&|^~?:;,.(){}\[\]\#])
""", re.X | re.S)

_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f",
                   "v": "\v", "\\": "\\", '"': '"', "'": "'", "?": "?"}


def unescape(s: str) -> str:
    if "\\" not in s:
        return s
    out = bytearray()
    i = 0
    while i < len(s):
        c = s[i]
        if c != "\\" or i + 1 >= len(s):
            out += c.encode("utf-8")
            i += 1
            continue
        n = s[i + 1]
        if n == "x":
            m = re.match(r"[0-9a-fA-F]+", s[i + 2:])
            out.append(int(m.group(0), 16) & 0xFF if m else 0)
            i += 2 + (len(m.group(0)) if m else 0)
        elif n in "uU":
            width = 4 if n == "u" else 8
            try:
                out += chr(int(s[i + 2:i + 2 + width], 16)).encode("utf-8")
            except ValueError:
                pass
            i += 2 + width
        elif n in "01234567":
            m = re.match(r"[0-7]{1,3}", s[i + 1:])
            out.append(int(m.group(0), 8) & 0xFF)
            i += 1 + len(m.group(0))
        else:
            out += _SIMPLE_ESCAPES.get(n, n).encode("utf-8")
            i += 2
    return out.decode("utf-8", errors="replace")


def decode_string_literal(lit: str) -> str:
    m = re.match(r'(?:u8|u|U|L)?(R?)"', lit)
    body = lit[m.end():]
    if m.group(1):  # raw string: delim( ... )delim"
        p = body.index("(")
        return body[p + 1:len(body) - p - 2]
    return unescape(body[:-1])


class Tok:
    __slots__ = ("kind", "val", "start", "end")

    def __init__(self, kind: str, val: str, start: int, end: int):
        self.kind, self.val, self.start, self.end = kind, val, start, end

    def __repr__(self) -> str:
        return f"Tok({self.kind},{self.val!r})"


def tokenize(text: str) -> list[Tok]:
    toks: list[Tok] = []
    for m in _TOKEN_RE.finditer(text):
        if m.group("ws") is not None:
            continue
        if m.group("str") is not None:
            val = decode_string_literal(m.group("str"))
            if toks and toks[-1].kind == "str":  # "adjacent" "literals" concatenate
                toks[-1].val += val
                toks[-1].end = m.end()
                continue
            toks.append(Tok("str", val, m.start(), m.end()))
        elif m.group("chr") is not None:
            toks.append(Tok("chr", unescape(m.group("chr").split("'", 1)[1][:-1]), m.start(), m.end()))
        elif m.group("num") is not None:
            toks.append(Tok("num", m.group("num"), m.start(), m.end()))
        elif m.group("id") is not None:
            toks.append(Tok("id", m.group("id"), m.start(), m.end()))
        else:
            toks.append(Tok("op", m.group("op"), m.start(), m.end()))
    return toks


def match_brackets(toks: list[Tok]) -> dict[int, int]:
    pairs = {")": "(", "]": "[", "}": "{"}
    match: dict[int, int] = {}
    stack: list[int] = []
    for i, t in enumerate(toks):
        if t.kind != "op":
            continue
        if t.val in ("(", "[", "{"):
            stack.append(i)
        elif t.val in pairs:
            while stack and toks[stack[-1]].val != pairs[t.val]:
                stack.pop()
            if stack:
                o = stack.pop()
                match[o] = i
                match[i] = o
    return match


def parse_number(text: str) -> int | float:
    t = text.replace("'", "")
    if t[:2] in ("0x", "0X"):
        return int(t.rstrip("uUlL"), 16)
    t = t.rstrip("uUlLfF")
    return float(t) if any(c in t for c in ".eE") else int(t)


class Source:
    """A preprocessed, tokenized C++ file."""

    def __init__(self, name: str, text: str, aux: bool = False):
        self.name = name
        self.aux = aux
        self.text = preprocess(strip_comments(text))
        self.toks = tokenize(self.text)
        self.match = match_brackets(self.toks)
        self._blocks: dict[tuple[int, int], list] = {}

    def raw(self, s: int, e: int) -> str:
        """Source text of tokens [s, e) with whitespace runs collapsed."""
        parts: list[str] = []
        prev = None
        for t in self.toks[s:e]:
            if prev is not None and t.start > prev:
                parts.append(" ")
            parts.append(re.sub(r"\s+", " ", self.text[t.start:t.end]) if t.kind == "str"
                         else self.text[t.start:t.end])
            prev = t.end
        return "".join(parts)

    def close_of(self, i: int, default: int) -> int:
        return self.match.get(i, default)

    def split_top(self, s: int, e: int, sep: str) -> list[tuple[int, int]]:
        """Split [s, e) on top-level `sep` operator tokens."""
        parts, start, k = [], s, s
        while k < e:
            t = self.toks[k]
            if t.kind == "op" and t.val in ("(", "[", "{") and k in self.match:
                k = self.match[k] + 1
                continue
            if t.kind == "op" and t.val == sep:
                parts.append((start, k))
                start = k + 1
            k += 1
        parts.append((start, e))
        return parts

    # ---- statements -----------------------------------------------------

    def block(self, s: int, e: int) -> list:
        key = (s, e)
        if key not in self._blocks:
            stmts, i = [], s
            while i < e:
                node, nxt = self.statement(i, e)
                stmts.append(node)
                i = max(nxt, i + 1)
            self._blocks[key] = stmts
        return self._blocks[key]

    def _stmt_end(self, i: int, e: int) -> int:
        k = i
        while k < e:
            t = self.toks[k]
            if t.kind == "op":
                if t.val in ("(", "[", "{"):
                    k = self.match.get(k, e - 1) + 1
                    continue
                if t.val == ";" or t.val in (")", "]", "}"):
                    return k
            k += 1
        return e

    def statement(self, i: int, e: int):
        toks = self.toks
        t = toks[i]
        if t.kind == "op":
            if t.val == "{":
                close = self.close_of(i, e)
                return ("block", self.block(i + 1, close)), close + 1
            if t.val in (";", ")", "]", "}"):
                return ("nop",), i + 1
        if t.kind == "id":
            v = t.val
            nxt_val = toks[i + 1].val if i + 1 < e else ""
            if v == "if":
                k = i + 1
                if k < e and toks[k].val == "constexpr":
                    k += 1
                if k < e and toks[k].val == "(" and k in self.match:
                    close = self.match[k]
                    then, nxt = self.statement(close + 1, e) if close + 1 < e else (("nop",), e)
                    els = None
                    if nxt < e and toks[nxt].val == "else":
                        els, nxt = self.statement(nxt + 1, e)
                    return ("if", (k + 1, close), then, els), nxt
            elif v in ("for", "while", "switch") and nxt_val == "(" and i + 1 in self.match:
                close = self.match[i + 1]
                body, nxt = self.statement(close + 1, e) if close + 1 < e else (("nop",), e)
                return (v, (i + 2, close), body), nxt
            elif v == "do":
                body, nxt = self.statement(i + 1, e)
                if nxt < e and toks[nxt].val == "while" and nxt + 1 in self.match:
                    nxt = self.match[nxt + 1] + 1
                    if nxt < e and toks[nxt].val == ";":
                        nxt += 1
                return body, nxt
            elif v in ("else", "try"):
                return self.statement(i + 1, e) if i + 1 < e else (("nop",), e)
            elif v == "catch" and nxt_val == "(" and i + 1 in self.match:
                _, nxt = self.statement(self.match[i + 1] + 1, e)
                return ("nop",), nxt
            elif v == "case":
                k = i + 1
                while k < e and toks[k].val != ":":
                    k += 1
                return ("nop",), k + 1
            elif v in ("default", "public", "private", "protected") and nxt_val == ":":
                return ("nop",), i + 2
            elif v in ("break", "continue"):
                end = self._stmt_end(i, e)
                return ("break",), end + 1
            elif v == "return":
                end = self._stmt_end(i + 1, e)
                return ("return", (i + 1, end)), end + 1
        end = self._stmt_end(i, e)
        return ("expr", (i, end)), end + 1


# --------------------------------------------------------------------------
# A tiny C++ interpreter
# --------------------------------------------------------------------------

class Sym:
    """An unevaluated name or expression (enum constant, unknown call, ...)."""
    __slots__ = ("name",)

    def __init__(self, name: str):
        self.name = name

    def __repr__(self) -> str:
        return f"Sym({self.name})"


UNKNOWN = Sym("?")


class RawList(list):
    """Value of a braced initializer list; remembers its source text."""
    raw = ""


class Lambda:
    def __init__(self, params: list[str], body: tuple[int, int], env: "Env"):
        self.params, self.body, self.env = params, body, env


class Fmt:
    """boost::format(...) % a % b"""

    def __init__(self, fmt: str):
        self.fmt, self.args = fmt, []

    def render(self) -> str:
        s = re.sub(r"%(\d+)%", lambda m: str(self.args[int(m.group(1)) - 1])
                   if int(m.group(1)) <= len(self.args) else m.group(0), self.fmt)
        it = iter(self.args)
        return re.sub(r"%[-+ #0]*\d*(?:\.\d+)?[sdifgu]", lambda m: str(next(it, m.group(0))), s)


class Func:
    def __init__(self, qualname: str, params: list[str], body: tuple[int, int], src: Source):
        self.qualname, self.params, self.body, self.src = qualname, params, body, src
        self.cls = qualname.rsplit("::", 1)[0] if "::" in qualname else ""
        self.name = qualname.rsplit("::", 1)[-1]


class EvalError(Exception):
    pass


class ReturnSignal(Exception):
    def __init__(self, value):
        self.value = value


class BreakSignal(Exception):
    pass


class Env:
    def __init__(self, parent: "Env | None" = None, src: Source | None = None, cls: str | None = None):
        self.vars: dict = {}
        self.parent = parent
        self.src = src if src is not None else (parent.src if parent else None)
        self.cls = cls if cls is not None else (parent.cls if parent else "")

    def find(self, name: str) -> "Env | None":
        e = self
        while e is not None:
            if name in e.vars:
                return e
            e = e.parent
        return None

    def lookup(self, name: str):
        e = self.find(name)
        if e is None:
            raise KeyError(name)
        return e.vars[name]

    def assign(self, name: str, value) -> None:
        (self.find(name) or self).vars[name] = value


_TYPEISH_OPS = {"::", "<", ">", ",", "*", "&", "&&"}
_TRANSPARENT_CALLS = {"L", "_L", "_u8L", "_", "_utf8", "L_CONTEXT", "_CTX", "_CTX_utf8", "u8", "from_u8",
                      "into_u8", "wxString", "string", "FromUTF8", "static_cast", "dynamic_cast",
                      "const_cast", "reinterpret_cast", "move", "wxT", "wxS"}


def truth(v):
    """C++ truthiness, or None when unknown."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return True
    return None


class Interp:
    """Statement/expression evaluator; subclasses add domain hooks."""

    MAX_DEPTH = 24

    def __init__(self, sources: list[Source]):
        self.sources = sources
        self.funcs: dict[str, list[Func]] = {}
        self.structs: dict[str, list[str]] = {}
        self.globals = Env()
        self.globals.vars.update({"true": True, "false": False, "INT_MAX": 2147483647,
                                  "FLT_MAX": float("inf"), "DBL_MAX": float("inf")})
        self.stack: list[str] = []
        self.errors = 0
        for src in sources:
            self._scan_toplevel(src)

    # ---- top-level scanning --------------------------------------------

    def _scan_toplevel(self, src: Source) -> None:
        toks, match, n = src.toks, src.match, len(src.toks)
        # struct definitions anywhere (field order is what brace-init uses)
        for i, t in enumerate(toks):
            if t.val in ("struct", "class") and i + 2 < n and toks[i + 1].kind == "id" \
                    and toks[i + 2].val == "{" and i + 2 in match:
                self.structs.setdefault(toks[i + 1].val, self._struct_fields(src, i + 3, match[i + 2]))
        i = 0
        while i < n:
            t = toks[i]
            if t.kind == "id" and t.val == "namespace":
                k = i + 1
                while k < n and toks[k].val not in ("{", ";", "="):
                    k += 1
                i = k + 1  # step into the namespace body (or past the alias)
                continue
            if t.val == "extern" and i + 2 < n and toks[i + 1].kind == "str" and toks[i + 2].val == "{":
                i += 3
                continue
            if t.val == "(" and i in match:
                close = match[i]
                k = close + 1
                while k < n and toks[k].val in ("const", "noexcept", "override", "final"):
                    k += 1
                if k < n and toks[k].val == ":":  # constructor initializer list
                    while k < n and toks[k].val not in (";",):
                        if toks[k].val == "{" and toks[k - 1].val in (")", "}"):
                            break
                        k = match.get(k, k) + 1 if toks[k].val in ("(", "{", "[") else k + 1
                j = i - 1
                parts = []
                while j >= 0 and toks[j].kind == "id":
                    parts.insert(0, toks[j].val)
                    if j >= 2 and toks[j - 1].val == "::" and toks[j - 2].kind == "id":
                        j -= 2
                    else:
                        break
                if k < n and toks[k].val == "{" and k in match and parts:
                    qual = "::".join(parts)
                    params = self._params(src, i + 1, close)
                    self.funcs.setdefault(qual, []).append(Func(qual, params, (k + 1, match[k]), src))
                    i = match[k] + 1
                    continue
                i = close + 1
                continue
            if t.val in ("{", "[") and i in match:
                i = match[i] + 1
                continue
            i += 1

    def _params(self, src: Source, s: int, e: int) -> list[str]:
        names = []
        for ps, pe in src.split_top(s, e, ","):
            if ps >= pe:
                continue
            for k in range(ps, pe):
                if src.toks[k].val == "=":
                    pe = k
                    break
            ids = [t.val for t in src.toks[ps:pe] if t.kind == "id"]
            if ids and ids != ["void"]:
                names.append(ids[-1])
        return names

    def _struct_fields(self, src: Source, s: int, e: int) -> list[str]:
        fields = []
        for fs, fe in src.split_top(s, e, ";"):
            toks = src.toks[fs:fe]
            if not toks or any(t.val == "(" for t in toks) or toks[0].val in ("using", "static", "enum"):
                continue
            cut = next((k for k, t in enumerate(toks) if t.val in ("=", "{", "[")), len(toks))
            ids = [t.val for t in toks[:cut] if t.kind == "id"]
            if len(ids) >= 2:
                fields.append(ids[-1])
        return fields

    def find_func(self, name: str, cls: str = "", aux_only: bool = False) -> Func | None:
        cands = []
        if "::" in name:
            cands = self.funcs.get(name, [])
        else:
            for c in ([cls] if cls else []) + ["Tab", ""]:
                cands = self.funcs.get(f"{c}::{name}" if c else name, [])
                if cands:
                    break
        cands = [f for f in cands if f.src.aux] if aux_only else cands
        return cands[0] if cands else None

    # ---- execution -----------------------------------------------------

    def invoke(self, fn: Func, args: list):
        if fn.qualname in self.stack or len(self.stack) >= self.MAX_DEPTH:
            return UNKNOWN
        env = Env(self.globals, src=fn.src, cls=fn.cls)
        env.vars["this"] = Sym("this")
        for p, a in zip(fn.params, args):
            env.vars[p] = a
        self.stack.append(fn.qualname)
        try:
            self.exec_block(fn.src.block(*fn.body), env)
        except ReturnSignal as r:
            return r.value
        except BreakSignal:
            pass
        finally:
            self.stack.pop()
        return None

    def call_lambda(self, lam: Lambda, args: list):
        if len(self.stack) >= self.MAX_DEPTH:
            return UNKNOWN
        env = Env(lam.env)
        for p, a in zip(lam.params, args):
            env.vars[p] = a
        self.stack.append("<lambda>")
        try:
            self.exec_block(env.src.block(*lam.body), env)
        except ReturnSignal as r:
            return r.value
        except BreakSignal:
            pass
        finally:
            self.stack.pop()
        return None

    def exec_block(self, stmts: list, env: Env, in_switch: bool = False) -> None:
        for st in stmts:
            if in_switch:
                try:
                    self.exec_stmt(st, env)
                except BreakSignal:
                    pass
            else:
                self.exec_stmt(st, env)

    def exec_stmt(self, node, env: Env) -> None:
        kind = node[0]
        if kind == "expr":
            try:
                self.exec_expr(node[1], env)
            except (EvalError, KeyError, IndexError, TypeError, ValueError, AttributeError, ZeroDivisionError,
                    RecursionError):
                self.errors += 1
        elif kind == "block":
            self.exec_block(node[1], Env(env))
        elif kind == "if":
            try:
                cond = truth(self.eval_range(node[1], env))
            except Exception:
                cond = None
            if cond is not False:
                self.exec_stmt(node[2], Env(env))
            if cond is not True and node[3] is not None:
                self.exec_stmt(node[3], Env(env))
        elif kind == "for":
            self.exec_for(node, env)
        elif kind == "while":
            try:
                self.exec_stmt(node[2], Env(env))
            except BreakSignal:
                pass
        elif kind == "switch":
            body = node[2]
            stmts = body[1] if body[0] == "block" else [body]
            self.exec_block(stmts, Env(env), in_switch=True)
        elif kind == "return":
            s, e = node[1]
            value = None
            if s < e:
                try:
                    value = self.eval_range((s, e), env)
                except Exception:
                    value = UNKNOWN
            raise ReturnSignal(value)
        elif kind == "break":
            raise BreakSignal()

    def exec_for(self, node, env: Env) -> None:
        src = env.src
        s, e = node[1]
        semis = src.split_top(s, e, ";")
        if len(semis) > 1:  # classic for: run the body once, loop variables unknown
            inner = Env(env)
            try:
                self.exec_expr(semis[0], inner)
            except Exception:
                pass
            for name in inner.vars:
                inner.vars[name] = UNKNOWN
            try:
                self.exec_stmt(node[2], inner)
            except BreakSignal:
                pass
            return
        colon, k = None, s
        while k < e:  # find a top-level ':' (skip bracket groups)
            t = src.toks[k]
            if t.val in ("(", "[", "{") and k in src.match:
                k = src.match[k] + 1
                continue
            if t.val == ":":
                colon = k
                break
            k += 1
        if colon is None or any(t.val == "[" for t in src.toks[s:colon]):
            return
        var = next((t.val for t in reversed(src.toks[s:colon]) if t.kind == "id"), None)
        try:
            rng = self.eval_range((colon + 1, e), env)
        except Exception:
            rng = UNKNOWN
        if not isinstance(rng, list):
            return  # unknown range (runtime data): skip the body
        for item in list(rng):
            inner = Env(env)
            inner.vars[var] = item
            try:
                self.exec_stmt(node[2], inner)
            except BreakSignal:
                break

    def _typeish(self, toks: list[Tok]) -> bool:
        return bool(toks) and all(t.kind in ("id", "num") or t.val in _TYPEISH_OPS for t in toks)

    def exec_expr(self, rng: tuple[int, int], env: Env) -> None:
        src = env.src
        s, e = rng
        if s >= e:
            return
        toks = src.toks
        first = toks[s]
        if first.val in ("struct", "class") and s + 2 < e and toks[s + 2].val == "{":
            self.structs[toks[s + 1].val] = self._struct_fields(src, s + 3, src.close_of(s + 2, e))
            return
        if first.val in ("using", "typedef", "assert", "static_assert", "throw", "goto", "BOOST_LOG_TRIVIAL"):
            return
        if first.kind == "op" and first.val == "(" and s + 2 < e and toks[s + 1].val == "void" \
                and toks[s + 2].val == ")":
            return  # (void)L("...") translation markers
        if e - s == 2 and {toks[s].val, toks[s + 1].val} & {"++", "--"}:
            name_tok = toks[s] if toks[s].kind == "id" else toks[s + 1]
            op = toks[s + 1].val if toks[s].kind == "id" else toks[s].val
            cur = env.lookup(name_tok.val)
            if isinstance(cur, (int, float)) and not isinstance(cur, bool):
                env.assign(name_tok.val, cur + (1 if op == "++" else -1))
            return
        parts = src.split_top(s, e, "=")
        if len(parts) > 1:
            value = self.eval_range(parts[-1], env)
            for ls, le in parts[:-1]:
                self.assign_to(ls, le, value, env, parts[-1])
            return
        # Declarations without '=':  T name;  T name{...};  T name(...);
        last = e - 1
        if toks[last].val in ("}", ")") and last in src.match:
            o = src.match[last]
            if o - 1 > s and toks[o - 1].kind == "id" and toks[o - 2].val not in ("::", ",") \
                    and self._typeish(toks[s:o - 1]):
                name = toks[o - 1].val
                if toks[last].val == "}":
                    value = self.eval_range((o, last + 1), env)
                    env.vars[name] = self.convert_decl(toks[s:o - 1], value)
                else:
                    for a in src.split_top(o + 1, last, ","):
                        self._try_eval(a, env)
                    env.vars[name] = Sym(name)
                return
        if e - s >= 2 and toks[last].kind == "id" and self._typeish(toks[s:e]) and toks[last - 1].val != "::":
            env.vars[toks[last].val] = None
            return
        self.eval_range((s, e), env)

    def _try_eval(self, rng, env):
        try:
            return self.eval_range(rng, env)
        except Exception:
            return UNKNOWN

    def assign_to(self, ls: int, le: int, value, env: Env, rhs: tuple[int, int]) -> None:
        src = env.src
        toks = src.toks
        n = le - ls
        if n <= 0:
            return
        last = toks[le - 1]
        if n == 1 and last.kind == "id":
            env.assign(last.val, value)
        elif last.kind == "id" and toks[le - 2].val in (".", "->"):
            base = self.eval_range((ls, le - 2), env)
            self.set_member(base, last.val, value, env, rhs)
        elif last.kind == "id" and self._typeish(toks[ls:le]) and toks[le - 2].val != "::":
            env.vars[last.val] = self.convert_decl(toks[ls:le - 1], value)

    def convert_decl(self, type_toks: list[Tok], value):
        """Turn brace-initialized data into dicts when the element type is a known struct."""
        names = [t.val for t in type_toks if t.kind == "id"]
        struct = next((nm for nm in reversed(names) if nm in self.structs), None)
        if struct is None or not isinstance(value, list):
            return value
        fields = self.structs[struct]
        is_container = any(nm in ("vector", "array", "deque", "list", "initializer_list") for nm in names)

        def mk(item):
            if isinstance(item, list):
                return dict(zip(fields, item))
            return item
        if is_container:
            out = RawList(mk(x) for x in value)
            out.raw = getattr(value, "raw", "")
            return out
        return mk(value)

    # ---- hooks for subclasses -----------------------------------------

    NOT_HANDLED = object()

    def call_hook(self, callee: tuple, args: list[tuple[int, int]], env: Env):
        return self.NOT_HANDLED

    def get_member(self, base, name: str):
        if isinstance(base, dict):
            return base.get(name, UNKNOWN)
        if isinstance(base, Sym):
            return Sym(f"{base.name}.{name}")
        return UNKNOWN

    def set_member(self, base, name: str, value, env: Env, rhs: tuple[int, int]) -> None:
        if isinstance(base, dict):
            base[name] = value

    # ---- calls ---------------------------------------------------------

    def call(self, callee: tuple, args: list[tuple[int, int]], env: Env):
        r = self.call_hook(callee, args, env)
        if r is not self.NOT_HANDLED:
            return r
        if callee[0] == "func":
            name, fval = callee[1], callee[2]
            if isinstance(fval, Lambda):
                return self.call_lambda(fval, [self._try_eval(a, env) for a in args])
            short = name.rsplit("::", 1)[-1]
            if short in _TRANSPARENT_CALLS or name in ("std::string", "wxString::FromUTF8"):
                return self.eval_range(args[0], env) if args and args[0][0] < args[0][1] else ""
            if name in ("boost::format", "format") and args:
                return Fmt(str(self.eval_range(args[0], env)))
            if short == "to_upper_copy" and args:
                return str(self.eval_range(args[0], env)).upper()
            if short == "to_lower_copy" and args:
                return str(self.eval_range(args[0], env)).lower()
            fn = self.find_func(name, aux_only=True)
            if fn is not None:
                return self.invoke(fn, [self._try_eval(a, env) for a in args])
            for a in args:
                self._try_eval(a, env)
            return Sym(name + "()")
        base, name = callee[1], callee[2]
        vals = [self._try_eval(a, env) for a in args]
        if isinstance(base, str):
            if name in ("length", "size"):
                return len(base)
            if name == "empty":
                return len(base) == 0
            if name in ("c_str", "ToStdString", "utf8_str", "ToUTF8"):
                return base
            if name == "find" and vals and isinstance(vals[0], str):
                return base.find(vals[0])
            if name == "substr" and vals and isinstance(vals[0], int):
                return base[vals[0]:] if len(vals) < 2 or not isinstance(vals[1], int) \
                    else base[vals[0]:vals[0] + vals[1]]
            return UNKNOWN
        if isinstance(base, Fmt) and name == "str":
            return base.render()
        if isinstance(base, list):
            if name in ("push_back", "emplace_back") and vals:
                base.append(vals[0])
                return None
            if name == "size":
                return len(base)
            if name == "clear":
                base.clear()
                return None
        return Sym(f"{getattr(base, 'name', '?')}.{name}()")

    # ---- expressions -----------------------------------------------------

    def eval_range(self, rng: tuple[int, int], env: Env):
        s, e = rng
        if s >= e:
            raise EvalError("empty expression")
        p = _Parser(self, env, s, e)
        v = p.ternary()
        if p.pos < e:
            raise EvalError(f"trailing tokens at {env.src.raw(p.pos, min(e, p.pos + 4))!r}")
        return v


class _Parser:
    def __init__(self, interp: Interp, env: Env, s: int, e: int):
        self.it, self.env, self.pos, self.end = interp, env, s, e
        self.src = env.src
        self.toks = env.src.toks

    def peek(self, k: int = 0) -> str:
        i = self.pos + k
        return self.toks[i].val if i < self.end else ""

    def close(self, i: int) -> int:
        c = self.src.match.get(i)
        if c is None or c >= self.end:
            raise EvalError("unbalanced brackets")
        return c

    def ternary(self):
        c = self.logic_or()
        if self.peek() == "?":
            self.pos += 1
            a = self.ternary()
            if self.peek() != ":":
                raise EvalError("bad ternary")
            self.pos += 1
            b = self.ternary()
            t = truth(c)
            return a if t is True else b if t is False else UNKNOWN
        return c

    def logic_or(self):
        left = self.logic_and()
        while self.peek() == "||":
            self.pos += 1
            right = self.logic_and()
            a, b = truth(left), truth(right)
            left = True if (a is True or b is True) else False if (a is False and b is False) else UNKNOWN
        return left

    def logic_and(self):
        left = self.compare()
        while self.peek() == "&&":
            self.pos += 1
            right = self.compare()
            a, b = truth(left), truth(right)
            left = False if (a is False or b is False) else True if (a is True and b is True) else UNKNOWN
        return left

    def compare(self):
        left = self.additive()
        while self.peek() in ("==", "!=", "<", ">", "<=", ">=", "|", "&", "^", "<<"):
            op = self.peek()
            self.pos += 1
            right = self.additive()
            if isinstance(left, Sym) or isinstance(right, Sym) or op in ("|", "&", "^", "<<"):
                left = UNKNOWN
                continue
            try:
                left = {"==": lambda a, b: a == b, "!=": lambda a, b: a != b, "<": lambda a, b: a < b,
                        ">": lambda a, b: a > b, "<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b}[op](left, right)
            except TypeError:
                left = UNKNOWN
        return left

    def additive(self):
        left = self.multiplicative()
        while self.peek() in ("+", "-"):
            op = self.peek()
            self.pos += 1
            right = self.multiplicative()
            left = self.binop(op, left, right)
        return left

    def multiplicative(self):
        left = self.unary()
        while self.peek() in ("*", "/", "%"):
            op = self.peek()
            self.pos += 1
            right = self.unary()
            if op == "%" and isinstance(left, Fmt):
                left.args.append(right)
            else:
                left = self.binop(op, left, right)
        return left

    @staticmethod
    def binop(op, a, b):
        if isinstance(a, Sym) or isinstance(b, Sym) or a is None or b is None:
            return UNKNOWN
        try:
            if op == "+":
                if isinstance(a, str) or isinstance(b, str):
                    return str(a) + str(b) if isinstance(a, str) and isinstance(b, str) else UNKNOWN
                return a + b
            if op == "-":
                return a - b
            if op == "*":
                return a * b
            if op == "/":
                return a // b if isinstance(a, int) and isinstance(b, int) else a / b
            if op == "%":
                return a % b
        except Exception:
            return UNKNOWN
        return UNKNOWN

    def unary(self):
        v = self.peek()
        if v in ("-", "+", "!", "~", "&", "*", "new", "delete", "const", "++", "--"):
            self.pos += 1
            x = self.unary()
            if v == "-":
                return -x if isinstance(x, (int, float)) and not isinstance(x, bool) else UNKNOWN
            if v == "!":
                t = truth(x)
                return UNKNOWN if t is None else not t
            return x
        if v == "sizeof":
            self.pos += 1
            self.unary()
            return UNKNOWN
        if v == "(" and self.pos + 2 < self.end and self.toks[self.pos + 1].kind == "id":
            c = self.close(self.pos)
            inner = self.toks[self.pos + 1:c]
            casts = {"void", "int", "double", "float", "size_t", "bool", "unsigned", "char", "long", "short",
                     "int64_t", "uint32_t", "coord_t"}
            if c + 1 < self.end and (inner[0].val in casts and all(t.kind == "id" or t.val in "*&" for t in inner)):
                self.pos = c + 1
                return self.unary()
        return self.postfix(self.primary())

    def skip_template(self) -> bool:
        """If at '<' that opens template args followed by ( :: or {, skip them."""
        if self.peek() != "<":
            return False
        depth, k = 0, self.pos
        while k < self.end:
            t = self.toks[k]
            if t.val in ("(", "[", "{") and k in self.src.match:
                k = self.src.match[k] + 1
                continue
            if t.val == "<":
                depth += 1
            elif t.val == ">":
                depth -= 1
                if depth == 0:
                    nxt = self.toks[k + 1].val if k + 1 < self.end else ""
                    if nxt in ("(", "::", "{", ")", ",", ""):
                        self.pos = k + 1
                        return True
                    return False
            elif t.val in (";", "&&", "||", "?", "=", "==", "!=") or t.kind in ("str",):
                return False
            k += 1
        return False

    def args(self, open_idx: int) -> list[tuple[int, int]]:
        c = self.close(open_idx)
        self.pos = c + 1
        if c == open_idx + 1:
            return []
        return self.src.split_top(open_idx + 1, c, ",")

    def primary(self):
        if self.pos >= self.end:
            raise EvalError("unexpected end")
        t = self.toks[self.pos]
        if t.kind == "num":
            self.pos += 1
            return parse_number(t.val)
        if t.kind in ("str", "chr"):
            self.pos += 1
            return t.val
        if t.val == "(":
            c = self.close(self.pos)
            v = self.it.eval_range((self.pos + 1, c), self.env)
            self.pos = c + 1
            return v
        if t.val == "{":
            c = self.close(self.pos)
            out = RawList()
            out.raw = self.src.raw(self.pos + 1, c)
            for a in self.src.split_top(self.pos + 1, c, ","):
                if a[0] < a[1]:
                    out.append(self.it._try_eval(a, self.env))
            self.pos = c + 1
            return out
        if t.val == "[":  # lambda
            c = self.close(self.pos)
            self.pos = c + 1
            params: list[str] = []
            if self.peek() == "(":
                pc = self.close(self.pos)
                params = self.it._params(self.src, self.pos + 1, pc)
                self.pos = pc + 1
            while self.pos < self.end and self.peek() != "{":
                self.pos += 1
            bc = self.close(self.pos)
            lam = Lambda(params, (self.pos + 1, bc), self.env)
            self.pos = bc + 1
            return lam
        if t.kind == "id" or t.val == "::":
            parts = []
            if t.val == "::":
                self.pos += 1
            while self.pos < self.end and self.toks[self.pos].kind == "id":
                parts.append(self.toks[self.pos].val)
                self.pos += 1
                self.skip_template()
                if self.peek() == "::" and self.pos + 1 < self.end and self.toks[self.pos + 1].kind == "id":
                    self.pos += 1
                    continue
                break
            name = "::".join(parts)
            if name == "this":
                return Sym("this")
            if name == "nullptr":
                return Sym("nullptr")
            if self.peek() == "(":
                fval = None
                if len(parts) == 1:
                    try:
                        fval = self.env.lookup(name)
                    except KeyError:
                        pass
                return self.it.call(("func", name, fval), self.args(self.pos), self.env)
            if self.peek() == "{" and parts and parts[-1][:1].isupper():  # Type{...} temporary
                c = self.close(self.pos)
                v = self.it.eval_range((self.pos, c + 1), self.env)
                self.pos = c + 1
                return self.it.convert_decl([Tok("id", p, 0, 0) for p in parts], v)
            if len(parts) == 1:
                try:
                    return self.env.lookup(name)
                except KeyError:
                    pass
                if name in self.it.globals.vars:
                    return self.it.globals.vars[name]
            return Sym(name)
        raise EvalError(f"unexpected token {t.val!r}")

    def postfix(self, val):
        while self.pos < self.end:
            v = self.peek()
            if v in (".", "->") and self.pos + 1 < self.end and self.toks[self.pos + 1].kind == "id":
                name = self.toks[self.pos + 1].val
                self.pos += 2
                if name == "template" and self.pos < self.end and self.toks[self.pos].kind == "id":
                    name = self.toks[self.pos].val
                    self.pos += 1
                self.skip_template()
                if self.peek() == "(":
                    val = self.it.call(("method", val, name), self.args(self.pos), self.env)
                else:
                    val = self.it.get_member(val, name)
            elif v == "(":
                args = self.args(self.pos)
                if isinstance(val, Lambda):
                    val = self.it.call_lambda(val, [self.it._try_eval(a, self.env) for a in args])
                else:
                    for a in args:
                        self.it._try_eval(a, self.env)
                    val = UNKNOWN
            elif v == "[":
                c = self.close(self.pos)
                idx = self.it._try_eval((self.pos + 1, c), self.env)
                self.pos = c + 1
                try:
                    val = val[idx]
                except Exception:
                    val = UNKNOWN
            elif v in ("++", "--"):
                self.pos += 1
            else:
                break
        return val


# --------------------------------------------------------------------------
# PrintConfig.cpp: option definitions
# --------------------------------------------------------------------------

class OptRef:
    __slots__ = ("key",)

    def __init__(self, key: str):
        self.key = key


class ConfigDefInterp(Interp):
    """Executes PrintConfigDef::PrintConfigDef() and records every option."""

    LIST_FIELDS = ("enum_values", "enum_labels")

    def __init__(self, sources: list[Source]):
        super().__init__(sources)
        self.options: dict[str, dict] = {}

    def run(self) -> None:
        ctor = self.find_func("PrintConfigDef::PrintConfigDef")
        if ctor is None:
            raise RuntimeError("PrintConfigDef::PrintConfigDef() not found in PrintConfig.cpp")
        self.invoke(ctor, [])

    def call_hook(self, callee, args, env):
        if callee[0] == "method":
            base, name = callee[1], callee[2]
            is_this = isinstance(base, Sym) and base.name == "this"
            if isinstance(base, Sym) and base.name in ("options", "this.options") and name == "find" and args:
                key = self._try_eval(args[0], env)
                return OptRef(key) if isinstance(key, str) and key in self.options else UNKNOWN
            if is_this and name in ("add", "add_nullable") and len(args) >= 2:
                key = self.eval_range(args[0], env)
                if not isinstance(key, str):
                    raise EvalError("option key is not a string")
                typ = self._try_eval(args[1], env)
                typ = typ.name if isinstance(typ, Sym) else typ if isinstance(typ, str) else "coNone"
                self.options[key] = {"type": typ.rsplit("::", 1)[-1], "nullable": name == "add_nullable"}
                return OptRef(key)
            if is_this:
                fn = self.find_func(f"PrintConfigDef::{name}")
                if fn is not None:
                    return self.invoke(fn, [self._try_eval(a, env) for a in args])
            if isinstance(base, OptRef) and name == "set_default_value" and args:
                self.options[base.key]["default"] = self._default_text(args[0], env)
                return None
        return self.NOT_HANDLED

    def _default_text(self, rng, env) -> str | None:
        """Raw text inside `new ConfigOptionX(...)` / `{...}`."""
        src = env.src
        toks = src.toks
        s, e = rng
        k = s + 1 if toks[s].val == "new" else s
        angle = 0
        while k < e:
            v = toks[k].val
            if v == "<":
                angle += 1
            elif v == ">":
                angle -= 1
            elif v in ("(", "{") and angle == 0:
                break
            k += 1
        if k >= e or k not in src.match:
            return src.raw(s, e)
        inner = (k + 1, src.match[k])
        # Copy the default of another option (add_nullable override loop).
        for t in toks[inner[0]:inner[1]]:
            if t.kind == "id":
                try:
                    v = env.lookup(t.val)
                except KeyError:
                    continue
                if isinstance(v, OptRef):
                    return self.options.get(v.key, {}).get("default")
        # Defaults passed in through variables (lambda params, loop structs).
        if any(t.kind == "id" and env.find(t.val) not in (None, self.globals) for t in toks[inner[0]:inner[1]]):
            v = self._try_eval(inner, env)
            if hasattr(v, "raw"):
                return v.raw
            if isinstance(v, Sym) and v is not UNKNOWN:
                return v.name
            if isinstance(v, str):
                return json.dumps(v, ensure_ascii=False)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return str(v)
        return src.raw(*inner)

    def get_member(self, base, name):
        if isinstance(base, OptRef):
            if name == "second":
                return base
            opt = self.options.get(base.key, {})
            if name in self.LIST_FIELDS:
                return opt.setdefault(name, [])
            if name == "default_value":
                return Sym("default_value")
            return opt.get(name)
        return super().get_member(base, name)

    def set_member(self, base, name, value, env, rhs):
        if not isinstance(base, OptRef):
            return super().set_member(base, name, value, env, rhs)
        opt = self.options.setdefault(base.key, {})
        if name == "enum_keys_map":
            opt[name] = value if isinstance(value, str) else env.src.raw(*rhs)
        elif isinstance(value, list):
            opt[name] = list(value)
        else:
            opt[name] = value


# --------------------------------------------------------------------------
# Tab.cpp: settings tab layout
# --------------------------------------------------------------------------

class Page:
    def __init__(self, title: str):
        self.title = title
        self.groups: list[Group] = []


class Group:
    def __init__(self, title: str):
        self.title = title
        self.options: list[str] = []


class PageRef:
    __slots__ = ("page",)

    def __init__(self, page: Page):
        self.page = page


class GroupRef:
    __slots__ = ("group",)

    def __init__(self, group: Group):
        self.group = group


class TabOption:
    __slots__ = ("key",)

    def __init__(self, key: str):
        self.key = key


class PagePos:
    """m_pages.begin() + n  /  m_pages.end() - n"""

    def __init__(self, anchor: str, offset: int = 0):
        self.anchor, self.offset = anchor, offset

    def __add__(self, n):
        return PagePos(self.anchor, self.offset + n) if isinstance(n, int) else UNKNOWN

    def __sub__(self, n):
        return PagePos(self.anchor, self.offset - n) if isinstance(n, int) else UNKNOWN


_PAGE_MARKERS = ("add_options_page", "new_optgroup")


class LayoutInterp(Interp):
    """Executes a Tab*::build() function and records pages, groups and options."""

    def __init__(self, sources: list[Source]):
        super().__init__(sources)
        self._builders: dict[str, bool] = {}

    def build(self, entry: str) -> list[Page]:
        self.pages: list[Page] = []      # m_pages, in tab order
        self.created: list[Page] = []
        self.page: Page | None = None
        self.group: Group | None = None
        fn = self.find_func(entry)
        if fn is None:
            raise RuntimeError(f"{entry}() not found in Tab.cpp")
        self.invoke(fn, [])
        return self.pages + [p for p in self.created if p not in self.pages]

    def _is_builder(self, fn: Func) -> bool:
        if fn.qualname not in self._builders:
            s, e = fn.body
            self._builders[fn.qualname] = any(t.val in _PAGE_MARKERS for t in fn.src.toks[s:e])
        return self._builders[fn.qualname]

    def _add(self, group, key) -> None:
        if isinstance(key, TabOption):
            key = key.key
        if not isinstance(key, str) or not key:
            return
        g = group.group if isinstance(group, GroupRef) else self.group
        if g is None:
            g = self._new_group(None, "")
        key = key.split("#", 1)[0]
        if key not in g.options:
            g.options.append(key)

    def _new_group(self, page, title: str) -> Group:
        p = page.page if isinstance(page, PageRef) else self.page
        if p is None:
            p = Page("")
            self.created.append(p)
            self.pages.append(p)
            self.page = p
        g = Group(title)
        p.groups.append(g)
        self.group = g
        return g

    def call_hook(self, callee, args, env):
        if callee[0] == "func":
            name, base = callee[1], None
        else:
            base, name = callee[1], callee[2]
        is_this = callee[0] == "func" or isinstance(base, Sym) and base.name == "this"
        ev = lambda i: self._try_eval(args[i], env) if i < len(args) else UNKNOWN  # noqa: E731

        if name == "add_options_page" and is_this:
            title = ev(0)
            page = Page(title if isinstance(title, str) else "")
            self.created.append(page)
            if truth(ev(2)) is not True:  # is_extruder_pages: placed later via m_pages.insert
                self.pages.append(page)
            self.page, self.group = page, None
            return PageRef(page)
        if name == "new_optgroup" and callee[0] == "method":
            title = ev(0)
            return GroupRef(self._new_group(base, title if isinstance(title, str) else ""))
        if name in ("append_single_option_line", "get_option") and callee[0] == "method" and args:
            key = ev(0)
            self._add(base, key)
            return TabOption(key.key if isinstance(key, TabOption) else key) if isinstance(key, (str, TabOption)) \
                else UNKNOWN
        if name in ("create_line_with_widget", "append_option_line") and len(args) >= 2:
            self._add(ev(0), ev(1))
            for i in range(2, len(args)):
                ev(i)
            return UNKNOWN
        if name == "get" and isinstance(base, GroupRef):
            return base
        if isinstance(base, Sym) and base.name == "m_pages":
            if name == "begin":
                return PagePos("begin")
            if name == "end":
                return PagePos("end")
            if name in ("insert", "push_back"):
                pos = ev(0) if name == "insert" else PagePos("end")
                page = ev(len(args) - 1)
                page = page.page if isinstance(page, PageRef) else (self.created[-1] if self.created else None)
                if page is None:
                    return None
                if page in self.pages:
                    self.pages.remove(page)
                idx = len(self.pages)
                if isinstance(pos, PagePos):
                    idx = pos.offset if pos.anchor == "begin" else len(self.pages) + pos.offset
                self.pages.insert(max(0, min(idx, len(self.pages))), page)
                return None
            return UNKNOWN
        if is_this:
            fn = self.find_func(name, cls=env.cls)
            if fn is not None and fn.cls and self._is_builder(fn):
                return self.invoke(fn, [self._try_eval(a, env) for a in args])
        return self.NOT_HANDLED

    def get_member(self, base, name):
        if isinstance(base, (GroupRef, PageRef, TabOption)):
            return UNKNOWN
        return super().get_member(base, name)


# --------------------------------------------------------------------------
# Small source scrapers
# --------------------------------------------------------------------------

def string_list_after(src: Source, name: str) -> list[str] | None:
    """Strings in the braced initializer that follows identifier `name`."""
    toks = src.toks
    for i, t in enumerate(toks):
        if t.kind == "id" and t.val == name:
            k = i + 1
            if k < len(toks) and toks[k].val == "=":
                k += 1
            if k < len(toks) and toks[k].val == "{" and k in src.match:
                return [x.val for x in toks[k + 1:src.match[k]] if x.kind == "str"]
    return None


def global_string_lists(src: Source) -> dict[str, RawList]:
    """`std::vector<std::string> NAME = {...}` / std::set at any level."""
    out: dict[str, RawList] = {}
    toks = src.toks
    for i, t in enumerate(toks):
        if t.val in ("vector", "set") and i + 7 < len(toks) and [x.val for x in toks[i + 1:i + 6]] == \
                ["<", "std", "::", "string", ">"] and toks[i + 6].kind == "id":
            k = i + 7
            if toks[k].val == "=":
                k += 1
            if toks[k].val == "{" and k in src.match:
                vals = RawList(x.val for x in toks[k + 1:src.match[k]] if x.kind == "str")
                out.setdefault(toks[i + 6].val, vals)
    return out


def enum_key_maps(src: Source) -> dict[str, list[str]]:
    """s_keys_map_<Enum> { {"name", value}, ... } -> {Enum: [names...]}"""
    out: dict[str, list[str]] = {}
    toks = src.toks
    for i, t in enumerate(toks):
        if t.kind == "id" and t.val.startswith("s_keys_map_"):
            k = i + 1
            if k < len(toks) and toks[k].val == "=":
                k += 1
            if k < len(toks) and toks[k].val == "{" and k in src.match:
                names, j, end = [], k + 1, src.match[k]
                while j < end:
                    if toks[j].val == "{" and j in src.match:
                        inner = toks[j + 1:src.match[j]]
                        if inner and inner[0].kind == "str":
                            names.append(inner[0].val)
                        j = src.match[j] + 1
                    else:
                        j += 1
                out.setdefault(t.val[len("s_keys_map_"):], names)
    return out


def default_mode(config_hpp: str) -> str:
    m = re.search(r"ConfigOptionMode\s+mode\s*=\s*(com\w+)\s*;", strip_comments(config_hpp))
    if not m:
        log("warning: could not find ConfigOptionDef::mode default in Config.hpp; assuming comSimple")
        return "comSimple"
    return m.group(1)


def unique(seq) -> list:
    seen, out = set(), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------

def _num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float) and (v != v or abs(v) >= 1e30):
        return None
    return v


def _text(v):
    return v if isinstance(v, str) else None


def build_catalog(tag: str, texts: dict[str, str]) -> tuple[dict, dict]:
    aux = [Source(n, texts[n], aux=True) for n in OPTIONAL_SOURCES if n in texts]
    pc = Source("PrintConfig.cpp", texts["PrintConfig.cpp"])
    preset = Source("Preset.cpp", texts["Preset.cpp"])
    tab = Source("Tab.cpp", texts["Tab.cpp"])
    stats: dict = {}

    # ---- options ----
    log("parsing PrintConfig.cpp ...")
    cfg = ConfigDefInterp([pc] + aux)
    cfg.globals.vars.update(global_string_lists(pc))
    cfg.run()
    keymaps = enum_key_maps(pc)
    mode_default = default_mode(texts["Config.hpp"])
    stats["default_mode"] = MODES.get(mode_default, mode_default)
    stats["config_stmt_errors"] = cfg.errors

    options: dict[str, dict] = {}
    for key, o in cfg.options.items():
        typ, vector = CO_TYPES.get(o.get("type", ""), ("other", False))
        values = [v for v in (o.get("enum_values") or []) if isinstance(v, str)]
        if not values and o.get("enum_keys_map"):
            m = re.search(r"ConfigOptionEnum\s*<\s*(\w+)\s*>", o["enum_keys_map"])
            if m and m.group(1) in keymaps:
                values = list(keymaps[m.group(1)])
        labels = [v if isinstance(v, str) else None for v in (o.get("enum_labels") or [])]
        if values:
            labels = [(labels[i] if i < len(labels) and labels[i] is not None else v) for i, v in enumerate(values)]
        mode = o.get("mode")
        mode = mode.name.rsplit("::", 1)[-1] if isinstance(mode, Sym) else mode_default
        options[key] = {
            "type": typ,
            "vector": vector,
            "label": _text(o.get("label")) or None,
            "full_label": _text(o.get("full_label")) or None,
            "category": _text(o.get("category")) or None,
            "tooltip": _text(o.get("tooltip")) or None,
            "sidetext": _text(o.get("sidetext")) or None,
            "min": _num(o.get("min")),
            "max": _num(o.get("max")),
            "mode": MODES.get(mode, MODES[mode_default] if mode_default in MODES else "simple"),
            "enum_values": values or None,
            "enum_labels": labels or None,
            "multiline": o.get("multiline") is True,
            "readonly": o.get("readonly") is True,
            "default": o.get("default") if isinstance(o.get("default"), str) else None,
        }

    # ---- preset type membership ----
    def plist(name: str) -> list[str]:
        vals = string_list_after(preset, name)
        if vals is None:
            raise RuntimeError(f"{name} not found in Preset.cpp")
        return vals
    extruder_keys = string_list_after(pc, "m_extruder_option_keys") or []
    type_options_raw = {
        "process": plist("s_Preset_print_options"),
        "filament": plist("s_Preset_filament_options"),
        # Preset::printer_options() = printer + machine limits + nozzle (extruder) options
        "machine": plist("s_Preset_printer_options") + plist("s_Preset_machine_limits_options") + extruder_keys,
    }
    type_options, stats["type_keys_unknown"] = {}, {}
    for t, keys in type_options_raw.items():
        keys = unique(keys)
        type_options[t] = [k for k in keys if k in options]
        stats["type_keys_unknown"][t] = sorted(k for k in keys if k not in options)

    # ---- layouts ----
    log("parsing Tab.cpp ...")
    lay = LayoutInterp([tab] + aux)
    layouts, stats["layout_dropped"], stats["other_appended"] = {}, {}, {}
    for t, entry in LAYOUT_ENTRY_POINTS.items():
        placed: set[str] = set()
        dropped: list[str] = []
        pages_out = []
        for page in lay.build(entry):
            groups_out = []
            for g in page.groups:
                opts = []
                for k in g.options:
                    if k not in options:
                        dropped.append(k)
                    elif k not in placed:
                        placed.add(k)
                        opts.append(k)
                if opts:
                    groups_out.append({"title": g.title, "options": opts})
            if groups_out:
                pages_out.append({"page": page.title, "groups": groups_out})
        rest = [k for k in type_options[t] if k not in placed]
        if rest:
            pages_out.append({"page": "Other", "groups": [{"title": "Other", "options": rest}]})
        layouts[t] = pages_out
        stats["layout_dropped"][t] = unique(dropped)
        stats["other_appended"][t] = len(rest)
    stats["layout_stmt_errors"] = lay.errors

    catalog = {
        "orca_tag": tag,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "options": options,
        "type_options": type_options,
        "layouts": layouts,
    }
    return catalog, stats


# --------------------------------------------------------------------------
# Profiles
# --------------------------------------------------------------------------

def _tree(sha: str, recursive: bool) -> dict:
    url = API_TREE_URL.format(repo=REPO, sha=urllib.parse.quote(sha, safe="")) + ("?recursive=1" if recursive else "")
    return json.loads(http_get(url))


def list_profile_files(tag: str) -> list[str]:
    """Paths of resources/profiles/**.json at `tag` via the git trees API."""
    data = _tree(tag, recursive=True)
    if not data.get("truncated"):
        return sorted(e["path"] for e in data.get("tree", [])
                      if e.get("type") == "blob" and e["path"].startswith(PROFILES_PREFIX)
                      and e["path"].lower().endswith(".json"))
    log("  repository tree is truncated; walking resources/profiles instead")
    sha = tag
    for part in PROFILES_PREFIX.strip("/").split("/"):
        entry = next((e for e in _tree(sha, False).get("tree", []) if e["path"] == part and e["type"] == "tree"), None)
        if entry is None:
            raise FetchError(API_TREE_URL, f"{PROFILES_PREFIX} not found at {tag}")
        sha = entry["sha"]

    out: list[str] = []

    def walk(tree_sha: str, prefix: str) -> None:
        sub = _tree(tree_sha, recursive=True)
        if not sub.get("truncated"):
            out.extend(prefix + e["path"] for e in sub.get("tree", [])
                       if e.get("type") == "blob" and e["path"].lower().endswith(".json"))
            return
        for e in _tree(tree_sha, False).get("tree", []):
            if e["type"] == "tree":
                walk(e["sha"], prefix + e["path"] + "/")
            elif e["type"] == "blob" and e["path"].lower().endswith(".json"):
                out.append(prefix + e["path"])
    walk(sha, PROFILES_PREFIX)
    return sorted(out)


def download_profiles(tag: str, dest: Path) -> dict:
    t0 = time.monotonic()
    log("listing profiles ...")
    paths = list_profile_files(tag)
    if not paths:
        raise FetchError(API_TREE_URL, f"no JSON files under {PROFILES_PREFIX} at {tag}")
    log(f"  {len(paths)} JSON files; downloading with {WORKERS} workers ...")
    total = 0
    done = 0
    bad_json: list[str] = []

    def get(path: str) -> tuple[str, int, bool]:
        data = http_get(raw_url(tag, path), retries=3)
        rel = path[len(PROFILES_PREFIX):]
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        try:
            json.loads(data)
            ok = True
        except ValueError:
            ok = False
        return rel, len(data), ok

    step = max(1, len(paths) // 20)
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(get, p) for p in paths]
        try:
            for fut in cf.as_completed(futures):
                rel, size, ok = fut.result()
                total += size
                done += 1
                if not ok:
                    bad_json.append(rel)
                if done % step == 0 or done == len(paths):
                    log(f"  {done}/{len(paths)} files, {total / 1048576:.1f} MiB")
        except BaseException:
            for f in futures:
                f.cancel()
            raise
    for rel in bad_json:
        log(f"  warning: {rel} is not valid JSON (kept as-is)")
    vendors = [p for p in paths if p.count("/") == PROFILES_PREFIX.count("/")]
    return {"files": len(paths), "vendor_index_files": len(vendors), "bytes": total,
            "seconds": round(time.monotonic() - t0, 1), "invalid_json": len(bad_json)}


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def summarize(catalog: dict, stats: dict) -> None:
    opts = catalog["options"]
    by_mode: dict[str, int] = {}
    by_type: dict[str, int] = {}
    for o in opts.values():
        by_mode[o["mode"]] = by_mode.get(o["mode"], 0) + 1
        t = o["type"] + ("[]" if o["vector"] else "")
        by_type[t] = by_type.get(t, 0) + 1
    log(f"options: {len(opts)}  (default mode when unset: {stats['default_mode']})")
    log("  by mode: " + ", ".join(f"{k}={v}" for k, v in sorted(by_mode.items())))
    log("  by type: " + ", ".join(f"{k}={v}" for k, v in sorted(by_type.items())))
    for t, pages in catalog["layouts"].items():
        groups = sum(len(p["groups"]) for p in pages)
        log(f"layout {t}: {len(pages)} pages, {groups} groups, {len(catalog['type_options'][t])} preset keys, "
            f"{stats['other_appended'][t]} appended to 'Other', "
            f"{len(stats['layout_dropped'][t])} unknown layout keys dropped")
        if stats["type_keys_unknown"][t]:
            log(f"  preset keys without a definition (dropped): {', '.join(stats['type_keys_unknown'][t])}")
        if stats["layout_dropped"][t]:
            log(f"  dropped layout keys: {', '.join(stats['layout_dropped'][t])}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", required=True, help="OrcaSlicer git tag, e.g. v2.5.1")
    ap.add_argument("--out", required=True, type=Path, help="output directory (replaced atomically)")
    ap.add_argument("--no-profiles", action="store_true", help="only write catalog.json")
    ap.add_argument("--source-dir", type=Path,
                    help="read PrintConfig.cpp, Tab.cpp, ... from this directory when present (development aid)")
    args = ap.parse_args(argv)

    out: Path = args.out.resolve()
    tmp = out.with_name(out.name + ".tmp")
    old = out.with_name(out.name + ".old")
    try:
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)

        log(f"fetching OrcaSlicer {args.tag} sources ...")
        texts = fetch_sources(args.tag, args.source_dir)
        catalog, stats = build_catalog(args.tag, texts)
        if len(catalog["options"]) < 100 or not all(catalog["layouts"].values()):
            raise RuntimeError(f"parsing produced only {len(catalog['options'])} options; "
                               "the source layout probably changed")
        (tmp / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n",
                                          encoding="utf-8")
        summarize(catalog, stats)

        if not args.no_profiles:
            p = download_profiles(args.tag, tmp / "profiles")
            log(f"profiles: {p['files']} JSON files ({p['vendor_index_files']} vendor index files), "
                f"{p['bytes'] / 1048576:.1f} MiB in {p['seconds']} s")

        if old.exists():
            shutil.rmtree(old)
        if out.exists():
            out.rename(old)
        tmp.rename(out)
        if old.exists():
            shutil.rmtree(old)
        log(f"done: {out}")
        return 0
    except FetchError as e:
        log(f"error: download failed: {e}")
        return 2
    except KeyboardInterrupt:
        log("interrupted")
        return 130
    except Exception as e:  # parsing / filesystem problems
        log(f"error: {type(e).__name__}: {e}")
        return 1
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
