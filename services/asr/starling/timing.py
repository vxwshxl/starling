"""Wall-clock timing for pipeline stages.

INVARIANT: every pipeline stage logs its own duration. This module is the one
implementation of that, so no stage hand-rolls perf_counter arithmetic.

Usage:

    timings = Timings()
    with timings.stage("asr"):
        ...
    timings.as_dict()  # {"asr_ms": 812.4, "total_ms": 812.4}
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

logger = logging.getLogger("starling.timing")


@dataclass
class Timings:
    """Ordered record of how long each stage took, in milliseconds."""

    stages: dict[str, float] = field(default_factory=dict)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        start = time.perf_counter()
        try:
            yield
        finally:
            # Recorded even when the stage raises -- a failed stage's duration
            # is exactly the thing you want when debugging a timeout.
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            self.stages[name] = round(elapsed_ms, 1)
            logger.info("stage %-14s %8.1f ms", name, elapsed_ms)

    def as_dict(self) -> dict[str, float]:
        out = {f"{name}_ms": ms for name, ms in self.stages.items()}
        out["total_ms"] = round(sum(self.stages.values()), 1)
        return out

    def summary(self) -> str:
        """One-line human summary, for the lab UI."""
        parts = [f"{name} {ms:.0f}ms" for name, ms in self.stages.items()]
        total = sum(self.stages.values())
        return "  ·  ".join(parts) + f"  =  TOTAL {total:.0f}ms"
