"""Incremental speech text segmenter tests."""

import pytest

from timeflow.intelligence.speech.segmenter import TextSegmenter


def test_segments_complete_sentences_across_deltas() -> None:
    segmenter = TextSegmenter()

    assert segmenter.push("已为你创建") == ()
    assert segmenter.push("明天下午三点的日程。下一句") == ("已为你创建明天下午三点的日程。",)
    assert segmenter.flush() == "下一句"
    assert segmenter.flush() is None


def test_segments_multiple_chinese_and_english_sentences() -> None:
    segmenter = TextSegmenter()

    assert segmenter.push("第一句！第二句？Third sentence. Fourth;") == (
        "第一句！",
        "第二句？",
        "Third sentence.",
        "Fourth;",
    )


def test_newline_is_a_boundary_and_whitespace_is_trimmed() -> None:
    segmenter = TextSegmenter()

    assert segmenter.push("  第一行\n  第二行") == ("第一行",)
    assert segmenter.flush() == "第二行"


def test_long_text_prefers_weak_boundary() -> None:
    segmenter = TextSegmenter(target_length=5, max_length=12)

    assert segmenter.push("一二三四五，六七八九十十一十二") == ("一二三四五，",)
    assert segmenter.flush() == "六七八九十十一十二"


def test_long_text_hard_splits_and_never_exceeds_maximum() -> None:
    segmenter = TextSegmenter(target_length=4, max_length=8)

    emitted = segmenter.push("一二三四五六七八九十一二三四五六七")
    remaining = segmenter.flush()

    assert emitted == ("一二三四五六七八", "九十一二三四五六")
    assert remaining == "七"
    assert all(len(segment) <= 8 for segment in (*emitted, remaining))


def test_empty_input_does_not_create_segments() -> None:
    segmenter = TextSegmenter()

    assert segmenter.push("") == ()
    assert segmenter.push("   ") == ()
    assert segmenter.flush() is None


@pytest.mark.parametrize(
    ("target", "maximum", "message"),
    [(0, 10, "positive"), (10, 5, "at least")],
)
def test_invalid_lengths_are_rejected(target: int, maximum: int, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        TextSegmenter(target_length=target, max_length=maximum)
