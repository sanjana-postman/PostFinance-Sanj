import os
import sqlite3

from app.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    account_id  TEXT PRIMARY KEY,
    owner       TEXT NOT NULL CHECK (length(owner) >= 1),
    created_at  TEXT NOT NULL,
    balance     REAL NOT NULL CHECK (balance >= 0),
    currency    TEXT NOT NULL CHECK (currency IN ('POST_COINS','POST_GOLD','POST_BUCKS'))
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id    TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    amount            REAL NOT NULL CHECK (amount > 0),
    currency          TEXT NOT NULL CHECK (currency IN ('POST_COINS','POST_GOLD','POST_BUCKS')),
    account_id        TEXT NOT NULL,
    transaction_type  TEXT NOT NULL CHECK (transaction_type IN ('WITHDRAWAL','DEPOSIT'))
);

CREATE TABLE IF NOT EXISTS api_keys (
    api_key     TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key  TEXT NOT NULL,
    endpoint         TEXT NOT NULL,
    status_code      INTEGER NOT NULL,
    response_body    TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (endpoint, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
"""


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
