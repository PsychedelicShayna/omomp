#!/usr/bin/env python3
"""Bounded NDJSON bridge from OMP to claude_agent_sdk 0.2.128."""

import asyncio
import dataclasses
import json
import os
import sys
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolUseBlock,
)

MAX_FRAME = 1_048_576
MAX_COMMANDS = 16


def emit(kind: str, **payload: Any) -> None:
    def encode(value: Any) -> Any:
        if dataclasses.is_dataclass(value):
            return dataclasses.asdict(value)
        if hasattr(value, "value"):
            return value.value
        return str(value)

    encoded = json.dumps(
        {"type": kind, **payload}, ensure_ascii=False, separators=(",", ":"), default=encode
    )
    if len(encoded.encode()) > MAX_FRAME:
        encoded = json.dumps({"type": "error", "error": "Claude sidecar output frame exceeded 1 MiB"})
    print(encoded, flush=True)


def read_frame() -> dict[str, Any]:
    line = sys.stdin.buffer.readline(MAX_FRAME + 2)
    if not line:
        raise EOFError("OMP closed Claude sidecar input")
    if len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise ValueError("Claude sidecar input frame exceeded 1 MiB")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("Claude sidecar input must be a JSON object")
    return value


def real_child(path: str, root: str) -> bool:
    resolved = Path(path).resolve()
    boundary = Path(root).resolve()
    return resolved == boundary or boundary in resolved.parents


def option_tools(requested: list[str], writable: bool) -> list[str]:
    read_map = {
        "read": "Read", "grep": "Grep", "glob": "Glob",
        "web_search": "WebSearch", "web_fetch": "WebFetch",
    }
    # Command execution is intentionally unavailable: this repository has no
    # cgroup/subreaper supervisor that can contain setsid/double-fork children.
    write_map = {"edit": "Edit", "write": "Write"}
    mapped = [read_map[name] for name in requested if name in read_map]
    if writable:
        mapped.extend(write_map[name] for name in requested if name in write_map)
    return list(dict.fromkeys(mapped))

def tool_path(tool_input: dict[str, Any]) -> str | None:
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def permission_handler(
    enabled_tools: set[str], writable: bool, worktree: str | None
):
    async def can_use_tool(
        tool_name: str, tool_input: dict[str, Any], _context: Any
    ) -> PermissionResultAllow | PermissionResultDeny:
        if tool_name not in enabled_tools:
            return PermissionResultDeny(
                message=f"OMP did not grant Claude tool {tool_name}", interrupt=False
            )
        if tool_name in {"Edit", "Write"}:
            target = tool_path(tool_input)
            if not writable or not worktree or not target:
                return PermissionResultDeny(
                    message=f"{tool_name} requires a path inside the OMP worktree",
                    interrupt=False,
                )
            absolute = target if os.path.isabs(target) else os.path.join(worktree, target)
            if not real_child(absolute, worktree):
                return PermissionResultDeny(
                    message=f"{tool_name} path escapes the OMP worktree", interrupt=False
                )
        elif tool_name == "Bash":
            return PermissionResultDeny(
                message="Bash is unavailable without descendant-safe containment",
                interrupt=False,
            )
        return PermissionResultAllow()

    return can_use_tool


async def main() -> None:
    start = await asyncio.to_thread(read_frame)
    if start.get("type") != "start":
        raise ValueError("First Claude sidecar frame must be start")
    cwd = str(start["cwd"])
    isolation = start.get("isolation") or {}
    writable = bool(isolation.get("isolated") and isolation.get("worktree"))
    worktree = str(Path(str(isolation["worktree"])).resolve()) if writable else None
    if writable and (not worktree or not real_child(cwd, worktree)):
        raise ValueError("Writable Claude cwd is outside the OMP-created isolated worktree")
    tools = option_tools(list(start.get("tools") or []), writable)
    enabled_tools = set(tools)
    model = start.get("model")
    allowed_tools = [
        tool for tool in tools if tool not in {"Edit", "Write", "Bash"}
    ]
    if writable and worktree:
        allowed_tools.extend(
            f"{tool}({worktree}/**)" for tool in ("Edit", "Write") if tool in enabled_tools
        )
    options = ClaudeAgentOptions(
        cwd=cwd,
        system_prompt=str(start.get("systemPrompt") or ""),
        tools=tools,
        allowed_tools=allowed_tools,
        can_use_tool=permission_handler(enabled_tools, writable, worktree),
        permission_mode="dontAsk",
        setting_sources=[],
        include_partial_messages=True,
        max_turns=64,
        model=str(model) if model else None,
        sandbox={
            "enabled": writable,
            "autoAllowBashIfSandboxed": False,
            "allowUnsandboxedCommands": False,
            "excludedCommands": [],
        },
        env={str(key): str(value) for key, value in dict(start.get("env") or {}).items()},
    )
    command_count = 1
    async with ClaudeSDKClient(options) as client:
        await client.query(str(start["prompt"]))

        async def controls() -> None:
            nonlocal command_count
            while command_count < MAX_COMMANDS:
                try:
                    command = await asyncio.to_thread(read_frame)
                except EOFError:
                    return
                command_count += 1
                kind = command.get("type")
                if kind == "interrupt":
                    await client.interrupt()
                    return
                if kind == "input":
                    text = command.get("prompt")
                    if not isinstance(text, str) or not text:
                        raise ValueError("Claude steering input requires a non-empty prompt")
                    await client.query(text)
                elif kind == "close":
                    return
                else:
                    raise ValueError(f"Unknown Claude sidecar command: {kind}")

        controls_task = asyncio.create_task(controls())
        try:
            async for message in client.receive_response():
                if isinstance(message, SystemMessage):
                    emit("metadata", sessionId=message.data.get("session_id"), model=message.data.get("model"))
                elif isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            emit("text", text=block.text)
                        elif isinstance(block, ToolUseBlock):
                            emit("tool", name=block.name, input=block.input)
                elif isinstance(message, ResultMessage):
                    emit(
                        "result", output=message.result or "", sessionId=message.session_id,
                        error=bool(message.is_error), turns=message.num_turns,
                        usage=message.usage, modelUsage=message.model_usage,
                    )
                    return
            emit("result", output="", error=True, turns=0, reason="Claude stream ended without a result")
        finally:
            controls_task.cancel()
            await asyncio.gather(controls_task, return_exceptions=True)


try:
    asyncio.run(main())
except BaseException as exc:
    emit("error", error=str(exc))
    raise SystemExit(1)
