"""Session handshake messages: hello and ready."""

from typing import Literal

from pydantic import BaseModel


class SessionHelloPayload(BaseModel):
    """Credentials and client metadata sent as the first frame."""

    access_token: str
    device_id: str
    app_version: str | None = None
    timezone: str | None = None
    latitude: float | None = None
    longitude: float | None = None


class SessionHello(BaseModel):
    """Client request that opens an authenticated session."""

    type: Literal["session.hello"]
    request_id: str | None = None
    payload: SessionHelloPayload


class SessionReadyPayload(BaseModel):
    """Identifiers assigned to an accepted session."""

    session_id: str
    server_time: str


class SessionReady(BaseModel):
    """Server acknowledgement of a successful handshake."""

    type: Literal["session.ready"] = "session.ready"
    request_id: str | None = None
    ok: Literal[True] = True
    payload: SessionReadyPayload
