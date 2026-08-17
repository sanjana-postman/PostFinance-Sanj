import os

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "1234")
DB_PATH = os.environ.get("DB_PATH", "data/postfinanceco.db")
RATE_LIMIT_MAX_REQUESTS = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS", "300"))
RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))
