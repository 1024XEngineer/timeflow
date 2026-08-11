"""Static contracts for the forward-only Alembic revision chain."""

import ast
import subprocess
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

from alembic import command
from timeflow.infrastructure.settings import get_settings

BACKEND_ROOT = Path(__file__).parents[1]
VERSIONS_ROOT = BACKEND_ROOT / "alembic" / "versions"
EXPECTED_FILES = {
    "20260810_0003_create_accounts_table.py": "accounts",
    "20260810_0004_create_schedules_table.py": "schedules",
    "20260810_0005_create_schedule_occurrence_overrides_table.py": (
        "schedule_occurrence_overrides"
    ),
}
IMMUTABLE_BLOBS = {
    "20260728_0001_initial_structure.py": "0591ce3beece9ba78a3f4c3643e505654471db27",
    "20260729_0002_create_schedules_table.py": "f58e24d81fc24c43815d65494a39a83789ce781f",
}


def _upgrade_create_table_literals(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    upgrade = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "upgrade"
    )
    names: list[str] = []
    for node in ast.walk(upgrade):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr != "create_table" or not node.args:
            continue
        first_arg = node.args[0]
        if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str):
            names.append(first_arg.value)
    return names


def test_migration_chain_has_expected_single_head() -> None:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_heads() == ["20260810_0005"]
    revisions = {revision.revision: revision.down_revision for revision in scripts.walk_revisions()}
    assert revisions == {
        "20260810_0005": "20260810_0004",
        "20260810_0004": "20260810_0003",
        "20260810_0003": "20260729_0002",
        "20260729_0002": "20260728_0001",
        "20260728_0001": None,
    }


def test_mainline_revisions_remain_immutable() -> None:
    for filename, expected_blob in IMMUTABLE_BLOBS.items():
        relative_path = Path("backend/alembic/versions") / filename
        result = subprocess.run(
            [
                "git",
                "hash-object",
                f"--path={relative_path.as_posix()}",
                "--",
                str(relative_path),
            ],
            cwd=BACKEND_ROOT.parent,
            check=True,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == expected_blob


def test_each_new_revision_creates_exactly_one_documented_table() -> None:
    for filename, table_name in EXPECTED_FILES.items():
        assert _upgrade_create_table_literals(VERSIONS_ROOT / filename) == [table_name]


def test_schedules_revision_guards_legacy_data_before_replacement() -> None:
    source = (VERSIONS_ROOT / "20260810_0004_create_schedules_table.py").read_text(encoding="utf-8")
    assert "Legacy schedules table contains data" in source
    assert source.index("Legacy schedules table contains data") < source.index(
        'op.drop_table("schedules")'
    )


def test_schedules_revision_rejects_offline_mode_deliberately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "TIMEFLOW_DATABASE_URL",
        "postgresql+psycopg://postgres:postgres@localhost:5432/timeflow_test",
    )
    get_settings.cache_clear()
    config = Config(str(BACKEND_ROOT / "alembic.ini"))

    try:
        with pytest.raises(RuntimeError, match="requires online mode"):
            command.upgrade(config, "head", sql=True)
    finally:
        get_settings.cache_clear()


def test_occurrence_override_revision_avoids_redundant_schedule_id_index() -> None:
    source = (
        VERSIONS_ROOT / "20260810_0005_create_schedule_occurrence_overrides_table.py"
    ).read_text(encoding="utf-8")
    assert "ix_schedule_occurrence_overrides_schedule_id" not in source
