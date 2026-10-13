#!/usr/bin/env python3
"""
SENKISEM – lapképek exportja mind a 4 PDF-ből.

Futtatás (bárhonnan, a szkript a saját mappáját tekinti a projekt gyökerének):
    python export_pages.py --check          # csak ellenőriz, képet nem készít
    python export_pages.py --all            # mind a 4 könyv exportja
    python export_pages.py --book notes --lang en
    python export_pages.py --all --force    # meglévő képek felülírása

Bemenet (csak OLVAS):  ebooks/product_1..4.pdf   (mind borítós: 1=előlap, 2=hátlap, tartalom a 3.-tól)
Kimenet:  public/assets/book/<könyv>/<nyelv>/p001.webp ...
          public/assets/book/synthetic/anchors.json   (fejezet-horgonyok)
          export_manifest.json   (jelentés, a projekt gyökerében, NEM a public-ban)
"""
import argparse, json, os, re, shutil, sys, unicodedata
try:
    import pymupdf as fitz
except ImportError:
    import fitz
from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
EBOOKS = os.path.join(ROOT, "ebooks")
OUT = os.path.join(ROOT, "public", "assets", "book")

SOURCES = {("notes", "en"): ("product_1.pdf", 119), ("notes", "hu"): ("product_2.pdf", 119),
           ("synthetic", "en"): ("product_3.pdf", 120), ("synthetic", "hu"): ("product_4.pdf", 119)}
NAME_PAGE = 3
QUESTIONS = [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 29, 31, 33, 35, 37, 39, 41, 47, 49, 53, 55, 57,
             61, 63, 65, 67, 71, 73, 75, 77, 79, 81, 85, 87, 89, 91, 93, 95, 101, 105, 107, 109]
PROMPTS = [45, 51, 97, 99, 111, 115]
FILLABLE = sorted([NAME_PAGE] + QUESTIONS + PROMPTS)       # 49 db
SHORT = 130                                                # ennyi karakter alatt "üres" kérdésoldal
DPI, MAXSIZE, QUALITY = 200, (1160, 1650), 80


def fail(msg):
    print("\nHIBA:", msg)
    sys.exit(1)


def body_lines(page):
    return [l.strip() for l in page.get_text().split("\n") if l.strip() and not re.fullmatch(r"\d+", l.strip())]


def text_len(page):
    return len(" ".join(body_lines(page)))


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").upper()


def check_notes(doc, lang):
    short_odd = [n for n in range(3, len(doc) + 1) if n % 2 == 1 and text_len(doc[n - 1]) < SHORT]
    if short_odd != FILLABLE:
        fail(f"notes/{lang}: a rövid, páratlan oldalak nem egyeznek a kitölthető listával.\n"
             f"  csak a PDF-ben rövid: {sorted(set(short_odd) - set(FILLABLE))}\n"
             f"  csak a listában van:  {sorted(set(FILLABLE) - set(short_odd))}")
    bottoms = {}
    for n in QUESTIONS + PROMPTS:
        p = doc[n - 1]
        h = p.rect.height
        bl = [b for b in p.get_text("blocks") if b[6] == 0 and b[4].strip() and not b[4].strip().isdigit() and b[3] / h < 0.92]
        bottoms[n] = max(b[3] for b in bl) / h
    worst = max(bottoms, key=bottoms.get)
    p = doc[NAME_PAGE - 1]
    lines = [round((d["rect"].y0 + d["rect"].y1) / 2 / p.rect.height, 3) for d in p.get_drawings()
             if d["rect"].height < 2 and d["rect"].width > 0.25 * p.rect.width]
    return {"question_bottom_max": round(bottoms[worst], 3), "page": worst,
            "suggested_zone_top": round(bottoms[worst] + 0.04, 2), "name_line_y": lines}


def find_anchors(doc):
    mod_re, ch_re = re.compile(r"^[IVX]+\.\s+(MODULE|MODUL):", re.I), re.compile(r"^(\d{1,2})\.\s+(\S+)")
    out, mi = [], 0
    for n in range(5, len(doc) + 1):
        for line in body_lines(doc[n - 1]):
            nl = norm(line)
            if nl.startswith("PROLOG") and line.upper() == line:
                out.append(("pro", n))
            elif nl.startswith("EPILOG") and line.upper() == line:
                out.append(("epi", n))
            elif mod_re.match(line) and line.upper() == line:
                mi += 1
                out.append((f"m{mi:02d}", n))
            elif len(line) < 60:
                m = ch_re.match(line)
                if m and m.group(2).upper() == m.group(2) and 1 <= int(m.group(1)) <= 40:
                    out.append((f"c{int(m.group(1)):02d}", n))
    return [{"id": i, "page": n} for i, n in sorted(out, key=lambda x: x[1])]


def export(doc, book, lang, force):
    d = os.path.join(OUT, book, lang)
    os.makedirs(d, exist_ok=True)
    new = skip = 0
    for i, page in enumerate(doc, 1):
        fn = os.path.join(d, f"p{i:03d}.webp")
        if os.path.exists(fn) and not force:
            skip += 1
            continue
        pix = page.get_pixmap(dpi=DPI)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        img.thumbnail(MAXSIZE)
        img.save(fn, "WEBP", quality=QUALITY)
        new += 1
        print(f"\r   {book}/{lang}: {i}/{len(doc)}", end="", flush=True)
    print(f"\n   {book}/{lang}: {new} új kép, {skip} kihagyva (már megvolt)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--book", choices=["notes", "synthetic"])
    ap.add_argument("--lang", choices=["hu", "en"])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if not (a.all or a.book or a.check):
        ap.print_help()
        sys.exit(2)
    keys = [k for k in SOURCES if (not a.book or k[0] == a.book) and (not a.lang or k[1] == a.lang)]

    print("== 1. PDF-ek és oldalszámok")
    docs = {}
    for k, (fn, pages) in SOURCES.items():
        path = os.path.join(EBOOKS, fn)
        if not os.path.exists(path):
            fail(f"Nem találom: {path}")
        docs[k] = fitz.open(path)
        ok = len(docs[k]) == pages
        print(f"   {fn:<14} {k[0]:<10} {k[1]}  {len(docs[k])} oldal  {'OK' if ok else 'ELTÉRÉS, várt: ' + str(pages)}")
        if not ok:
            fail(f"{fn}: {len(docs[k])} oldal van, {pages} helyett. Ha a PDF jó, szólj, mert az olvasóban is át kell írni.")

    print("\n== 2. Jegyzetek: kitölthető oldalak (49 db) és írózóna")
    manifest = {"fillable": FILLABLE, "notes": {}, "synthetic": {}}
    for lang in ("hu", "en"):
        z = check_notes(docs[("notes", lang)], lang)
        manifest["notes"][lang] = z
        print(f"   notes/{lang}: 49 kitölthető oldal egyezik. Kérdés alja max {z['question_bottom_max']} (p{z['page']}) "
              f"-> zóna teteje legalább {z['suggested_zone_top']}; névvonal: {z['name_line_y']}")

    print("\n== 3. Synthetic: fejezet-horgonyok")
    anchors = {l: find_anchors(docs[("synthetic", l)]) for l in ("hu", "en")}
    for l in ("hu", "en"):
        print(f"   synthetic/{l}: {len(anchors[l])} horgony, {len(docs[('synthetic', l)])} oldal")
        manifest["synthetic"][l] = anchors[l]
    ids_hu, ids_en = [x["id"] for x in anchors["hu"]], [x["id"] for x in anchors["en"]]
    if ids_hu != ids_en or not ids_hu:
        fail("A HU és EN horgonyok nem egyeznek:\n  HU " + str(anchors["hu"]) + "\n  EN " + str(anchors["en"]))
    print("   horgonyok egyeznek; EN-HU eltolás horgonyonként:", [e["page"] - h["page"] for h, e in zip(anchors["hu"], anchors["en"])])

    for k, d in docs.items():
        c = len(d) - 2
        print(f"   {k[0]}/{k[1]}: {c} tartalmi oldal -> {'páratlan, 1 üres lap kerül a végére' if c % 2 else 'páros'}; "
              f"nyomtatott oldalszám = PDF-oldal - 2")

    with open(os.path.join(ROOT, "export_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.makedirs(os.path.join(OUT, "synthetic"), exist_ok=True)
    with open(os.path.join(OUT, "synthetic", "anchors.json"), "w", encoding="utf-8") as f:
        json.dump(anchors, f, ensure_ascii=False, indent=1)

    if a.check:
        print("\n--check: képeket nem készítettem. Minden ellenőrzés rendben.")
        return
    print("\n== 4. Képek")
    # a régi magyar képek (public/assets/book/p001.webp ...) átmásolása, törlés nélkül
    old = [f for f in os.listdir(OUT) if re.fullmatch(r"p\d{3}\.webp", f)] if os.path.isdir(OUT) else []
    if old and ("notes", "hu") in keys:
        dst = os.path.join(OUT, "notes", "hu")
        os.makedirs(dst, exist_ok=True)
        n = 0
        for f in old:
            if not os.path.exists(os.path.join(dst, f)):
                shutil.copy2(os.path.join(OUT, f), os.path.join(dst, f))
                n += 1
        print(f"   {n} régi magyar kép átmásolva (a régieket nem töröltem)")
    for k in keys:
        export(docs[k], k[0], k[1], a.force)
    print("\nKész.")


if __name__ == "__main__":
    main()