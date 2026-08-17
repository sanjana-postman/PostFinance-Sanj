import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Active API version for this instance. Edit the default below and save — `uv run fastapi dev
# main.py`'s reloader restarts the process automatically, so switching versions locally is a
# one-line edit. Deployed instances just bake in whatever default is here at image build time
# (same as any other code change); the API_VERSION env var override exists only as an escape
# hatch matching the reference project's own precedent — nothing in this platform's CDK/onboarding
# sets it.
#
# MUST stay above the `from app.routers import ...` line below: those router modules do
# `from main import HAS_V1_5_FEATURES, HAS_V2_FEATURES` at their own import time (needed to
# conditionally define routes, e.g. accounts.py's v2-only PATCH endpoint). That import triggers
# Python to hand back this partially-initialized `main` module rather than re-running it — which
# only has the right values if these names are already assigned by the time it happens.
API_VERSION = os.environ.get("API_VERSION", "v1")
if API_VERSION not in ("v1", "v1.5", "v2"):
    raise ValueError(f"Invalid API_VERSION '{API_VERSION}'; must be 'v1', 'v1.5', or 'v2'.")
HAS_V1_5_FEATURES = API_VERSION in ("v1.5", "v2")
HAS_V2_FEATURES = API_VERSION == "v2"

from app.db import init_db
from app.errors import ApiError
from app.ratelimit import rate_limit_middleware
from app.routers import accounts, admin, health, llms, transactions

# SE_NAME/URL_ENV come from the SeStack ConfigMap this pod's Deployment loads via envFrom —
# every SE's own instance of this app only ever serves under its own fixed prefix, since the
# shared ALB forwards the full unstripped `/<se>/<dev|prod>/...` path straight through with no
# rewrite layer. Locally (no ConfigMap present) these default to empty, so the app still runs
# unprefixed for local dev/tests.
SE_NAME = os.environ.get("SE_NAME", "")
URL_ENV = os.environ.get("URL_ENV", "")
ROUTE_PREFIX = f"/{SE_NAME}/{URL_ENV}" if SE_NAME and URL_ENV else ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="PostFinanceCo API", version="1.0.0", lifespan=lifespan)

app.middleware("http")(rate_limit_middleware)


@app.exception_handler(ApiError)
async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"name": exc.name, "message": exc.message}},
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"name": "validationError", "message": exc.errors()[0]["msg"]}},
    )


@app.exception_handler(Exception)
async def handle_unhandled(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {"name": "serverError", "message": "An unexpected error occurred"}},
    )


# /health stays unprefixed and un-mounted under ROUTE_PREFIX — k8s readiness/liveness probes
# and the ALB target-group health check all hit it directly, decoupled from the per-SE path
# scheme so Ingress/probe config never has to change if the prefix scheme ever does.
app.include_router(health.router)

app.include_router(admin.router, prefix=ROUTE_PREFIX)
app.include_router(accounts.router, prefix=ROUTE_PREFIX)
app.include_router(transactions.router, prefix=ROUTE_PREFIX)
if HAS_V1_5_FEATURES:
    app.include_router(llms.router, prefix=ROUTE_PREFIX)
