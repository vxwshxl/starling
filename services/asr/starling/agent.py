"""The browsing agent: the brain behind POST /agent/act.

One call decides ONE action. The loop lives in the extension, not here, and
that split is deliberate. The service cannot see the page -- it has no browser
-- so any loop it ran would be a loop over stale state. The content script
holds the live DOM, sends a snapshot, gets one action back, executes it,
observes what changed and asks again. The service stays stateless and the
extension stays honest about what it is actually looking at.

The same English pivot as `chat.py`, and for the same reason:

    goal (native) -> English -> decide -> act -> ... -> report (native)

Qwen2.5-3B cannot follow an instruction written in Bodo, and it certainly
cannot emit JSON while doing so. It reasons in English over an English page
index, and only the closing message to the user is translated back.

**Why a fixed action vocabulary and not free-form code.** A 3B model asked to
write a selector will invent one, and an invented selector either matches
nothing or matches the wrong thing. Instead the content script hands over a
numbered list of the elements it can actually see, and the model may only name
one of those numbers. A reference that is not in the list is rejected here,
before it reaches the page -- so the failure is "the model picked a bad
option", surfaced in the action log, never "the agent clicked something nobody
listed".
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from . import languages, llm, translate
from .timing import Timings

logger = logging.getLogger("starling.agent")

#: One action is a short JSON object. This is a runaway guard, not a budget --
#: anything approaching it means the model started narrating instead of
#: answering, and the parse below will fail anyway.
MAX_TOKENS = 220

#: How many page elements go into the prompt. The content script sends them in
#: viewport order, so truncating keeps what the user can see and drops the
#: footer. A 3B model given two hundred options picks worse than one given
#: sixty, quite apart from the prompt-processing cost.
MAX_ELEMENTS = 60

#: How many past steps the model is reminded of. Enough to notice it is
#: repeating itself, short enough not to crowd out the page.
MAX_HISTORY = 8

#: Every action the agent may take. The extension implements exactly these and
#: nothing else, so adding one here without adding it there produces an action
#: the page silently ignores.
ACTIONS: dict[str, tuple[str, ...]] = {
    "click": ("ref",),
    "type": ("ref", "text"),
    "select": ("ref", "value"),
    "scroll": ("direction",),
    "navigate": ("url",),
    "back": (),
    "done": ("message",),
    "fail": ("message",),
}

SYSTEM_PROMPT = """You are Starling's browsing agent. You control a web browser for a user who may not read English. You are given a goal, the current page, and a numbered list of the elements on it. You choose ONE action at a time.

Reply with a single JSON object and nothing else. No explanation outside the JSON, no markdown fences.

The actions are:
{"action":"click","ref":"e12","why":"..."}                      press a button or link
{"action":"type","ref":"e3","text":"...","submit":true,"why":"..."}   type into a field; submit presses Enter
{"action":"select","ref":"e8","value":"...","why":"..."}        choose an option in a dropdown
{"action":"scroll","direction":"down","why":"..."}              direction is up, down, top or bottom
{"action":"navigate","url":"https://...","why":"..."}           go straight to an address
{"action":"back","why":"..."}                                   the browser's back button
{"action":"done","message":"...","why":"..."}                   the goal is achieved; message tells the user the result
{"action":"fail","message":"...","why":"..."}                   the goal cannot be achieved here; message says why

Rules:
- FIRST, read the page text. If it already answers the goal, reply with "done" and put the answer in "message". Do not click anything to confirm what you can already read. Most goals that are questions end this way.
- "ref" MUST be one of the reference codes listed on the page. Never invent one. If what you need is not listed, scroll to look for it or navigate somewhere it will be.
- Do one thing per reply. Do not plan several steps ahead in one action.
- Look at the actions already taken. If the last one did not change anything, do something different -- never repeat a failing action.
- Prefer searching or navigating over clicking through many pages.
- "message" is read aloud to the user in their own language. Write it as one or two plain sentences, no markup.
- Never enter passwords, card numbers or one-time codes. Never confirm a purchase, a payment, a deletion or anything that sends a message on the user's behalf. Stop with "fail" and say what you were asked to do that you will not do."""


@dataclass
class Decision:
    """One action, validated and ready for the content script to execute."""

    action: str
    args: dict[str, Any] = field(default_factory=dict)
    why: str = ""
    message: str = ""
    """The user-facing text for `done`/`fail`, in the user's own language."""

    message_en: str = ""
    language: str = "en"
    goal_en: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def terminal(self) -> bool:
        """Whether the loop should stop after this action."""
        return self.action in ("done", "fail")

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "args": self.args,
            "why": self.why,
            "message": self.message,
            "message_en": self.message_en,
            "terminal": self.terminal,
            "language": self.language,
            "goal_en": self.goal_en,
            "warnings": self.warnings,
        }


def _element_line(el: dict[str, Any]) -> str:
    """One page element, as the model sees it.

    Compact on purpose. Every extra character here is multiplied by sixty and
    paid for in prompt-processing time on every single step.
    """
    ref = str(el.get("ref", "?"))
    role = str(el.get("role") or el.get("tag") or "element")
    name = str(el.get("name") or "").strip()
    parts = [f"{ref}", role]
    if name:
        parts.append(f'"{name[:120]}"')
    if el.get("value"):
        parts.append(f"= {str(el['value'])[:60]}")
    if el.get("placeholder"):
        parts.append(f"(hint: {str(el['placeholder'])[:60]})")
    if el.get("options"):
        options = ", ".join(str(o)[:30] for o in el["options"][:8])
        parts.append(f"[{options}]")
    if el.get("checked") is not None:
        parts.append("[checked]" if el["checked"] else "[unchecked]")
    return "  ".join(parts)


def _history_line(step: dict[str, Any]) -> str:
    action = step.get("action", "?")
    args = step.get("args") or {}
    detail = args.get("ref") or args.get("url") or args.get("direction") or ""
    label = step.get("label") or ""
    outcome = step.get("outcome") or "done"
    head = f"{action} {detail}".strip()
    if label:
        head += f' ("{label[:60]}")'
    return f"{head} -> {outcome}"


def build_prompt_body(
    goal: str,
    *,
    url: str,
    title: str,
    elements: list[dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
    text: str = "",
) -> str:
    """The user turn: goal, page, elements, what has happened so far.

    Pure string assembly, no model, so the smoke check can exercise it.
    """
    listing = "\n".join(_element_line(el) for el in elements[:MAX_ELEMENTS])
    if not listing:
        listing = "(no interactive elements found on this page)"
    elif len(elements) > MAX_ELEMENTS:
        listing += (
            f"\n... and {len(elements) - MAX_ELEMENTS} more further down the page "
            "(scroll to see them)"
        )

    sections = [
        f"GOAL: {goal.strip()}",
        f"\nCURRENT PAGE: {title.strip() or '(untitled)'}\nURL: {url.strip()}",
    ]
    if text.strip():
        sections.append(f"\nPAGE TEXT (extract):\n{text.strip()[:1500]}")
    sections.append(f"\nELEMENTS ON THIS PAGE:\n{listing}")

    # The closing reminder is not redundant with the system prompt, and its
    # position is the whole point. Measured: with the rule only in the system
    # turn, a question the PAGE TEXT above answered outright still came back
    # as a click on a plausible-looking link -- twice out of two, in Assamese
    # and in English. A 3B model weights the end of the prompt heavily, and
    # the end of the prompt was a list of things to click. Asking the question
    # here, after the elements, is what makes it consider answering at all.
    sections.append(
        "\nBefore choosing: does the PAGE TEXT above already answer the goal? "
        'If it does, reply with {"action":"done","message":"<the answer>"}.'
    )

    recent = (history or [])[-MAX_HISTORY:]
    if recent:
        steps = "\n".join(
            f"{i}. {_history_line(s)}" for i, s in enumerate(recent, start=1)
        )
        sections.append(f"\nACTIONS ALREADY TAKEN:\n{steps}")
    else:
        sections.append("\nACTIONS ALREADY TAKEN: none, this is the first step.")

    sections.append("\nYour next action, as one JSON object:")
    return "\n".join(sections)


#: The model wraps JSON in a fence perhaps a third of the time despite being
#: told not to. Cheaper to strip than to fight in the prompt.
_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


def parse_action(raw: str) -> dict[str, Any]:
    """Pull the first JSON object out of a reply, or raise ValueError.

    Deliberately strict about the shape and lenient about the wrapping: a 3B
    model gets the punctuation around JSON wrong far more often than it gets
    the JSON itself wrong.
    """
    text = _FENCE.sub("", raw).strip()
    start = text.find("{")
    if start == -1:
        raise ValueError(f"no JSON object in reply: {raw[:200]!r}")

    # Scan for the matching brace rather than taking the last one -- the model
    # sometimes emits a second object as a "here is what I would do next".
    depth = 0
    in_string = False
    escaped = False
    end = -1
    for i, ch in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end == -1:
        raise ValueError(f"unterminated JSON object: {raw[:200]!r}")

    parsed = json.loads(text[start:end])
    if not isinstance(parsed, dict):
        raise ValueError(f"expected a JSON object, got {type(parsed).__name__}")
    return parsed


def validate(parsed: dict[str, Any], refs: set[str]) -> Decision:
    """Turn a parsed reply into a Decision, or raise ValueError.

    `refs` is every reference code the content script actually reported. A ref
    outside it is rejected here rather than sent to the page, which is the
    whole safety property of the numbered-element design.
    """
    action = str(parsed.get("action", "")).strip().lower()
    if action not in ACTIONS:
        raise ValueError(
            f"unknown action {action!r}; expected one of {', '.join(sorted(ACTIONS))}"
        )

    args: dict[str, Any] = {}
    for key in ACTIONS[action]:
        if key not in parsed or parsed[key] in (None, ""):
            raise ValueError(f"action {action!r} is missing required field {key!r}")
        args[key] = parsed[key]

    if "ref" in args:
        ref = str(args["ref"]).strip()
        if ref not in refs:
            raise ValueError(
                f"ref {ref!r} is not on this page; it must be one of the listed codes"
            )
        args["ref"] = ref

    if action == "type":
        args["text"] = str(args["text"])
        # Optional, and defaulted here rather than in the schema so the model
        # omitting it is not a validation failure.
        args["submit"] = bool(parsed.get("submit", False))
    if action == "select":
        args["value"] = str(args["value"])
    if action == "scroll":
        direction = str(args["direction"]).strip().lower()
        if direction not in ("up", "down", "top", "bottom"):
            raise ValueError(f"scroll direction {direction!r} is not up/down/top/bottom")
        args["direction"] = direction
    if action == "navigate":
        url = str(args["url"]).strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"navigate url must be http(s), got {url!r}")
        args["url"] = url

    message = str(parsed.get("message", "")).strip()
    return Decision(
        action=action,
        args=args,
        why=str(parsed.get("why", "")).strip()[:300],
        message_en=message,
        message=message,
    )


def _decide_en(body: str, refs: set[str]) -> Decision:
    """One validated decision, with one corrective retry.

    The retry matters more than it looks. The single most common 3B failure
    here is naming a plausible-sounding ref that is not on the page, and
    handing the model its own error text fixes that most of the time -- far
    more cheaply than failing the step and making the user ask again.
    """
    model, tokenizer = llm.load()
    attempts: list[str] = []
    last_error = ""

    for attempt in range(2):
        prompt_body = body
        if last_error:
            prompt_body = (
                f"{body}\n\nYour previous reply was rejected: {last_error}\n"
                "Reply again with one valid JSON object."
            )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt_body},
        ]
        prompt = tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

        from mlx_lm import generate as mlx_generate
        from mlx_lm.sample_utils import make_logits_processors, make_sampler

        raw = mlx_generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=MAX_TOKENS,
            # Lower than llm.py's 0.3: this output is a decision, not prose,
            # and there is nothing to be gained from variety. Not zero,
            # because translate.py's repetition loops showed what greedy
            # decoding does to these 4-bit checkpoints.
            sampler=make_sampler(temp=0.1, top_p=0.9),
            logits_processors=make_logits_processors(repetition_penalty=1.05),
            verbose=False,
        )
        attempts.append(raw)
        try:
            decision = validate(parse_action(raw), refs)
            if attempt:
                decision.warnings.append(
                    f"The first attempt was rejected ({last_error}) and retried."
                )
            return decision
        except ValueError as exc:
            last_error = str(exc)
            logger.warning("agent reply rejected (attempt %d): %s", attempt + 1, exc)

    # Both attempts failed. This is a real outcome, not an exception: the loop
    # should stop and tell the user, the same as any other terminal step.
    return Decision(
        action="fail",
        why="the model did not produce a usable action",
        message_en=(
            "I could not work out what to do on this page. Try telling me the "
            "step you want in simpler words."
        ),
        message=(
            "I could not work out what to do on this page. Try telling me the "
            "step you want in simpler words."
        ),
        warnings=[f"Two invalid replies from the model. Last error: {last_error}"],
    )


def decide(
    goal: str,
    *,
    url: str,
    title: str,
    elements: list[dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
    text: str = "",
    language: str = "en",
) -> tuple[Decision, Timings]:
    """Choose the next action, translating in and out of the user's language.

    The goal arrives in whatever language the user spoke or typed, and any
    closing message goes back in the same one. Everything between is English,
    because that is the only language the answering model can reason and emit
    JSON in at this size.
    """
    timings = Timings()
    lang = language if language in ("en", "") else language
    warnings: list[str] = []

    goal_en = goal
    if lang not in ("en", ""):
        if languages.translatable(lang):
            with timings.stage("translate_in"):
                goal_en = translate.to_english(goal, lang)
        else:
            warnings.append(
                f"{languages.get(lang).name} cannot be translated, so the goal was "
                "sent to the agent as written."
            )

    refs = {str(el.get("ref")) for el in elements if el.get("ref")}
    body = build_prompt_body(
        goal_en, url=url, title=title, elements=elements, history=history, text=text
    )

    with timings.stage("decide"):
        decision = _decide_en(body, refs)

    decision.language = lang
    decision.goal_en = goal_en
    decision.warnings.extend(warnings)

    # Only terminal steps carry a message, and only that message is worth the
    # several seconds a translation costs. Translating every step's "why"
    # would double the wall clock of the whole loop for text nobody reads.
    if decision.message_en and lang not in ("en", "") and languages.translatable(lang):
        with timings.stage("translate_out"):
            decision.message = translate.from_english(decision.message_en, lang)

    logger.info(
        "agent step: %s %s -- %s",
        decision.action,
        decision.args,
        decision.why[:80],
    )
    return decision, timings
