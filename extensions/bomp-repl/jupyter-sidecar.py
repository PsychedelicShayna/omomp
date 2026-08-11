#!/usr/bin/env python3
"""Bounded NDJSON bridge around jupyter_client. No package installation or fallback kernels."""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback
from typing import Any

MAX_BYTES = 8 * 1024 * 1024
MAX_MESSAGES = 10_000
WRITE_LOCK = threading.Lock()
EXECUTE_TIMEOUT_SECONDS = 120
KERNELS: dict[str, tuple[Any, Any]] = {}


def emit(value: dict[str, Any]) -> None:
    line = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    with WRITE_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def error(request_id: str | None, exc: BaseException) -> None:
    emit({"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


def start_kernel(alias: str, kernel_name: str, cwd: str, env: dict[str, str]) -> tuple[Any, Any]:
    from jupyter_client import KernelManager
    old = KERNELS.pop(alias, None)
    if old:
        old[1].stop_channels()
        old[0].shutdown_kernel(now=True)
    manager = KernelManager(kernel_name=kernel_name)
    manager.start_kernel(cwd=cwd, env={**os.environ, **env})
    client = manager.client()
    client.start_channels()
    client.wait_for_ready(timeout=15)
    KERNELS[alias] = (manager, client)
    return manager, client


def execute(request_id: str, request: dict[str, Any]) -> None:
    try:
        alias = request["alias"]
        pair = KERNELS.get(alias)
        if pair is None:
            pair = start_kernel(alias, request["kernel_name"], request["cwd"], request.get("env", {}))
        _, client = pair
        msg_id = client.execute(request["code"], allow_stdin=True, stop_on_error=False)
        bundles: list[dict[str, Any]] = []
        text: list[str] = []
        byte_count = 0
        message_count = 0
        shell_reply: dict[str, Any] | None = None
        idle = False
        deadline = time.monotonic() + EXECUTE_TIMEOUT_SECONDS
        while not (idle and shell_reply is not None):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"kernel execution exceeded {EXECUTE_TIMEOUT_SECONDS}s")
            if message_count >= MAX_MESSAGES or byte_count >= MAX_BYTES:
                raise RuntimeError("kernel output exceeded sidecar bounds")
            if shell_reply is None:
                try:
                    reply = client.get_shell_msg(timeout=0.05)
                    if reply.get("parent_header", {}).get("msg_id") == msg_id:
                        shell_reply = reply
                except queue.Empty:
                    pass
            try:
                stdin_message = client.get_stdin_msg(timeout=0.01)
                if stdin_message.get("parent_header", {}).get("msg_id") == msg_id:
                    content = stdin_message.get("content", {})
                    emit({
                        "id": request_id,
                        "event": "stdin",
                        "prompt": str(content.get("prompt", "")),
                        "password": bool(content.get("password")),
                    })
                    client.input("")
            except queue.Empty:
                pass
            try:
                message = client.get_iopub_msg(timeout=0.1)
            except queue.Empty:
                continue
            if message.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            msg_type = message.get("header", {}).get("msg_type")
            content = message.get("content", {})
            if msg_type == "status" and content.get("execution_state") == "idle":
                idle = True
            elif msg_type == "stream":
                chunk = str(content.get("text", ""))
                text.append(chunk)
                byte_count += len(chunk.encode())
                emit({"id": request_id, "event": "chunk", "text": chunk})
            elif msg_type in ("display_data", "execute_result"):
                bundle = content.get("data", {})
                if isinstance(bundle, dict):
                    bundles.append(bundle)
                    byte_count += len(json.dumps(bundle).encode())
                    emit({"id": request_id, "event": "display", "data": bundle})
            elif msg_type == "error":
                chunk = "\n".join(content.get("traceback", [])) + "\n"
                text.append(chunk)
                byte_count += len(chunk.encode())
                emit({"id": request_id, "event": "chunk", "text": chunk})
            # input_request is delivered on the stdin channel and handled above.
        status = shell_reply.get("content", {}).get("status") if shell_reply else "error"
        emit({"id": request_id, "ok": status == "ok", "status": status, "text": "".join(text), "bundles": bundles})
    except BaseException as exc:
        error(request_id, exc)


def dispatch(request: dict[str, Any]) -> None:
    request_id = str(request.get("id", ""))
    try:
        operation = request.get("op")
        alias = str(request.get("alias", ""))
        if operation == "execute":
            threading.Thread(target=execute, args=(request_id, request), daemon=True).start()
            return
        if operation == "start":
            start_kernel(alias, request["kernel_name"], request["cwd"], request.get("env", {}))
        elif operation == "interrupt":
            pair = KERNELS.get(alias)
            if pair:
                pair[0].interrupt_kernel()
        elif operation == "restart":
            pair = KERNELS.get(alias)
            if not pair:
                raise KeyError(f"unknown kernel alias: {alias}")
            pair[1].stop_channels()
            pair[0].restart_kernel(now=True)
            client = pair[0].client()
            client.start_channels()
            client.wait_for_ready(timeout=15)
            KERNELS[alias] = (pair[0], client)
        elif operation == "shutdown":
            pair = KERNELS.pop(alias, None)
            if pair:
                pair[1].stop_channels()
                pair[0].shutdown_kernel(now=False)
        elif operation == "shutdown_all":
            shutdown_all()
        else:
            raise ValueError(f"unknown operation: {operation}")
        emit({"id": request_id, "ok": True})
    except BaseException as exc:
        error(request_id, exc)


def shutdown_all() -> None:
    for _, (manager, client) in list(KERNELS.items()):
        try:
            client.stop_channels()
            manager.shutdown_kernel(now=False)
        except BaseException:
            try:
                manager.shutdown_kernel(now=True)
            except BaseException:
                pass
    KERNELS.clear()


def main() -> None:
    try:
        import jupyter_client  # noqa: F401
    except BaseException as exc:
        error(None, exc)
        return
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise TypeError("request must be an object")
                dispatch(request)
            except BaseException as exc:
                error(None, exc)
    finally:
        shutdown_all()


if __name__ == "__main__":
    main()
