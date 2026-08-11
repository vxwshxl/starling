"""Smoke check: everything except the model weights.

Deliberately does NOT download or load any model, so it stays fast and can run
before the multi-GB first-use download. It verifies imports resolve, ffmpeg
works on a real generated file, the language config is coherent, and the
language codes we configured actually exist in the installed libraries.

    uv run python -m starling.smoke
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

PASS, FAIL = "  ok  ", " FAIL "
failures: list[str] = []


def check(label: str, fn) -> None:
    try:
        detail = fn()
        print(f"[{PASS}] {label}{f' -- {detail}' if detail else ''}")
    except Exception as exc:  # noqa: BLE001
        print(f"[{FAIL}] {label} -- {type(exc).__name__}: {exc}")
        failures.append(label)


def _imports() -> str:
    from . import audio, config, languages, models, pipeline  # noqa: F401
    from . import asr_backends, timing  # noqa: F401

    return "all starling modules import"


def _ffmpeg_roundtrip() -> str:
    from .audio import ensure_ffmpeg, probe_duration, to_wav_16k

    ensure_ffmpeg()
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "tone.wav"
        # A 1-second 44.1 kHz stereo tone, i.e. deliberately the wrong shape.
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
             "-ac", "2", str(src)],
            check=True, capture_output=True,
        )
        out = to_wav_16k(src, Path(d) / "out.wav")

        import soundfile as sf

        info = sf.info(str(out))
        assert info.samplerate == 16000, f"expected 16000 Hz, got {info.samplerate}"
        assert info.channels == 1, f"expected mono, got {info.channels} channels"
        duration = probe_duration(out)
        return f"44.1k stereo -> {info.samplerate} Hz mono, {duration:.2f}s"


def _language_config() -> str:
    from . import languages

    enabled = languages.enabled()
    assert enabled, "no languages enabled"
    assert languages.DEFAULT_LANGUAGE in languages.LANGUAGES
    for lang in languages.LANGUAGES.values():
        assert lang.code and lang.name and lang.iso and lang.script
        if lang.asr_native:
            assert lang.asr_code, f"{lang.code} claims native ASR but has no code"
        if lang.tts_native:
            assert lang.tts_code, f"{lang.code} claims native TTS but has no code"
    return f"{len(enabled)} enabled of {len(languages.LANGUAGES)}: " + ", ".join(
        lang.code for lang in enabled
    )


def _codes_exist_in_libraries() -> str:
    """The whole point of the two-code design: verify against reality.

    Each language's asr_code is checked against ITS OWN backend, not against
    Whisper globally -- Bodo's "brx" is a real IndicConformer language and
    deliberately not a Whisper one.
    """
    from mlx_whisper.tokenizer import LANGUAGES as WHISPER_LANGS
    from omnivoice.utils.lang_map import LANG_IDS as OMNI_LANGS

    from . import languages
    from .asr_backends import INDIC_CONFORMER_REPOS
    from .config import settings

    notes: list[str] = []
    for lang in languages.LANGUAGES.values():
        backend = lang.asr_backend or settings.asr_backend
        if lang.asr_code:
            if backend == "mlx-whisper" and lang.asr_code not in WHISPER_LANGS:
                raise AssertionError(
                    f"{lang.code}: asr_code {lang.asr_code!r} is not a Whisper language"
                )
            if backend == "indic-conformer" and lang.asr_code not in INDIC_CONFORMER_REPOS:
                raise AssertionError(
                    f"{lang.code}: asr_code {lang.asr_code!r} has no IndicConformer "
                    "ONNX export configured"
                )
        if lang.tts_code and lang.tts_code not in OMNI_LANGS:
            raise AssertionError(
                f"{lang.code}: tts_code {lang.tts_code!r} is not an OmniVoice language"
            )
        if lang.asr_code and not lang.asr_native:
            notes.append(f"{lang.code}->asr:{lang.asr_code}")
        if lang.tts_code and not lang.tts_native:
            notes.append(f"{lang.code}->tts:{lang.tts_code}")
    fallbacks = f"; fallbacks: {', '.join(notes)}" if notes else ""
    return f"whisper {len(WHISPER_LANGS)} langs, omnivoice {len(OMNI_LANGS)} langs{fallbacks}"


def _model_apis_present() -> str:
    """Confirm the functions we call actually exist, without loading weights."""
    import inspect

    import mlx_whisper
    from omnivoice import OmniVoice

    assert callable(mlx_whisper.transcribe)
    sig = inspect.signature(mlx_whisper.transcribe)
    assert "path_or_hf_repo" in sig.parameters

    assert hasattr(OmniVoice, "from_pretrained")
    gen = inspect.signature(OmniVoice.generate)
    for param in ("text", "language", "ref_audio", "ref_text"):
        assert param in gen.parameters, f"OmniVoice.generate has no {param!r}"

    import onnx_asr

    assert callable(onnx_asr.load_model)
    rec = inspect.signature(onnx_asr.load_model)
    assert "model" in rec.parameters, "onnx_asr.load_model has no 'model' parameter"

    return (
        "mlx_whisper.transcribe, OmniVoice.generate and onnx_asr.load_model "
        "signatures match our call sites"
    )


def _fastapi_app() -> str:
    from .main import app

    routes = sorted(
        r.path for r in app.routes if getattr(r, "methods", None)
    )
    for expected in (
        "/health", "/asr", "/tts", "/roundtrip",
        "/translate", "/translate/batch", "/agent/act", "/page/ask",
    ):
        assert expected in routes, f"missing route {expected}"
    return ", ".join(routes)


def _batch_protocol() -> str:
    """The pack/unpack round trip that whole-page translation rides on.

    Worth a smoke check because its failure mode is silent and severe: a reply
    the parser mis-splits does not raise, it attaches the wrong translation to
    the wrong DOM node, and the page looks translated while being nonsense.
    """
    from .translate import _pack, _unpack, plan_batches

    texts = ["Home", "Read more", "Contact us"]
    packed = _pack(texts)
    assert packed.count("<<") == 3, f"expected 3 markers, got {packed!r}"

    # A well-formed reply.
    good = _unpack("<<1>> ঘৰ\n<<2>> অধিক পঢ়ক\n<<3>> যোগাযোগ", 3)
    assert good == {0: "ঘৰ", 1: "অধিক পঢ়ক", 2: "যোগাযোগ"}, good

    # A dropped segment must come back as a GAP, not as a shifted mapping --
    # this is the case that would silently mis-attribute translations.
    gap = _unpack("<<1>> ঘৰ\n<<3>> যোগাযোগ", 3)
    assert gap == {0: "ঘৰ", 2: "যোগাযোগ"}, gap

    # Regression, and the reason _translate_batch is all-or-nothing. Measured
    # from the real model: it absorbed one input into its neighbour and then
    # RENUMBERED the rest, so every marker still looked well-formed while the
    # contents had shifted by one. The only detectable signal is that the set
    # of markers is no longer complete -- so an incomplete parse must never be
    # treated as "mostly fine with a couple of gaps".
    renumbered = _unpack("<<1>> a\n<<2>> b\n<<3>> c\n<<5>> e", 5)
    assert len(renumbered) != 5, "a renumbered reply must not look complete"

    # The single-angle form the model sometimes emits instead.
    assert _unpack("<1> ঘৰ", 1) == {0: "ঘৰ"}

    # A segment over the character budget gets a batch to itself.
    plan = plan_batches(["a" * 900, "short", "also short"])
    assert plan[0] == [0], f"oversized segment was batched with others: {plan}"
    return f"pack/unpack round trip, drop detection, {len(plan)} batches planned"


def _page_filters() -> str:
    """What page translation refuses to spend the model on."""
    from .translate_cache import dedupe, worth_translating

    keep = ["Hello", "Read more", "सुरक्षा", "ᱥᱟᱱᱛᱟᱲᱤ", "Terms/Conditions"]
    drop = ["2024", "1,299", "...", "→", "https://x.com/a", "a@b.com", "/about/us", "index.html"]
    for text in keep:
        assert worth_translating(text), f"{text!r} should be translated"
    for text in drop:
        assert not worth_translating(text), f"{text!r} should be skipped"

    unique, mapping = dedupe(["Read more", "Home", "Read more"])
    assert unique == ["Read more", "Home"] and mapping == [0, 1, 0], (unique, mapping)
    return f"{len(keep)} kept, {len(drop)} skipped, dedupe collapses repeats"


def _agent_contract() -> str:
    """The agent's reply parser and its refusal to touch unlisted elements."""
    from .agent import build_prompt_body, parse_action, validate

    assert parse_action('```json\n{"action":"click","ref":"e3"}\n```')["ref"] == "e3"
    assert parse_action('Sure: {"action":"scroll","direction":"down"} then...')["action"] == "scroll"

    ok = validate({"action": "type", "ref": "e2", "text": "fever", "submit": True}, {"e2"})
    assert ok.args == {"ref": "e2", "text": "fever", "submit": True}, ok.args
    assert not ok.terminal
    assert validate({"action": "done", "message": "found it"}, set()).terminal

    # Each of these must be refused. The ref check is the safety property of
    # the whole design: a model-invented reference must never reach the page.
    for bad in (
        {"action": "click", "ref": "e99"},
        {"action": "frobnicate"},
        {"action": "click"},
        {"action": "navigate", "url": "javascript:alert(1)"},
        {"action": "scroll", "direction": "sideways"},
    ):
        try:
            validate(bad, {"e2"})
        except ValueError:
            continue
        raise AssertionError(f"validate() accepted {bad!r}")

    body = build_prompt_body(
        "book a ticket", url="https://x", title="X",
        elements=[{"ref": "e1", "role": "button", "name": "Search"}],
        conversation=[{"role": "user", "text": "find me a cheap flight"}],
    )
    assert "e1" in body and "GOAL: book a ticket" in body
    assert "cheap flight" in body, "conversation history is not reaching the prompt"
    return "parser handles fences and prose; 5 invalid actions refused"


def _confirmation_gate() -> str:
    """Actions that spend money must not execute without an explicit yes.

    The model is instructed to `ask` first and mostly does. This is the
    backstop for when it does not, and it is the one check here whose failure
    costs the user real money rather than a bad translation.
    """
    from .agent import is_sensitive, validate

    # Real button labels, including the ones that broke earlier versions.
    # "Place your order" is here because the first implementation matched the
    # plain substring "place order" and therefore sailed straight past
    # Amazon's actual button -- the single case this gate exists for. The
    # near-miss pairs matter as much: "Proceed to checkout" and "Post office"
    # must NOT trip a gate that "Proceed to pay" and "Post comment" do.
    must_confirm = [
        "Place your order", "Place order", "Buy now", "Buy it now",
        "Proceed to pay", "Pay now", "Confirm and pay", "Complete your purchase",
        "Book now", "Subscribe", "Delete my account", "Permanently delete",
        "Start your free trial", "Post comment", "Confirm your booking",
    ]
    must_not = [
        "Add to cart", "Search", "Next page", "Sign in", "View details",
        "Compare prices", "Read more", "Continue", "Proceed to checkout",
        "Apply coupon", "Save for later", "Your orders", "Post office",
    ]
    for label in must_confirm:
        assert is_sensitive(label), f"{label!r} should require confirmation"
    for label in must_not:
        assert not is_sensitive(label), f"{label!r} should NOT require confirmation"

    # With names available, a sensitive click is flagged and carries the label
    # the client re-checks after the user answers.
    refs = {
        "e1": {"name": "Place your order", "role": "button"},
        "e2": {"name": "Add to cart", "role": "button"},
        "e3": {"name": "Search", "role": "input:search"},
    }

    # `type` on a button is coerced to a click rather than refused -- see the
    # note in validate(). The coercion must NOT bypass the money gate.
    coerced = validate({"action": "type", "ref": "e1", "text": "Place your order"}, refs)
    assert coerced.action == "click", "type on a button should become a click"
    assert coerced.needs_confirmation, "a coerced click must still be gated"
    assert coerced.warnings, "a coercion must be surfaced, not silent"
    assert validate({"action": "type", "ref": "e3", "text": "shoes"}, refs).action == "type"
    hot = validate({"action": "click", "ref": "e1"}, refs)
    assert hot.needs_confirmation and hot.target_label == "Place your order", hot
    assert hot.message_en, "a confirmation must explain what it is about to press"

    cool = validate({"action": "click", "ref": "e2"}, refs)
    assert not cool.needs_confirmation, "adding to a cart should not need a yes"
    assert cool.target_label == "Add to cart"

    # Terminal set: these hand control back to the user rather than looping.
    for action, payload in (
        ("ask", {"action": "ask", "message": "which size?"}),
        ("done", {"action": "done", "message": "found it"}),
        ("translate_page", {"action": "translate_page"}),
    ):
        assert validate(payload, refs).terminal, f"{action} should end the run"
    assert not validate({"action": "click", "ref": "e2"}, refs).terminal

    return f"{len(must_confirm)} gated, {len(must_not)} allowed through, terminal set correct"


def _identifier_handling() -> str:
    """The model must never produce an Aadhaar number, a captcha or an OTP.

    This is the privacy property of the Aadhaar flow, and it is structural
    rather than prompted: a `type` into a field the service recognises as an
    identifier is converted into an `ask`, so the value is collected by the
    panel and typed straight into the page. If this check ever fails, a
    hallucinated twelve-digit number can be submitted to UIDAI.
    """
    from . import tasks
    from .agent import redact, validate

    refs = {
        "e1": {"name": "Aadhaar Number", "role": "input:text"},
        "e2": {"name": "Enter Captcha", "role": "input:text"},
        "e3": {"name": "Enter OTP", "role": "input:text"},
        "e4": {"name": "Search", "role": "input:search"},
        "e5": {"name": "Type a message", "role": "textbox"},
    }
    secret = validate({"action": "type", "ref": "e1", "text": "123412341234"}, refs)
    assert secret.action == "ask" and secret.needs == "secret", secret
    assert "123412341234" not in secret.message_en, "the number leaked into the message"

    for ref in ("e2", "e3"):
        human = validate({"action": "type", "ref": ref, "text": "1234"}, refs)
        assert human.action == "ask" and human.needs == "human", (ref, human)

    # An ordinary search box is untouched, or the agent could never type.
    assert validate({"action": "type", "ref": "e4", "text": "shoes"}, refs).action == "type"

    # Enter in a message box IS sending, so it is confirmed and quotes the text.
    sending = validate(
        {"action": "type", "ref": "e5", "text": "How is it going?", "submit": True}, refs
    )
    assert sending.needs_confirmation, "sending a message must be confirmed"
    assert "How is it going?" in sending.message_en, "confirm without showing the text"
    assert not validate(
        {"action": "type", "ref": "e5", "text": "draft", "submit": False}, refs
    ).needs_confirmation, "typing a draft is not sending"

    assert redact("aadhaar 1234 5678 9012") == "aadhaar [redacted-12-digit]"
    assert redact("order 42 arrived") == "order 42 arrived", "over-redacting ordinary numbers"

    # Recipes, and the host allow-list that stops an Aadhaar number being
    # typed into a lookalike domain.
    aadhaar = tasks.match("download my aadhaar card")
    assert aadhaar and "Aadhaar" in aadhaar.name, aadhaar
    assert tasks.match("message ramesh on whatsapp"), "whatsapp recipe not matched"
    assert tasks.match("what is the weather today") is None, "matched an ordinary goal"
    assert tasks.host_allowed(aadhaar, "https://myaadhaar.uidai.gov.in/x")
    for phish in ("https://uidai.gov.in.phish.example/z", "https://evil.com/uidai.gov.in"):
        assert not tasks.host_allowed(aadhaar, phish), f"allow-list let through {phish}"

    return (
        f"{len(tasks.TASKS)} recipes, identifiers withheld from the model, "
        "captcha/OTP handed to the user, send confirmed with the text shown"
    )


def _extension_manifest() -> str:
    """The Chrome extension's manifest, and that every file it names exists.

    Chrome reports a missing file as a silent no-op or an unhelpful load
    error, and an unpacked extension is only loaded by hand -- so a typo here
    is discovered in front of an audience rather than in CI. Cheap to check.
    """
    import json

    from .config import REPO_ROOT

    root = REPO_ROOT / "apps" / "extension"
    if not root.is_dir():
        return "no apps/extension directory; skipped"

    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3, "must be MV3"

    referenced = [
        manifest["background"]["service_worker"],
        manifest["side_panel"]["default_path"],
        *manifest["icons"].values(),
        *manifest["action"]["default_icon"].values(),
    ]
    # The content scripts are injected programmatically rather than declared,
    # so the manifest does not name them and this has to.
    referenced += ["content/translate.js", "content/agent.js", "lib/api.js",
                   "lib/tabs.js", "lib/run.js", "sidepanel/panel.js",
                   "sidepanel/panel.css", "permission.html", "permission.js"]
    missing = [path for path in referenced if not (root / path).is_file()]
    assert not missing, f"manifest references missing files: {missing}"

    # The service only allows chrome-extension:// through CORS because of the
    # widening in main.py; if that is ever reverted, every request the
    # extension makes fails with a bare "Failed to fetch".
    from .main import app

    cors = [m for m in app.user_middleware if "CORS" in str(m)]
    assert cors, "CORS middleware is not installed"
    assert "chrome-extension" in str(cors[0].kwargs.get("allow_origin_regex", "")), (
        "CORS does not allow chrome-extension:// origins; the extension cannot "
        "reach this service"
    )
    return f"MV3, {len(referenced)} referenced files present, CORS allows the extension"


def main() -> int:
    print("Starling smoke check (no model weights are loaded)\n")
    check("starling imports", _imports)
    check("ffmpeg 16 kHz mono conversion", _ffmpeg_roundtrip)
    check("language config coherent", _language_config)
    check("configured codes exist in libraries", _codes_exist_in_libraries)
    check("model APIs match our call sites", _model_apis_present)
    check("fastapi routes registered", _fastapi_app)
    check("batch translation protocol", _batch_protocol)
    check("page translation filters", _page_filters)
    check("agent action contract", _agent_contract)
    check("purchase confirmation gate", _confirmation_gate)
    check("identifiers and known tasks", _identifier_handling)
    check("chrome extension wiring", _extension_manifest)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All checks passed. Models will download on first real use.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
