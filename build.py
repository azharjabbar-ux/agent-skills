#!/usr/bin/env python3
"""
build.py -- Knowledge Galaxy indexer.

Scans every .md file under the project root and emits:

  viewer/graph-data.js   const GRAPH = {nodes:[...], links:[...]}   (browser-facing)
  notes-index.json       fuller note text for server-side retrieval  (NOT web-reachable)

Node ids are numeric and equal to the node's index in the nodes array.

Standard library only. Python 3.8+.
"""

import json
import os
import re
import sys

# --- configuration ----------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(ROOT, "viewer")
GRAPH_OUT = os.path.join(VIEWER_DIR, "graph-data.js")
INDEX_OUT = os.path.join(ROOT, "notes-index.json")

EXCERPT_CHARS = 700          # "roughly a 700-character excerpt"
RETRIEVAL_CHARS = 4000       # server-side text kept for /chat scoring
MAX_LINKS_PER_NODE = 12      # keeps the galaxy readable instead of a hairball

# How a node's colour group is chosen:
#   "toplevel" -> the top-level directory (docs, skills, evals, ...)
#   "parent"   -> the immediate parent directory
# For a flat notes vault these are identical. For a nested repo "toplevel"
# gives a handful of meaningful colours instead of ~26 singleton groups.
GROUP_MODE = "toplevel"

# Directories never worth indexing.
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".pytest_cache", "dist", "build", ".next", ".cache", "vendor",
}

# Filenames that carry no meaning on their own -- the containing folder is the
# real title (skills/idea-refine/SKILL.md is the "idea-refine" note).
GENERIC_STEMS = {"skill", "readme", "index", "_index", "overview", "about"}

# Titles too common to be a reliable "mention" signal on their own.
WEAK_TITLE_WORDS = {
    "agents", "plan", "build", "test", "review", "ship", "spec", "docs",
    "notes", "index", "readme", "overview", "about", "todo", "log", "main",
    "home", "new", "draft", "ideas", "comparison", "commands", "rules",
}

WORD_RE = re.compile(r"[a-z0-9]+")
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)")


# --- helpers ----------------------------------------------------------------

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def humanize(title):
    """'api-and-interface-design' -> 'api and interface design'"""
    return re.sub(r"[-_]+", " ", title).strip()


def strip_markdown(text):
    """Reduce markdown to readable prose for the excerpt."""
    # YAML frontmatter
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    text = re.sub(r"```.*?```", " ", text, flags=re.S)        # fenced code
    text = re.sub(r"`([^`]*)`", r"\1", text)                   # inline code
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)        # html comments
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]{1,400}>", " ", text)                 # html tags (badges etc.)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)          # images
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)       # links -> text
    text = re.sub(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]", r"\1", text)  # wikilinks
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)  # headings
    text = re.sub(r"^\s{0,3}>\s?", "", text, flags=re.M)       # quotes
    text = re.sub(r"^\s{0,3}[-*+]\s+", "", text, flags=re.M)   # bullets
    text = re.sub(r"^\s{0,3}\|.*\|\s*$", " ", text, flags=re.M)  # tables
    text = re.sub(r"[*_~]{1,3}", "", text)                     # emphasis
    text = re.sub(r"^\s*[-=]{3,}\s*$", " ", text, flags=re.M)  # rules
    return re.sub(r"\s+", " ", text).strip()


def make_excerpt(prose, limit=EXCERPT_CHARS):
    """Roughly `limit` characters, cut on a word boundary."""
    if len(prose) <= limit:
        return prose
    cut = prose[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "..."


def derive_title(rel_path):
    """Filename as the label -- unless the filename is generic, in which case
    the containing folder is what the note is actually called."""
    parts = rel_path.split(os.sep)
    stem = os.path.splitext(parts[-1])[0]
    if stem.lower() in GENERIC_STEMS and len(parts) > 1:
        return parts[-2]
    return stem


def derive_group(rel_path):
    parts = rel_path.split(os.sep)
    if len(parts) == 1:
        return "root"
    if GROUP_MODE == "toplevel":
        return parts[0]
    # Parent mode: a generic filename promoted its folder to the title, so
    # the group promotes one level too.
    stem = os.path.splitext(parts[-1])[0]
    dirs = parts[:-2] if stem.lower() in GENERIC_STEMS else parts[:-1]
    return dirs[-1] if dirs else "root"


# --- scan -------------------------------------------------------------------

def scan(root):
    notes = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".git")
        )
        for fn in sorted(filenames):
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()
            except OSError as exc:
                print("  ! skipped %s (%s)" % (rel, exc), file=sys.stderr)
                continue
            prose = strip_markdown(raw)
            notes.append({
                "path": rel.replace(os.sep, "/"),
                "title": derive_title(rel),
                "group": derive_group(rel),
                "raw": raw,
                "prose": prose,
            })
    return notes


# --- linking ----------------------------------------------------------------

def build_links(notes):
    """A mentions B when A cites B's path, wikilinks B, or names B's title.
    Scores are merged symmetrically; each node keeps its strongest links."""
    scores = {}

    def bump(a, b, weight):
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        scores[key] = scores.get(key, 0) + weight

    lowered = [n["prose"].lower() + " " + n["raw"].lower() for n in notes]
    wikilinks = [
        {slugify(m) for m in WIKILINK_RE.findall(n["raw"])} for n in notes
    ]

    # Precompute match patterns per note.
    patterns = []
    for n in notes:
        title = n["title"]
        forms = {title.lower(), humanize(title).lower()}
        forms = {f for f in forms if len(f) >= 3}
        distinctive = len(title) >= 8 or "-" in title or "_" in title
        if title.lower() in WEAK_TITLE_WORDS:
            distinctive = False
        patterns.append({
            "path": n["path"].lower(),
            "tail": n["path"].lower().split("/")[-1],
            "slug": slugify(title),
            "regexes": [
                re.compile(r"(?<![a-z0-9])" + re.escape(f) + r"(?![a-z0-9])")
                for f in sorted(forms)
            ],
            "distinctive": distinctive,
        })

    for i, text in enumerate(lowered):
        for j, pat in enumerate(patterns):
            if i == j:
                continue
            # 1. explicit path reference -- the strongest "mentions" signal
            if pat["path"] in text:
                bump(i, j, 3)
                continue
            # 2. wikilink to B's title
            if pat["slug"] and pat["slug"] in wikilinks[i]:
                bump(i, j, 3)
                continue
            # 3. title mentioned in prose
            hits = sum(len(rx.findall(text)) for rx in pat["regexes"])
            if hits:
                if pat["distinctive"]:
                    bump(i, j, 2)
                elif hits >= 2:
                    bump(i, j, 1)

    # 4. shared wikilink targets
    for i in range(len(notes)):
        if not wikilinks[i]:
            continue
        for j in range(i + 1, len(notes)):
            if wikilinks[i] & wikilinks[j]:
                bump(i, j, 1)

    # Trim to each node's strongest links so hubs don't swallow the galaxy.
    by_node = {}
    for (a, b), w in scores.items():
        by_node.setdefault(a, []).append((w, b))
        by_node.setdefault(b, []).append((w, a))

    keep = set()
    for node, edges in by_node.items():
        edges.sort(key=lambda e: (-e[0], e[1]))
        for w, other in edges[:MAX_LINKS_PER_NODE]:
            keep.add((node, other) if node < other else (other, node))

    return [
        {"source": a, "target": b, "value": scores[(a, b)]}
        for (a, b) in sorted(keep)
    ]


# --- emit -------------------------------------------------------------------

def main():
    print("Scanning %s for .md files..." % ROOT)
    notes = scan(ROOT)
    if not notes:
        print("No markdown files found. Nothing to build.", file=sys.stderr)
        return 1
    print("Found %d notes." % len(notes))

    links = build_links(notes)
    print("Derived %d links." % len(links))

    degrees = {}
    for l in links:
        degrees[l["source"]] = degrees.get(l["source"], 0) + 1
        degrees[l["target"]] = degrees.get(l["target"], 0) + 1

    # id == index in the nodes array.
    nodes = []
    for i, n in enumerate(notes):
        nodes.append({
            "id": i,
            "label": n["title"],
            "group": n["group"],
            "path": n["path"],
            "excerpt": make_excerpt(n["prose"]),
            "degree": degrees.get(i, 0),
        })

    os.makedirs(VIEWER_DIR, exist_ok=True)
    payload = json.dumps({"nodes": nodes, "links": links}, indent=1, ensure_ascii=False)
    with open(GRAPH_OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generated by build.py -- do not edit by hand.\n")
        fh.write("// %d notes, %d links. Node id == index in nodes[].\n" % (len(nodes), len(links)))
        fh.write("const GRAPH = %s;\n" % payload)

    # Retrieval index stays in the project root, outside the served folder.
    index = [{
        "id": i,
        "title": n["title"],
        "group": n["group"],
        "path": n["path"],
        "text": n["prose"][:RETRIEVAL_CHARS],
    } for i, n in enumerate(notes)]
    with open(INDEX_OUT, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1, ensure_ascii=False)

    groups = {}
    for n in nodes:
        groups[n["group"]] = groups.get(n["group"], 0) + 1
    print("Groups: %s" % ", ".join(
        "%s (%d)" % (g, c) for g, c in sorted(groups.items(), key=lambda x: -x[1])
    ))
    print("Wrote %s" % os.path.relpath(GRAPH_OUT, ROOT))
    print("Wrote %s" % os.path.relpath(INDEX_OUT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
