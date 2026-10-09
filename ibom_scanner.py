#!/usr/bin/env python3
"""Add a camera / barcode part scanner to an InteractiveHtmlBom (iBOM) .html file.

    python ibom_scanner.py ibom.html                      # writes ibom_scanner.html
    python ibom_scanner.py ibom.html -o out.html --side top
    python ibom_scanner.py ibom.html --extras extras.csv  # replacement parts + notes

Only the Python standard library is needed. See README.md.
"""
import argparse
import base64
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
START = "<!-- ibom-scanner:start -->"
END = "<!-- ibom-scanner:end -->"

# field names people use for the manufacturer part number / manufacturer, most specific first
MPN_NAMES = ["mpn", "manufacturer part number", "manufacturer_part_number", "mfr part number",
             "mfr. part number", "mfr pn", "mfr_pn", "mfrpn", "mfg part number", "mfg pn", "mfg p/n",
             "mfr p/n", "partnumber", "part number", "part_number", "pn", "p/n"]
MFR_NAMES = ["manufacturer", "mfr", "mfr.", "mnf", "mnf.", "mfg", "mfg.", "manufacturer name"]

ROWNUM_ORIG = "td.textContent = rownum;"
ROWNUM_NEW = ("td.textContent = (window.__ibomScannerRowLabel && "
              "window.__ibomScannerRowLabel(bomentry)) || rownum;")


def die(msg):
    sys.exit("error: " + msg)


def read(path, mode="r"):
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def find_field(fields, wanted, names, what):
    if wanted:
        for i, f in enumerate(fields):
            if f.lower() == wanted.lower():
                return i
        die('field "%s" is not in this iBOM. Fields available: %s' % (wanted, ", ".join(fields)))
    low = [f.strip().lower() for f in fields]
    for n in names:
        if n in low:
            return low.index(n)
    return None


def load_extras(path):
    """CSV with columns: mpn, alternates (separated by ; or |), note."""
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = csv.DictReader(f)
        cols = {c.strip().lower(): c for c in (rows.fieldnames or [])}
        if "mpn" not in cols:
            die("extras CSV needs an 'mpn' column (optional: 'alternates', 'note'). Found: %s"
                % ", ".join(rows.fieldnames or []))
        for r in rows:
            mpn = (r.get(cols["mpn"]) or "").strip()
            if not mpn:
                continue
            alts = re.split(r"[;|]", r.get(cols.get("alternates", ""), "") or "")
            out.append({"mpn": mpn,
                        "alts": [a.strip() for a in alts if a.strip()],
                        "note": (r.get(cols.get("note", ""), "") or "").strip()})
    return out


def safe_script(s):
    return s.replace("</script", "<\\/script")


def main():
    ap = argparse.ArgumentParser(description="Add a camera / barcode part scanner to an iBOM .html file.")
    ap.add_argument("ibom", help="iBOM .html file made by InteractiveHtmlBom")
    ap.add_argument("-o", "--output", help="output file (default: <name>_scanner.html, or <name>_top/_bottom.html with --side)")
    ap.add_argument("--side", choices=["top", "bottom"], help="only list parts on this side of the board")
    ap.add_argument("--mpn-field", help="iBOM field holding the manufacturer part number (auto-detected if omitted)")
    ap.add_argument("--mfr-field", help="iBOM field holding the manufacturer name (optional, auto-detected)")
    ap.add_argument("--checkbox", help='iBOM checkbox column to tick when a part is scanned (default "Sourced")')
    ap.add_argument("--extras", help="CSV with replacement part numbers and notes (columns: mpn, alternates, note)")
    ap.add_argument("--in-place", action="store_true", help="overwrite the input file")
    a = ap.parse_args()

    html = read(a.ibom)
    if "var pcbdata" not in html or "var config" not in html:
        die("%s does not look like an InteractiveHtmlBom file" % a.ibom)
    m = re.search(r"^var config = (\{.*\})\s*$", html, re.M)
    if not m:
        die("could not read the iBOM config block (unsupported iBOM version?)")
    config = json.loads(m.group(1))
    fields = config.get("fields") or []
    if not fields:
        die("this iBOM has no field list. Regenerate it with InteractiveHtmlBom v2.4 or newer.")

    mpn_i = find_field(fields, a.mpn_field, MPN_NAMES, "MPN")
    if mpn_i is None:
        die("no part-number field found. Fields in this iBOM: %s\n"
            "Pass --mpn-field NAME, or regenerate the iBOM with your MPN field added "
            "(iBOM plugin: Fields tab, or --extra-fields MPN on the command line)." % ", ".join(fields))
    mfr_i = find_field(fields, a.mfr_field, MFR_NAMES, "manufacturer")
    if mfr_i == mpn_i:
        mfr_i = None

    boxes = [b for b in (config.get("checkboxes") or "").split(",") if b]
    if a.checkbox and a.checkbox not in boxes:
        die('checkbox "%s" is not in this iBOM. Checkboxes: %s' % (a.checkbox, ", ".join(boxes) or "none"))

    cfg = {
        "mpnField": mpn_i,
        "mfrField": mfr_i,
        "checkbox": a.checkbox,
        "side": {"top": "F", "bottom": "B"}.get(a.side),
        "extras": load_extras(a.extras) if a.extras else [],
    }

    # remove an earlier injection so the tool can be re-run on its own output
    html = re.sub(re.escape(START) + r".*?" + re.escape(END) + r"\n?", "", html, flags=re.S)
    if a.side and ROWNUM_NEW not in html:
        if ROWNUM_ORIG in html:
            html = html.replace(ROWNUM_ORIG, ROWNUM_NEW, 1)
        else:
            print("note: could not keep full-board row numbers in --side mode (unknown iBOM version); "
                  "row numbers will follow the one-sided table", file=sys.stderr)

    vendor = os.path.join(HERE, "vendor", "zxing-wasm")
    block = "\n".join([
        START,
        "<script>\n" + safe_script(read(os.path.join(vendor, "zxing-reader.iife.js"))) + "\n</script>",
        "<script>",
        'window.__ZXING_WASM_B64__="%s";' % base64.b64encode(read(os.path.join(vendor, "zxing_reader.wasm"), "rb")).decode(),
        "window.__IBOM_SCANNER_CFG__=%s;" % safe_script(json.dumps(cfg)),
        "window.__IBOM_SCANNER_CSS__=%s;" % safe_script(json.dumps(read(os.path.join(HERE, "src", "scanner.css")))),
        'window.addEventListener("load",function(){setTimeout(function(){',
        safe_script(read(os.path.join(HERE, "src", "scanner.js"))),
        "},0);});",
        "</script>",
        END,
        "",
    ])
    i = html.lower().rfind("</body>")
    if i < 0:
        die("no </body> tag found")
    html = html[:i] + block + html[i:]

    if a.in_place:
        out = a.ibom
    elif a.output:
        out = a.output
    else:
        stem = os.path.splitext(a.ibom)[0]
        out = stem + ("_" + a.side if a.side else "_scanner") + ".html"
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write(html)

    print("wrote %s" % out)
    print("  part number field: %s" % fields[mpn_i])
    print("  manufacturer field: %s" % (fields[mfr_i] if mfr_i is not None else "(none)"))
    print("  ticks go to: %s" % (a.checkbox or ("Sourced" if "Sourced" in boxes else (boxes[0] if boxes else "scanner's own storage"))))
    if a.side:
        print("  side: %s only" % a.side)
    if cfg["extras"]:
        print("  extras: %d part numbers" % len(cfg["extras"]))


if __name__ == "__main__":
    main()
