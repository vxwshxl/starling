"""Compatibility shims for third-party code written against transformers 4.x.

We run transformers 5.14, because OmniVoice needs it and OmniVoice is the one
model whose working configuration was hard-won. IndicTrans2's repos and
IndicTransToolkit both predate that and import symbols transformers has since
moved or deleted.

Downgrading transformers would fix them and risk breaking OmniVoice, so we
patch in the other direction instead. Every shim here is narrow, restores an
API that genuinely existed, and is only touched by export-time code paths that
inference never runs.

`apply()` is idempotent and must be called before importing IndicTransToolkit
or loading any IndicTrans2 repo with trust_remote_code=True.
"""

from __future__ import annotations

import logging
import sys
import types

logger = logging.getLogger("starling.compat")

_applied = False


def _shim_tokenization_utils() -> None:
    """`PreTrainedTokenizerBase` moved to transformers.tokenization_utils_base.

    IndicTransToolkit's collator still imports it from the old location, and
    the package __init__ imports the collator, so nothing in the toolkit is
    reachable without this.
    """
    from transformers.tokenization_utils_base import PreTrainedTokenizerBase

    name = "transformers.tokenization_utils"
    mod = sys.modules.get(name) or types.ModuleType(name)
    if not hasattr(mod, "PreTrainedTokenizerBase"):
        mod.PreTrainedTokenizerBase = PreTrainedTokenizerBase
    sys.modules[name] = mod


def _shim_onnx_export_config() -> None:
    """`transformers.onnx` was removed in transformers 5.

    IndicTrans2's `configuration_indictrans.py` imports OnnxConfig and
    compute_effective_axis_dimension at module scope purely to declare an ONNX
    *export* config class. We never export; we only need the import to resolve.

    It has to be registered as a package, not a plain module, or the
    `transformers.onnx.utils` import fails with "is not a package".
    """
    pkg_name = "transformers.onnx"
    utils_name = "transformers.onnx.utils"
    if pkg_name in sys.modules and utils_name in sys.modules:
        return

    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = []  # marks it as a package so submodule imports resolve

    class _ExportConfig:
        """Stand-in base class. Subclassed at import time, never instantiated."""

    def compute_effective_axis_dimension(
        dimension: int, fixed_dimension: int, num_token_to_add: int = 0
    ) -> int:
        # Verbatim behaviour of the transformers 4.x helper.
        if dimension <= 0:
            dimension = fixed_dimension
        dimension -= num_token_to_add
        return dimension

    utils = types.ModuleType(utils_name)
    utils.compute_effective_axis_dimension = compute_effective_axis_dimension

    pkg.OnnxConfig = _ExportConfig
    pkg.OnnxSeq2SeqConfigWithPast = _ExportConfig
    pkg.utils = utils

    sys.modules[pkg_name] = pkg
    sys.modules[utils_name] = utils


def apply() -> None:
    """Install every shim. Safe to call repeatedly."""
    global _applied
    if _applied:
        return
    _shim_tokenization_utils()
    _shim_onnx_export_config()
    _applied = True
    logger.debug("transformers 4.x compatibility shims applied")
