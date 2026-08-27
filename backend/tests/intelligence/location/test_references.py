"""Personal/relative place reference detection tests."""

import pytest

from timeflow.intelligence.location.references import is_personal_place_reference


@pytest.mark.parametrize(
    "value",
    [
        "家",
        "我家",
        "到家",
        "回家",
        "老家",
        "公司",
        "回公司",
        "单位",
        "学校",
        "宿舍",
        "食堂",
        "附近",
        "这里",
        "那边",
        "老地方",
    ],
)
def test_detects_personal_place_references(value: str) -> None:
    assert is_personal_place_reference(value) is True


@pytest.mark.parametrize(
    "value",
    ["静安寺", "张江路地铁站", "万达广场", "家乐福", "虹桥", "上海中心", "203会议室"],
)
def test_accepts_concrete_place_names(value: str) -> None:
    assert is_personal_place_reference(value) is False


@pytest.mark.parametrize("value", ["家 ", " 公司", " 到家  "])
def test_strips_surrounding_whitespace(value: str) -> None:
    assert is_personal_place_reference(value) is True


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_string_is_not_a_reference(value: str) -> None:
    assert is_personal_place_reference(value) is False
