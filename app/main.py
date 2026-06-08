"""
Multi-Store SQL Query Engine
============================
FastAPI application to fan out SQL queries across 600+ store SQL Servers
in parallel and aggregate results — behaving like a single virtual SQL
Server that proxies all stores.

Key features
------------
- Async parallel execution across all stores (configurable concurrency)
- Per-store connection timeouts and detailed error capture
- Store CRUD (add/edit/delete/enable/disable) persisted in SQLite
- Shared username/password (configured once)
- Live connectivity health check
- Schema introspection (list tables/columns of any store)
- Drag-and-drop report builder (no SQL required)
- Result download (CSV) and "stores not connected" drilldown
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pyodbc
from fastapi import FastAPI, HTTPException, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "stores.db"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

# Shared credentials for all stores (override via env or settings page)
DEFAULT_USERNAME = os.getenv("STORE_USER", "USERNAME")
DEFAULT_PASSWORD = os.getenv("STORE_PASS", "PASSWORD")
DEFAULT_DATABASE = os.getenv("STORE_DB",   "DB_NAME")
DEFAULT_DRIVER   = os.getenv("STORE_DRIVER", "ODBC Driver 17 for SQL Server")

# Parallelism — 600 stores, but we don't want to nuke the network
MAX_CONCURRENCY  = int(os.getenv("MAX_CONCURRENCY", "60"))
CONNECT_TIMEOUT  = int(os.getenv("CONNECT_TIMEOUT", "5"))     # seconds
QUERY_TIMEOUT    = int(os.getenv("QUERY_TIMEOUT",   "30"))    # seconds
HEALTH_TIMEOUT   = int(os.getenv("HEALTH_TIMEOUT",  "4"))     # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("multistore")

# ---------------------------------------------------------------------------
# SQLite — store registry
# ---------------------------------------------------------------------------

def init_db() -> None:
    """Create the registry tables if they do not exist."""
    with sqlite3.connect(DB_PATH) as cx:
        cx.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stores (
                store_code TEXT PRIMARY KEY,
                ip         TEXT NOT NULL,
                port       INTEGER NOT NULL DEFAULT 1433,
                database   TEXT,
                label      TEXT,
                enabled    INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS query_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                sql        TEXT NOT NULL,
                executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                total      INTEGER NOT NULL,
                succeeded  INTEGER NOT NULL,
                failed     INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS saved_reports (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                config     TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        # Seed default credentials if absent
        for k, v in [
            ("username", DEFAULT_USERNAME),
            ("password", DEFAULT_PASSWORD),
            ("database", DEFAULT_DATABASE),
            ("driver",   DEFAULT_DRIVER),
        ]:
            cx.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (k, v),
            )


@contextmanager
def cx_registry():
    cx = sqlite3.connect(DB_PATH)
    cx.row_factory = sqlite3.Row
    try:
        yield cx
        cx.commit()
    finally:
        cx.close()


def get_setting(key: str) -> str:
    with cx_registry() as cx:
        row = cx.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else ""


def set_setting(key: str, value: str) -> None:
    with cx_registry() as cx:
        cx.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

@dataclass
class StoreConfig:
    store_code: str
    ip: str
    port: int
    database: str
    label: str = ""
    enabled: bool = True


def load_stores(only_enabled: bool = True) -> list[StoreConfig]:
    sql = "SELECT * FROM stores"
    if only_enabled:
        sql += " WHERE enabled=1"
    sql += " ORDER BY store_code"
    with cx_registry() as cx:
        return [
            StoreConfig(
                store_code=r["store_code"],
                ip=r["ip"],
                port=r["port"],
                # Each store's database name = its store_code by convention.
                # An explicit per-store override in the `database` column wins.
                database=r["database"] or r["store_code"],
                label=r["label"] or "",
                enabled=bool(r["enabled"]),
            )
            for r in cx.execute(sql).fetchall()
        ]


def build_conn_str(s: StoreConfig) -> str:
    driver   = get_setting("driver")   or DEFAULT_DRIVER
    username = get_setting("username") or DEFAULT_USERNAME
    password = get_setting("password") or DEFAULT_PASSWORD
    # Database = explicit override on the StoreConfig, else the store_code itself.
    # The global "database" setting is intentionally NOT consulted here, because
    # every store has its own DB named after its store_code.
    database = s.database or s.store_code

    # The legacy built-in "SQL Server" driver (and Native Client) doesn't
    # understand the modern Encrypt / TrustServerCertificate keywords and
    # will error out if they're present. Only emit those for the modern
    # "ODBC Driver NN for SQL Server" drivers.
    is_modern = "ODBC Driver" in driver

    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={s.ip},{s.port}",
        f"DATABASE={database}",
        f"UID={username}",
        f"PWD={password}",
        f"Connection Timeout={CONNECT_TIMEOUT}",
    ]
    if is_modern:
        parts.append("TrustServerCertificate=yes")
        parts.append("Encrypt=no")

    return ";".join(parts) + ";"


# ---------------------------------------------------------------------------
# Per-store execution (sync, run inside a thread)
# ---------------------------------------------------------------------------

def _json_safe(v):
    """
    Coerce any value coming back from pyodbc into something that json.dumps
    will accept WITHOUT producing invalid JSON literals (NaN, Infinity).
    """
    if v is None:
        return None
    # Common primitives
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        # NaN/Infinity are not valid JSON; clients will fail to parse.
        if v != v or v == float("inf") or v == float("-inf"):
            return None
        return v
    if isinstance(v, str):
        return v
    # Decimal → float (lossless for typical retail amounts; still safe-checked)
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            try:
                f = float(v)
            except (OverflowError, ValueError):
                return str(v)
            if f != f or f == float("inf") or f == float("-inf"):
                return str(v)
            return f
    except Exception:
        pass
    # Dates / times
    if isinstance(v, datetime):
        return v.isoformat(sep=" ")
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            pass
    # Binary
    if isinstance(v, (bytes, bytearray)):
        try:
            return v.hex()
        except Exception:
            return str(v)
    # Anything else → string fallback
    try:
        return str(v)
    except Exception:
        return None


def _exec_one_sync(s: StoreConfig, sql: str, timeout: int) -> dict[str, Any]:
    """Run a single SQL statement against a single store. Sync, blocking."""
    t0 = time.perf_counter()
    out: dict[str, Any] = {
        "store_code": s.store_code,
        "ip":         s.ip,
        "label":      s.label,
        "ok":         False,
        "rows":       [],
        "columns":    [],
        "rowcount":   0,
        "error":      None,
        "duration_ms": 0,
    }
    cn = None
    try:
        cn = pyodbc.connect(build_conn_str(s), timeout=CONNECT_TIMEOUT, autocommit=True)
        cn.timeout = timeout
        cur = cn.cursor()
        cur.execute(sql)

        # Some statements (INSERT/UPDATE) won't have a result set
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = []
            for r in cur.fetchall():
                row = {}
                for c, v in zip(cols, r):
                    row[c] = _json_safe(v)
                rows.append(row)
            out["columns"]  = cols
            out["rows"]     = rows
            out["rowcount"] = len(rows)
        else:
            out["rowcount"] = cur.rowcount

        out["ok"] = True
    except pyodbc.Error as e:
        msg = str(e)
        # Trim ODBC noise
        if "]" in msg:
            msg = msg.split("]")[-1].strip()
        out["error"] = msg or "ODBC error"
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    finally:
        if cn is not None:
            try:
                cn.close()
            except Exception:
                pass
        out["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    return out


def _ping_one_sync(s: StoreConfig) -> dict[str, Any]:
    """Cheap connectivity probe — SELECT 1."""
    return _exec_one_sync(s, "SELECT 1 AS ok", timeout=HEALTH_TIMEOUT)


# ---------------------------------------------------------------------------
# Parallel fan-out
# ---------------------------------------------------------------------------

async def run_on_stores(
    sql: str,
    stores: list[StoreConfig] | None = None,
    timeout: int = QUERY_TIMEOUT,
    concurrency: int = MAX_CONCURRENCY,
) -> list[dict[str, Any]]:
    """Run SQL on every (enabled) store, in parallel, returning per-store results."""
    if stores is None:
        stores = load_stores(only_enabled=True)
    if not stores:
        return []

    sem = asyncio.Semaphore(concurrency)
    loop = asyncio.get_running_loop()

    async def _bound(s: StoreConfig) -> dict[str, Any]:
        async with sem:
            return await loop.run_in_executor(None, _exec_one_sync, s, sql, timeout)

    return await asyncio.gather(*[_bound(s) for s in stores])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class StoreIn(BaseModel):
    store_code: str = Field(..., min_length=1, max_length=64)
    ip:         str = Field(..., min_length=1, max_length=64)
    port:       int = Field(1433, ge=1, le=65535)
    database:   str | None = Field(None, max_length=128)
    label:      str | None = Field(None, max_length=128)
    enabled:    bool = True


class StoreUpdate(BaseModel):
    ip:       str | None = None
    port:     int | None = Field(None, ge=1, le=65535)
    database: str | None = None
    label:    str | None = None
    enabled:  bool | None = None


class QueryIn(BaseModel):
    sql:          str
    store_codes:  list[str] | None = None    # subset; None = all enabled
    timeout:      int = QUERY_TIMEOUT
    concurrency:  int = MAX_CONCURRENCY


class ReportColumn(BaseModel):
    name:  str
    alias: str | None = None
    agg:   str | None = None    # SUM, COUNT, AVG, MIN, MAX, COUNT_DISTINCT


class ReportFilter(BaseModel):
    column:  str
    op:      str     # =, <>, >, <, >=, <=, LIKE, IN, BETWEEN, IS NULL, IS NOT NULL
    value:   Any = None
    value2:  Any = None    # for BETWEEN


class ReportConfig(BaseModel):
    table:    str
    columns:  list[ReportColumn]
    filters:  list[ReportFilter] = []
    group_by: list[str] = []
    order_by: list[dict[str, str]] = []   # [{column, dir}]
    limit:    int | None = None


class SettingsIn(BaseModel):
    username: str | None = None
    password: str | None = None
    database: str | None = None
    driver:   str | None = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("Database ready at %s", DB_PATH)
    yield


app = FastAPI(title="Multi-Store SQL Query Engine", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# --- Cross-version TemplateResponse compatibility ----------------------------
# Starlette changed the TemplateResponse signature:
#   Old API:  TemplateResponse(name, {"request": request, ...})
#   New API:  TemplateResponse(request, name, ...)
# We probe once at import time using a fake Request, and lock in the form
# that actually works on this installed version. No per-request guessing.

def _pick_render():
    # Build a minimal fake Request (ASGI scope is all that's needed)
    from starlette.requests import Request as _SReq
    fake_scope = {
        "type": "http", "method": "GET", "path": "/", "headers": [],
        "query_string": b"", "client": ("127.0.0.1", 0), "server": ("testserver", 80),
        "scheme": "http", "root_path": "", "http_version": "1.1",
    }
    fake_req = _SReq(fake_scope)
    # We need a template that definitely exists to probe with — use base.html
    probe_name = "base.html"

    # Try the new (request, name) form first
    try:
        templates.TemplateResponse(fake_req, probe_name)
        def _r(request, name):
            return templates.TemplateResponse(request, name)
        return _r
    except Exception:
        pass

    # Fall back to legacy (name, {"request": request}) form
    def _r(request, name):
        return templates.TemplateResponse(name, {"request": request})
    return _r

render = _pick_render()


# Also initialize at import-time so direct ASGI/uvicorn loads are safe
init_db()


# -------- UI ---------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def page_index(request: Request):
    return render(request, "index.html")


@app.get("/stores", response_class=HTMLResponse)
def page_stores(request: Request):
    return render(request, "stores.html")


@app.get("/builder", response_class=HTMLResponse)
def page_builder(request: Request):
    return render(request, "builder.html")


@app.get("/settings", response_class=HTMLResponse)
def page_settings(request: Request):
    return render(request, "settings.html")


# -------- Settings API -----------------------------------------------------

@app.get("/api/settings")
def api_settings_get():
    return {
        "username": get_setting("username"),
        # never expose password to UI
        "password_set": bool(get_setting("password")),
        "database": get_setting("database"),
        "driver":   get_setting("driver"),
        "max_concurrency": MAX_CONCURRENCY,
        "connect_timeout": CONNECT_TIMEOUT,
        "query_timeout":   QUERY_TIMEOUT,
    }


@app.post("/api/settings")
def api_settings_set(s: SettingsIn):
    for k, v in s.model_dump(exclude_none=True).items():
        set_setting(k, v)
    return {"ok": True}


# -------- Store CRUD -------------------------------------------------------

@app.get("/api/stores")
def api_stores_list():
    with cx_registry() as cx:
        rows = cx.execute("SELECT * FROM stores ORDER BY store_code").fetchall()
        return [dict(r) for r in rows]


def _store_row_to_dict(r) -> dict[str, Any]:
    """Render a sqlite Row of the stores table as a JSON-friendly dict."""
    return {
        "store_code": r["store_code"],
        "ip":         r["ip"],
        "port":       r["port"],
        "database":   r["database"],
        "label":      r["label"] or "",
        "enabled":    bool(r["enabled"]),
    }


@app.post("/api/stores")
def api_stores_add(s: StoreIn, on_duplicate: str = "error"):
    """
    Add a single store.
    `on_duplicate` controls what to do if the store_code already exists:
      - "error"  (default) — return 409 with the existing row so the UI
                              can prompt the user to choose.
      - "update" — overwrite the existing row with the new values.
      - "skip"   — leave the existing row untouched, return 200.
    """
    on_duplicate = (on_duplicate or "error").lower()
    if on_duplicate not in ("error", "update", "skip"):
        raise HTTPException(400, "on_duplicate must be one of: error, update, skip")

    with cx_registry() as cx:
        existing = cx.execute(
            "SELECT * FROM stores WHERE store_code = ?",
            (s.store_code,),
        ).fetchone()

        if existing is None:
            cx.execute(
                "INSERT INTO stores(store_code, ip, port, database, label, enabled) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (s.store_code, s.ip, s.port, s.database, s.label, int(s.enabled)),
            )
            return {"ok": True, "action": "added"}

        # Duplicate exists — react per the requested policy
        existing_d = _store_row_to_dict(existing)

        if on_duplicate == "error":
            # Return 409 with rich detail so the UI can render a clear prompt.
            raise HTTPException(
                status_code=409,
                detail={
                    "error":    "duplicate_store",
                    "message":  f"Store '{s.store_code}' already exists",
                    "existing": existing_d,
                    "incoming": {
                        "store_code": s.store_code,
                        "ip":         s.ip,
                        "port":       s.port,
                        "database":   s.database,
                        "label":      s.label,
                        "enabled":    s.enabled,
                    },
                },
            )

        if on_duplicate == "skip":
            return {"ok": True, "action": "skipped", "existing": existing_d}

        # on_duplicate == "update"
        cx.execute(
            "UPDATE stores SET ip = ?, port = ?, database = ?, label = ?, enabled = ? "
            "WHERE store_code = ?",
            (s.ip, s.port, s.database, s.label, int(s.enabled), s.store_code),
        )
        return {"ok": True, "action": "updated", "previous": existing_d}


@app.post("/api/stores/bulk")
def api_stores_bulk(payload: Any = Body(...), on_duplicate: str = "skip"):
    """
    Bulk import.
    Accepts either a bare list or {"stores": [...], "on_duplicate": "..."}.
    `on_duplicate` controls collision behavior:
      - "skip"   (default for bulk) — leave existing rows untouched
      - "update" — overwrite each existing row with the new values
      - "error"  — abort the entire batch on first collision (returns 409)
    """
    # If the payload is a dict with explicit on_duplicate, that wins.
    if isinstance(payload, dict):
        raw_items = payload.get("stores")
        if "on_duplicate" in payload:
            on_duplicate = payload["on_duplicate"]
    else:
        raw_items = payload

    on_duplicate = (on_duplicate or "skip").lower()
    if on_duplicate not in ("error", "update", "skip"):
        raise HTTPException(400, "on_duplicate must be one of: error, update, skip")

    if not isinstance(raw_items, list):
        raise HTTPException(
            422,
            "Expected a JSON list of store objects, or {'stores': [...]}.",
        )
    try:
        items = [StoreIn(**(r if isinstance(r, dict) else {})) for r in raw_items]
    except Exception as e:
        raise HTTPException(422, f"Invalid store row: {e}")

    added = updated = skipped = 0
    conflicts: list[dict[str, Any]] = []

    with cx_registry() as cx:
        for s in items:
            existing = cx.execute(
                "SELECT * FROM stores WHERE store_code = ?",
                (s.store_code,),
            ).fetchone()

            if existing is None:
                cx.execute(
                    "INSERT INTO stores(store_code, ip, port, database, label, enabled) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (s.store_code, s.ip, s.port, s.database, s.label, int(s.enabled)),
                )
                added += 1
                continue

            # Duplicate handling
            if on_duplicate == "error":
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error":   "duplicate_in_bulk",
                        "message": f"Store '{s.store_code}' already exists. "
                                   "Re-submit with on_duplicate=update or skip.",
                        "store_code": s.store_code,
                    },
                )
            if on_duplicate == "update":
                cx.execute(
                    "UPDATE stores SET ip = ?, port = ?, database = ?, label = ?, enabled = ? "
                    "WHERE store_code = ?",
                    (s.ip, s.port, s.database, s.label, int(s.enabled), s.store_code),
                )
                updated += 1
                conflicts.append({
                    "store_code": s.store_code,
                    "action":     "updated",
                    "previous":   _store_row_to_dict(existing),
                })
            else:  # skip
                skipped += 1
                conflicts.append({
                    "store_code": s.store_code,
                    "action":     "skipped",
                    "existing":   _store_row_to_dict(existing),
                })

    return {
        "added":     added,
        "updated":   updated,
        "skipped":   skipped,
        "conflicts": conflicts,
    }


@app.patch("/api/stores/{code}")
def api_stores_update(code: str, body: StoreUpdate):
    fields = body.model_dump(exclude_none=True)
    if not fields:
        return {"ok": True}
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [code]
    with cx_registry() as cx:
        cur = cx.execute(f"UPDATE stores SET {sets} WHERE store_code=?", vals)
        if cur.rowcount == 0:
            raise HTTPException(404, "Store not found")
    return {"ok": True}


@app.delete("/api/stores/{code}")
def api_stores_delete(code: str):
    with cx_registry() as cx:
        cur = cx.execute("DELETE FROM stores WHERE store_code=?", (code,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Store not found")
    return {"ok": True}


# -------- Health / ping ----------------------------------------------------

class HealthIn(BaseModel):
    codes: list[str] | None = None


@app.post("/api/health")
async def api_health(payload: Any = Body(default=None)):
    """
    Ping every enabled store. Optionally restrict to a subset via `codes`.
    Accepts: empty body, [], ["S001", ...], {}, or {"codes": [...]}.
    """
    codes: list[str] | None = None
    if isinstance(payload, list):
        codes = [str(c) for c in payload] or None
    elif isinstance(payload, dict):
        raw = payload.get("codes")
        if isinstance(raw, list):
            codes = [str(c) for c in raw] or None

    stores = load_stores(only_enabled=True)
    if codes:
        cs = set(codes)
        stores = [s for s in stores if s.store_code in cs]

    t0 = time.perf_counter()
    sem  = asyncio.Semaphore(MAX_CONCURRENCY)
    loop = asyncio.get_running_loop()

    async def _bound(s: StoreConfig):
        async with sem:
            return await loop.run_in_executor(None, _ping_one_sync, s)

    results = await asyncio.gather(*[_bound(s) for s in stores])
    elapsed = int((time.perf_counter() - t0) * 1000)

    connected = [r for r in results if r["ok"]]
    return {
        "total":           len(results),
        "connected":       len(connected),
        "disconnected":    len(results) - len(connected),
        "duration_ms":     elapsed,
        "results":         results,
    }


# -------- Run query --------------------------------------------------------

# Preview cap: the on-screen Query Console only renders the first 5,000 rows
# of a result anyway, so sending more over JSON is wasteful and risks blowing
# up memory / connection on huge fan-outs. Exports (CSV/XLSX) bypass this.
QUERY_PREVIEW_ROW_CAP = 10_000


async def _run_query_full(q: QueryIn) -> dict[str, Any]:
    """
    Fan-out the query and assemble the FULL unified result set (no cap).
    Used by CSV/XLSX export. The on-screen JSON endpoint wraps this and caps.
    """
    sql = q.sql.strip()
    if not sql:
        raise HTTPException(400, "Empty SQL")

    stores = load_stores(only_enabled=True)
    if q.store_codes:
        cs = set(q.store_codes)
        stores = [s for s in stores if s.store_code in cs]
    if not stores:
        raise HTTPException(400, "No stores selected")

    t0 = time.perf_counter()
    results = await run_on_stores(
        sql,
        stores=stores,
        timeout=q.timeout,
        concurrency=q.concurrency,
    )
    elapsed = int((time.perf_counter() - t0) * 1000)

    succeeded = [r for r in results if r["ok"]]
    failed    = [r for r in results if not r["ok"]]

    unified_columns: list[str] = []
    unified_rows: list[dict[str, Any]] = []
    for r in succeeded:
        for c in r["columns"]:
            if c not in unified_columns:
                unified_columns.append(c)
        for row in r["rows"]:
            unified_rows.append({"_store": r["store_code"], "_ip": r["ip"], **row})

    # Persist short history (truncate the SQL for the log; full SQL not needed)
    with cx_registry() as cx:
        cx.execute(
            "INSERT INTO query_history(sql, total, succeeded, failed, duration_ms) "
            "VALUES (?, ?, ?, ?, ?)",
            (sql[:2000], len(results), len(succeeded), len(failed), elapsed),
        )

    return {
        "summary": {
            "total":          len(results),
            "succeeded":      len(succeeded),
            "failed":         len(failed),
            "duration_ms":    elapsed,
            "total_rows":     sum(r["rowcount"] for r in succeeded),
        },
        "unified": {
            "columns": ["_store", "_ip"] + unified_columns,
            "rows":    unified_rows,
        },
        "per_store":   results,
        "failed_list": [
            {"store_code": r["store_code"], "ip": r["ip"], "error": r["error"]}
            for r in failed
        ],
    }


@app.post("/api/query")
async def api_query(q: QueryIn):
    """
    On-screen query endpoint. Returns a CAPPED preview of rows
    (first QUERY_PREVIEW_ROW_CAP) so the JSON payload stays small and the
    browser doesn't choke on multi-million-row datasets.
    Use /api/query/csv or /api/query/xlsx to get the full result set.
    """
    full = await _run_query_full(q)

    total_rows = full["summary"]["total_rows"]
    is_truncated = total_rows > QUERY_PREVIEW_ROW_CAP

    if is_truncated:
        # Cap the unified preview
        full["unified"]["rows"] = full["unified"]["rows"][:QUERY_PREVIEW_ROW_CAP]
        # Also cap per-store rows so the per-store tab can't blow up either.
        # We keep counts/columns intact; rows are previewed proportionally.
        for ps in full["per_store"]:
            if len(ps["rows"]) > 500:
                ps["rows"] = ps["rows"][:500]
                ps["preview_truncated"] = True

    full["summary"]["preview_rows"]    = len(full["unified"]["rows"])
    full["summary"]["preview_capped"]  = is_truncated
    full["summary"]["preview_cap"]     = QUERY_PREVIEW_ROW_CAP
    return full


@app.post("/api/query/csv")
async def api_query_csv(q: QueryIn):
    """Same as /api/query but streams a CSV download of the FULL unified rows."""
    data = await _run_query_full(q)
    cols = data["unified"]["columns"]
    rows = data["unified"]["rows"]

    def gen():
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)
        for row in rows:
            w.writerow({c: row.get(c, "") for c in cols})
            yield buf.getvalue()
            buf.seek(0); buf.truncate(0)

    fname = f"multistore_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/query/xlsx")
async def api_query_xlsx(q: QueryIn):
    """
    Run the query and stream an XLSX workbook of the unified rows.
    Single sheet. Build runs in a worker thread so the event loop stays
    responsive; bytes stream out as soon as the workbook is finalized.
    """
    from openpyxl import Workbook

    data = await _run_query_full(q)
    cols = data["unified"]["columns"]
    rows = data["unified"]["rows"]
    total = len(rows)

    def _build_xlsx() -> bytes:
        # write_only mode → minimal memory, no styling overhead, ~5-10x faster
        # than the default mode for large row counts.
        wb = Workbook(write_only=True)
        ws = wb.create_sheet(title="Results")
        ws.append(cols or ["(no rows)"])
        # Build the row sequence once per column to avoid repeated dict lookups.
        if rows and cols:
            for r in rows:
                ws.append([_xlsx_safe(r.get(c)) for c in cols])
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    # Run the CPU/IO-heavy build off the event loop.
    loop = asyncio.get_running_loop()
    payload = await loop.run_in_executor(None, _build_xlsx)

    fname = f"multistore_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    return StreamingResponse(
        iter([payload]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Content-Length":      str(len(payload)),
            "X-Total-Rows":        str(total),
        },
    )


def _xlsx_safe(v):
    """Coerce a cell value into something openpyxl can write."""
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        # Excel rejects cell strings > 32,767 chars
        if isinstance(v, str) and len(v) > 32767:
            return v[:32764] + "..."
        # Also strip illegal control chars
        if isinstance(v, str):
            return "".join(ch for ch in v if ch == "\t" or ch == "\n" or ch >= " ")
        return v
    # datetime/date — openpyxl handles natively
    try:
        from datetime import datetime as _dt, date as _d, time as _t
        if isinstance(v, (_dt, _d, _t)):
            return v
    except Exception:
        pass
    # bytes / anything else — stringify
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="replace")
        except Exception:
            return v.hex()
    return str(v)


# -------- Schema introspection (for report builder) ------------------------

@app.get("/api/schema/tables")
async def api_schema_tables(store_code: str | None = None):
    """List tables from a representative store (defaults to first connected)."""
    stores = load_stores(only_enabled=True)
    if not stores:
        raise HTTPException(400, "No stores configured")
    if store_code:
        stores = [s for s in stores if s.store_code == store_code]
        if not stores:
            raise HTTPException(404, "Store not found")

    sql = (
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE "
        "FROM INFORMATION_SCHEMA.TABLES "
        "ORDER BY TABLE_SCHEMA, TABLE_NAME"
    )

    # Try stores in order until one responds
    loop = asyncio.get_running_loop()
    last_err = None
    for s in stores[:10]:    # don't iterate forever
        r = await loop.run_in_executor(None, _exec_one_sync, s, sql, HEALTH_TIMEOUT)
        if r["ok"]:
            return {"store_code": s.store_code, "tables": r["rows"]}
        last_err = r["error"]
    raise HTTPException(503, f"No store responded: {last_err}")


@app.get("/api/schema/columns")
async def api_schema_columns(table: str, store_code: str | None = None):
    """List columns for a given table from a representative store."""
    if "." in table:
        schema, tbl = table.split(".", 1)
    else:
        schema, tbl = "dbo", table

    stores = load_stores(only_enabled=True)
    if not stores:
        raise HTTPException(400, "No stores configured")
    if store_code:
        stores = [s for s in stores if s.store_code == store_code]

    sql = (
        f"SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH "
        f"FROM INFORMATION_SCHEMA.COLUMNS "
        f"WHERE TABLE_SCHEMA = '{schema.replace(chr(39), chr(39)*2)}' "
        f"  AND TABLE_NAME   = '{tbl.replace(chr(39), chr(39)*2)}' "
        f"ORDER BY ORDINAL_POSITION"
    )

    loop = asyncio.get_running_loop()
    for s in stores[:10]:
        r = await loop.run_in_executor(None, _exec_one_sync, s, sql, HEALTH_TIMEOUT)
        if r["ok"]:
            return {"store_code": s.store_code, "columns": r["rows"]}
    raise HTTPException(503, "No store responded")


# -------- Report builder ---------------------------------------------------

ALLOWED_AGG = {"SUM", "COUNT", "AVG", "MIN", "MAX", "COUNT_DISTINCT"}
ALLOWED_OP  = {"=", "<>", ">", "<", ">=", "<=", "LIKE", "IN",
               "BETWEEN", "IS NULL", "IS NOT NULL"}


def _quote_ident(name: str) -> str:
    # Identifiers: allow only safe chars then wrap in []
    safe = "".join(ch for ch in name if ch.isalnum() or ch in "._ ")
    parts = safe.split(".")
    return ".".join(f"[{p.strip()}]" for p in parts if p.strip())


def _lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    # string — single-quote and escape
    return "'" + str(v).replace("'", "''") + "'"


def build_sql_from_report(cfg: ReportConfig) -> str:
    """Convert the drag-and-drop ReportConfig into a parameter-free T-SQL string.

    Caveat: this is server-side string generation, not parameter binding, because
    we fan out across hundreds of servers and ODBC parameter handling becomes
    awkward. All identifiers are whitelisted and literals are escaped.
    """
    if not cfg.table or not cfg.columns:
        raise HTTPException(400, "Report needs a table and at least one column")

    # SELECT clause
    select_parts: list[str] = []
    for c in cfg.columns:
        col = _quote_ident(c.name)
        if c.agg:
            agg = c.agg.upper()
            if agg not in ALLOWED_AGG:
                raise HTTPException(400, f"Invalid aggregate: {agg}")
            if agg == "COUNT_DISTINCT":
                expr = f"COUNT(DISTINCT {col})"
            else:
                expr = f"{agg}({col})"
        else:
            expr = col
        if c.alias:
            expr += " AS " + _quote_ident(c.alias)
        select_parts.append(expr)

    sql = "SELECT "
    if cfg.limit:
        sql += f"TOP {int(cfg.limit)} "
    sql += ", ".join(select_parts)
    sql += " FROM " + _quote_ident(cfg.table)

    # WHERE
    if cfg.filters:
        clauses = []
        for f in cfg.filters:
            op = f.op.upper().strip()
            if op not in ALLOWED_OP:
                raise HTTPException(400, f"Invalid operator: {op}")
            col = _quote_ident(f.column)
            if op in ("IS NULL", "IS NOT NULL"):
                clauses.append(f"{col} {op}")
            elif op == "IN":
                if not isinstance(f.value, list) or not f.value:
                    raise HTTPException(400, "IN needs a non-empty list")
                vals = ", ".join(_lit(v) for v in f.value)
                clauses.append(f"{col} IN ({vals})")
            elif op == "BETWEEN":
                clauses.append(f"{col} BETWEEN {_lit(f.value)} AND {_lit(f.value2)}")
            elif op == "LIKE":
                clauses.append(f"{col} LIKE {_lit(f.value)}")
            else:
                clauses.append(f"{col} {op} {_lit(f.value)}")
        sql += " WHERE " + " AND ".join(clauses)

    # GROUP BY
    if cfg.group_by:
        sql += " GROUP BY " + ", ".join(_quote_ident(c) for c in cfg.group_by)

    # ORDER BY
    if cfg.order_by:
        parts = []
        for o in cfg.order_by:
            d = (o.get("dir") or "ASC").upper()
            if d not in ("ASC", "DESC"):
                d = "ASC"
            parts.append(f"{_quote_ident(o['column'])} {d}")
        sql += " ORDER BY " + ", ".join(parts)

    return sql


@app.post("/api/report/preview")
def api_report_preview(cfg: ReportConfig):
    return {"sql": build_sql_from_report(cfg)}


@app.post("/api/report/run")
async def api_report_run(cfg: ReportConfig):
    sql = build_sql_from_report(cfg)
    q = QueryIn(sql=sql)
    return await api_query(q)


@app.get("/api/reports")
def api_reports_list():
    with cx_registry() as cx:
        rows = cx.execute(
            "SELECT id, name, created_at FROM saved_reports ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


@app.post("/api/reports")
def api_reports_save(body: dict[str, Any]):
    name = (body.get("name") or "").strip()
    cfg  = body.get("config")
    if not name or cfg is None:
        raise HTTPException(400, "name and config required")
    with cx_registry() as cx:
        try:
            cx.execute(
                "INSERT INTO saved_reports(name, config) VALUES (?, ?)",
                (name, json.dumps(cfg)),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Report name already exists")
    return {"ok": True}


@app.get("/api/reports/{rid}")
def api_reports_get(rid: int):
    with cx_registry() as cx:
        r = cx.execute(
            "SELECT id, name, config, created_at FROM saved_reports WHERE id=?",
            (rid,),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        return {"id": r["id"], "name": r["name"],
                "config": json.loads(r["config"]),
                "created_at": r["created_at"]}


@app.delete("/api/reports/{rid}")
def api_reports_delete(rid: int):
    with cx_registry() as cx:
        cur = cx.execute("DELETE FROM saved_reports WHERE id=?", (rid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
    return {"ok": True}


# -------- Query history ----------------------------------------------------

@app.get("/api/history")
def api_history(limit: int = 50):
    with cx_registry() as cx:
        rows = cx.execute(
            "SELECT * FROM query_history ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


# Health probe for monitoring tools
@app.get("/healthz")
def healthz():
    return {"ok": True, "ts": datetime.utcnow().isoformat()}
