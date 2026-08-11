"""Answering: the brain behind POST /chat.

This is what used to be the PHASE 2 SEAM in pipeline.py, and it is now the
whole middle of the cascade:

    ASR -> translate to English -> retrieve + generate -> translate back -> TTS

Both translation legs are real, on Sarvam-Translate -- see translate.py for
why that works where IndicTrans2 could not. English is the pivot throughout:
the knowledge base is English, the answering model reasons in English, and the
user's language is put on at the very end. That is not a shortcut, it is the
only arrangement that lets a 3B model give a correct answer in Bodo.

Three ways a question gets answered, and the caller is told which:

    small_talk  a greeting or pleasantry, fixed text, no model involved
    answer      retrieval found passages; the model may only restate them
    general     retrieval found nothing; the model answers from its own
                knowledge, and this MUST be labelled as ungrounded in the UI

That third one is a deliberate loosening. A twenty-passage corpus cannot cover
what a person will actually ask, and refusing everything else made the
assistant look broken. The safety rules do not loosen with it: llm.py's
GENERAL_PROMPT still forbids diagnosis, medicine names and dosages, and still
routes anything urgent to a health centre.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Literal

from . import languages, llm, retrieval, translate
from .timing import Timings

logger = logging.getLogger("starling.chat")

#: Answer to a greeting. Retrieval cannot help here -- "hi" shares no words
#: with any passage -- so without this the very first thing a new user typed
#: got a refusal, which reads as the assistant being broken rather than
#: careful. Fixed text, not generated: there is nothing to ground it in.
GREETING = (
    "Hello. I am Starling. I answer questions about health, government "
    "services, education and rural livelihoods from a knowledge base held on "
    "this machine, so nothing you say leaves it. Ask me something like \"my "
    "child has loose motion since morning\" or \"how do I apply for a job "
    "card\"."
)

THANKS = (
    "You are welcome. Ask me anything else about health, government services, "
    "education or rural livelihoods."
)

#: Small talk, matched before retrieval. Anchored whole-string and kept
#: deliberately narrow: a phrase long enough to carry a real question must
#: never be swallowed here, so "hello, my child has a fever" falls through to
#: retrieval as it should.
_SMALL_TALK: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"^(hi|hii+|hey+|hello+|hlo|yo|namaste|namaskar|nomoskar|salaam|"
            # "greetings" and "hello there" arrive from the translator, which
            # is where an Assamese নমস্কাৰ lands after the inbound leg.
            r"greetings|good\s+(morning|afternoon|evening)|are\s+you\s+there)"
            r"([\s,!.?]+(there|starling|everyone))?$"
        ),
        GREETING,
    ),
    (
        re.compile(r"^(thanks?|thank\s+you|thx|ok(ay)?|got\s+it|nice|good)$"),
        THANKS,
    ),
    (
        re.compile(
            r"^((what|who)\s+(are|can)\s+you(\s+do)?|what\s+do\s+you\s+do|"
            r"what\s+can\s+(you|i)\s+ask|help|how\s+does\s+this\s+work)$"
        ),
        GREETING,
    ),
)


def _small_talk(question: str) -> str | None:
    """Fixed reply for a greeting or pleasantry, or None to answer normally."""
    normalised = re.sub(r"[\s]+", " ", question.strip().lower()).strip(" !.?,")
    for pattern, reply in _SMALL_TALK:
        if pattern.fullmatch(normalised):
            return reply
    return None


@dataclass
class Source:
    id: str
    title: str
    sector: str
    score: float


@dataclass
class ChatResult:
    text: str
    """The answer in the language it was asked in -- what the user reads, and
    what gets spoken. Equal to `text_en` when the question was in English."""

    text_en: str = ""
    """The same answer before the return translation. Kept because it is the
    text the model actually reasoned in: when a Bodo answer looks wrong, this
    is how you tell a bad answer apart from a bad translation."""

    sources: list[Source] = field(default_factory=list)
    """Passages the answer was built from. Empty means it was not grounded."""

    grounded: bool = True
    """False when the text did not come from retrieved passages."""

    kind: Literal["answer", "general", "small_talk"] = "answer"
    """Why the text says what it says. `grounded` alone cannot distinguish
    these -- a greeting, a refusal and a general-knowledge answer are all
    ungrounded, and the UI has to treat them completely differently."""

    language: str = "en"
    """Language the answer is actually written in. Equal to the language asked
    in, unless translation was unavailable for it."""

    warnings: list[str] = field(default_factory=list)


def translation_available() -> bool:
    """Whether the indic<->English legs of the cascade exist.

    They do, on Sarvam-Translate. Kept as a function rather than deleted
    because callers already branch on it, and because the honest answer is
    per-language -- see `languages.translatable()`.
    """
    return True


def _needs_translation(language_code: str) -> bool:
    return language_code not in ("en", "")


def answer(
    question: str,
    language_code: str = "en",
    timings: Timings | None = None,
) -> tuple[ChatResult, Timings]:
    """Answer a question, in the language it was asked in.

    `language_code` is the language of `question` and of the reply. English is
    the pivot: the question is translated in, answered, and translated back.
    """
    timings = timings or Timings()
    warnings: list[str] = []

    if not question.strip():
        raise ValueError("Cannot answer an empty question.")

    translating = _needs_translation(language_code)
    if translating and not languages.translatable(language_code):
        # A language we can hear and speak but not translate. Answer in
        # English rather than not at all, and say so.
        translating = False
        warnings.append(
            f"Answers cannot be written in {languages.get(language_code).name} "
            "yet, so this one is in English."
        )

    def reply(text_en: str, **kw: object) -> tuple[ChatResult, Timings]:
        """Put the answer back into the user's language and package it."""
        text = text_en
        if translating:
            with timings.stage("translate_out"):
                text = translate.from_english(text_en, language_code)
        return (
            ChatResult(
                text=text,
                text_en=text_en,
                language=language_code if translating else "en",
                warnings=warnings,
                **kw,  # type: ignore[arg-type]
            ),
            timings,
        )

    # Small talk is matched on the raw question first. A greeting is short,
    # often typed in Latin script whatever the chosen language, and running it
    # through a translator to discover it means "hello" wastes several seconds
    # on every "hi".
    if (fixed := _small_talk(question)) is not None:
        logger.info("small talk: %r", question[:40])
        return reply(fixed, sources=[], grounded=False, kind="small_talk")

    question_en = question
    if translating:
        with timings.stage("translate_in"):
            question_en = translate.to_english(question, language_code)
        logger.info("question %r -> en %r", question[:40], question_en[:40])
        # Worth a second look now that it is English: "নমস্কাৰ" arrives as
        # "Hello" and should get the greeting, not a retrieval miss.
        if (fixed := _small_talk(question_en)) is not None:
            return reply(fixed, sources=[], grounded=False, kind="small_talk")

    with timings.stage("retrieve"):
        hits = retrieval.search(question_en)

    if not hits:
        # Not a refusal any more. The corpus is twenty passages; almost
        # everything a real person asks falls outside it, and stonewalling all
        # of it made the assistant useless. Answer from the model's own
        # knowledge instead -- under GENERAL_PROMPT, which keeps every medical
        # safety rule -- and mark it ungrounded so the UI can say where it
        # came from.
        logger.info("no passage matched %r; answering from general knowledge", question_en[:60])
        with timings.stage("generate"):
            text_en = llm.answer_general(question_en)
        return reply(text_en, sources=[], grounded=False, kind="general")

    with timings.stage("generate"):
        text_en = llm.answer(question_en, [h.passage.text for h in hits])

    sources = [
        Source(
            id=h.passage.id,
            title=h.passage.title,
            sector=h.passage.sector,
            score=round(h.score, 2),
        )
        for h in hits
    ]
    logger.info(
        "answered %r from %s", question_en[:50], ", ".join(s.id for s in sources)
    )
    return reply(text_en, sources=sources, grounded=True, kind="answer")
