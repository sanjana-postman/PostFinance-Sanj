class ApiError(Exception):
    status_code: int
    name: str

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class AuthenticationError(ApiError):
    status_code = 401
    name = "authenticationError"


class ValidationError(ApiError):
    status_code = 400
    name = "validationError"


class InstanceNotFoundError(ApiError):
    status_code = 404
    name = "instanceNotFoundError"


class InsufficientFundsError(ApiError):
    status_code = 403
    name = "txInsufficientFunds"


class RateLimitExceededError(ApiError):
    status_code = 429
    name = "rateLimitExceeded"


class ServerError(ApiError):
    status_code = 500
    name = "serverError"
