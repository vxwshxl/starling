"""Segment cache and skip rules for whole-page translation.

Page translation only becomes usable because most of a page is not new. The
same nav bar, the same "Read more", the same footer and the same cookie banner
appear on every page of a site and on every reload during a demo, and a 4B
model re-translating them is pure waste. Two cheap filters run before the
model is ever consulted:

  1. `worth_translating()` throws out what has no words in it -- numbers,
     punctuation, icon glyphs, URLs. On a real page this is a surprising
     fraction of the text nodes.
  2. `Cache` remembers everything already translated, keyed by the exact
     source text and target language, and persists across restarts.

Both are exact-match and deliberately dumb. There is no fuzzy matching and no
normalisation beyond stripping whitespace: a cache that returns an
almost-right translation for an almost-matching string is a bug generator,
and the hit rate from exact matching alone is already high.

The cache file lives in the system temp directory alongside generated audio,
not in the repo and not in the user's home. It holds page text the user
browsed, so it is treated as disposable: cleared on reboot, and clearable from
the extension's side panel.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger("starling.translate_cache")

CACHE_DIR = Path(tempfile.gettempdir()) / "starling"
CACHE_PATH = CACHE_DIR / "translate-cache.json"

#: Stop the cache growing without bound over a long browsing session. Entries
#: are short, so this is a few megabytes at worst; the limit exists so the
#: JSON file cannot become slow to write, not to save memory.
MAX_ENTRIES = 20_000

#: A segment is worth sending to the model only if it contains a run of at
#: least two letters. `\w` would match digits, and "2024" or "1,299" is not
#: translatable text. Unicode-aware, because the source page may already be in
#: Devanagari or Ol Chiki -- this module is used in both directions.
_HAS_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)

#: Bare URLs, emails, absolute paths and filenames. These survive translation
#: unchanged at best and get mangled at worst, and a mangled link label is
#: worse than an untranslated one.
#:
#: Each branch consumes the WHOLE token, not just its prefix. An earlier
#: version alternated on `https?://` alone, which then had to match `\s*$`
#: against the rest of the URL and never fired -- so every bare link on the
#: page was sent to the model. Anchored both ends, so a sentence that merely
#: mentions a domain is still translated; only a segment that is nothing but
#: an address is skipped.
#:
#: There is deliberately no general "looks like a path" branch. `a/b` would
#: match "Terms/Conditions" and "and/or", which are ordinary page text, so
#: paths only count when they start with / ~ ./ or ../
_OPAQUE = re.compile(
    r"""^\s*(?:
          (?:https?://|www\.)\S+          # bare URL
        | (?:mailto:|tel:)\S+
        | [\w.+-]+@[\w-]+\.[\w.]+         # email address
        | (?:\.{1,2}/|[/~])[\w./~-]*      # absolute or relative path
        | [\w-]+\.(?:html?|php|aspx?|js|css|json|xml|csv|pdf|zip|
                     png|jpe?g|gif|svg|webp|ico|mp[34]|wav)   # bare filename
    )\s*$""",
    re.IGNORECASE | re.VERBOSE,
)

#: Longer than this and it is almost certainly not prose a page is displaying
#: -- an inlined data URI, a minified blob, a licence dump. Translating it
#: would cost minutes and produce nothing anyone reads.
MAX_SEGMENT_CHARS = 2_000


def worth_translating(text: str) -> bool:
    """Whether a segment should be sent to the model at all."""
    stripped = text.strip()
    if not stripped or len(stripped) > MAX_SEGMENT_CHARS:
        return False
    if _OPAQUE.match(stripped):
        return False
    return bool(_HAS_WORD.search(stripped))


def dedupe(texts: list[str]) -> tuple[list[str], list[int]]:
    """Collapse repeated segments.

    Returns the unique segments and, for each input, the index of its unique
    segment. A page with forty identical "Read more" links becomes one call.
    """
    unique: list[str] = []
    seen: dict[str, int] = {}
    mapping: list[int] = []
    for text in texts:
        key = text.strip()
        index = seen.get(key)
        if index is None:
            index = len(unique)
            seen[key] = index
            unique.append(text)
        mapping.append(index)
    return unique, mapping


class Cache:
    """Exact-match translation memory, persisted to one JSON file.

    Loaded lazily on first use and written back after each save, rather than
    on an interval or at shutdown: the service is killed with SIGKILL by
    `scripts/stop.sh`, so there is no shutdown hook to rely on.
    """

    def __init__(self, path: Path = CACHE_PATH) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._entries: dict[str, str] | None = None

    @staticmethod
    def _key(text: str, source: str, target: str) -> str:
        # The "|" is load-bearing. Language codes are short and unpunctuated,
        # so without a separator "en>as" + "sam" and "en>a" + "ssam" collide
        # into the same key and one page's translation is served for another's.
        return f"{source}>{target}|{text.strip()}"

    def _ensure(self) -> dict[str, str]:
        if self._entries is None:
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                self._entries = raw if isinstance(raw, dict) else {}
                logger.info("translation cache: %d entries", len(self._entries))
            except (OSError, ValueError):
                # Missing or corrupt is the normal empty case, not an error.
                self._entries = {}
        return self._entries

    def get_many(
        self, texts: list[str], source: str, target: str
    ) -> dict[int, str]:
        """Cached translations, keyed by position in `texts`."""
        with self._lock:
            entries = self._ensure()
            return {
                i: entries[self._key(t, source, target)]
                for i, t in enumerate(texts)
                if self._key(t, source, target) in entries
            }

    def put_many(
        self, pairs: list[tuple[str, str]], source: str, target: str
    ) -> None:
        """Record (source, translation) pairs and flush to disk."""
        if not pairs:
            return
        with self._lock:
            entries = self._ensure()
            for text, translated in pairs:
                entries[self._key(text, source, target)] = translated
            if len(entries) > MAX_ENTRIES:
                # Oldest-first: dicts preserve insertion order, and browsing
                # is temporally local enough that recency is a fine proxy for
                # usefulness. No LRU bookkeeping for a cold path.
                excess = len(entries) - MAX_ENTRIES
                for key in list(entries)[:excess]:
                    del entries[key]
            self._flush()

    def clear(self) -> int:
        """Forget everything. Returns how many entries were dropped."""
        with self._lock:
            count = len(self._ensure())
            self._entries = {}
            self._flush()
            return count

    def size(self) -> int:
        with self._lock:
            return len(self._ensure())

    def _flush(self) -> None:
        """Write the cache out. Called with the lock held."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Write-then-rename, so a kill mid-write leaves the previous file
            # intact rather than a truncated one that fails to parse.
            tmp = self._path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(self._entries, ensure_ascii=False), encoding="utf-8"
            )
            tmp.replace(self._path)
        except OSError as exc:  # pragma: no cover - cache is best-effort
            logger.warning("could not persist translation cache: %s", exc)


#: One shared cache for the process. Import this rather than constructing.
cache = Cache()
