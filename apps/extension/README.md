# Starling for Chrome

Read any website in Assamese, Bodo, Manipuri, Nepali, Santali or Sylheti, and
tell the browser what to do out loud. Everything runs against the Starling
service on `127.0.0.1:8000` — the same models as the main app, on the same
machine.

Two features, one side panel:

| | What it does |
|---|---|
| **Translate** | Rewrites the page in your language, in place. Visible screen first, then the rest. One click to put the English back. |
| **Do it for me** | You say or type a goal; the agent looks at the page, takes one action, looks again, and repeats. Every action is shown before it happens. |

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

What the extension does instead is make the *wait* land where it does not
matter. Text is sorted by position relative to the viewport and sent in small
chunks, so the screen you are looking at is translated first and the rest
fills in behind you. The counts under the progress bar are honest about it:
how many segments went to the model, how many came from cache, how many were
skipped as untranslatable.

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

It picks one action per step from a fixed vocabulary — click, type, select,
scroll, navigate, back, done, fail — and it may only name an element from the
numbered list the page handed it. A reference the model invents is rejected
twice: once by `agent.py` on the service, once by `content/agent.js` in the
page. It cannot write a selector and cannot reach an element nobody listed.

It stops after **12 steps**, or when it repeats the same action three times,
or when you press Stop. It is told not to enter passwords, pay for anything,
delete anything or send messages, and it will refuse and say so.

It is a 3B model. It is good at "search this site for X", "find the contact
page", "what does this page say about eligibility". It is not good at long
multi-page forms, and it will sometimes click a plausible wrong link. That is
why every step is printed with the reason the model gave, and why the element
it is about to touch is ringed in the page as it happens.

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
- **`chrome://`, the Web Store and PDFs** cannot be scripted by any extension.
  The panel names that rather than failing obscurely.
