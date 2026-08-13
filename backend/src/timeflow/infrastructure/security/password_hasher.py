"""使用 Argon2id 哈希密码，且不暴露底层实现错误。"""

from pwdlib import PasswordHash


class Argon2PasswordHasher:
    """使用 pwdlib 推荐的 Argon2id 参数哈希并验证密码。"""

    def __init__(self) -> None:
        self._password_hash = PasswordHash.recommended()

    def hash(self, password: str) -> str:
        """返回已验证密码的带盐 Argon2id 哈希。"""
        try:
            return self._password_hash.hash(password)
        except Exception:
            raise RuntimeError("Password hashing failed") from None

    def verify(self, password: str, password_hash: str) -> bool:
        """密码不匹配、哈希格式错误或算法不受支持时返回 False。"""
        try:
            return self._password_hash.verify(password, password_hash)
        except Exception:
            return False
