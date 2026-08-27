"""Identify universal personal/relative place references that POI search cannot resolve.

「家」「公司」「学校」「附近」这类词指代的是用户自己的、相对的场所，不是一个能用 POI
检索命中的具体地点——拿它们去 location_search 会模糊匹配成某个同名 POI，直接建日程则会
得到错误坐标。它们不能搜索，也不能直接建成地点日程。

这不是穷举所有模糊表达的「黑名单」：灵活识别仍交给 LLM 提示词。这里只放那一小撮
「任何 POI 检索都天生解不出来的」相对/个人指代，作为确定性的最后兜底，防止模型忽略
提示词、反复拿这类词直接创建出错误地点。要补充新词只需在集合里加一行。
"""

from __future__ import annotations

# 常见的前缀（物主/方向动词），剥离后剩核心指代词：「到家」→「家」、「回公司」→「公司」。
_LEADING_PREFIXES = frozenset({"我", "到", "回", "去"})

_CORE_REFERENCES = frozenset(
    {
        "家",
        "老家",
        "家里",
        "公司",
        "单位",
        "上班的地方",
        "工作的地方",
        "学校",
        "上学的地方",
        "宿舍",
        "食堂",
        "附近",
        "周边",
        "这里",
        "这儿",
        "这边",
        "那里",
        "那儿",
        "那边",
        "老地方",
        "老位置",
    }
)


def is_personal_place_reference(value: str) -> bool:
    """Return True when `value` names only a personal/relative place, not a POI."""
    normalized = value.strip()
    while len(normalized) > 1 and normalized[0] in _LEADING_PREFIXES:
        normalized = normalized[1:]
    return normalized in _CORE_REFERENCES


__all__ = ["is_personal_place_reference"]
