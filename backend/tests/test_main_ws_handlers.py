"""main.py 里两个 WS handler 工厂函数的单元测试:只做解析转发,没有判断逻辑。"""

import asyncio

from timeflow.main import build_refs_check_result_handler, build_schedule_delete_ack_handler


class _StubDispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    async def handle_refs_check_reply(self, schedule_id: str, calendar_exists: bool) -> None:
        self.calls.append((schedule_id, calendar_exists))


def test_refs_check_result_forwards_calendar_exists_true() -> None:
    """`system_schedule_exists=True` 原样转发给 dispatcher。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handler = build_refs_check_result_handler(dispatcher)

        await handler(
            {
                "type": "system.refs.check.result",
                "schedule_id": "schedule_1",
                "ok": True,
                "system_schedule_exists": True,
            },
            "device_1",
        )

        assert dispatcher.calls == [("schedule_1", True)]

    asyncio.run(scenario())


def test_refs_check_result_forwards_calendar_exists_false() -> None:
    """`system_schedule_exists=False` 原样转发给 dispatcher。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handler = build_refs_check_result_handler(dispatcher)

        await handler(
            {
                "type": "system.refs.check.result",
                "schedule_id": "schedule_1",
                "ok": True,
                "system_schedule_exists": False,
            },
            "device_1",
        )

        assert dispatcher.calls == [("schedule_1", False)]

    asyncio.run(scenario())


def test_refs_check_result_ok_false_defaults_to_calendar_exists() -> None:
    """`ok=False`(客户端查询失败)按"日历还在"处理,不能把 None 传给业务函数。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handler = build_refs_check_result_handler(dispatcher)

        await handler(
            {
                "type": "system.refs.check.result",
                "schedule_id": "schedule_1",
                "ok": False,
                "error": {"code": "SYSTEM_REF_CHECK_FAILED", "message": "查询失败"},
            },
            "device_1",
        )

        assert dispatcher.calls == [("schedule_1", True)]

    asyncio.run(scenario())


def test_refs_check_result_missing_exists_field_defaults_to_calendar_exists() -> None:
    """`ok=True` 但 `system_schedule_exists` 缺失(None)时同样按"日历还在"处理。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handler = build_refs_check_result_handler(dispatcher)

        await handler(
            {"type": "system.refs.check.result", "schedule_id": "schedule_1", "ok": True},
            "device_1",
        )

        assert dispatcher.calls == [("schedule_1", True)]

    asyncio.run(scenario())


def test_schedule_delete_ack_success_clears_ref() -> None:
    """`ok=True` 时调用清空引用的回调。"""

    async def scenario() -> None:
        cleared: list[str] = []
        handler = build_schedule_delete_ack_handler(cleared.append)

        await handler(
            {
                "type": "system.schedule.delete.ack",
                "schedule_id": "schedule_1",
                "ok": True,
                "system_schedule_ref_id": "system_schedule_1",
            },
            "device_1",
        )

        assert cleared == ["schedule_1"]

    asyncio.run(scenario())


def test_schedule_delete_ack_failure_does_not_clear_ref() -> None:
    """`ok=False` 时不调用清空引用的回调。"""

    async def scenario() -> None:
        cleared: list[str] = []
        handler = build_schedule_delete_ack_handler(cleared.append)

        await handler(
            {
                "type": "system.schedule.delete.ack",
                "schedule_id": "schedule_1",
                "ok": False,
                "system_schedule_ref_id": "system_schedule_1",
                "error": {"code": "SYSTEM_SCHEDULE_DELETE_FAILED", "message": "删除失败"},
            },
            "device_1",
        )

        assert cleared == []

    asyncio.run(scenario())
