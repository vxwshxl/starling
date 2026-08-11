"""Whole-page translation: the orchestration behind POST /translate/batch.

This is `chat.py`'s counterpart for the browser extension. Where chat.py runs
the middle of the speech cascade, this runs the middle of the page cascade:

    DOM text -> skip what has no words -> cache -> dedupe -> batch -> DOM text

Each filter exists because the one before it was not enough. A news article
has roughly three hundred text nodes, and a 4B model on this machine gets
through about 2.4 of them a second, so the naive version is two minutes of
staring at an English page.

Measured, 29 segments of a real government page, English to Assamese, warm:

    no filtering, one request per segment      16.2 s
    batched, when the reply parses             11.8 s    1.37x
    every segment already in the cache          0.013 s   ~900x

The ordering there is the point, and it is not the intuitive one. Batching
looks like the optimisation and is the weakest: output tokens dominate, so
packing the input barely helps, and one batch in five has to be thrown away
and re-run for correctness (translate._translate_batch), which cancels most
of what is left. **The cache is the one that matters** -- three orders of
magnitude, because most of a page is not new: the same nav bar, the same
"Read more", the same footer on every page of a site and on every reload
during a demo. Dedupe is the same insight applied within a single page, and
skipping wordless segments removes a fifth of the nodes for free before the
model is consulted at all.

One consequence of leaning on a cache: **a bad translation is a sticky bad
translation.** When a batching bug mis-attributed segments during development,
the wrong text was cached and survived the fix until the cache was cleared.
That is why `POST /translate/cache/clear` exists and why the extension puts a
button on it, rather than treating the cache as an invisible internal detail.

**The honest claim.** The extension sends the visible viewport first and the
rest afterwards, so the first screen lands in seconds -- around 12 s for a
dense first screen cold, near-instant once cached. A whole long page does not
land in seconds, and this module does not pretend otherwise: it reports how
many segments it actually translated, how many were cache hits and how many
it skipped, and the side panel shows all three. Anything that says "done"
without those numbers is hiding the cost, not removing it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from . import translate
from .timing import Timings
from .translate_cache import cache, dedupe, worth_translating

logger = logging.getLogger("starling.page")


@dataclass
class PageTranslation:
    """One batch of page segments, translated.

    `translations` is positionally aligned with the input, always, including
    the segments that were skipped -- those come back as their own source
    text. The extension writes results back into DOM nodes by index, so a
    shorter or reordered list would silently scramble the page.
    """

    translations: list[str]
    translated: int = 0
    """Segments that actually went through the model."""

    from_cache: int = 0
    skipped: int = 0
    """Segments with nothing translatable in them, returned unchanged."""

    source: str = "en"
    target: str = "en"
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "translations": self.translations,
            "source": self.source,
            "target": self.target,
            "counts": {
                "total": len(self.translations),
                "translated": self.translated,
                "from_cache": self.from_cache,
                "skipped": self.skipped,
            },
            "warnings": self.warnings,
        }


def translate_segments(
    segments: list[str],
    *,
    source: str = "en",
    target: str,
    use_cache: bool = True,
) -> tuple[PageTranslation, Timings]:
    """Translate page segments, returning a list aligned with the input.

    `source` and `target` are Starling language codes; one of them must be
    "en". Indic -> Indic is rejected rather than pivoted, because pivoting a
    whole page doubles an already slow operation and the caller should have to
    choose that.
    """
    timings = Timings()
    result = PageTranslation(
        translations=list(segments), source=source, target=target
    )

    if not segments or source == target:
        return result, timings

    # Positions worth spending the model on. Everything else keeps its source
    # text, which is why `result.translations` starts as a copy of the input.
    with timings.stage("filter"):
        live = [i for i, s in enumerate(segments) if worth_translating(s)]
        result.skipped = len(segments) - len(live)

    if not live:
        return result, timings

    # Dedupe operates on the survivors only, and everything below is indexed
    # in "unique segment" space until the final write-back.
    with timings.stage("dedupe"):
        unique, mapping = dedupe([segments[i] for i in live])

    with timings.stage("cache_read"):
        hits = cache.get_many(unique, source, target) if use_cache else {}

    pending = [i for i in range(len(unique)) if i not in hits]
    resolved: dict[int, str] = dict(hits)

    if pending:
        with timings.stage("translate"):
            translated = translate.translate_segments(
                [unique[i] for i in pending], source=source, target=target
            )
        for i, text in zip(pending, translated):
            resolved[i] = text
        if use_cache:
            with timings.stage("cache_write"):
                cache.put_many(
                    [(unique[i], resolved[i]) for i in pending], source, target
                )

    # Back out through both indirections: unique -> live position -> original.
    for position, original_index in enumerate(live):
        result.translations[original_index] = resolved[mapping[position]]

    # Counted in original-segment terms, not unique terms, because that is
    # what the user sees on the page.
    result.from_cache = sum(1 for p in mapping if p in hits)
    result.translated = len(live) - result.from_cache

    logger.info(
        "page batch %s -> %s: %d segments (%d translated, %d cached, %d skipped)",
        source,
        target,
        len(segments),
        result.translated,
        result.from_cache,
        result.skipped,
    )
    return result, timings
