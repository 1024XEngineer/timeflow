"""Access token verification.

Real JWT verification belongs to the account module and is not built yet, so this stand-in
accepts any non-empty token. It satisfies the transport's verifier port structurally and
deliberately does not import the gateway, keeping the dependency direction inward.
"""

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
