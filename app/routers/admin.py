from fastapi import APIRouter, Depends

from app import repositories
from app.auth import require_basic_auth
from app.schemas import ErrorResponse, GenerateApiKeyResponse

router = APIRouter(prefix="/api/v1", tags=["Admin"])


@router.get(
    "/auth",
    response_model=GenerateApiKeyResponse,
    responses={500: {"model": ErrorResponse}},
)
async def generate_api_key(_: str = Depends(require_basic_auth)):
    new_key = repositories.create_api_key()
    return GenerateApiKeyResponse(apiKey=new_key)
