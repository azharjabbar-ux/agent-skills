#!/usr/bin/env python3
"""
server.py -- Knowledge Galaxy server.

Serves ONLY the viewer/ folder as static files on port 4700, and adds a single
dynamic endpoint:

  POST /chat  {"question": "..."}  ->  {"answer": "...", "nodes": [indexes]}

Retrieval is keyword overlap against notes-index.json (project root, never
served). config.json (project root, never served) holds the API key; it is read
server-side only and is not reachable from the browser.

Standard library only. Python 3.8+.
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(ROOT, "viewer")
CONFIG_PATH = os.path.join(ROOT, "config.json")
INDEX_PATH = os.path.join(ROOT, "notes-index.json")

PORT = 4700
TOP_K = 6
HISTORY_TURNS = 4          # user+assistant pairs kept server-side
MAX_QUESTION = 2000
PLACEHOLDER_KEYS = {"", "PUT-YOUR-KEY-HERE", "YOUR-KEY-HERE", "sk-...", None}

OPENAI_URL = "https://api.openai.com/v1/chat/completions"

# --- grounding ---------------------------------------------------------
# Whether a question is ABOUT the notes is decided here, before the client is
# told anything, because this is the only place that can see retrieval scores.
# A question that is not grounded comes back with nodes: [] and grounded: false,
# so the viewer physically cannot fly the camera on small talk.
#
# Measured against this note set: small talk ("good morning", "tell me a joke",
# "what's up") tops out around 2.8; real questions start around 6.3. 4.5 sits
# in the gap. Raise it if chit-chat starts moving the camera; lower it if real
# questions get turned away.
GROUNDING_MIN_SCORE = 4.5

# A cited note must score at least this fraction of the best match. Without it
# every question returns a full six, the answer rests on four weak notes it
# never really used, and the viewer can never justify a dive to a single note.
SOURCE_RATIO = 0.5
SMALL_TALK_MAX_WORDS = 6          # anything longer is treated as a real ask

# Filler acknowledgements, allowed to appear in short runs ("ok cool", "haha nice").
_FILLER = (r"ok|okay|kk|cool|nice|great|awesome|lovely|perfect|sweet|haha|hah"
           r"|lol|hmm+|wow|right|sure|yep|yeah|yes|nope|fine|indeed|noted"
           r"|thanks|thanx|thank\s+you|cheers|ta|bye|goodbye")

SMALL_TALK_RE = re.compile((r"""^(?:
      (?:good\s+)?(?:morning|afternoon|evening|night|day)
    | (?:hi|hey|hello|howdy|yo|hiya)(?:\s+there|\s+galaxy)?
    | how(?:'?s|\s+is|\s+are)\s+(?:it\s+going|you|things|tricks)
    | what'?s\s+up
    | (?:many\s+)?thanks|thank\s+you|cheers|ta
    | (?:%(f)s)(?:\s+(?:%(f)s)){0,3}
    | who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do
    | tell\s+me\s+a\s+joke|say\s+something|make\s+me\s+laugh
    | are\s+you\s+(?:there|awake|alive|ok|okay)
    | (?:good)?bye|see\s+you|later|night\s+night
    | sorry|please|never\s*mind|forget\s+it
  )[\s!.?,]*$""" % {"f": _FILLER}), re.X | re.I)

NOTES_SYSTEM_PROMPT = (
    "You are the mind behind a personal knowledge base. Answer ONLY from the "
    "notes provided below. Do not use outside knowledge and do not guess. "
    "Answer in two or three sentences. Do NOT quote the notes at length or "
    "recite their contents -- the reader already has the note open on screen, "
    "so summarise in your own words and keep it short. If the notes do not "
    "cover the question, say so plainly and do not invent an answer."
)

ASIDE_SYSTEM_PROMPT = (
    "You are the voice of a personal knowledge galaxy. The message below is NOT "
    "answerable from the user's notes. If it is small talk, a greeting or an "
    "acknowledgement, reply with one short, warm sentence and do not mention "
    "notes at all. If it is a genuine question, say in one plain sentence that "
    "their notes do not cover it. Never invent note content, never list "
    "anything, and never exceed one sentence."
)

STOPWORDS = set("""
a an and are as at be but by can could do does for from had has have how i if in
into is it its me my of on or our should so some that the their them then there
these they this to was we were what when where which who why will with would you
your about above after again all also am any been before being below between both
did doing down during each few further here him his more most no nor not now off
once only other out over own same she too under until up very via while
""".split())

WORD_RE = re.compile(r"[a-z0-9][a-z0-9'_-]*")

_lock = threading.Lock()
_history = []          # [{"role": "...", "content": "..."}]
_notes = []
_notes_mtime = None


# ---------------------------------------------------------------- notes load

def tokenize(text):
    return [w for w in WORD_RE.findall(text.lower())
            if w not in STOPWORDS and len(w) > 1]


def load_notes(force=False):
    """Load notes-index.json, re-reading it if build.py has run since."""
    global _notes, _notes_mtime
    try:
        mtime = os.path.getmtime(INDEX_PATH)
    except OSError:
        return []
    if not force and _notes and _notes_mtime == mtime:
        return _notes
    with open(INDEX_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    prepared = []
    for n in raw:
        title = n.get("title", "")
        prepared.append({
            "id": n["id"],
            "title": title,
            "path": n.get("path", ""),
            "group": n.get("group", ""),
            "text": n.get("text", ""),
            "title_tokens": set(tokenize(title)),
            "title_phrase": re.sub(r"[-_]+", " ", title.lower()).strip(),
            "body": Counter(tokenize(n.get("text", ""))),
        })
    _notes, _notes_mtime = prepared, mtime
    return _notes


# ------------------------------------------------------------------ scoring

def rank(question, notes, k=TOP_K):
    """Keyword overlap; title matches weigh more than body matches.
    Returns the top k as (score, note) pairs, best first."""
    q_tokens = tokenize(question)
    if not q_tokens:
        return []
    q_set = set(q_tokens)
    q_low = question.lower()

    scored = []
    for n in notes:
        score = 0.0
        for tok in q_set:
            if tok in n["title_tokens"]:
                score += 5.0                       # title match: heavy
            elif len(tok) > 3 and tok in n["title_phrase"]:
                score += 2.0                       # partial title match
            tf = n["body"].get(tok, 0)
            if tf:
                score += 1.0 + min(tf, 5) * 0.35   # body match, saturating
        # whole title named in the question is a very strong signal
        if len(n["title_phrase"]) >= 4 and n["title_phrase"] in q_low:
            score += 8.0
        if score > 0:
            scored.append((score, n))

    scored.sort(key=lambda p: (-p[0], p[1]["id"]))
    return scored[:k]


def is_small_talk(question):
    """Greetings, thanks, jokes -- anything that is chat rather than a query.
    Only short utterances qualify; a long sentence is a real ask."""
    t = re.sub(r"[^a-z0-9'\s]", " ", question.lower())
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return True
    if len(t.split()) > SMALL_TALK_MAX_WORDS:
        return False
    return bool(SMALL_TALK_RE.match(t))


def classify(question, notes):
    """Decide what kind of message this is BEFORE anything is retrieved or
    rendered. Returns (intent, hits):

      "notes"  a genuine question with real support in the notes -- cite and fly
      "aside"  everything else: small talk, or a question the notes do not
               cover. Both carry no node indexes, so the camera holds still.

    Separating small talk from an out-of-scope question is left to the model,
    which is far better at it than a keyword score -- and it changes only the
    wording of the reply, never whether the galaxy moves.
    """
    if is_small_talk(question):
        return "aside", []

    scored = rank(question, notes)
    if not scored or scored[0][0] < GROUNDING_MIN_SCORE:
        return "aside", []

    # Keep only the notes that genuinely support the answer. These are both
    # what the model is shown and what the viewer is told to light, so the
    # citation is the truth rather than a top-six leaderboard.
    cutoff = scored[0][0] * SOURCE_RATIO
    return "notes", [n for sc, n in scored if sc >= cutoff]


def build_context(hits):
    parts = []
    for n in hits:
        body = n["text"][:1800].strip()
        parts.append("--- NOTE [index %d] %s (%s)\n%s" %
                     (n["id"], n["title"], n["path"], body))
    return "\n\n".join(parts)


# ------------------------------------------------------------------- OpenAI

class ChatError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def load_config():
    if not os.path.exists(CONFIG_PATH):
        raise ChatError(
            "config.json not found in the project root. Create it with "
            '{"openai_api_key": "sk-...", "model": "gpt-6-astra"}.')
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        raise ChatError("config.json could not be read: %s" % exc)
    key = (cfg.get("openai_api_key") or "").strip()
    if key in PLACEHOLDER_KEYS:
        raise ChatError(
            "No OpenAI API key set. Open config.json in the project root and "
            'replace "PUT-YOUR-KEY-HERE" with your real key, then ask again. '
            "(The server reads it directly; the browser never sees it.)")
    return key, (cfg.get("model") or "gpt-6-astra").strip()


def call_openai(key, model, messages):
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 400,
    }).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_URL, data=payload, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            body = json.loads(exc.read().decode("utf-8"))
            detail = body.get("error", {}).get("message", "")
        except Exception:
            pass
        raise ChatError(
            "OpenAI API error (HTTP %d)%s" % (exc.code, ": " + detail if detail else ""),
            status=502)
    except urllib.error.URLError as exc:
        raise ChatError("Could not reach the OpenAI API: %s" % exc.reason, status=502)
    except (ValueError, KeyError) as exc:
        raise ChatError("Unexpected response from the OpenAI API: %s" % exc, status=502)

    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError):
        raise ChatError("The OpenAI API returned no message content.", status=502)


def answer_question(question):
    notes = load_notes()
    if not notes:
        raise ChatError("No note index found. Run `python3 build.py` first.")

    # Classify first. Only a "notes" verdict is allowed to return node indexes,
    # so small talk can never reach the camera no matter what the client does.
    intent, hits = classify(question, notes)

    if intent == "aside":
        try:
            key, model = load_config()
        except ChatError:
            # No key configured: still answer honestly rather than erroring out.
            return ("I can only answer from your notes, and that one isn't in "
                    "them.", [], False)
        reply = call_openai(key, model, _messages(ASIDE_SYSTEM_PROMPT, question))
        _remember(question, reply)
        return reply, [], False

    key, model = load_config()

    reply = call_openai(key, model, _messages(
        NOTES_SYSTEM_PROMPT, "NOTES:\n%s\n\nQUESTION: %s"
        % (build_context(hits), question)))
    _remember(question, reply)
    return reply, [n["id"] for n in hits], True


def _messages(system, user):
    with _lock:
        history = list(_history)
    msgs = [{"role": "system", "content": system}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": user})
    return msgs


def _remember(question, reply):
    with _lock:
        _history.append({"role": "user", "content": question})
        _history.append({"role": "assistant", "content": reply})
        del _history[:max(0, len(_history) - HISTORY_TURNS * 2)]


# ------------------------------------------------------------------ handler

class Handler(SimpleHTTPRequestHandler):
    server_version = "KnowledgeGalaxy/1.0"

    def translate_path(self, path):
        """Root everything at viewer/ and refuse anything that escapes it."""
        resolved = super().translate_path(path)
        real_root = os.path.realpath(VIEWER_DIR)
        real_path = os.path.realpath(resolved)
        if real_path != real_root and not real_path.startswith(real_root + os.sep):
            return os.path.join(real_root, "__forbidden__")
        return resolved

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/chat":
            return self._json(404, {"error": "Not found."})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1 << 20:
            return self._json(400, {"error": "Send a JSON body with a question."})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            question = str(payload.get("question", "")).strip()[:MAX_QUESTION]
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "Body must be valid JSON."})
        if not question:
            return self._json(400, {"error": "Ask a question first."})

        try:
            answer, ids, grounded = answer_question(question)
        except ChatError as exc:
            return self._json(exc.status, {"error": exc.message})
        except Exception as exc:                      # never 500 with a stack trace
            sys.stderr.write("chat failed: %r\n" % (exc,))
            return self._json(500, {"error": "Unexpected server error: %s" % exc})

        # grounded == False always ships an empty nodes list: the viewer is
        # given nothing to fly to, rather than being trusted not to.
        return self._json(200, {"answer": answer, "nodes": ids,
                                "grounded": bool(grounded)})

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    if not os.path.isdir(VIEWER_DIR):
        print("viewer/ not found. Run `python3 build.py` first.", file=sys.stderr)
        return 1
    if not os.path.exists(os.path.join(VIEWER_DIR, "graph-data.js")):
        print("viewer/graph-data.js missing. Run `python3 build.py` first.", file=sys.stderr)
        return 1

    notes = load_notes(force=True)
    print("Knowledge Galaxy")
    print("  notes indexed : %d" % len(notes))
    print("  serving       : %s" % VIEWER_DIR)
    if os.path.exists(CONFIG_PATH):
        try:
            key, model = load_config()
            print("  brain         : ready (model %s)" % model)
        except ChatError:
            print("  brain         : idle - set your key in config.json")
    else:
        print("  brain         : idle - config.json missing")
    print("\n  ->  http://localhost:%d\n" % PORT)

    handler = partial(Handler, directory=VIEWER_DIR)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
