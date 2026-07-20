"""Excel Reader unit (category: parser). Reads an uploaded Excel file into JSON.

No config needed. When the user uploads a file the chat base64-encodes the .xlsx
into the run input (input["file_b64"]); this unit decodes it and reads EVERY
sheet, packing all of them into one JSON:

    { file, source, sheet_count, total_rows,
      sheets: [ { name, columns, rows: [ {col: val, ...} ], row_count }, ... ] }

Row 1 of each sheet = header -> column names; later rows -> dicts keyed by them.
If no file was uploaded it returns a small fixed sample so the builder can still
be exercised. Deterministic code tool -> always done on the first attempt.
"""
from __future__ import annotations

import base64
import binascii
import datetime as _dt
import io
import time
from typing import Any

from openpyxl import load_workbook

from shared import config as cfg
from shared.celery_app import celery_app
from node.base import run_step

NAME = "excel_reader"

_SAMPLE_SHEETS = [
    {
        "name": "Sheet1",
        "columns": ["id", "name", "amount"],
        "rows": [
            {"id": 1, "name": "Alpha", "amount": 100},
            {"id": 2, "name": "Beta", "amount": 250},
            {"id": 3, "name": "Gamma", "amount": 75},
        ],
        "row_count": 3,
    }
]


def _cell(v: Any) -> Any:
    """Coerce a cell value to something JSON-serializable."""
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    return v


def _read_sheet(ws: Any) -> dict[str, Any]:
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if header is None:
        return {"name": ws.title, "columns": [], "rows": [], "row_count": 0}

    columns = [str(h) if h is not None else f"col{i + 1}" for i, h in enumerate(header)]
    rows: list[dict[str, Any]] = []
    for r in rows_iter:
        if r is None or all(c is None for c in r):
            continue  # skip blank rows
        rows.append({columns[i]: _cell(r[i]) for i in range(min(len(columns), len(r)))})
    return {"name": ws.title, "columns": columns, "rows": rows, "row_count": len(rows)}


def _parse_all(raw: bytes) -> list[dict[str, Any]]:
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    try:
        return [_read_sheet(wb[name]) for name in wb.sheetnames]
    finally:
        wb.close()


def _pack(file: str, source: str, sheets: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "file": file,
        "source": source,
        "sheet_count": len(sheets),
        "total_rows": sum(s["row_count"] for s in sheets),
        "sheets": sheets,
    }


def _build_output(input_obj: dict[str, Any], conf: dict[str, Any], attempt: int) -> dict[str, Any]:
    name = input_obj.get("file") or "sample.xlsx"
    b64 = input_obj.get("file_b64")

    if not b64:
        return _pack("sample.xlsx", "sample", _SAMPLE_SHEETS)

    # Reject oversized uploads before decoding/parsing (zip-bomb / OOM guard).
    # base64 inflates ~4/3, so pre-check the encoded length too.
    if len(b64) > cfg.MAX_XLSX_BYTES * 4 // 3 + 4:
        out = _pack(name, "error", [])
        out["error"] = f"file too large: exceeds {cfg.MAX_XLSX_BYTES} bytes"
        return out

    try:
        raw = base64.b64decode(b64, validate=True)
        if len(raw) > cfg.MAX_XLSX_BYTES:
            out = _pack(name, "error", [])
            out["error"] = f"file too large: {len(raw)} bytes > {cfg.MAX_XLSX_BYTES}"
            return out
        return _pack(name, "upload", _parse_all(raw))
    except (binascii.Error, ValueError) as exc:
        out = _pack(name, "error", [])
        out["error"] = f"invalid base64: {exc}"
        return out
    except Exception as exc:  # not an xlsx / corrupt
        out = _pack(name, "error", [])
        out["error"] = f"cannot read excel: {exc}"
        return out


@celery_app.task(name="node.excel_reader")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    # simulate parse latency so the node stays visibly busy in the DAG panel
    if cfg.EXCEL_READER_DELAY_SEC > 0:
        time.sleep(cfg.EXCEL_READER_DELAY_SEC)
    return run_step(NAME, payload, _build_output, always_done=True)
