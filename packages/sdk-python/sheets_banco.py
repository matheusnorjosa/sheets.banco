"""
sheets.banco Python SDK

Usage:
    from sheets_banco import SheetsBanco

    client = SheetsBanco("https://your-api.com", api_id="your-api-id")
    client.set_auth(bearer="your-token")

    rows = client.get_rows()
    client.create_rows([{"name": "Alice", "age": "30"}])
"""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlencode

try:
    import httpx

    _client_cls = httpx.Client
except ImportError:
    _client_cls = None  # type: ignore

import urllib.request
import urllib.error


class SheetsBancoError(Exception):
    """Base exception for SheetsBanco SDK."""

    def __init__(self, message: str, status_code: int = 0, code: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class SheetsBanco:
    """Client for the sheets.banco REST API."""

    def __init__(self, base_url: str, api_id: str):
        self.base_url = base_url.rstrip("/")
        self.api_id = api_id
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        self._use_httpx = _client_cls is not None

    def set_auth(
        self,
        bearer: Optional[str] = None,
        basic_user: Optional[str] = None,
        basic_pass: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> "SheetsBanco":
        """Configure authentication."""
        if bearer:
            self._headers["Authorization"] = f"Bearer {bearer}"
        elif basic_user and basic_pass:
            import base64

            cred = base64.b64encode(f"{basic_user}:{basic_pass}".encode()).decode()
            self._headers["Authorization"] = f"Basic {cred}"
        if api_key:
            self._headers["X-Api-Key"] = api_key
        return self

    def _endpoint(self, path: str = "") -> str:
        return f"{self.base_url}/api/v1/{self.api_id}{path}"

    def _request(self, method: str, path: str, body: Any = None, params: Optional[dict] = None) -> Any:
        url = self._endpoint(path)
        if params:
            url += "?" + urlencode({k: v for k, v in params.items() if v is not None})

        if self._use_httpx:
            with httpx.Client() as client:
                resp = client.request(
                    method, url, headers=self._headers,
                    json=body if body else None, timeout=30.0,
                )
                if resp.status_code >= 400:
                    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                    raise SheetsBancoError(
                        data.get("message", resp.text), resp.status_code, data.get("code", "")
                    )
                return resp.json()
        else:
            # Fallback to urllib
            data_bytes = json.dumps(body).encode() if body else None
            req = urllib.request.Request(url, data=data_bytes, headers=self._headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                body_text = e.read().decode()
                try:
                    err = json.loads(body_text)
                except Exception:
                    err = {}
                raise SheetsBancoError(err.get("message", body_text), e.code, err.get("code", ""))

    # ── Read ──

    def get_rows(
        self,
        sheet: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        sort_by: Optional[str] = None,
        sort_order: Optional[str] = None,
        cast_numbers: bool = False,
        version: Optional[int] = None,
        source: Optional[str] = None,
    ) -> list[dict]:
        """Fetch all rows."""
        return self._request("GET", "", params={
            "sheet": sheet, "limit": str(limit) if limit else None,
            "offset": str(offset) if offset else None,
            "sort_by": sort_by, "sort_order": sort_order,
            "cast_numbers": "true" if cast_numbers else None,
            "version": str(version) if version else None,
            "source": source,
        })

    def get_columns(self, sheet: Optional[str] = None) -> list[str]:
        """Get column names."""
        return self._request("GET", "/keys", params={"sheet": sheet})

    def get_count(self, sheet: Optional[str] = None) -> int:
        """Get row count."""
        result = self._request("GET", "/count", params={"sheet": sheet})
        return result.get("rows", 0)

    def search(
        self, filters: dict[str, str], mode: str = "and",
        sheet: Optional[str] = None, limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> list[dict]:
        """Search rows with filters."""
        path = "/search" if mode == "and" else "/search_or"
        params = {**filters, "sheet": sheet}
        if limit:
            params["limit"] = str(limit)
        if offset:
            params["offset"] = str(offset)
        return self._request("GET", path, params=params)

    # ── Write ──

    def create_rows(self, rows: list[dict] | dict, sync: bool = False, sheet: Optional[str] = None) -> dict:
        """Create one or more rows."""
        data = rows if isinstance(rows, list) else [rows]
        return self._request("POST", "", body={"data": data}, params={
            "sync": "true" if sync else None, "sheet": sheet,
        })

    def update_rows(self, column: str, value: str, data: dict, sync: bool = False, sheet: Optional[str] = None) -> dict:
        """Update rows matching column=value."""
        return self._request("PATCH", f"/{column}/{value}", body={"data": data}, params={
            "sync": "true" if sync else None, "sheet": sheet,
        })

    def delete_rows(self, column: str, value: str, sync: bool = False, sheet: Optional[str] = None) -> dict:
        """Delete rows matching column=value."""
        return self._request("DELETE", f"/{column}/{value}", params={
            "sync": "true" if sync else None, "sheet": sheet,
        })

    def clear_all(self, sync: bool = False, sheet: Optional[str] = None) -> dict:
        """Delete all data rows."""
        return self._request("DELETE", "/all", params={
            "sync": "true" if sync else None, "sheet": sheet,
        })

    # ── Batch ──

    def batch_update(
        self, filters: dict[str, str], data: dict[str, str],
        filter_mode: str = "and", sync: bool = False, sheet: Optional[str] = None,
    ) -> dict:
        """Batch update rows matching filters."""
        return self._request("POST", "/batch/update", body={
            "filters": filters, "data": data, "filter_mode": filter_mode,
        }, params={"sync": "true" if sync else None, "sheet": sheet})

    def batch_delete(
        self, filters: dict[str, str],
        filter_mode: str = "and", sync: bool = False, sheet: Optional[str] = None,
    ) -> dict:
        """Batch delete rows matching filters."""
        return self._request("POST", "/batch/delete", body={
            "filters": filters, "filter_mode": filter_mode,
        }, params={"sync": "true" if sync else None, "sheet": sheet})
