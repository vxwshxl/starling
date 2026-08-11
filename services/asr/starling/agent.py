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
#: Ceiling on one reply.
#:
#: Generous, and generous costs almost nothing: an action step emits perhaps
#: forty tokens and stops at its own stop token, so this is only ever actually
#: spent on a `done` that is a real answer. 220 was the old value and it was a
#: second, invisible length limit sitting behind the prompt -- asking for a
#: thorough answer while capping it there produced answers cut off mid-
#: sentence, which in Bodo is invisible to anyone reading the English.
#: Same reasoning as llm.MAX_TOKENS; see the note in CLAUDE.md about
#: tightening what the model may say rather than how much.
MAX_TOKENS = 900

#: How many page elements go into the prompt. The content script sends them in
#: viewport order, so truncating keeps what the user can see and drops the
#: footer. A 3B model given two hundred options picks worse than one given
#: sixty, quite apart from the prompt-processing cost.
MAX_ELEMENTS = 60

#: How many past steps the model is reminded of. Enough to notice it is
#: repeating itself, short enough not to crowd out the page.
MAX_HISTORY = 8

#: How many turns of the conversation the model is given. The panel is a chat,
#: so "now add it to the cart" has to resolve against what "it" was three
#: turns ago. Capped because each turn costs prompt-processing time on every
#: step of every subsequent run.
MAX_CONVERSATION = 6

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
    "translate_page": (),
    "ask": ("message",),
    "done": ("message",),
    "fail": ("message",),
}

#: Actions that end a run and hand control back to the user.
#:
#: `ask` is here rather than suspending the loop mid-flight, and that is a
#: deliberate simplification: a suspended loop has to hold the page, the
#: history and the model's intent alive across an unbounded wait. Ending the
#: run and starting a fresh one with the user's reply in the conversation
#: reaches the same place with no suspended state to get stale.
TERMINAL = frozenset({"done", "fail", "ask", "translate_page"})

#: Things that spend money, send something on the user's behalf, or cannot be
#: undone. The agent is not forbidden from reaching them -- an agent that
#: cannot finish a purchase is not much use -- but it must `ask` first, and
#: the extension turns that into an explicit confirmation in the chat.
#:
#: Matched against the accessible name of the element about to be clicked,
#: which is a blunt instrument and is meant to be: a false positive costs one
#: confirmation click, a false negative costs real money.
#: Patterns, not plain substrings, because real buttons put words in the
#: middle. Measured: "place order" was in the list and Amazon's button says
#: "Place your order", so the gate did not fire on the single most important
#: button it exists to catch. Any matcher here has to tolerate the filler --
#: "your", "my", "the", "and pay" -- that sites put inside these phrases.
SENSITIVE = re.compile(
    r"""
      \bplace\s+(?:your\s+|my\s+|the\s+)?order
    | \bbuy\s+(?:it\s+)?now
    | \bpay\s+(?:now|securely)
    | \bproceed\s+to\s+(?:pay|checkout\s+and\s+pay)
    | \b(?:make|submit|confirm|authorise|authorize)\s+(?:the\s+)?payment
    | \bconfirm\s+(?:and\s+pay|(?:your\s+|the\s+)?(?:order|purchase|booking|payment))
    | \bcomplete\s+(?:your\s+|the\s+)?(?:purchase|order|booking)
    | \bbook\s+now
    | \bsubscribe\b
    | \bstart\s+(?:my\s+|your\s+)?(?:free\s+)?trial
    | \bdelete\s+(?:my\s+|your\s+|this\s+)?(?:account|permanently|forever)
    | \bpermanently\s+delete
    | \bclose\s+(?:my\s+|your\s+)?account
    | \b(?:send|post|publish|tweet|submit)\s+(?:the\s+|your\s+|this\s+)?
        (?:message|reply|comment|review|post|application)
    | \b(?:transfer|withdraw|send)\s+(?:money|funds|₹|rs\.?\s*\d)
    """,
    re.IGNORECASE | re.VERBOSE,
)

SYSTEM_PROMPT = """You are Starling, an assistant that operates a web browser for a user who may not read English. You are shown the current page and a numbered list of the elements on it, and you choose ONE action at a time. This is a conversation: the user can follow up, and "it" or "that one" refers to what was being discussed earlier.

Reply with a single JSON object and nothing else. No explanation outside the JSON, no markdown fences.

The actions are:
{"action":"click","ref":"e12","why":"..."}                      press a button or link
{"action":"type","ref":"e3","text":"...","submit":true,"why":"..."}   type into a field; submit presses Enter
{"action":"select","ref":"e8","value":"...","why":"..."}        choose an option in a dropdown
{"action":"scroll","direction":"down","why":"..."}              direction is up, down, top or bottom
{"action":"navigate","url":"https://...","why":"..."}           go straight to an address
{"action":"back","why":"..."}                                   the browser's back button
{"action":"translate_page","why":"..."}                         rewrite this page in the user's language
{"action":"ask","message":"...","why":"..."}                    you need the user to decide or confirm
{"action":"done","message":"...","why":"..."}                   finished; message is the answer or the result
{"action":"fail","message":"...","why":"..."}                   it cannot be done here; message says why

Rules:
- NEVER say something has been done unless it appears in ACTIONS ALREADY TAKEN. If the user asked you to do something and you have not done it yet, do it -- do not reply "done" claiming it happened. Reporting an order as placed when you never pressed the button is the worst mistake you can make.
- FIRST, read the page text and the conversation. If either already answers what the user asked, reply with "done" and put the answer in "message". Do not click anything to look up a number you were already told. Most questions end this way.
- If the user asks you to translate the page, to show it in their language, or to put it in Assamese/Bodo/Nepali/Manipuri/Santali, reply exactly {"action":"translate_page","why":"..."}. Do not use "ask" for this.
- "ref" MUST be one of the reference codes listed on the page. Never invent one. If what you need is not listed, scroll to look for it or navigate somewhere it will be.
- Do one thing per reply. Do not plan several steps ahead in one action.
- Look at the actions already taken. If the last one did not change anything, do something different -- never repeat a failing action.
- Prefer searching or navigating over clicking through many pages.

Writing the "message" for done, ask and fail:
- Be thorough. Aim for 6-12 sentences. The person asking may not read the page's language at all, so your answer is the only version of it they get -- a one-line reply throws away everything you just read for them.
- Lead with the direct answer, then give the detail that surrounds it on the page: the numbers, dates, amounts, eligibility conditions, documents needed, deadlines, contact routes, and any exception or caveat the page states.
- If the page lists steps, give all the steps in order rather than summarising them away.
- Say what you could NOT find, if the user asked for something the page does not cover. Do not pad the gap with guesses.
- Never invent a figure, a phone number, a fee or a date that is not on the page or in the conversation. Everything you state must come from what you actually read.
- Plain sentences and short paragraphs. No markdown, no bullets, no ** -- this is shown as plain text and may be read aloud.

Before anything that spends money, sends something on the user's behalf, or cannot be undone -- placing an order, paying, subscribing, deleting, posting -- use "ask" and say exactly what you are about to do and what it will cost. Do the whole task up to that point; just do not press the final button until the user says yes. Shopping, filling in forms and getting to a checkout page are all ordinary work and need no permission.

Never type a password, a card number, a CVV or a one-time code, even if the user asks. Use "ask" and tell them to type it themselves."""


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

    needs_confirmation: bool = False
    """True when the extension must get an explicit yes before executing.

    Set here rather than left to the client, because the client that forgets
    to check it is the one that silently places an order."""

    target_label: str = ""
    """The accessible name of the element this action targets.

    Sent so the client can re-check it. A confirmation is a round trip through
    the user, and by the time they answer, the page may have re-rendered and
    the ref numbering with it -- so `e12` after the yes is not necessarily
    `e12` before it. The client re-indexes and compares this label before
    executing an approved action, which turns "the page changed" from a wrong
    click into a refusal."""

    @property
    def terminal(self) -> bool:
        """Whether the loop should stop after this action."""
        return self.action in TERMINAL

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "args": self.args,
            "why": self.why,
            "message": self.message,
            "message_en": self.message_en,
            "terminal": self.terminal,
            "needs_confirmation": self.needs_confirmation,
            "target_label": self.target_label,
            "language": self.language,
            "goal_en": self.goal_en,
            "warnings": self.warnings,
        }


#: Roles you can put text into. Anything else, `type` is simply the wrong
#: action, and the model reaching for it is a mistake the page can catch
#: before it wastes a step.
#:
#: This check earns its place. Measured on Qwen2.5-3B: prompted to click a
#: product link or a "Place your order" button, it repeatedly answered
#: `type` and used the element's OWN NAME as the text -- typing "Add to cart"
#: into a button called "Add to cart". Three rounds of prompt rewording did
#: not shift it. Rejecting the action structurally does, because the retry in
#: `_decide_en` then hands the model the specific reason and it picks `click`.
#: Same principle as the ref check: validate against what the page actually
#: is, rather than asking the model more nicely.
_TYPABLE = frozenset({"textbox", "searchbox", "combobox", "textarea"})


def _is_typable(role: str) -> bool:
    role = (role or "").lower()
    # roleOf() in content/agent.js emits "input:<type>" for real inputs, and
    # maps checkboxes and radios to their own roles, so any "input:*" here
    # takes text.
    return role.startswith("input:") or role in _TYPABLE


def is_sensitive(label: str) -> bool:
    """Whether clicking something with this label should need a yes first.

    Deliberately loose. The model is already instructed to `ask` before
    spending money and mostly does; this is the backstop for when it does not,
    and a backstop that only fires on exact wording is not one. A false
    positive costs the user one extra click. A false negative costs money.
    """
    return bool(SENSITIVE.search(label or ""))


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
    conversation: list[dict[str, Any]] | None = None,
) -> str:
    """The user turn: conversation, goal, page, elements, steps so far.

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

    sections: list[str] = []

    # Earlier turns come first, so the goal stays adjacent to the page it is
    # about. A follow-up like "add it to the cart" is meaningless without
    # them, and meaningless in a way that produces a confident wrong click
    # rather than a question.
    earlier = (conversation or [])[-MAX_CONVERSATION:]
    if earlier:
        lines = "\n".join(
            f"{turn.get('role', 'user')}: {str(turn.get('text', '')).strip()[:300]}"
            for turn in earlier
            if str(turn.get("text", "")).strip()
        )
        if lines:
            sections.append(f"EARLIER IN THIS CONVERSATION:\n{lines}\n")

    sections += [
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
    # The closing reminder is not redundant with the system prompt, and its
    # position is the whole point. Measured: with the rules only in the system
    # turn, a question the PAGE TEXT answered outright still came back as a
    # click on a plausible-looking link. A 3B model weights the end of the
    # prompt heavily, and the end of the prompt is a list of things to click.
    # Asking the questions here, after the elements, is what makes it consider
    # answering and makes it check its own claim before asserting one.
    sections.append(
        "\nBefore choosing, in order:"
        "\n1. Does the PAGE TEXT or the conversation already answer this? "
        'Then {"action":"done","message":"<the answer>"}.'
        "\n2. Is this a request to translate the page? "
        'Then {"action":"translate_page"}.'
        "\n3. If you are about to claim something is done, check ACTIONS "
        "ALREADY TAKEN. If it is not listed, you have not done it -- do it "
        "instead of claiming it."
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


def validate(parsed: dict[str, Any], refs: Any) -> Decision:
    """Turn a parsed reply into a Decision, or raise ValueError.

    `refs` is every reference code the content script actually reported. A ref
    outside it is rejected here rather than sent to the page, which is the
    whole safety property of the numbered-element design.

    `refs` may be a plain set of codes, or a mapping of code to either the
    accessible name or a {"name", "role"} dict. The richer the mapping, the
    more this can check: names enable the sensitive-action backstop, roles
    enable the typable check below. All three forms support `in`, so a caller
    with only codes can still pass a set.
    """
    action = str(parsed.get("action", "")).strip().lower()
    if action not in ACTIONS:
        raise ValueError(
            f"unknown action {action!r}; expected one of {', '.join(sorted(ACTIONS))}"
        )

    # Coerce before checking required fields. Qwen2.5-3B reaches for `type`
    # on links and buttons constantly -- measured, it typed a button's own
    # name into the button -- and rejecting it did not help: told "e2 is a
    # button, not a text field", it replied `type` again, that time without
    # any text at all, and the step was lost.
    #
    # So interpret rather than refuse. The ref it named is the element it
    # meant to interact with, and the only thing you can do to a link is
    # press it, so `type` on a non-typable element becomes `click` on that
    # element. The coercion cannot smuggle anything past the safety gate: the
    # sensitive-label check below runs on the coerced action, not the
    # original one.
    coerced_from = None
    if action == "type" and isinstance(refs, dict):
        entry = refs.get(str(parsed.get("ref", "")))
        role = entry.get("role", "") if isinstance(entry, dict) else ""
        if role and not _is_typable(role):
            coerced_from = f"type into a {role}"
            action = "click"
            parsed = {**parsed, "action": "click"}

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
    decision = Decision(
        action=action,
        args=args,
        why=str(parsed.get("why", "")).strip()[:300],
        message_en=message,
        message=message,
    )

    # The backstop. The prompt already tells the model to `ask` before
    # spending money; this catches the times it does not, by looking at what
    # the button actually says rather than at what the model intended.
    if isinstance(refs, dict) and "ref" in args:
        entry = refs.get(args["ref"])
        if isinstance(entry, dict):
            decision.target_label = str(entry.get("name", ""))
            role = str(entry.get("role", ""))
        else:
            decision.target_label = str(entry or "")
            role = ""

        if action == "select" and role and role != "select":
            raise ValueError(
                f"{args['ref']} is a {role}, not a dropdown. Use click instead."
            )

        if action == "click" and is_sensitive(decision.target_label):
            decision.needs_confirmation = True
            decision.message_en = decision.message = (
                f'This will press "{decision.target_label.strip()}". Shall I go ahead?'
            )

    if coerced_from:
        # Surfaced rather than silent: the panel shows warnings in the trace,
        # and a coercion is exactly the kind of thing that should be visible
        # when working out why the agent did something unexpected.
        decision.warnings.append(
            f"The model asked to {coerced_from}; pressed it instead."
        )
        logger.info("coerced %s -> click on %s", coerced_from, args.get("ref"))
    return decision


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


#: Answering a question about the page, with no action vocabulary in sight.
#:
#: A separate prompt because the two jobs pull against each other. The action
#: prompt's whole shape -- "reply with one JSON object", a list of verbs, a
#: numbered list of things to click -- is exactly wrong for producing twelve
#: sentences of prose, and measured on Qwen2.5-3B it loses: asked to explain
#: eligibility from page text that plainly contained the answer, it kept
#: replying `click`. Three rewordings of the action prompt did not fix it,
#: because the problem was not the wording. Questions now bypass that prompt
#: entirely and get one with nothing to click in it.
PAGE_QA_PROMPT = """You are Starling. You are reading a web page aloud, in effect, for someone who cannot read the language it is written in. They have asked you a question about it. Answer from the page text below.

How to answer:
- Be thorough. Aim for 6-12 sentences. This is the only version of the page they get, so a one-line reply throws away everything you just read for them.
- Lead with the direct answer, then the detail around it: amounts, dates, eligibility conditions, documents needed, deadlines, who to contact, and any exception the page states.
- If the page lists steps or requirements, give all of them, in order.
- Quote figures exactly as the page gives them. Never invent a number, a fee, a phone number or a date. If the page does not say, say that it does not say.
- If the page does not answer the question at all, say so plainly in one or two sentences and describe what the page IS about, so they know where they have landed.
- Plain sentences and short paragraphs. No markdown, no bullets, no asterisks -- this is shown as plain text and may be read aloud.
- Answer in English. Translation into the user's language happens after you."""


def answer_page(
    question: str,
    *,
    text: str,
    url: str = "",
    title: str = "",
    language: str = "en",
) -> tuple[Decision, Timings]:
    """Answer a question about the current page, at length.

    Returns a Decision so the extension can treat it exactly like a terminal
    `done` from the agent loop -- same shape, same translation handling, same
    rendering. The only difference is that no action was ever considered.
    """
    timings = Timings()
    lang = language if language not in ("en", "") else "en"

    question_en = question
    if lang != "en" and languages.translatable(lang):
        with timings.stage("translate_in"):
            question_en = translate.to_english(question, lang)

    model, tokenizer = llm.load()
    body = (
        f"PAGE: {title.strip() or '(untitled)'}\nURL: {url.strip()}\n\n"
        f"PAGE TEXT:\n{text.strip()[:6000]}\n\n"
        f"QUESTION: {question_en.strip()}"
    )
    prompt = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": PAGE_QA_PROMPT},
            {"role": "user", "content": body},
        ],
        add_generation_prompt=True,
        tokenize=False,
    )

    from mlx_lm import generate as mlx_generate
    from mlx_lm.sample_utils import make_logits_processors, make_sampler

    with timings.stage("answer"):
        raw = mlx_generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=MAX_TOKENS,
            # Warmer than the action path: this is prose, not a decision, and
            # 0.1 makes long answers repetitive.
            sampler=make_sampler(temp=0.3, top_p=0.9),
            logits_processors=make_logits_processors(repetition_penalty=1.05),
            verbose=False,
        )
    answer = llm._clean(raw)

    decision = Decision(
        action="done",
        why="answered from the page text",
        message_en=answer,
        message=answer,
        language=lang,
        goal_en=question_en,
    )
    if lang != "en" and languages.translatable(lang):
        with timings.stage("translate_out"):
            decision.message = translate.from_english(answer, lang)

    logger.info("page question answered in %d chars", len(answer))
    return decision, timings


def decide(
    goal: str,
    *,
    url: str,
    title: str,
    elements: list[dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
    text: str = "",
    language: str = "en",
    conversation: list[dict[str, Any]] | None = None,
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

    # A mapping, not a set, so validate() can see what the model is actually
    # pointing at: the label drives the sensitive-action backstop, the role
    # rejects typing into a button.
    refs = {
        str(el["ref"]): {
            "name": str(el.get("name") or ""),
            "role": str(el.get("role") or el.get("tag") or ""),
        }
        for el in elements
        if el.get("ref")
    }
    body = build_prompt_body(
        goal_en,
        url=url,
        title=title,
        elements=elements,
        history=history,
        text=text,
        conversation=conversation,
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
