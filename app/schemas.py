from datetime import date
from enum import Enum

from pydantic import BaseModel, Field


class Currency(str, Enum):
    POST_COINS = "POST_COINS"
    POST_GOLD = "POST_GOLD"
    POST_BUCKS = "POST_BUCKS"


class TransactionType(str, Enum):
    WITHDRAWAL = "WITHDRAWAL"
    DEPOSIT = "DEPOSIT"


class Account(BaseModel):
    accountId: str
    owner: str = Field(min_length=1)
    createdAt: date
    balance: float = Field(ge=0)
    currency: Currency


class CreateAccountRequest(BaseModel):
    owner: str = Field(min_length=1)
    balance: float = Field(default=0, ge=0)
    currency: Currency


class Transaction(BaseModel):
    transactionId: str
    createdAt: date
    amount: float = Field(gt=0)
    currency: Currency
    accountId: str
    transactionType: TransactionType


class CreateTransactionRequest(BaseModel):
    accountId: str
    amount: float = Field(gt=0)
    currency: Currency
    transactionType: TransactionType


class ErrorBody(BaseModel):
    name: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody


class AccountListResponse(BaseModel):
    accounts: list[Account]


class AccountIdOnly(BaseModel):
    accountId: str


class CreateAccountResponse(BaseModel):
    account: AccountIdOnly


class UpdateAccountRequest(BaseModel):
    owner: str = Field(min_length=1)


class UpdateAccountResponse(BaseModel):
    account: Account


class TransactionListResponse(BaseModel):
    transactions: list[Transaction]


class TransactionIdOnly(BaseModel):
    transactionId: str


class CreateTransactionResponse(BaseModel):
    transaction: TransactionIdOnly


class GetTransactionResponse(BaseModel):
    transaction: Transaction


class GenerateApiKeyResponse(BaseModel):
    apiKey: str
