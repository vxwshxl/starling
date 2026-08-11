"""The two translation legs of the cascade, on Sarvam-Translate.

    ASR -> [translate to English] -> retrieve + generate -> [translate back] -> TTS
            ^^^^^^^^^^^^^^^^^^^^                            ^^^^^^^^^^^^^^

This is the piece chat.py used to declare impossible. The blocker was never
translation as such -- it was IndicTrans2 specifically, which needs a slow
tokenizer that transformers 5 removed, while OmniVoice pins transformers>=5.3.
Sarvam-Translate sidesteps that entirely: it is a fine-tune of Gemma-3-4B-IT,
so it is an ordinary causal LM that mlx-lm loads like any other, with no
tokenizer archaeology and no version standoff.

What it buys, and this is the whole product promise: Sarvam-Translate covers
all 22 scheduled Indian languages, which includes every one of Starling's six
-- Assamese, Bodo, Manipuri, Nepali and Santali among them. Those are exactly
the languages no general-purpose LLM can write. A 4B model asked to answer in
Bodo produces confident nonsense; the same model fine-tuned on Bodo
translation produces Bodo.

Only English<->Indic is supported by the open checkpoint. Indic->Indic would
have to pivot through English, which is what we do anyway: the knowledge base
and the answering model are both English.

Verified against the installed package (mlx-lm 0.31.3), same API as llm.py:
    load(path_or_hf_repo) -> (model, tokenizer)
    generate(model, tokenizer, prompt, **kwargs) -> str
The prompt shape is from the model card: a system turn reading
"Translate the text below to {Language}." and the text as the user turn.
"""

from __future__ import annotations

import gc
import logging
import re
import threading
from typing import Any

from . import languages
from .config import settings

logger = logging.getLogger("starling.translate")

_lock = threading.Lock()
_model: Any | None = None
_tokenizer: Any | None = None

#: Ceiling on a single translation.
#:
#: Has to sit well above llm.MAX_TOKENS, not merely match it: Indic scripts
#: tokenise far less efficiently than English -- Ol Chiki and Meetei Mayek in
#: particular run several tokens per syllable -- so the same answer needs
#: noticeably more tokens in Santali than it did in English. Too low and a
#: long answer is silently cut off mid-sentence, which in the user's language
#: is invisible to anyone reading the English. This is a runaway guard against
#: repetition loops, not a length budget.
MAX_TOKENS = 3072


def loaded() -> bool:
    return _model is not None


def load() -> tuple[Any, Any]:
    """Load the translator once and keep it resident."""
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer

    with _lock:
        if _model is not None:
            return _model, _tokenizer
        from mlx_lm import load as mlx_load

        logger.info(
            "Loading translator %s -- first run downloads ~2.6 GB from the HF hub.",
            settings.translate_model,
        )
        _model, _tokenizer = mlx_load(settings.translate_model)
        logger.info("Translator ready: %s", settings.translate_model)
        return _model, _tokenizer


def unload() -> bool:
    """Drop the translator. Returns whether anything was actually resident."""
    global _model, _tokenizer
    if _model is None:
        return False
    _model = None
    _tokenizer = None
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:  # pragma: no cover - best-effort cache release
        pass
    logger.info("Translator unloaded")
    return True


def _prompt(text: str, target: str) -> str:
    """Build the Gemma turn structure by hand, deliberately.

    Every other model here goes through `apply_chat_template`, and this one
    must not. The template shipped in the MLX repo is broken in two ways that
    both produce fluent garbage rather than an error:

      1. It writes the instruction itself -- "Translate the text below to
         {lang}." -- and derives {lang} from the system message by splitting
         on ": " and taking the tail. Passing the whole sentence as the system
         turn, which is what the upstream model card shows, yields "Translate
         the text below to Translate the text below to Assamese.."
      2. It ignores `add_generation_prompt`, so the prompt ends after
         <end_of_turn> with no <start_of_turn>model cue. The model is left to
         guess that it is its turn, and what came back was the repetition
         loops: "এক মিনিটৰ আগতে এক মিনিটৰ আগতে", Santali collapsing to one
         syllable, and Assamese "my son has a fever" rendered as "I'm afraid
         I'm going to have to disappoint you."

    Both were misread as 4-bit quantisation damage. They were prompt damage.
    """
    return (
        f"<bos><start_of_turn>user\n"
        f"Translate the text below to {target}.\n\n"
        f"{text.strip()}<end_of_turn>\n"
        f"<start_of_turn>model\n"
    )


def _run(text: str, target: str) -> str:
    from mlx_lm import generate as mlx_generate
    from mlx_lm.sample_utils import make_logits_processors, make_sampler

    model, tokenizer = load()
    prompt = _prompt(text, target)
    # Do NOT run this greedy. temp=0 makes the 4-bit checkpoint fall into
    # repetition loops that never terminate -- measured: "এক মিনিটৰ আগতে" twice
    # in Assamese, and Santali and Manipuri degenerating into one syllable
    # repeated until max_tokens. A little temperature plus a repetition penalty
    # fixes it; the model card likewise samples at 0.01 rather than taking the
    # argmax. Still low enough that translation does not wander.
    out = mlx_generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=MAX_TOKENS,
        sampler=make_sampler(temp=0.2, top_p=0.9),
        logits_processors=make_logits_processors(repetition_penalty=1.1),
        verbose=False,
    )
    return _clean(out)


#: The model occasionally prefixes its output with a restatement of the task
#: ("Translation:", "Here is the translation:"). Stripped rather than prompted
#: away, because the prompt shape is the one the card specifies and deviating
#: from it costs more quality than this costs to clean up.
_PREAMBLE = re.compile(
    r"^\s*(here\s+is\s+the\s+)?(translation|translated\s+text)\s*[:\-]\s*",
    re.IGNORECASE,
)


def _clean(text: str) -> str:
    return _PREAMBLE.sub("", text.strip()).strip().strip('"')


def to_english(text: str, language_code: str) -> str:
    """Indic -> English. Returns `text` unchanged when already English."""
    if language_code in ("en", ""):
        return text
    languages.translate_name_for(language_code)  # raises early if uncovered
    result = _run(text, "English")
    logger.info("translated %s -> en (%d chars)", language_code, len(result))
    return result


def from_english(text: str, language_code: str) -> str:
    """English -> Indic. Returns `text` unchanged when the target is English."""
    if language_code in ("en", ""):
        return text
    target = languages.translate_name_for(language_code)
    result = _run(text, target)
    logger.info("translated en -> %s (%d chars)", language_code, len(result))
    return result


# ---------------------------------------------------------------------------
# Batched translation, for the browser extension's whole-page mode
# ---------------------------------------------------------------------------
#
# A web page is not one paragraph, it is two to five hundred short fragments:
# nav items, buttons, table cells, link text. Sent one at a time each pays the
# full prompt-processing overhead for perhaps three words.
#
# Measured on this machine, 29 segments of a real government page, English to
# Assamese, cache disabled, model already warm:
#
#   one request per segment   16.2 s   0.56 s/segment
#   batched, reply parsed     11.8 s   0.41 s/segment   1.37x
#
# But 1.37x is the best case, not the expected one. Measured over five
# realistic batches, **one in five came back with the numbering shifted** and
# had to be discarded and re-run segment by segment (see `_translate_batch`).
# A discarded batch costs the wasted generation on top of the individual ones,
# so netting the two out leaves batching at roughly break-even -- single-digit
# percent, well inside the noise.
#
# It is kept for the reason that is not about speed: the model sees sibling
# fragments together, so a nav bar is translated as a nav bar rather than as
# eight unrelated words. Nobody should reach for this expecting it to make
# page translation fast. The cache in translate_cache.py is what does that,
# and it is worth three orders of magnitude, not thirty percent.
#
# The packing protocol has to survive a 4-bit model, and the thing it has to
# survive is not the model refusing -- it is the model quietly returning the
# right number of plausible lines in the wrong order. A page whose button
# labels have been shuffled looks translated and is unusable, and nothing
# raises.
#
# Every segment is wrapped in a numbered marker and the reply is parsed by
# marker, but the numbers are treated as a CHECKSUM, not as an index: unless
# all of 1..N come back exactly once, the batch is thrown away and re-run one
# segment at a time. See `_translate_batch` for the measured case that forced
# this -- the model absorbed one fragment into its neighbour and renumbered
# everything after it.

#: Marker wrapping each segment. Deliberately ASCII and deliberately unlike
#: anything in ordinary page text, so the parser cannot collide with content.
#: Sarvam-Translate is document-level trained and passes such markers through
#: unchanged; the parser below still assumes it sometimes will not.
_MARKER = "<<{n}>>"

#: Tolerant reader for the above. Accepts stray whitespace inside the marker,
#: and the single-angle form the model occasionally emits instead.
_MARKER_RE = re.compile(r"<<\s*(\d+)\s*>>|<\s*(\d+)\s*>")

#: How much text goes into one generation. Both limits matter: the character
#: budget keeps the reply inside MAX_TOKENS with Indic scripts' worse token
#: efficiency accounted for, and the count limit stops fifty two-word nav
#: items becoming one enormous fragile block. Whichever trips first wins.
BATCH_MAX_CHARS = 700
BATCH_MAX_SEGMENTS = 12


def plan_batches(
    texts: list[str],
    *,
    max_chars: int = BATCH_MAX_CHARS,
    max_segments: int = BATCH_MAX_SEGMENTS,
) -> list[list[int]]:
    """Group segment indices into batches, by character budget and count.

    Pure and weight-free, so the smoke check can exercise it. A segment longer
    than `max_chars` on its own gets a batch to itself rather than being split
    -- splitting a sentence mid-clause costs more quality than the extra call
    costs time.
    """
    batches: list[list[int]] = []
    current: list[int] = []
    size = 0
    for i, text in enumerate(texts):
        length = len(text)
        if current and (len(current) >= max_segments or size + length > max_chars):
            batches.append(current)
            current, size = [], 0
        current.append(i)
        size += length
    if current:
        batches.append(current)
    return batches


def _pack(texts: list[str]) -> str:
    return "\n".join(
        f"{_MARKER.format(n=i + 1)} {t.strip()}" for i, t in enumerate(texts)
    )


def _unpack(reply: str, count: int) -> dict[int, str]:
    """Split a marked-up reply back into {zero-based index: translation}.

    Returns only the segments it is confident about. Anything missing is the
    caller's problem to re-run, which is the point: a partial parse is a
    recoverable event, a mis-attributed line is not.
    """
    hits: list[tuple[int, int, int]] = []  # (segment number, start, end of marker)
    for m in _MARKER_RE.finditer(reply):
        raw = m.group(1) or m.group(2)
        number = int(raw)
        if 1 <= number <= count:
            hits.append((number, m.start(), m.end()))

    out: dict[int, str] = {}
    for pos, (number, _start, end) in enumerate(hits):
        stop = hits[pos + 1][1] if pos + 1 < len(hits) else len(reply)
        body = _clean(reply[end:stop])
        # A marker that came back with nothing after it is a drop, not an
        # empty translation. Leave it out so the caller retries it.
        if body:
            out[number - 1] = body
    return out


#: How often a batch had to be thrown away and re-run one segment at a time.
#: Exposed because it decides whether batching is worth doing at all: the
#: speedup is only 1.37x, so a fallback rate much above a third makes the
#: whole mechanism net-negative. Read it from /health if it ever matters.
_batch_stats = {"batches": 0, "fallbacks": 0}


def batch_stats() -> dict[str, int]:
    return dict(_batch_stats)


def _translate_batch(texts: list[str], target: str) -> list[str]:
    """One generation for many segments, or none at all.

    All-or-nothing, and that is the whole correctness argument. **Marker
    numbers cannot be trusted as indices.** Measured, translating nine page
    segments to Assamese: the model silently absorbed segment 6 ("before
    applying.", a sentence fragment) into its translation of segment 5, then
    RENUMBERED everything after it -- emitting <<6>> for input 7, <<7>> for
    input 8, and skipping to <<9>> for input 9.

    The earlier version of this function trusted those numbers and re-ran only
    the marker that went missing. The result was two segments silently given
    each other's translations, which on the page put "Published 2024" inside
    a link labelled "eligibility rules". That is precisely the failure this
    protocol was supposed to prevent: it does not raise, it does not look
    broken, it just quietly scrambles the page.

    So a reply is accepted only when every marker 1..N came back exactly once.
    Anything else -- a drop, a merge, a duplicate, a renumbering -- discards
    the batch and re-runs each segment alone, where there is no numbering to
    get wrong. That costs one wasted generation plus N single ones, i.e. worse
    than never batching, which is why the fallback rate is worth watching.
    """
    if len(texts) == 1:
        return [_run(texts[0], target)]

    _batch_stats["batches"] += 1
    reply = _run(_pack(texts), target)
    parsed = _unpack(reply, len(texts))

    if len(parsed) == len(texts):
        return [parsed[i] for i in range(len(texts))]

    _batch_stats["fallbacks"] += 1
    missing = sorted(i + 1 for i in range(len(texts)) if i not in parsed)
    logger.warning(
        "batch of %d came back with markers %s missing -- the numbering may "
        "have shifted, so the whole batch is re-run one segment at a time",
        len(texts),
        missing,
    )
    return [_run(text, target) for text in texts]


def translate_segments(
    texts: list[str],
    *,
    source: str,
    target: str,
    on_batch: Any | None = None,
) -> list[str]:
    """Translate many independent segments between English and one Indic language.

    Exactly one of `source`/`target` must be "en" -- Sarvam's open checkpoint
    is English<->Indic only, and Indic<->Indic has to pivot, which is a
    decision for the caller rather than something to do silently here.

    `on_batch(done, total)` is called after each batch, so a long page can
    report progress rather than looking hung.
    """
    if not texts:
        return []

    if source == target:
        return list(texts)
    if source == "en":
        target_name = languages.translate_name_for(target)
    elif target == "en":
        languages.translate_name_for(source)  # raises early if uncovered
        target_name = "English"
    else:
        raise ValueError(
            f"Sarvam-Translate is English<->Indic only, so {source!r} -> {target!r} "
            "must pivot through English. Do that explicitly in the caller."
        )

    batches = plan_batches(texts)
    results: list[str] = [""] * len(texts)
    for done, indices in enumerate(batches, start=1):
        chunk = [texts[i] for i in indices]
        for i, translated in zip(indices, _translate_batch(chunk, target_name)):
            results[i] = translated
        if on_batch is not None:
            on_batch(done, len(batches))

    logger.info(
        "translated %d segment(s) %s -> %s in %d batch(es)",
        len(texts),
        source,
        target,
        len(batches),
    )
    return results
