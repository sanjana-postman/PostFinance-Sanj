import threading
import time

from fastapi import Request
from fastapi.responses import JSONResponse

from app.config import RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS


class RateLimiter:
    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window_seconds = window_seconds
        self._buckets: dict[str, tuple[int, int]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, reset_epoch); increments count if allowed."""
        now = int(time.time())
        with self._lock:
            window_start, count = self._buckets.get(key, (now, 0))
            if now - window_start >= self.window_seconds:
                window_start, count = now, 0
            reset_epoch = window_start + self.window_seconds
            if count >= self.limit:
                self._buckets[key] = (window_start, count)
                return False, 0, reset_epoch
            count += 1
            self._buckets[key] = (window_start, count)
            return True, self.limit - count, reset_epoch


rate_limiter = RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS)


async def rate_limit_middleware(request: Request, call_next):
    api_key = request.headers.get("x-api-key", "anonymous")
    allowed, remaining, reset_epoch = rate_limiter.check(api_key)
    if not allowed:
        response = JSONResponse(
            status_code=429,
            content={
                "error": {
                    "name": "rateLimitExceeded",
                    "message": f"Too many requests. Maximum {RATE_LIMIT_MAX_REQUESTS} requests per minute allowed.",
                }
            },
        )
    else:
        response = await call_next(request)
    response.headers["X-RateLimit-Limit"] = str(RATE_LIMIT_MAX_REQUESTS)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    response.headers["X-RateLimit-Reset"] = str(reset_epoch)
    return response
