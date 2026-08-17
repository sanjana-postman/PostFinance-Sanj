from fastapi import APIRouter, Response

from main import HAS_V2_FEATURES

router = APIRouter(tags=["Admin"])

LLMS_TXT = """# PostFinanceCo API v1.5.0
Base URL: https://api.postfinanceco.example.com

Account and transaction management API.
Auth: x-api-key header (generate via GET /api/v1/auth with Basic Auth).
POST operations require Idempotency-Key header.
Rate limit: 300 req/min.

Endpoints:
  GET  /api/v1/auth                         - Generate API key
  POST /api/v1/accounts                     - Create account
  GET  /api/v1/accounts                     - List accounts
  POST /api/v1/transactions                 - Create transaction (DEPOSIT or WITHDRAWAL)
  GET  /api/v1/transactions                 - List transactions
  GET  /api/v1/transactions/{transactionId} - Get transaction
"""
if HAS_V2_FEATURES:
    LLMS_TXT += "  PATCH /api/v1/accounts/{accountId}        - Update account owner name\n"


@router.get("/.well-known/llms.txt")
async def get_llms_txt():
    return Response(content=LLMS_TXT, media_type="text/plain")
