from fastapi import APIRouter, Depends, Header, Response

from app import repositories
from app.auth import require_api_key
from app.errors import InstanceNotFoundError, ValidationError
from app.schemas import (
    Account,
    AccountIdOnly,
    AccountListResponse,
    CreateAccountRequest,
    CreateAccountResponse,
    ErrorResponse,
    UpdateAccountRequest,
    UpdateAccountResponse,
)
from main import HAS_V1_5_FEATURES, HAS_V2_FEATURES

router = APIRouter(prefix="/api/v1/accounts", tags=["Accounts"])


@router.get(
    "",
    response_model=AccountListResponse,
    responses={401: {"model": ErrorResponse}, 429: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def list_accounts(
    owner: str | None = None,
    _: str = Depends(require_api_key),
):
    rows = repositories.list_accounts(owner)
    return AccountListResponse(accounts=[Account(**row) for row in rows])


@router.post(
    "",
    response_model=CreateAccountResponse,
    status_code=201,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def create_account(
    body: CreateAccountRequest,
    response: Response,
    idempotency_key: str | None = Header(default=None),
    _: str = Depends(require_api_key),
):
    if HAS_V1_5_FEATURES:
        if not idempotency_key:
            raise ValidationError("Idempotency-Key header is required.")
        cached = repositories.get_idempotent_response("createAccount", idempotency_key)
        if cached is not None:
            response.headers["Idempotent-Replayed"] = "true"
            return cached["body"]

    row = repositories.create_account(body.owner, body.balance, body.currency.value)
    result = CreateAccountResponse(account=AccountIdOnly(accountId=row["accountId"]))

    if HAS_V1_5_FEATURES:
        repositories.save_idempotent_response(
            "createAccount", idempotency_key, 201, result.model_dump(mode="json")
        )
        response.headers["Idempotent-Replayed"] = "false"

    return result


if HAS_V2_FEATURES:

    @router.patch(
        "/{accountId}",
        response_model=UpdateAccountResponse,
        responses={
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            429: {"model": ErrorResponse},
            500: {"model": ErrorResponse},
        },
    )
    async def update_account(
        accountId: str,
        body: UpdateAccountRequest,
        response: Response,
        idempotency_key: str | None = Header(default=None),
        _: str = Depends(require_api_key),
    ):
        if not idempotency_key:
            raise ValidationError("Idempotency-Key header is required.")
        cached = repositories.get_idempotent_response("updateAccount", idempotency_key)
        if cached is not None:
            response.headers["Idempotent-Replayed"] = "true"
            return cached["body"]

        row = repositories.update_account(accountId, body.owner)
        if row is None:
            raise InstanceNotFoundError("The specified account does not exist.")
        result = UpdateAccountResponse(account=Account(**row))

        repositories.save_idempotent_response(
            "updateAccount", idempotency_key, 200, result.model_dump(mode="json")
        )
        response.headers["Idempotent-Replayed"] = "false"
        return result
