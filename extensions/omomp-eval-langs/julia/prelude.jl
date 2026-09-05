# OMP Julia prelude — loaded once into the runner's top-level scope (Main)
# right after julia/runner.jl starts, so every helper below is visible to cell
# code and survives for the lifetime of the kernel.
#
# Host access (`tool.*`, `agent()`, `completion()`, `wait()`, `workpool()`,
# `budget`) goes through the loopback HTTP tool bridge the Python backend owns
# (PI_TOOL_BRIDGE_URL / _TOKEN / _SESSION), using the same bridge op names as
# packages/coding-agent/src/eval/py/prelude.py:
#   __agent__ __completion__ __wait__ __status__ __cancel__ __workpool__ __budget__
#
# `agent()` and `completion()` return handles immediately; `wait(handles)`
# blocks. There is no `parallel()` / `pipeline()` — use handles and `wait`.

if !isdefined(Main, :__omp_prelude_loaded)
    global __omp_prelude_loaded = true
end

using Downloads

# ---------------------------------------------------------------------------
# Internal-URL path resolution
# ---------------------------------------------------------------------------

function __omp_url_decode(s::AbstractString)
    str = String(s)
    res = IOBuffer()
    i = 1
    len = ncodeunits(str)
    while i <= len
        c = Char(codeunit(str, i))
        if c == '%' && i + 2 <= len
            try
                write(res, parse(UInt8, str[i+1:i+2], base = 16))
                i += 3
                continue
            catch
                # not a valid escape; fall through and copy the '%' verbatim
            end
        end
        write(res, codeunit(str, i))
        i += 1
    end
    return String(take!(res))
end

"""
    __omp_resolve_path(path) -> String

Map an internal URL (`local://…`) onto its on-disk root as published by the
host in `PI_EVAL_LOCAL_ROOTS`; plain paths are returned absolute. Traversal out
of a root is refused.
"""
function __omp_resolve_path(p::AbstractString)
    path = String(p)
    m = match(r"^([a-z][a-z0-9+.\-]*)://(.*)$"i, path)
    if m === nothing
        return abspath(path)
    end
    scheme = lowercase(String(m.captures[1]))
    roots = try
        Main.json_parse(get(ENV, "PI_EVAL_LOCAL_ROOTS", "{}"))
    catch
        Dict{String, Any}()
    end
    root = roots isa AbstractDict ? get(roots, scheme, nothing) : nothing
    if root === nothing || isempty(String(root))
        error("Protocol paths are not supported by this helper: $path")
    end

    relative = __omp_url_decode(replace(String(m.captures[2]), '\\' => '/'))
    root_path = abspath(String(root))
    if isempty(relative)
        return root_path
    end
    if startswith(relative, '/') || ".." in split(relative, '/')
        error("Unsafe $scheme:// path (absolute or traversal): $path")
    end
    resolved = abspath(joinpath(root_path, relative))
    if resolved != root_path && !startswith(resolved, root_path * Base.Filesystem.path_separator)
        error("$scheme:// path escapes its root: $path")
    end
    return resolved
end

# ---------------------------------------------------------------------------
# Display + status frames
# ---------------------------------------------------------------------------

# `display(value)` needs no definition here: runner.jl pushes an `OmpDisplay`
# onto Julia's display stack, so plain `display(x)` emits a MIME bundle frame.

"""
    display_image(base64, mime_type = "image/png")

Emit an already-base64-encoded image as an inline display frame.
"""
function display_image(base64_str::AbstractString, mime_type::AbstractString = "image/png")
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(String(mime_type) => String(base64_str)),
    ))
    return nothing
end

"""
    __omp_emit_status(op, fields = Dict())

Emit one `application/x-omp-status` display frame — the channel the host
renders as read/write/agent/log/phase progress.
"""
function __omp_emit_status(op::AbstractString, fields::AbstractDict = Dict{String, Any}())
    status = Dict{String, Any}("op" => String(op))
    for (k, v) in fields
        status[string(k)] = v
    end
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict("application/x-omp-status" => status),
    ))
    return nothing
end

# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------

"""
    read(path, offset = 1, limit = nothing) -> String

Read a file (or an internal URL) as text, optionally sliced to a line range,
and report the read to the host. Replaces `Base.read(::AbstractString)`, whose
byte-vector result is not the eval contract.
"""
function Base.read(path::AbstractString, offset::Integer = 1, limit::Union{Integer, Nothing} = nothing)
    resolved = __omp_resolve_path(path)
    content = open(resolved, "r") do io
        Base.read(io, String)
    end
    if offset > 1 || limit !== nothing
        lines = split(content, '\n')
        st = max(1, Int(offset))
        en = limit === nothing ? length(lines) : min(length(lines), st + Int(limit) - 1)
        content = st <= length(lines) ? join(lines[st:en], '\n') : ""
    end
    __omp_emit_status("read", Dict{String, Any}(
        "path" => resolved,
        "chars" => length(content),
        "preview" => first(content, 500),
    ))
    return content
end

"""
    write(path, content) -> String

Write text to a file (or an internal URL), creating parent directories, and
report the write to the host. Returns the resolved path.
"""
function Base.write(path::AbstractString, content::Any)
    resolved = __omp_resolve_path(path)
    mkpath(dirname(resolved))
    text = string(content)
    open(resolved, "w") do io
        Base.write(io, text)
    end
    __omp_emit_status("write", Dict{String, Any}("path" => resolved, "chars" => length(text)))
    return resolved
end

function __omp_apply_query(data, query)
    if query === nothing || isempty(string(query))
        return data
    end
    q = strip(string(query))
    if startswith(q, ".")
        q = length(q) == 1 ? "" : q[2:end]
    end
    if isempty(q)
        return data
    end

    tokens = Vector{Tuple{Symbol, Any}}()
    buf = ""
    chars = collect(q)
    i = 1
    while i <= length(chars)
        ch = chars[i]
        if ch == '.'
            if !isempty(buf)
                push!(tokens, (:key, buf))
                buf = ""
            end
        elseif ch == '['
            if !isempty(buf)
                push!(tokens, (:key, buf))
                buf = ""
            end
            j = i + 1
            while j <= length(chars) && chars[j] != ']'
                j += 1
            end
            inner = j > i + 1 ? String(chars[(i + 1):(j - 1)]) : ""
            if startswith(inner, "\"") && endswith(inner, "\"")
                push!(tokens, (:key, length(inner) <= 2 ? "" : inner[2:end-1]))
            else
                push!(tokens, (:index, parse(Int, inner)))
            end
            i = j
        else
            buf *= string(ch)
        end
        i += 1
    end
    if !isempty(buf)
        push!(tokens, (:key, buf))
    end

    current = data
    for (kind, value) in tokens
        if kind === :index
            if !(current isa AbstractVector)
                return nothing
            end
            idx = Int(value)
            julia_idx = idx >= 0 ? idx + 1 : length(current) + idx + 1
            if julia_idx < 1 || julia_idx > length(current)
                return nothing
            end
            current = current[julia_idx]
        else
            key = string(value)
            if !(current isa AbstractDict) || !haskey(current, key)
                return nothing
            end
            current = current[key]
        end
    end
    return current
end

function __omp_json_text(value)
    if value === nothing
        return "null"
    end
    try
        return Main.json_serialize(value)
    catch
        return string(value)
    end
end

function __omp_optional_int(value, default::Int)
    if value === nothing
        return default
    elseif value isa Integer
        return Int(value)
    elseif value isa AbstractFloat
        return Int(trunc(value))
    elseif value isa AbstractString
        return parse(Int, value)
    end
    return Int(value)
end

"""
    output(ids...; format = "raw", query = nothing, offset = nothing, limit = nothing)

Read spilled tool output artifacts from the session's artifacts directory.
`format` is `"raw"`, `"stripped"` (ANSI removed) or `"json"` (metadata entry);
`query` selects into a JSON artifact and cannot be combined with offset/limit.
"""
function output(ids...; format = "raw", query = nothing, offset = nothing, limit = nothing)
    artifacts_dir = get(ENV, "PI_ARTIFACTS_DIR", "")
    if isempty(artifacts_dir)
        session_file = get(ENV, "PI_SESSION_FILE", "")
        if isempty(session_file)
            __omp_emit_status("output", Dict{String, Any}("error" => "No session file available"))
            error("No session - output artifacts unavailable")
        end
        artifacts_dir = replace(session_file, r"\.[^.]*$" => "")
    end
    if !isdir(artifacts_dir)
        __omp_emit_status("output", Dict{String, Any}("error" => "Artifacts directory not found", "path" => artifacts_dir))
        error("No artifacts directory found: $artifacts_dir")
    end
    if isempty(ids)
        __omp_emit_status("output", Dict{String, Any}("error" => "No IDs provided"))
        error("At least one output ID is required")
    end
    if query !== nothing && (offset !== nothing || limit !== nothing)
        __omp_emit_status("output", Dict{String, Any}("error" => "query cannot be combined with offset/limit"))
        error("query cannot be combined with offset/limit")
    end

    results = Vector{Dict{String, Any}}()
    not_found = String[]
    for output_id_value in ids
        output_id = string(output_id_value)
        output_path = joinpath(artifacts_dir, output_id * ".md")
        if !isfile(output_path)
            push!(not_found, output_id)
            continue
        end

        raw = open(output_path, "r") do io
            Base.read(io, String)
        end
        raw_lines = split(raw, '\n'; keepempty = true)
        total_lines = length(raw_lines)
        selected = raw
        range_info = nothing

        if query !== nothing
            json_value = try
                Main.json_parse(raw)
            catch err
                __omp_emit_status("output", Dict{String, Any}("id" => output_id, "error" => "Not valid JSON: $(err)"))
                error("Output $output_id is not valid JSON: $(err)")
            end
            selected = __omp_json_text(__omp_apply_query(json_value, query))
        elseif offset !== nothing || limit !== nothing
            start_line = max(1, __omp_optional_int(offset, 1))
            if start_line > total_lines
                __omp_emit_status("output", Dict{String, Any}("id" => output_id, "error" => "Offset $start_line beyond end ($total_lines lines)"))
                error("Offset $start_line is beyond end of output ($total_lines lines) for $output_id")
            end
            effective_limit = limit === nothing ? total_lines - start_line + 1 : __omp_optional_int(limit, total_lines - start_line + 1)
            end_line = min(total_lines, start_line + effective_limit - 1)
            selected = join(raw_lines[start_line:end_line], '\n')
            range_info = Dict{String, Any}("start_line" => start_line, "end_line" => end_line, "total_lines" => total_lines)
        end

        if format == "stripped"
            selected = replace(selected, r"\x1b\[[0-9;]*m" => "")
        end

        if format == "json"
            entry = Dict{String, Any}(
                "id" => output_id,
                "path" => output_path,
                "line_count" => query !== nothing ? length(split(selected, '\n')) : total_lines,
                "char_count" => query !== nothing ? length(selected) : length(raw),
                "content" => selected,
            )
            if range_info !== nothing
                entry["range"] = range_info
            end
            if query !== nothing
                entry["query"] = query
            end
            push!(results, entry)
        else
            push!(results, Dict{String, Any}("id" => output_id, "content" => selected))
        end
    end

    if !isempty(not_found)
        available = sort([replace(name, r"\.md$" => "") for name in readdir(artifacts_dir) if endswith(name, ".md")])
        msg = "Output not found: $(join(not_found, ", "))"
        if !isempty(available)
            shown = available[1:min(20, length(available))]
            msg *= "\n\nAvailable outputs: $(join(shown, ", "))"
            if length(available) > 20
                msg *= " (and $(length(available) - 20) more)"
            end
        end
        __omp_emit_status("output", Dict{String, Any}("not_found" => not_found, "available_count" => length(available)))
        error(msg)
    end

    if length(ids) == 1
        if format == "json"
            __omp_emit_status("output", Dict{String, Any}("id" => string(ids[1]), "chars" => results[1]["char_count"]))
            return results[1]
        end
        __omp_emit_status("output", Dict{String, Any}("id" => string(ids[1]), "chars" => length(results[1]["content"])))
        return results[1]["content"]
    end

    if format == "json"
        __omp_emit_status("output", Dict{String, Any}("count" => length(results), "total_chars" => sum(r["char_count"] for r in results)))
        return results
    end
    __omp_emit_status("output", Dict{String, Any}("count" => length(results), "total_chars" => sum(length(r["content"]) for r in results)))
    return results
end

"""
    env() -> Dict; env(key) -> value|nothing; env(key, value) -> value

Read or set one runtime environment variable, or snapshot all of them.
"""
function env(key = nothing, value = nothing)
    if key === nothing
        items = Dict{String, String}()
        for (k, v) in ENV
            items[k] = v
        end
        keys_list = sort(collect(keys(items)))
        __omp_emit_status("env", Dict{String, Any}(
            "count" => length(items),
            "keys" => keys_list[1:min(20, length(keys_list))],
        ))
        return items
    end

    k = string(key)
    if value !== nothing
        v = string(value)
        ENV[k] = v
        __omp_emit_status("env", Dict{String, Any}("key" => k, "value" => v, "action" => "set"))
        return v
    end

    v = get(ENV, k, nothing)
    __omp_emit_status("env", Dict{String, Any}("key" => k, "value" => v, "action" => "get"))
    return v
end

# ---------------------------------------------------------------------------
# Host tool bridge
# ---------------------------------------------------------------------------

const __OMP_INTENT_FIELD = "i"
# Slice length for a blocking `__wait__`. Every host call is bounded so a wait
# is a sequence of short requests rather than one arbitrarily long one: the
# kernel stays interruptible and no transport idle limit can strand it.
const __OMP_WAIT_SLICE_MS = 10_000
const __OMP_BRIDGE_DOWNLOADER = Ref{Union{Nothing, Downloads.Downloader}}(nothing)

"""
    __omp_bridge_easy_hook(easy, info)

Undo the parts of `Downloads`' libcurl defaults that are wrong for a blocking
host call.

`Downloads.Curl.set_defaults` installs `CURLOPT_LOW_SPEED_TIME = 20` with
`CURLOPT_LOW_SPEED_LIMIT = 1`, i.e. "abort the transfer if the peer sends less
than one byte per second for 20 seconds". A bridge call that blocks — `agent()`
work, `__wait__` on a subagent, a slow `tool.*` — sends no bytes at all until
it answers, so the stock client tore the connection down after ~20s and left
the host-side work orphaned. Zero disables the check outright; `CURLOPT_TIMEOUT`
is pinned to 0 (unlimited) for the same reason. The proxy is cleared because
this endpoint is a host-owned 127.0.0.1 socket that must always be reached
directly, mirroring the Python prelude's empty `ProxyHandler`.
"""
function __omp_bridge_easy_hook(easy, info)
    curl = Downloads.Curl
    curl.setopt(easy, curl.CURLOPT_LOW_SPEED_LIMIT, 0)
    curl.setopt(easy, curl.CURLOPT_LOW_SPEED_TIME, 0)
    curl.setopt(easy, curl.CURLOPT_TIMEOUT, 0)
    curl.setopt(easy, curl.CURLOPT_CONNECTTIMEOUT, 10)
    curl.setopt(easy, curl.CURLOPT_TCP_KEEPALIVE, 1)
    curl.setopt(easy, curl.CURLOPT_PROXY, "")
    return nothing
end

"""
    __omp_bridge_downloader() -> Downloads.Downloader

The kernel's single long-lived bridge client. Built with an infinite grace
period so its multi handle and pooled connections are never reaped between
cells, and with the easy hook above applied to every request.
"""
function __omp_bridge_downloader()
    downloader = __OMP_BRIDGE_DOWNLOADER[]
    if downloader === nothing
        downloader = Downloads.Downloader(grace = Inf)
        downloader.easy_hook = __omp_bridge_easy_hook
        __OMP_BRIDGE_DOWNLOADER[] = downloader
    end
    return downloader
end

function __omp_bridge_env()
    base = get(ENV, "PI_TOOL_BRIDGE_URL", "")
    token = get(ENV, "PI_TOOL_BRIDGE_TOKEN", "")
    session = get(ENV, "PI_TOOL_BRIDGE_SESSION", "")
    if isempty(base) || isempty(token) || isempty(session)
        error("tool bridge is unavailable in this kernel")
    end
    return (replace(base, r"/+$" => ""), token, session)
end

"""
    __omp_call_bridge(name, args) -> value

POST one request to the host tool bridge and return its `value`. Host-reported
failures (`{ok: false}`) are raised as Julia errors carrying the host message.
"""
function __omp_call_bridge(name::AbstractString, args)
    base, token, session = __omp_bridge_env()
    payload = Main.json_serialize(Dict{String, Any}(
        "session" => session,
        "run" => Main.current_rid,
        "name" => String(name),
        "args" => args,
    ))
    io_out = IOBuffer()
    response = Downloads.request(
        base * "/v1/tool";
        method = "POST",
        headers = ["Content-Type" => "application/json", "Authorization" => "Bearer $token"],
        input = IOBuffer(payload),
        output = io_out,
        downloader = __omp_bridge_downloader(),
        throw = false,
    )
    if response isa Downloads.RequestError
        error("bridge call $(repr(String(name))): transport failure: $(response.message)")
    end
    body = String(take!(io_out))
    data = try
        Main.json_parse(body)
    catch
        error("bridge call $(repr(String(name))): non-JSON response: $(repr(String(first(body, 200)))) (status $(response.status))")
    end
    if !(data isa AbstractDict) || get(data, "ok", false) !== true
        message = data isa AbstractDict ? get(data, "error", nothing) : nothing
        error(message === nothing ? "bridge call $(repr(String(name))) failed" : string(message))
    end
    return get(data, "value", nothing)
end

# ---------------------------------------------------------------------------
# Tool proxy — `tool.read(path = "...")`
# ---------------------------------------------------------------------------

struct OmpToolProxy end
struct OmpToolCallable
    name::String
end

function (callable::OmpToolCallable)(args = nothing; kwargs...)
    merged = Dict{String, Any}()
    if args isa AbstractDict
        for (k, v) in args
            merged[string(k)] = v
        end
    elseif args !== nothing
        error("tool.$(callable.name)(...) expects a Dict of arguments (got $(typeof(args)))")
    end
    for (k, v) in kwargs
        merged[string(k)] = v
    end
    if !haskey(merged, __OMP_INTENT_FIELD)
        merged[__OMP_INTENT_FIELD] = "jl prelude"
    end
    return __omp_call_bridge(callable.name, merged)
end

Base.show(io::IO, callable::OmpToolCallable) = print(io, "<tool.$(callable.name)>")

Base.getproperty(::OmpToolProxy, sym::Symbol) = OmpToolCallable(string(sym))
Base.getindex(::OmpToolProxy, name) = OmpToolCallable(string(name))
Base.propertynames(::OmpToolProxy) = Symbol[]

function Base.show(io::IO, ::OmpToolProxy)
    session = get(ENV, "PI_TOOL_BRIDGE_SESSION", "")
    print(io, isempty(session) ? "<tool proxy unavailable>" : "<tool proxy session=$session>")
end

const tool = OmpToolProxy()

# ---------------------------------------------------------------------------
# Handles — `agent()` / `completion()` return one immediately
# ---------------------------------------------------------------------------

struct OmpUnset end
const __OMP_UNSET = OmpUnset()

"""Raised for a handle the host reports as failed or cancelled."""
struct OmpHandleError <: Exception
    message::String
end
Base.showerror(io::IO, err::OmpHandleError) = print(io, err.message)

mutable struct AgentHandle
    const id::String
    const agent::Any
    const handle::String
    const schema::Any
    result::Any
end

mutable struct CompletionHandle
    const id::String
    const schema::Any
    result::Any
end

const OmpHandle = Union{AgentHandle, CompletionHandle}

__omp_handle_kind(::AgentHandle) = "agent"
__omp_handle_kind(::CompletionHandle) = "completion"
__omp_handle_ref(h::OmpHandle) = Dict{String, Any}("kind" => __omp_handle_kind(h), "id" => getfield(h, :id))
__omp_handle_settled(h::OmpHandle) = !(getfield(h, :result) isa OmpUnset)

function __omp_handle_status(h::OmpHandle)
    snapshot = __omp_call_bridge("__status__", Dict{String, Any}("item" => __omp_handle_ref(h)))
    return snapshot isa AbstractDict ? string(get(snapshot, "status", "failed")) : "failed"
end

function __omp_handle_cancel(h::OmpHandle)
    result = __omp_call_bridge("__cancel__", Dict{String, Any}("item" => __omp_handle_ref(h)))
    return result isa AbstractDict ? get(result, "cancelled", false) === true : false
end

"""
    __omp_resolve_snapshot(handle, snapshot)

Turn one `__wait__` snapshot into the handle's value, caching it on the handle.
A still-running snapshot means the caller's timeout expired.
"""
function __omp_resolve_snapshot(h::OmpHandle, snapshot)
    status = snapshot isa AbstractDict ? string(get(snapshot, "status", "failed")) : "failed"
    kind = __omp_handle_kind(h)
    id = getfield(h, :id)
    if status == "running"
        error("$kind handle $id is still running")
    end
    if status == "failed" || status == "cancelled"
        message = snapshot isa AbstractDict ? get(snapshot, "error", nothing) : nothing
        throw(OmpHandleError(message === nothing || isempty(string(message)) ? "$kind handle $id failed" : string(message)))
    end
    schema = getfield(h, :schema)
    value = if snapshot isa AbstractDict && haskey(snapshot, "data")
        snapshot["data"]
    else
        text = snapshot isa AbstractDict ? string(get(snapshot, "text", "")) : ""
        schema === nothing ? text : Main.json_parse(text)
    end
    setfield!(h, :result, value)
    return value
end

"""
    __omp_wait_snapshots(refs, timeout_ms) -> Vector

Block on the host `__wait__` op in `__OMP_WAIT_SLICE_MS` slices, dropping each
handle from the poll set as soon as it settles, and return one snapshot per ref
in input order. Slicing keeps every individual host request short-lived (the
kernel stays interruptible between slices) and keeps a settled result from
being re-consumed by a later slice.
"""
function __omp_wait_snapshots(refs::Vector{Any}, timeout_ms::Union{Nothing, Real})
    snapshots = Vector{Any}(nothing, length(refs))
    settled = falses(length(refs))
    started = time_ns()
    duration_ms = timeout_ms === nothing ? nothing : Float64(timeout_ms)
    while true
        pending = [i for i in eachindex(refs) if !settled[i]]
        if isempty(pending)
            return snapshots
        end
        slice_ms = Float64(__OMP_WAIT_SLICE_MS)
        if duration_ms !== nothing
            slice_ms = min(slice_ms, max(0.0, duration_ms - (time_ns() - started) / 1e6))
        end
        response = __omp_call_bridge("__wait__", Dict{String, Any}(
            "items" => Any[refs[i] for i in pending],
            "timeoutMs" => round(Int, slice_ms),
        ))
        items = response isa AbstractDict ? get(response, "items", nothing) : nothing
        if !(items isa AbstractVector) || length(items) != length(pending)
            error("wait() returned an incomplete handle result")
        end
        for (slot, i) in enumerate(pending)
            snapshots[i] = items[slot]
            status = items[slot] isa AbstractDict ? string(get(items[slot], "status", "failed")) : "failed"
            settled[i] = status != "running"
        end
        if all(settled) || (duration_ms !== nothing && (time_ns() - started) / 1e6 >= duration_ms)
            return snapshots
        end
    end
end

"""
    wait(handles; timeout = nothing, raise_errors = true) -> Vector

Wait for agent/completion handles and return their values in input order.
`timeout` is in seconds; with `raise_errors = false` a failed handle's error is
placed in its slot instead of being thrown.
"""
function Base.wait(handles::AbstractVector; timeout = nothing, raise_errors::Bool = true)
    items = collect(handles)
    for h in items
        if !(h isa AgentHandle || h isa CompletionHandle)
            throw(TypeError(:wait, "wait() expects agent or completion handles", OmpHandle, typeof(h)))
        end
    end
    results = Vector{Any}(nothing, length(items))
    pending_refs = Any[]
    pending_indexes = Int[]
    for (index, h) in enumerate(items)
        if __omp_handle_settled(h)
            results[index] = getfield(h, :result)
        else
            push!(pending_refs, __omp_handle_ref(h))
            push!(pending_indexes, index)
        end
    end
    if !isempty(pending_refs)
        snapshots = __omp_wait_snapshots(pending_refs, timeout === nothing ? nothing : max(0.0, Float64(timeout) * 1000))
        for (slot, index) in enumerate(pending_indexes)
            results[index] = try
                __omp_resolve_snapshot(items[index], snapshots[slot])
            catch err
                err isa OmpHandleError ? err : rethrow()
            end
        end
    end
    if raise_errors
        for result in results
            if result isa OmpHandleError
                throw(result)
            end
        end
    end
    return results
end

function Base.wait(h::AgentHandle; timeout = nothing, raise_errors::Bool = true)
    return Base.wait(Any[h]; timeout = timeout, raise_errors = raise_errors)[1]
end

function Base.wait(h::CompletionHandle; timeout = nothing, raise_errors::Bool = true)
    return Base.wait(Any[h]; timeout = timeout, raise_errors = raise_errors)[1]
end

function __omp_handle_wait(h::OmpHandle; timeout = nothing)
    if __omp_handle_settled(h)
        return getfield(h, :result)
    end
    return Base.wait(Any[h]; timeout = timeout)[1]
end

Base.fetch(h::AgentHandle) = __omp_handle_wait(h)
Base.fetch(h::CompletionHandle) = __omp_handle_wait(h)

# `h.status` reads live; `h.wait(...)`, `h.done()`, `h.cancel()`, `h.send(...)`
# and `h.output(...)` are callables, so cell code reads the same as the Python
# prelude's handle API.
function __omp_handle_property(h::OmpHandle, sym::Symbol)
    if sym === :status
        return __omp_handle_status(h)
    elseif sym === :done
        return () -> __omp_handle_status(h) != "running"
    elseif sym === :wait
        return (; timeout = nothing) -> __omp_handle_wait(h; timeout = timeout)
    elseif sym === :cancel
        return () -> __omp_handle_cancel(h)
    end
    return nothing
end

function Base.getproperty(h::AgentHandle, sym::Symbol)
    if sym === :id || sym === :agent || sym === :handle
        return getfield(h, sym)
    end
    if sym === :send
        return message -> __omp_call_bridge("hub", Dict{String, Any}(
            "op" => "send",
            "to" => getfield(h, :id),
            "message" => string(message),
            __OMP_INTENT_FIELD => "agent handle",
        ))
    end
    if sym === :output
        return (; kwargs...) -> output(getfield(h, :id); kwargs...)
    end
    value = __omp_handle_property(h, sym)
    value === nothing && return getfield(h, sym)
    return value
end

function Base.getproperty(h::CompletionHandle, sym::Symbol)
    if sym === :id
        return getfield(h, :id)
    end
    value = __omp_handle_property(h, sym)
    value === nothing && return getfield(h, sym)
    return value
end

Base.propertynames(::AgentHandle) = (:id, :agent, :handle, :status, :done, :wait, :cancel, :send, :output)
Base.propertynames(::CompletionHandle) = (:id, :status, :done, :wait, :cancel)

Base.show(io::IO, h::AgentHandle) = print(io, "<agent $(getfield(h, :id)) ($(getfield(h, :agent)))>")
Base.show(io::IO, h::CompletionHandle) = print(io, "<completion $(getfield(h, :id))>")

"""
    completion(prompt; model = "default", system = nothing, schema = nothing) -> CompletionHandle

Start a stateless one-shot completion (no history, no tools) and return its
handle immediately. `handle.wait()` or `wait([handle])` collects the text — or
the parsed object when `schema` was supplied.
"""
function completion(prompt::AbstractString; model = "default", system = nothing, schema = nothing)
    args = Dict{String, Any}("prompt" => String(prompt), "model" => model)
    system === nothing || (args["system"] = system)
    schema === nothing || (args["schema"] = schema)
    result = __omp_call_bridge("__completion__", args)
    if !(result isa AbstractDict) || !(get(result, "id", nothing) isa AbstractString)
        error("completion() did not return a handle")
    end
    return CompletionHandle(String(result["id"]), schema, __OMP_UNSET)
end

"""
    agent(prompt; agent = nothing, label = nothing, schema = nothing, schema_mode = nothing,
          isolated = nothing, apply = nothing, merge = nothing, tools = nothing) -> AgentHandle

Spawn a background subagent and return its handle immediately. Collect the
result with `handle.wait()` or `wait(handles)`.
"""
function agent(
    prompt::AbstractString;
    agent = nothing,
    label = nothing,
    schema = nothing,
    schema_mode = nothing,
    isolated = nothing,
    apply = nothing,
    merge = nothing,
    tools = nothing,
)
    args = Dict{String, Any}("prompt" => String(prompt))
    agent === nothing || (args["agent"] = agent)
    label === nothing || (args["label"] = label)
    schema === nothing || (args["schema"] = schema)
    schema_mode === nothing || (args["schemaMode"] = schema_mode)
    isolated === nothing || (args["isolated"] = Bool(isolated))
    apply === nothing || (args["apply"] = Bool(apply))
    merge === nothing || (args["merge"] = Bool(merge))
    tools === nothing || (args["tools"] = collect(tools))
    result = __omp_call_bridge("__agent__", args)
    if !(result isa AbstractDict) || !(get(result, "id", nothing) isa AbstractString)
        error("agent() did not return a handle")
    end
    id = String(result["id"])
    return AgentHandle(id, get(result, "agent", nothing), "agent://" * id, schema, __OMP_UNSET)
end

# ---------------------------------------------------------------------------
# Work pools
# ---------------------------------------------------------------------------

struct WorkPool
    name::String
    agent::Any
    limit::Any
end

function __omp_workpool_call(op::AbstractString, pool::WorkPool, extra::AbstractDict = Dict{String, Any}())
    args = Dict{String, Any}("op" => String(op), "name" => getfield(pool, :name))
    for (k, v) in extra
        args[string(k)] = v
    end
    return __omp_call_bridge("__workpool__", args)
end

"""
    push!(pool, items...) -> Vector

Queue string work items onto a pool; returns the host-assigned item ids.
"""
function Base.push!(pool::WorkPool, items...)
    for item in items
        item isa AbstractString || error("WorkPool push expects string items (got $(typeof(item)))")
    end
    result = __omp_workpool_call("push", pool, Dict{String, Any}("items" => Any[String(i) for i in items]))
    return result isa AbstractDict ? get(result, "ids", Any[]) : Any[]
end

function Base.getproperty(pool::WorkPool, sym::Symbol)
    if sym === :name || sym === :agent || sym === :limit
        return getfield(pool, sym)
    elseif sym === :push
        return (items...) -> push!(pool, items...)
    elseif sym === :status
        return () -> __omp_workpool_call("status", pool)
    elseif sym === :peek
        return () -> __omp_workpool_call("peek", pool)
    elseif sym === :close
        return () -> __omp_workpool_call("close", pool)
    end
    return getfield(pool, sym)
end

Base.propertynames(::WorkPool) = (:name, :agent, :limit, :push, :status, :peek, :close)
Base.close(pool::WorkPool) = __omp_workpool_call("close", pool)
Base.show(io::IO, pool::WorkPool) =
    print(io, "<workpool $(getfield(pool, :name)) ($(getfield(pool, :agent))) $(getfield(pool, :limit)) agents>")

"""
    workpool(agent = nothing; name = nothing, context = nothing, tools = nothing) -> WorkPool

Create a pool of keep-alive subagents. Push items with `pool.push(item, ...)`
or `push!(pool, item, ...)`; results are delivered as the pool's async job.
"""
function workpool(agent = nothing; name = nothing, context = nothing, tools = nothing)
    args = Dict{String, Any}("op" => "create")
    agent === nothing || (args["agent"] = agent)
    name === nothing || (args["name"] = name)
    context === nothing || (args["context"] = context)
    tools === nothing || (args["tools"] = collect(tools))
    result = __omp_call_bridge("__workpool__", args)
    if !(result isa AbstractDict) || !(get(result, "name", nothing) isa AbstractString)
        error("workpool() did not return a pool")
    end
    return WorkPool(String(result["name"]), get(result, "agent", nothing), get(result, "limit", nothing))
end

# ---------------------------------------------------------------------------
# Progress reporting
# ---------------------------------------------------------------------------

"""
    log(message)

Emit a status `log` event for TUI rendering.
"""
function Base.log(message::AbstractString)
    __omp_emit_status("log", Dict{String, Any}("message" => String(message)))
    return nothing
end

"""
    phase(title)

Record the current readable phase and emit a status `phase` event.
"""
function phase(title::AbstractString)
    global __omp_current_phase = String(title)
    __omp_emit_status("phase", Dict{String, Any}("title" => String(title)))
    return nothing
end

# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

struct OmpBudgetProxy end

function __omp_budget_snapshot()
    try
        snapshot = __omp_call_bridge("__budget__", Dict{String, Any}())
        return snapshot isa AbstractDict ? snapshot : Dict{String, Any}()
    catch
        return Dict{String, Any}()
    end
end

function __omp_budget_int(value, default::Int = 0)
    if value isa Integer
        return Int(value)
    elseif value isa AbstractFloat
        return Int(trunc(value))
    elseif value isa AbstractString
        parsed = tryparse(Int, value)
        return parsed === nothing ? default : parsed
    end
    return default
end

function Base.getproperty(::OmpBudgetProxy, sym::Symbol)
    if sym === :total
        return get(__omp_budget_snapshot(), "total", nothing)
    elseif sym === :hard
        return get(__omp_budget_snapshot(), "hard", false) === true
    elseif sym === :spent
        return () -> __omp_budget_int(get(__omp_budget_snapshot(), "spent", 0))
    elseif sym === :remaining
        return () -> begin
            snapshot = __omp_budget_snapshot()
            total = get(snapshot, "total", nothing)
            total === nothing && return Inf
            return max(0, __omp_budget_int(total) - __omp_budget_int(get(snapshot, "spent", 0)))
        end
    end
    error("Unknown budget metric: $sym")
end

Base.propertynames(::OmpBudgetProxy) = (:total, :hard, :spent, :remaining)

function Base.show(io::IO, ::OmpBudgetProxy)
    snapshot = __omp_budget_snapshot()
    if isempty(snapshot)
        print(io, "<budget unavailable>")
    else
        print(io, "<budget total=$(get(snapshot, "total", nothing)) spent=$(get(snapshot, "spent", 0))>")
    end
end

const budget = OmpBudgetProxy()
