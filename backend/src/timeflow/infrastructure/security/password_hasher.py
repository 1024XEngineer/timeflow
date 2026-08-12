"""使用 Argon2id 安全哈希和验证密码。"""

from argon2.exceptions import HashingError, UnsupportedParametersError
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError


class Argon2PasswordHasher:
    """使用 pwdlib 推荐的 Argon2id 参数实现密码端口。"""

    def __init__(self) -> None:
        self._password_hash = PasswordHash.recommended()

    def hash(self, password: str) -> str:
        """返回使用随机盐生成的 Argon2id 哈希。"""
        try:
            return self._password_hash.hash(password)
        except (HashingError, UnsupportedParametersError):
            raise RuntimeError("Password hashing failed") from None

    def verify(self, password: str, password_hash: str) -> bool:
        """验证密码，无法识别的哈希统一视为不匹配。"""
        try:
            return self._password_hash.verify(password, password_hash)
        except (UnknownHashError, UnsupportedParametersError):
            return False


__all__ = ["Argon2PasswordHasher"]
