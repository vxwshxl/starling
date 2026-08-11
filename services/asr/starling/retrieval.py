"""Lexical retrieval over the knowledge base.

BM25, implemented here in about sixty lines rather than pulled in as a
dependency. The corpus is a couple of dozen short passages, so an embedding
model would cost a download and hundreds of megabytes of resident memory to
rank twenty items -- memory this machine does not have spare, for a ranking
problem this small.

The trade-off is real and worth stating: lexical matching only finds passages
that share words with the query. That is why `Passage.tags` exists, carrying
the colloquial words a person actually says ("loose motion", "jor") alongside
the clinical ones. A question phrased with none of the corpus vocabulary will
retrieve nothing, and `chat.py` treats that as "not covered" rather than
guessing.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .knowledge import PASSAGES, Passage

# BM25 constants. k1 damps the effect of repeating a term, b controls how much
# a passage is penalised for being long. These are the standard defaults and
# there is not enough corpus here to justify tuning them.
_K1 = 1.5
_B = 0.75

#: Keep only hits scoring at least this fraction of the best one. Guards
#: against weak co-occurrence matches being presented as sources.
_RELATIVE_CUTOFF = 0.5

_WORD = re.compile(r"\w+", re.UNICODE)

#: Words carrying no discriminating power in questions of this shape. Kept
#: deliberately short: over-trimming hurts more than it helps on a small corpus.
_STOP = frozenset(
    """
    a an the is are was were be been being do does did doing have has had
    i me my we our you your he she it they them this that these those
    of in on at to for with from by about as and or but if then than so
    what when where which who whom how why can could should would will shall
    please tell me know want need help
    """.split()
)


def _tokenise(text: str) -> list[str]:
    return [t for t in (m.group(0).lower() for m in _WORD.finditer(text)) if t not in _STOP]


def _document_terms(p: Passage) -> list[str]:
    # Title and tags are repeated so a match there outweighs one buried in the
    # body -- a cheap stand-in for field weighting.
    return _tokenise(f"{p.title} {p.title} {' '.join(p.tags)} {' '.join(p.tags)} {p.text}")


@dataclass(frozen=True)
class Hit:
    passage: Passage
    score: float


class _Index:
    """Built once at import. The corpus is static, so there is nothing to invalidate."""

    def __init__(self, passages: list[Passage]) -> None:
        self.passages = passages
        self.docs = [_document_terms(p) for p in passages]
        self.lengths = [len(d) for d in self.docs]
        self.avg_length = (sum(self.lengths) / len(self.docs)) if self.docs else 0.0

        self.freqs: list[dict[str, int]] = []
        doc_count: dict[str, int] = {}
        for doc in self.docs:
            tf: dict[str, int] = {}
            for term in doc:
                tf[term] = tf.get(term, 0) + 1
            self.freqs.append(tf)
            for term in tf:
                doc_count[term] = doc_count.get(term, 0) + 1

        n = len(self.docs)
        self.idf = {
            term: math.log(1 + (n - df + 0.5) / (df + 0.5))
            for term, df in doc_count.items()
        }

    def search(self, query: str, limit: int, min_score: float) -> list[Hit]:
        terms = _tokenise(query)
        if not terms:
            return []

        scored: list[Hit] = []
        for i, passage in enumerate(self.passages):
            tf, length = self.freqs[i], self.lengths[i]
            score = 0.0
            for term in terms:
                f = tf.get(term)
                if not f:
                    continue
                norm = 1 - _B + _B * (length / self.avg_length if self.avg_length else 1)
                score += self.idf.get(term, 0.0) * (f * (_K1 + 1)) / (f + _K1 * norm)
            if score > 0:
                scored.append(Hit(passage=passage, score=score))

        scored.sort(key=lambda h: h.score, reverse=True)
        if not scored or scored[0].score < min_score:
            return []

        # Cut off relative to the best hit, not just at an absolute floor. A
        # question about diarrhoea was matching the schooling passage on the
        # shared word "child" and scoring a fifth of the top hit -- harmless to
        # the answer, since the model ignored it, but these are shown to the
        # user as sources and a wrong citation undermines the whole point.
        floor = max(min_score, scored[0].score * _RELATIVE_CUTOFF)
        return [h for h in scored[:limit] if h.score >= floor]


_index = _Index(PASSAGES)


def search(query: str, limit: int = 3, min_score: float = 1.0) -> list[Hit]:
    """Best passages for a query, empty when nothing matches well enough.

    An empty result is a real answer -- it means the knowledge base does not
    cover this -- and callers must not treat it as a reason to answer anyway.
    """
    return _index.search(query, limit=limit, min_score=min_score)
