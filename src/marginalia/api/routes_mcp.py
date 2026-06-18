from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from marginalia import mcp_server

router = APIRouter(tags=["mcp"])


class McpToolCallBody(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.get("/mcp/tools")
async def list_mcp_tools() -> dict[str, Any]:
    return {"tools": mcp_server.list_agent_mcp_tools()}


@router.post("/mcp/tools/{name}/call")
async def call_mcp_tool(
    name: str,
    body: McpToolCallBody | None = None,
) -> dict[str, Any]:
    try:
        return await mcp_server.call_mcp_tool_local(
            name,
            (body.arguments if body is not None else {}),
        )
    except mcp_server.JsonRpcError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
