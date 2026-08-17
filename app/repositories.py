import json
import uuid
from datetime import date, datetime, timezone

from app.db import get_connection
from app.errors import InstanceNotFoundError, InsufficientFundsError, ValidationError

ACCOUNT_COLUMNS = (
    "account_id AS accountId, owner, created_at AS createdAt, balance, currency"
)
TRANSACTION_COLUMNS = (
    "transaction_id AS transactionId, created_at AS createdAt, amount, currency, "
    "account_id AS accountId, transaction_type AS transactionType"
)


# --- api_keys ---


def api_key_exists(key: str) -> bool:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT 1 FROM api_keys WHERE api_key = ?", (key,)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def create_api_key() -> str:
    key = uuid.uuid4().hex
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO api_keys (api_key, created_at) VALUES (?, ?)",
            (key, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return key
    finally:
        conn.close()


# --- accounts ---


def create_account(owner: str, balance: float, currency: str) -> dict:
    account_id = uuid.uuid4().hex
    created_at = date.today().isoformat()
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO accounts (account_id, owner, created_at, balance, currency) "
            "VALUES (?, ?, ?, ?, ?)",
            (account_id, owner, created_at, balance, currency),
        )
        conn.commit()
        return {
            "accountId": account_id,
            "owner": owner,
            "createdAt": created_at,
            "balance": balance,
            "currency": currency,
        }
    finally:
        conn.close()


def get_account(account_id: str) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            f"SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE account_id = ?",
            (account_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_accounts(owner: str | None) -> list[dict]:
    query = f"SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE 1=1"
    params: list = []
    if owner is not None:
        query += " AND owner LIKE ? COLLATE NOCASE"
        params.append(f"%{owner}%")
    conn = get_connection()
    try:
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def update_account(account_id: str, owner: str) -> dict | None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE accounts SET owner = ? WHERE account_id = ?", (owner, account_id)
        )
        conn.commit()
    finally:
        conn.close()
    return get_account(account_id)


# --- transactions ---


def create_transaction(
    account_id: str, amount: float, currency: str, transaction_type: str
) -> dict:
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")

        account = conn.execute(
            "SELECT * FROM accounts WHERE account_id = ?", (account_id,)
        ).fetchone()
        if account is None:
            raise InstanceNotFoundError("The specified account does not exist.")
        if account["currency"] != currency:
            raise ValidationError(
                "Currency must match the currency of the account."
            )

        if transaction_type == "WITHDRAWAL":
            if account["balance"] < amount:
                raise InsufficientFundsError(
                    "Not enough funds in source account to complete transaction."
                )
            conn.execute(
                "UPDATE accounts SET balance = balance - ? WHERE account_id = ?",
                (amount, account_id),
            )
        else:
            conn.execute(
                "UPDATE accounts SET balance = balance + ? WHERE account_id = ?",
                (amount, account_id),
            )

        transaction_id = uuid.uuid4().hex
        created_at = date.today().isoformat()
        conn.execute(
            "INSERT INTO transactions "
            "(transaction_id, created_at, amount, currency, account_id, transaction_type) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (transaction_id, created_at, amount, currency, account_id, transaction_type),
        )

        conn.commit()
        return {
            "transactionId": transaction_id,
            "createdAt": created_at,
            "amount": amount,
            "currency": currency,
            "accountId": account_id,
            "transactionType": transaction_type,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_transaction(transaction_id: str) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            f"SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE transaction_id = ?",
            (transaction_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_transactions(account_id: str) -> list[dict]:
    query = f"SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE account_id = ?"
    params: list = [account_id]
    conn = get_connection()
    try:
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# --- idempotency ---


def get_idempotent_response(endpoint: str, idempotency_key: str) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT status_code AS statusCode, response_body AS responseBody "
            "FROM idempotency_keys WHERE endpoint = ? AND idempotency_key = ?",
            (endpoint, idempotency_key),
        ).fetchone()
        if row is None:
            return None
        return {"statusCode": row["statusCode"], "body": json.loads(row["responseBody"])}
    finally:
        conn.close()


def save_idempotent_response(
    endpoint: str, idempotency_key: str, status_code: int, body: dict
) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO idempotency_keys "
            "(idempotency_key, endpoint, status_code, response_body, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                idempotency_key,
                endpoint,
                status_code,
                json.dumps(body),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
