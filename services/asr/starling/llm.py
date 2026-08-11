"""The local language model, used only to phrase retrieved passages.

Runs entirely offline through MLX, so it uses the GPU via Metal on Apple
Silicon and never leaves the machine. Nothing a user says is transmitted
anywhere, which for health questions in a village clinic is the point.

The model is deliberately not the source of facts. `chat.py` retrieves
passages from `knowledge.py` and this module is instructed to answer only
from them. That is not a soft preference in the prompt -- when retrieval
returns nothing, generation is never called at all.

Verified against the installed package (mlx-lm 0.31.3):
    load(path_or_hf_repo) -> (model, tokenizer)
    generate(model, tokenizer, prompt, verbose=False, **kwargs) -> str
    make_sampler(temp=..., top_p=...) passed through kwargs as sampler=
"""

from __future__ import annotations

import gc
import logging
import re
import threading
from typing import Any

from .config import settings

logger = logging.getLogger("starling.llm")

_lock = threading.Lock()
_model: Any | None = None
_tokenizer: Any | None = None

#: Ceiling on one answer. 220 was the old value and it was a second, invisible
#: length limit sitting behind the prompt's "2-4 sentences" -- raising only the
#: prompt would have produced answers that stopped mid-sentence. 800 is roughly
#: 12-15 sentences of plain English, comfortably above what the prompt asks
#: for, so it acts as a runaway guard rather than a budget.
MAX_TOKENS = 800

#: Answering with retrieved passages behind it.
#:
#: The retrieved passages are the trusted spine of the answer, but they are two
#: or three sentences each and are not the whole answer. The previous version
#: of this prompt said "answer ONLY using the reference passages" and "reply in
#: 2-4 short sentences", and the result was a assistant that restated a stub
#: and stopped -- someone asking about a child's fever got told to visit a
#: health centre and nothing they could actually do in the meantime. Passages
#: anchor the facts; the model is expected to fill in the practical detail
#: around them.
SYSTEM_PROMPT = """You are Starling, a knowledgeable and practical assistant for people in Northeast India. You are often the only source of help someone has to hand, and the nearest health centre or block office may be hours away. Be genuinely useful.

The reference passages below are verified and take priority over your own knowledge -- if they say something, follow them. But they are short, so expand around them with your own knowledge to give a complete, practical answer.

How to answer:
- Lead with what the person can DO right now, in concrete steps. Specifics matter: quantities, timings, how to prepare something, what to use if the usual thing is unavailable.
- Explain briefly WHY, so they can adapt when their situation does not match exactly.
- Say what to watch for, and at what point the situation needs a health worker, a health centre, or the block office. Put this after the practical advice, not instead of it.
- Aim for 6-12 sentences. Use short paragraphs or a simple numbered list. Plain language, no jargon; it may be read aloud to someone who cannot read.
- Be direct. Do not hedge every sentence, and do not pad with disclaimers.
- Write plain text. No markdown, no ** for bold, no # headings -- this is spoken aloud as well as read.
- Do not invent specifics you are unsure of, especially helpline numbers, office names, fees or deadlines. Say "your nearest health centre" or "the block office" rather than guessing a number. A wrong number is worse than no number, because someone will dial it.
- Never mention "passages", "context", "documents" or "the knowledge base". Just answer.
- Answer in English. Translation to the user's language happens later in the pipeline."""

#: Answering with nothing retrieved -- the model's own knowledge, on any topic.
#:
#: Deliberately not a locked-down variant of the grounded prompt. It is the
#: same assistant answering a question the corpus does not cover, which is most
#: questions a real person asks.
GENERAL_PROMPT = """You are Starling, a knowledgeable and practical assistant for people in Northeast India. Answer from your own knowledge, on whatever subject is asked -- health, government services, education, farming, or anything else.

You are often the only source of help someone has to hand, and the nearest health centre or block office may be hours away. Be genuinely useful.

How to answer:
- Lead with what the person can DO, in concrete steps. Specifics matter: quantities, timings, how to prepare something, what to use if the usual thing is unavailable, what a process costs and what documents it needs.
- Explain briefly WHY, so they can adapt when their situation does not match exactly.
- Say what to watch for, and at what point the situation needs a health worker, a health centre, or the block office. Put this after the practical advice, not instead of it.
- Aim for 6-12 sentences. Use short paragraphs or a simple numbered list. Plain language, no jargon; it may be read aloud to someone who cannot read.
- Be direct. Do not hedge every sentence, and do not pad with disclaimers.
- Write plain text. No markdown, no ** for bold, no # headings -- this is spoken aloud as well as read.
- Be accurate. Where something genuinely varies by state, scheme or individual, say what it depends on rather than inventing a figure.
- Do not invent specifics you are unsure of, especially helpline numbers, office names, fees or deadlines. Say "your nearest health centre" or "the block office" rather than guessing a number. A wrong number is worse than no number, because someone will dial it.
- Answer in English. Translation to the user's language happens later in the pipeline."""


def loaded() -> bool:
    return _model is not None


def load() -> tuple[Any, Any]:
    """Load the model once and keep it resident."""
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer

    with _lock:
        if _model is not None:
            return _model, _tokenizer
        from mlx_lm import load as mlx_load

        logger.info(
            "Loading LLM %s -- first run downloads ~1.8 GB from the HF hub.",
            settings.llm_model,
        )
        _model, _tokenizer = mlx_load(settings.llm_model)
        logger.info("LLM ready: %s", settings.llm_model)
        return _model, _tokenizer


def unload() -> bool:
    """Drop the model. Returns whether anything was actually resident."""
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
    logger.info("LLM unloaded")
    return True


def _chat(tokenizer: Any, system: str, user: str) -> str:
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    # Qwen ships a chat template; using it rather than hand-rolling the special
    # tokens is what keeps this correct if the model is swapped.
    return tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=False
    )


#: Markdown emphasis and headings the model reaches for despite being told not
#: to. Stripped rather than rendered: this text has two destinations, and while
#: a browser could render **bold**, OmniVoice reads the asterisks out loud.
_MARKUP = re.compile(r"(\*\*|__|\*|`|^#{1,6}\s*)", re.MULTILINE)


def _clean(text: str) -> str:
    return _MARKUP.sub("", text).strip()


def _generate(prompt: str, model: Any, tokenizer: Any, max_tokens: int) -> str:
    from mlx_lm import generate as mlx_generate
    from mlx_lm.sample_utils import make_logits_processors, make_sampler

    text = mlx_generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
        sampler=make_sampler(temp=0.3, top_p=0.9),
        # A long answer has far more room to fall into a loop than a
        # three-sentence one did, and a numbered list of near-identical steps
        # is exactly the shape that invites it.
        logits_processors=make_logits_processors(repetition_penalty=1.05),
        verbose=False,
    )
    return _clean(text)


def answer(question: str, passages: list[str], max_tokens: int = MAX_TOKENS) -> str:
    """Phrase an answer to `question` using only `passages`.

    Callers must not invoke this with an empty `passages` -- an ungrounded
    answer is exactly what this design exists to prevent.
    """
    if not passages:
        raise ValueError(
            "answer() requires retrieved passages; call answer_general() if an "
            "ungrounded answer is genuinely wanted, so the caller has to say so"
        )

    model, tokenizer = load()
    reference = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
    prompt = _chat(
        tokenizer,
        SYSTEM_PROMPT,
        f"Reference passages:\n{reference}\n\nQuestion: {question}",
    )
    return _generate(prompt, model, tokenizer, max_tokens)


def answer_general(question: str, max_tokens: int = MAX_TOKENS) -> str:
    """Answer from the model's own knowledge, with no retrieved grounding.

    Separate from `answer()` on purpose. The caller has to choose this
    explicitly, and whatever it returns must be labelled as ungrounded in the
    UI -- a sourced health answer and an invented one must never look alike.
    """
    model, tokenizer = load()
    prompt = _chat(tokenizer, GENERAL_PROMPT, question)
    return _generate(prompt, model, tokenizer, max_tokens)
