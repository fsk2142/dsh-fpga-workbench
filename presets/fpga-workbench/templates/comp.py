#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""comp.py - 参照数据与本工具输出的比对:先归一化,再**只比值、不比排版**。

用法: python comp.py <参照文件> <输出文件> [--kind hex|text](默认 hex)
退出码: 0 = 取值一致;1 = 取值不一致 / 没比上;2 = 参数不全 / 文件读不到
实测事故:金标 CRLF、输出 LF,逐字节比导致每行都"不一致",纯排版差异冒充了功能失败 ——
所以行尾、首尾与行尾空白、十六进制大小写与 0x 前缀、空行先全部抹平,再比值。
"""
import argparse, sys

MAX_SHOWN = 10          # 最多打印多少处不一致(位置 + 两边的值)

def load(path):
    """读文件 → (文本, 行尾风格, 有没有 BOM)。读不到抛 OSError(调用方转成退出码 2)。"""
    with open(path, "rb") as fh:
        raw = fh.read()
    text = raw.decode("utf-8-sig", errors="replace")        # 抹掉 BOM,坏字节不炸
    eol = "CRLF" if "\r\n" in text else ("CR" if "\r" in text else "LF")
    return text, eol, raw.startswith(b"\xef\xbb\xbf")

def items(text, kind):
    """归一化成 [(位置, 值, 原样)]:空行与行尾空白丢掉;hex 去 0x 前缀后按数值比。"""
    out = []
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:                                        # 空行不是样本,不参与比对
            continue
        if kind == "text":
            out.append(("line %d" % ln, line, line))
            continue
        for w, tok in enumerate(line.split(), 1):
            bare = tok[2:] if tok.lower().startswith("0x") else tok
            try:
                out.append(("line %d word %d" % (ln, w), int(bare, 16), tok))
            except ValueError:                              # 认不出的词照样列出来比,不静默丢
                out.append(("line %d word %d" % (ln, w), tok, tok))
    return out

def show(v):
    return "<missing>" if v is None else ("0x%X" % v if isinstance(v, int) else repr(v))

def main():
    ap = argparse.ArgumentParser(description="compare values only, after normalizing formatting")
    ap.add_argument("reference")
    ap.add_argument("output")
    ap.add_argument("--kind", choices=("hex", "text"), default="hex")
    args = ap.parse_args()          # 参数不全或 --kind 不合法:argparse 自己以退出码 2 结束
    try:
        rtext, reol, rbom = load(args.reference)
        otext, oeol, obom = load(args.output)
    except OSError as exc:
        print("ERROR: cannot read file: %s" % exc)
        return 2

    ref, out = items(rtext, args.kind), items(otext, args.kind)
    if reol != oeol: print("format-only difference ignored: line endings (%s vs %s)" % (reol, oeol))
    if rbom != obom: print("format-only difference ignored: UTF-8 BOM")
    unit = "values" if args.kind == "hex" else "lines"
    if not ref and not out: print("EMPTY: nothing compared -- 0 samples is not a pass"); return 1

    val = lambda i, seq: seq[i][1] if i < len(seq) else None
    bad = [k for k in range(max(len(ref), len(out))) if val(k, ref) != val(k, out)]
    # 取值全一致时,原样写法不同就只是排版:大小写、0x 前缀、前导零
    if not bad and args.kind == "hex" and [p[2] for p in ref] != [p[2] for p in out]:
        print("format-only difference ignored: hex case or 0x prefix")
    if not bad:
        print("MATCH: %d %s compared" % (len(ref), unit))
        return 0
    print("MISMATCH: %d of %d %s differ (%d in reference, %d in output)"
          % (len(bad), max(len(ref), len(out)), unit, len(ref), len(out)))
    for k in bad[:MAX_SHOWN]:
        where = (ref if k < len(ref) else out)[k][0]
        print("  %s: reference=%s output=%s" % (where, show(val(k, ref)), show(val(k, out))))
    if len(bad) > MAX_SHOWN: print("  ... %d more" % (len(bad) - MAX_SHOWN))
    return 1

if __name__ == "__main__":
    sys.exit(main())
