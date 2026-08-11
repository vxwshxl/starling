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
