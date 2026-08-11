"""Recipes for the government services people actually come here to do.

A 3B model does not know that downloading an Aadhaar starts at
myaadhaar.uidai.gov.in, that the button says "Download Aadhaar", or that the
number goes in before the captcha rather than after. Asked cold, it guesses a
URL, and a guessed government URL is worse than useless -- it is how people
end up on a lookalike site typing their Aadhaar number into it.

So the entry point and the shape of each flow are written down here, matched
by keyword, and injected into the agent's prompt as a hint. The model still
drives: it reads the real page and picks real elements, and the recipe never
overrides what is actually on screen. It is a map, not a macro -- if the site
has been redesigned, the model follows the site.

**The domain allow-list is the security-relevant part.** Each recipe names the
host it is allowed to start from, and the extension refuses to auto-navigate
anywhere else for that task. Phishing an Aadhaar number is a real and common
attack, and an assistant that will type one into whatever page it landed on is
an excellent phishing tool. The number is only ever entered on a host named
here, and only ever by the user through a field the panel controls -- never by
the model. See SECRET_FIELDS in agent.py.

Adding a recipe is deliberately cheap. Anything with a stable public entry URL
and a few known steps belongs here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Task:
    name: str
    """Short human name, shown in the panel."""

    url: str
    """Where the flow starts. Must be on one of `hosts`."""

    hosts: tuple[str, ...]
    """Hostnames this task is permitted to operate on."""

    keywords: tuple[str, ...]
    """Matched against the user's goal, after translation to English."""

    steps: tuple[str, ...]
    """What the flow looks like, in order. Written as guidance for the model,
    not as a script -- it reads the real page at every step."""

    needs: tuple[str, ...] = ()
    """Things only the user can supply. Rendered in the panel as a masked
    field (for identifiers) or a "do this yourself" pause (captcha, OTP)."""

    caution: str = ""
    """Anything the model must be told not to do on this particular flow."""

    def as_hint(self) -> str:
        """The block injected into the agent prompt."""
        lines = [
            f"KNOWN TASK: {self.name}",
            f"Start at: {self.url}",
            "Steps on that site:",
            *(f"  {i}. {step}" for i, step in enumerate(self.steps, start=1)),
        ]
        if self.needs:
            lines.append(
                "You do NOT have these and must not invent them: "
                + ", ".join(self.needs)
                + '. Use {"action":"ask"} to request each one when you reach '
                "the field that needs it."
            )
        if self.caution:
            lines.append(f"Caution: {self.caution}")
        return "\n".join(lines)


#: Fields whose value must never be produced by the model, never logged, and
#: never put into the conversation history. The model may say "I need the
#: Aadhaar number for e12"; the panel collects it and types it directly.
SECRET_NEEDS = frozenset({
    "aadhaar number", "pan number", "account number", "password",
    "otp", "captcha", "card number", "cvv", "pin",
})

#: Things a human has to do in the page themselves, because they are designed
#: to be un-automatable and it would be dishonest to pretend otherwise.
HUMAN_NEEDS = frozenset({"captcha", "otp"})


TASKS: tuple[Task, ...] = (
    Task(
        name="Download Aadhaar (e-Aadhaar PDF)",
        url="https://myaadhaar.uidai.gov.in/genricDownloadAadhaar",
        hosts=("myaadhaar.uidai.gov.in", "uidai.gov.in"),
        keywords=(
            "download aadhaar", "aadhaar download", "e-aadhaar", "eaadhaar",
            "aadhar download", "download aadhar", "get my aadhaar",
            "aadhaar card copy", "aadhaar pdf",
        ),
        steps=(
            "The page asks for a 12-digit Aadhaar number, or a 16-digit VID.",
            "Enter the Aadhaar number in that field.",
            "There is a captcha image with a text box under it. STOP there and "
            "ask the user to type the captcha themselves.",
            "After the captcha, press the button that sends an OTP to the "
            "registered mobile number.",
            "STOP again and ask the user for the OTP that arrives on their phone.",
            "Once the OTP is accepted, press the button that downloads the PDF.",
        ),
        needs=("aadhaar number", "captcha", "otp"),
        caution=(
            "The downloaded PDF is password protected. The password is the "
            "first four letters of the name in CAPITALS followed by the year "
            "of birth -- tell the user that when the download finishes. Never "
            "read the Aadhaar number back to the user or repeat it in a message."
        ),
    ),
    Task(
        name="Check Aadhaar/bank seeding status",
        url="https://myaadhaar.uidai.gov.in/check-aadhaar-bank-seeding-status",
        hosts=("myaadhaar.uidai.gov.in", "uidai.gov.in"),
        keywords=(
            "aadhaar bank link", "bank seeding", "aadhaar linked to bank",
            "dbt status", "is my aadhaar linked",
        ),
        steps=(
            "Enter the Aadhaar number, then the captcha.",
            "Ask the user for the captcha and then the OTP.",
            "Read the seeding status back to the user in plain words.",
        ),
        needs=("aadhaar number", "captcha", "otp"),
    ),
    Task(
        name="PM-KISAN beneficiary status",
        url="https://pmkisan.gov.in/BeneficiaryStatus_New.aspx",
        hosts=("pmkisan.gov.in",),
        keywords=(
            "pm kisan", "pmkisan", "kisan samman", "farmer instalment",
            "kisan status", "pm-kisan status",
        ),
        steps=(
            "Choose whether to search by registration number or mobile number.",
            "Enter the number the user gives, then the captcha.",
            "Ask the user for the captcha.",
            "Read back the instalment history and the latest payment status.",
        ),
        needs=("registration or mobile number", "captcha"),
    ),
    Task(
        name="Send a WhatsApp message",
        url="https://web.whatsapp.com/",
        hosts=("web.whatsapp.com",),
        keywords=(
            "whatsapp", "message someone", "send a message", "text someone",
            "whats app", "message my", "ask him", "ask her", "tell him", "tell her",
        ),
        steps=(
            "WhatsApp Web must already be logged in. If it shows a QR code, "
            "stop and tell the user to scan it with their phone first.",
            "Use the search box at the top of the chat list to find the "
            "person by name, then click their chat in the results.",
            "The message box at the bottom is a text area labelled something "
            "like 'Type a message'. Type the message there.",
            "Sending is confirmed with the user before it happens. Write the "
            "message in the language the user asked for, not in English.",
        ),
        needs=("the name of the person to message",),
        caution=(
            "Never send to a chat you are not certain is the right person -- "
            "if the search returns several similar names, ask which one. Do "
            "not open or read other chats; only the one named."
        ),
    ),
    Task(
        name="Check a ration card / PDS entitlement",
        url="https://nfsa.gov.in/portal/ration_card_state_portals_aa",
        hosts=("nfsa.gov.in",),
        keywords=("ration card", "pds", "nfsa", "food security card"),
        steps=(
            "This page lists every state's own portal. Pick the user's state.",
            "State portals differ, so read the page you land on rather than "
            "assuming a layout.",
        ),
        needs=("ration card number",),
    ),
)


def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9\s]+", " ", text.lower())


def match(goal_en: str) -> Task | None:
    """Find the recipe for a goal, or None.

    Matched on the English goal, because the keywords are English and the
    cascade has already translated by the time this is called.
    """
    # Token containment rather than a contiguous phrase. People do not phrase
    # a request as a keyword: "download my aadhaar card" has to match the
    # keyword "download aadhaar", and requiring the two words to be adjacent
    # meant it did not. All of a keyword's words must be present, in any
    # arrangement.
    words = set(_normalise(goal_en).split())
    best: tuple[int, Task] | None = None
    for task in TASKS:
        for keyword in task.keywords:
            tokens = keyword.split()
            if all(token in words for token in tokens):
                # More words matched wins, so "download aadhaar" beats a
                # single-word keyword on a goal that contains both.
                score = len(tokens) * 100 + len(keyword)
                if best is None or score > best[0]:
                    best = (score, task)
    return best[1] if best else None


def host_allowed(task: Task, url: str) -> bool:
    """Whether `url` is somewhere this task may operate.

    Suffix-matched on a dot boundary so that `uidai.gov.in` covers
    `myaadhaar.uidai.gov.in` but never `uidai.gov.in.phish.example`.
    """
    host = re.sub(r"^https?://", "", url or "").split("/")[0].split(":")[0].lower()
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in task.hosts)
