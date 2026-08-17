from fastapi import Depends, Header
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app import repositories
from app.config import ADMIN_API_KEY, ADMIN_USERNAME
from app.errors import AuthenticationError

_basic = HTTPBasic(auto_error=False)


async def require_api_key(x_api_key: str | None = Header(default=None)) -> str:
    if not x_api_key:
        raise AuthenticationError(
            "API key is required. Please provide an API key in the x-api-key header."
        )
    if repositories.api_key_exists(x_api_key):
        return x_api_key
    raise AuthenticationError(
        "API key is required. Please provide an API key in the x-api-key header."
    )


async def require_basic_auth(
    credentials: HTTPBasicCredentials | None = Depends(_basic),
) -> str:
    if (
        credentials is None
        or credentials.username != ADMIN_USERNAME
        or credentials.password != ADMIN_API_KEY
    ):
        raise AuthenticationError("Valid admin credentials are required.")
    return credentials.username
