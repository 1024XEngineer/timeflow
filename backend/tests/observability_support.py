"""Prometheus scrape helpers shared by observability tests."""

from prometheus_client import REGISTRY


def metric_value(name: str, labels: dict[str, str] | None = None) -> float:
    """Return the current sample value, treating a missing series as zero."""
    wanted = labels or {}
    for metric in REGISTRY.collect():
        for sample in metric.samples:
            if sample.name != name:
                continue
            if sample.labels == wanted:
                return float(sample.value)
    return 0.0
