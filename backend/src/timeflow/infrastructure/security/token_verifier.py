"""Stand-in access token verification, until the account module provides the real one."""

FAKE_ACCOUNT_ID = "acc_fake_001"
REJECTED_TOKENS = frozenset({"bad", "invalid", "expired"})


class FakeTokenVerifier:
    """Accept any non-empty token that is not explicitly marked as rejected."""

    def __init__(self, account_id: str = FAKE_ACCOUNT_ID) -> None:
        """Store the account id every accepted token resolves to."""
        self._account_id = account_id

    async def verify(self, access_token: str) -> str | None:
        """Return the stand-in account id, or None for an unusable token."""
        if not access_token or access_token in REJECTED_TOKENS:
            return None
        return self._account_id
