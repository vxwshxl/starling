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
import threading
from typing import Any

from .config import settings

logger = logging.getLogger("starling.llm")

_lock = threading.Lock()
_model: Any | None = None
_tokenizer: Any | None = None

SYSTEM_PROMPT = """You are Starling, an assistant for people in Northeast India asking about health, government services, education and rural livelihoods.

Answer ONLY using the reference passages provided. They are the sole source of truth.

Rules:
- If the passages do not answer the question, say you do not have that information and suggest who locally could help. Never fill the gap from your own knowledge.
- Never diagnose, and never name a specific medicine or dosage.
- For anything urgent or worsening, say plainly that they should go to a health centre.
- Reply in 2-4 short sentences of plain language. It will be read aloud to someone who may not read.
- Do not mention "passages", "context" or "documents". Just answer.
- Answer in English. Translation happens elsewhere in the pipeline."""


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


def _build_prompt(tokenizer: Any, question: str, passages: list[str]) -> str:
    reference = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
    user = f"Reference passages:\n{reference}\n\nQuestion: {question}"
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]
    # Qwen ships a chat template; using it rather than hand-rolling the special
    # tokens is what keeps this correct if the model is swapped.
    return tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=False
    )


def answer(question: str, passages: list[str], max_tokens: int = 220) -> str:
    """Phrase an answer to `question` using only `passages`.

    Callers must not invoke this with an empty `passages` -- an ungrounded
    answer is exactly what this design exists to prevent.
    """
    if not passages:
        raise ValueError(
            "answer() requires retrieved passages; refuse the question instead "
            "of generating without grounding"
        )

    from mlx_lm import generate as mlx_generate
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load()
    prompt = _build_prompt(tokenizer, question, passages)
    # Near-greedy: this is meant to restate given facts, not to be creative.
    sampler = make_sampler(temp=0.3, top_p=0.9)
    text = mlx_generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
        sampler=sampler,
        verbose=False,
    )
    return text.strip()
