"""Shared error shape for every outbound envelope."""

from pydantic import BaseModel


class ErrorDetail(BaseModel):
    """Error body carried by a failed envelope."""

    code: str
    message: str
    retryable: bool = False
