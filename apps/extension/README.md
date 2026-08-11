# Starling for Chrome

Read any website in Assamese, Bodo, Manipuri, Nepali, Santali or Sylheti, and
tell the browser what to do out loud. Everything runs against the Starling
service on `127.0.0.1:8000` — the same models as the main app, on the same
machine.

It is a chat. One box, and what you type decides what happens:

| You type | What happens |
|---|---|
| *"what does this page say about eligibility?"* | Answered at length from the page text, in your language. Nothing is clicked. |
| *"translate this page into Bodo"* | The page is rewritten in place. One click to put the English back. |
| *"find a formal shoe under 1000 and add it to the cart"* | The agent looks at the page, takes one action, looks again, repeats. Every action is shown as it happens. |

Follow-ups work — "how much was that again?" resolves against what was said
earlier in the thread. Every answer has a **Listen** button that speaks it
through OmniVoice in your language.

Three separate paths, because one prompt cannot do all three. A model asked to
emit `{"action":"click"}` is measurably bad at writing twelve sentences of
prose, so questions bypass the action vocabulary entirely and go to a prompt
with nothing to click in it. The routing is a regex, not a model call, so it
costs nothing.

## Install

There is no build step. The extension is plain ES modules and loads as-is.

1. Start the service — `pnpm dev:api` from the repo root.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → select `apps/extension`.
4. Pin Starling to the toolbar and click it, or press `⌘⇧L`.

The side panel opens with a status pill in the corner. If it says **offline**,
the service is not running; click the pill to re-check.

> **Warm the models first for a demo.** Press *Warm models* in the panel
> footer. The first translation otherwise pays a ~2.6 GB load for
> Sarvam-Translate and the first agent step another ~1.8 GB for Qwen, and a
> cold first action looks exactly like a hang.

## How long it takes

Measured on an M4 MacBook Air, 16 GB, `STARLING_DEVICE=cpu`, model warm, on 29
segments of a real government page, English → Assamese:

| | Wall clock |
|---|---|
| One request per segment (the naive way) | 16.2 s |
| Batched, when the reply parses cleanly | 11.8 s |
| Every segment already cached | 0.013 s |

So: **a dense first screen takes about twelve seconds cold, and is instant on
any page you have already seen.** Not "a whole site in seconds" — a 4B
translation model on a fanless laptop does roughly 2.4 segments a second and
no amount of engineering in the extension changes that number.

What the extension does instead is translate **less**, and translate it where
you are looking. Only the visible screen plus about one and a half screens of
runway is done up front; everything further down is watched with an
`IntersectionObserver` and translated as you scroll towards it, a screen
ahead. On a 160-segment page that is the difference between a minute of
waiting and about nine seconds.

That also fixes the way the old behaviour *felt*. Sending all 160 at once left
the bottom of the page in English for a full minute while the progress bar
claimed to be working, so scrolling mid-run looked like the translation had
given up. Now scrolling is what causes the work. The card keeps counting as
you go and says "N more as you scroll" until there are none left.

Four things reduce the work before the model is consulted, in ascending order
of how much they actually save:

- **Batching** groups a dozen segments into one generation. 1.37× when it
  works — but one batch in five comes back with the numbering shifted and has
  to be discarded and re-run segment by segment to avoid putting the wrong
  translation on the wrong element. Netted out, it is close to break-even. It
  is kept because the model translates a nav bar more consistently when it
  sees the whole nav bar.
- **Skipping** drops anything with no words in it: numbers, dates, bare URLs,
  icon glyphs. About a fifth of a typical page.
- **Deduping** collapses repeats within a page. Every "Read more".
- **The cache** remembers every segment ever translated, across restarts. This
  is the one that matters — three orders of magnitude — and it is why the
  second page of a site is fast.

Because the cache is doing the heavy lifting, **a bad translation sticks**.
If a page comes out wrong, *Clear cache* in the footer and translate it again;
otherwise the wrong text is served from memory indefinitely.

## What the agent can and cannot do

It picks one action per step from a fixed vocabulary and may only name an
element from the numbered list the page handed it. A reference the model
invents is rejected twice: by `agent.py` on the service, and by
`content/agent.js` in the page. It cannot write a selector and cannot reach an
element nobody listed. The action is also checked against what the element
*is* — asked to type into a button, it presses it instead of failing.

It stops after **12 steps**, when it repeats the same action three times, or
when you press Stop.

**It will shop for you, and it stops before spending money.** Searching,
comparing, filling forms and getting to a checkout page are ordinary work and
happen without asking. Anything that spends money, sends something on your
behalf, or cannot be undone — *Place your order*, *Buy now*, *Subscribe*,
*Delete account* — stops and asks in the chat, quoting the exact button. One
click to proceed. If the page changes while you are deciding, the approval is
void and it says so rather than pressing whatever now sits at that position.
It never types a password, card number or OTP.

**Be realistic about the model.** Qwen2.5-3B is genuinely weak for multi-step
checkout. Measured on scripted Amazon-shaped pages: it reliably searches,
picks a product and adds to cart, and the money gate fires correctly — but it
loses track over long flows and will sometimes click a plausible wrong link.
Every step is printed with the model's own reason and the element is ringed in
the page as it is touched, so you can see it go wrong.

If you want it meaningfully better, swap the model — nothing else changes:

```bash
STARLING_LLM_MODEL=mlx-community/Qwen2.5-7B-Instruct-4bit pnpm dev:api
```

That is ~4.3 GB instead of ~1.8 GB, so it is a real dent in the 16 GB budget
next to the translator; free the other models from the panel footer first.

## Privacy

Every request goes to `127.0.0.1:8000` and the manifest's
`connect-src` blocks any other host, so a mistake in the code fails at the CSP
rather than quietly reaching the internet.

Two things worth knowing:

- **`<all_urls>` host permission.** An agent whose job is to navigate cannot
  use `activeTab`, which Chrome revokes on cross-origin navigation. To
  compensate there are **no declared content scripts** — nothing is injected
  into any page until you press a button in the panel.
- **The translation cache** is a JSON file in the system temp directory
  holding text from pages you translated. It is cleared on reboot, and
  *Clear cache* in the panel footer empties it immediately.

If the service is configured with the Modal TTS backend, that is a separate
feature of the main app; this extension never calls it.

## Layout

```
manifest.json        MV3. No declared content scripts — injection is on demand.
background.js        Almost empty on purpose: toolbar button and context menu.
                     The long jobs cannot live here; a service worker is killed
                     after ~30 s idle and the agent loop mostly waits.
lib/
  api.js             The service, and the only place that fetches.
  tabs.js            Injection, the pages Chrome forbids, waiting for a load.
  run.js             The two long jobs: runTranslation() and runAgent().
content/
  translate.js       Finds the text, orders it by viewport, writes results back,
                     restores. Groups inline markup so a sentence broken by an
                     <em> is still translated as one sentence.
  agent.js           Numbers the interactive elements, performs one action,
                     reports what changed. Draws the ring.
sidepanel/           The UI, and the owner of both loops.
```

### Why the panel runs the loops

A content script cannot fetch the service: its requests carry the *page's*
origin, and widening CORS to accept those would open the service to every site
you visit. So the content scripts do DOM work only and the panel does all
network work. The panel is also the only context that reliably stays alive for
the length of an agent run — see the comment at the top of `background.js`.

## Going to the right site first

If an instruction is about somewhere other than where you are, the panel goes
there before it starts work. One rule, not a special case per site:

- **A site named in the message.** *"buy me a formal shoe under 1000 from
  amazon.in"* names where the work happens as clearly as *"go to amazon.in"*
  does. Both navigate. This is the general case and nothing about it is
  per-site.
- **A known task**, for the flows that name no URL at all. *"download my
  aadhaar"* has to get its destination from somewhere, and
  `services/asr/starling/tasks.py` holds it — Aadhaar download, Aadhaar/bank
  seeding, PM-KISAN, ration card portals, WhatsApp.

Neither costs a model call, and the destination is never generated. That is
deliberate for the government flows especially: a *guessed* URL is exactly how
somebody ends up typing their Aadhaar number into a lookalike site.

**Naming a site you are already on does nothing**, which is what keeps a
multi-turn task on one page — *"now add it to the cart"* names nothing, and
*"buy shoes from amazon.in"* while already on Amazon must not reload and throw
away the last three turns. The comparison is a dot-boundary suffix match, so
`uidai.gov.in` covers `myaadhaar.uidai.gov.in` and never
`uidai.gov.in.phish.example` — on a lookalike domain it navigates *away*, to
the real one.

Instructions that name no site stay put: *"open the contact page"* is the
agent's job, not a URL.

### How the Aadhaar flow actually runs

1. You say *"download my aadhaar"*. It opens the UIDAI page.
2. It finds the Aadhaar number field and **stops**, asking you for the number.
3. You type it into a masked box in the panel. **The number goes straight
   into the page** — it is never sent to `/agent/act`, never written to the
   transcript, never logged. The model is told only "the user supplied that
   value".
4. It reaches the captcha and stops again: captchas exist to require a person,
   and pretending otherwise would be a lie. You type it, press *Done — carry
   on*.
5. Same for the OTP.
6. It presses download, and tells you the PDF password rule (first four
   letters of your name in capitals, then your year of birth).

The withholding is structural, not prompted. The service inspects the field's
label and placeholder, and a `type` into anything matching Aadhaar, PAN,
account number, OTP, captcha, password, CVV or PIN is **converted** into a
request to the user before it ever leaves the service. So even a model that
hallucinated a plausible twelve-digit number cannot submit one.

Digit runs that look like identifiers are also redacted from logs and from the
chat history on both sides — including from what *you* type, in case you paste
the number into the chat rather than the masked field.

### Messaging

*"message ramesh on whatsapp asking how the appointment is going"* opens
WhatsApp Web, searches for the chat, and composes the message in your language.

**Sending is always confirmed, with the full text quoted.** Note that on
WhatsApp the message is sent by pressing Enter, not by clicking Send — so the
gate is on `type` with submit, not only on the button. Gating the button alone
would have let a message go out unapproved.

## Listening to answers

Every answer gets a **Listen** button: OmniVoice, through `POST /tts`, in the
language the answer is written in.

It is a button and never automatic, because of the cost. Local synthesis runs
about **6× real time** on this machine, so a twelve-sentence answer — now the
normal length — is minutes of CPU. The button shows the elapsed seconds while
it works so a long wait reads as work rather than a hang.

If that is too slow to demo, `STARLING_TTS_BACKEND=modal` is ~3 s warm. It
does **not** clone the voice and the text leaves the machine; the service
attaches that caveat to the result and the panel prints it next to the button
rather than hiding it.

The panel sends no reference audio, so this is OmniVoice's default voice, not
a clone of yours. Cloning needs a recording of the speaker plus its
transcript — which the main app has and a browser panel generally does not.

## The microphone

Chrome will not open a permission prompt inside a side panel: prompts anchor
to a tab's address bar, and a panel is not a tab, so `getUserMedia` is
rejected without anything being shown. It looks like the extension asked and
was refused when nothing asked at all.

The panel detects this and offers to open `permission.html` in a normal tab.
Granting it there fixes it everywhere, because the permission is stored
against the extension's origin rather than the page that requested it.

## Known limitations

- **A sentence broken by a link is translated in pieces.** Cosmetic inline
  markup (`<em>`, `<strong>`, `<span>`) is absorbed into the surrounding
  sentence, but `<a>` cannot be — the translation would have to be split back
  across nodes, and the target languages reorder words. So "Read the
  [eligibility rules] before applying" goes to the model as three fragments.
- **Ol Chiki and Meetei Mayek need fonts.** Without *Noto Sans Ol Chiki* or
  *Noto Sans Meetei Mayek* installed, Santali and Manipuri render as empty
  boxes — which looks like the model failed rather than like a missing font.
- **Indic → Indic is refused,** not pivoted. Sarvam-Translate's open checkpoint
  is English↔Indic only. The panel disables the button and says so.
- **No streaming.** A chunk appears when the whole chunk is done.
- **`chrome://`, the new tab page, the Web Store and PDFs** cannot be scripted
  by any extension. That restriction is real and there is no way around it —
  but the panel is not dead there, which is what matters, since the new tab
  page is exactly where you start something from. On such a page it falls back
  to what does not need the DOM:
  - a known task (*"download my aadhaar"*) → navigates to the official page,
    then carries on normally;
  - *"go to amazon.in"* or a pasted URL → navigates, then carries on;
  - anything else → answered through `POST /chat`, Starling's own
    retrieval-and-generate path, which needs no page at all.

  Only *translating this page* and *questions about this page* are genuinely
  impossible there, and those say so instead of pretending.
