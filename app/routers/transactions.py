from fastapi import APIRouter, Depends, Header, Response

from app import repositories
from app.auth import require_api_key
from app.errors import InstanceNotFoundError, ValidationError
from app.schemas import (
    CreateTransactionRequest,
    CreateTransactionResponse,
    ErrorResponse,
    GetTransactionResponse,
    Transaction,
    TransactionIdOnly,
    TransactionListResponse,
)
from main import HAS_V1_5_FEATURES

router = APIRouter(prefix="/api/v1/transactions", tags=["Transactions"])


@router.get(
    "",
    response_model=TransactionListResponse,
    responses={401: {"model": ErrorResponse}, 429: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def list_transactions(
    accountId: str,
    _: str = Depends(require_api_key),
):
    rows = repositories.list_transactions(accountId)
    return TransactionListResponse(transactions=[Transaction(**row) for row in rows])


@router.post(
    "",
    response_model=CreateTransactionResponse,
    status_code=201,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def create_transaction(
    body: CreateTransactionRequest,
    response: Response,
    idempotency_key: str | None = Header(default=None),
    _: str = Depends(require_api_key),
):
    if HAS_V1_5_FEATURES:
        if not idempotency_key:
            raise ValidationError("Idempotency-Key header is required.")
        cached = repositories.get_idempotent_response("createTransaction", idempotency_key)
        if cached is not None:
            response.headers["Idempotent-Replayed"] = "true"
            return cached["body"]

    row = repositories.create_transaction(
        body.accountId, body.amount, body.currency.value, body.transactionType.value
    )
    result = CreateTransactionResponse(
        transaction=TransactionIdOnly(transactionId=row["transactionId"])
    )

    if HAS_V1_5_FEATURES:
        repositories.save_idempotent_response(
            "createTransaction", idempotency_key, 201, result.model_dump(mode="json")
        )
        response.headers["Idempotent-Replayed"] = "false"

    return result


@router.get(
    "/{transactionId}",
    response_model=GetTransactionResponse,
    responses={
        401: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def get_transaction(transactionId: str, _: str = Depends(require_api_key)):
    row = repositories.get_transaction(transactionId)
    if row is None:
        raise InstanceNotFoundError("The specified transaction does not exist.")
    return GetTransactionResponse(transaction=Transaction(**row))
