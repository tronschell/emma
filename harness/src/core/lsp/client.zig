const std = @import("std");
const builtin = @import("builtin");
const debug_trace = @import("../shared/debug_trace.zig");
const io_mod = @import("../shared/io.zig");
const servers = @import("servers.zig");
const windows_job = if (builtin.os.tag == .windows)
    @import("../permissions/windows_job.zig")
else
    struct {};

const Allocator = std.mem.Allocator;

pub const max_frame_bytes: usize = 16 * 1024 * 1024;
const diagnostics_settle_ms: u32 = 1_500;
const progress_quiet_ms: u32 = 750;
const first_progress_ms: u32 = 1_000;

const Diagnostics = struct {
    text: []u8,
    stamp: u64,
};

pub const Error = error{
    LspSpawnFailed,
    LspConnectionClosed,
    LspTimeout,
    LspInvalidFrame,
    LspFrameTooLarge,
    LspServerError,
};

const Signal = struct {
    event: std.Io.Event = .unset,

    fn prepareLocked(self: *Signal) void {
        self.event.reset();
    }

    fn notifyLocked(self: *Signal) void {
        self.event.set(io_mod.getIo());
    }

    fn wait(self: *Signal, deadline: std.Io.Clock.Timestamp) void {
        self.event.waitTimeout(io_mod.getIo(), .{ .deadline = deadline }) catch {};
    }
};

const Pending = struct {
    response: ?[]u8 = null,
    failure: ?anyerror = null,
    signal: Signal = .{},
};

pub const Client = struct {
    alloc: Allocator,
    server: servers.Server,
    root: []u8,
    child: std.process.Child,
    child_id: std.process.Child.Id,
    stdin: ?std.Io.File,
    stdout: ?std.Io.File,
    job: if (builtin.os.tag == .windows) ?windows_job.Job else void,
    reader_thread: ?std.Thread = null,
    mutex: std.Io.Mutex = .init,
    write_mutex: std.Io.Mutex = .init,
    running: bool = true,
    next_id: i64 = 1,
    pending: std.AutoHashMap(i64, *Pending),
    diagnostics: std.StringHashMap(Diagnostics),
    diagnostics_stamp: u64 = 0,
    diagnostics_signal: Signal = .{},
    active_progress: usize = 0,
    progress_seen: bool = false,
    progress_signal: Signal = .{},

    pub fn spawn(alloc: Allocator, server: servers.Server, root: []const u8) !*Client {
        const executable = servers.executablePath(alloc, server.argv[0]) orelse
            return error.LspSpawnFailed;
        defer alloc.free(executable);

        var argv = try alloc.alloc([]const u8, server.argv.len);
        defer alloc.free(argv);
        argv[0] = executable;
        for (server.argv[1..], 1..) |value, index| argv[index] = value;

        var child = std.process.spawn(io_mod.getIo(), .{
            .argv = argv,
            .cwd = .{ .path = root },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .ignore,
            .start_suspended = builtin.os.tag == .windows,
        }) catch return error.LspSpawnFailed;

        var detached = false;
        var stdin: ?std.Io.File = null;
        var stdout: ?std.Io.File = null;

        var job: if (builtin.os.tag == .windows) ?windows_job.Job else void =
            if (comptime builtin.os.tag == .windows) null else {};
        errdefer {
            if (detached) {
                if (stdin) |file| file.close(io_mod.getIo());
                if (stdout) |file| file.close(io_mod.getIo());
            }
            if (comptime builtin.os.tag == .windows) {
                if (job) |*owned_job| owned_job.deinit();
            }
            if (child.id != null) child.kill(io_mod.getIo());
        }

        const child_id = child.id orelse return error.LspSpawnFailed;
        stdin = child.stdin orelse return error.LspSpawnFailed;
        stdout = child.stdout orelse return error.LspSpawnFailed;
        if (comptime builtin.os.tag == .windows) {
            job = windows_job.Job.init(child_id, true) catch |err| {
                debug_trace.logf(
                    "lsp",
                    "failed to assign language server to a Windows job err={s}",
                    .{@errorName(err)},
                );
                return error.LspSpawnFailed;
            };
            windows_job.Job.resumeThread(child.thread_handle) catch |err| {
                debug_trace.logf(
                    "lsp",
                    "failed to resume language server after Windows job assignment err={s}",
                    .{@errorName(err)},
                );
                return error.LspSpawnFailed;
            };
        }

        const self = try alloc.create(Client);
        errdefer alloc.destroy(self);
        const owned_root = try alloc.dupe(u8, root);
        errdefer alloc.free(owned_root);

        child.stdin = null;
        child.stdout = null;
        detached = true;
        self.* = .{
            .alloc = alloc,
            .server = server,
            .root = owned_root,
            .child = child,
            .child_id = child_id,
            .stdin = stdin.?,
            .stdout = stdout.?,
            .job = job,
            .pending = std.AutoHashMap(i64, *Pending).init(alloc),
            .diagnostics = std.StringHashMap(Diagnostics).init(alloc),
        };
        self.reader_thread = try std.Thread.spawn(.{}, readerMain, .{self});
        return self;
    }

    pub fn deinit(self: *Client) void {
        if (self.isRunning()) {
            const response = self.request("shutdown", "null", 2_000) catch null;
            if (response) |body| self.alloc.free(body);
            self.notify("exit", "null") catch {};
        }
        self.closeStdin();
        if (comptime builtin.os.tag == .windows) {
            if (self.job) |*job| {
                job.terminate();
            } else {
                terminateChild(self.child_id);
            }
        } else {
            terminateChild(self.child_id);
        }
        if (self.reader_thread) |thread| {
            thread.join();
            self.reader_thread = null;
        }
        _ = self.child.wait(io_mod.getIo()) catch {};
        if (comptime builtin.os.tag == .windows) {
            if (self.job) |*job| job.deinit();
            self.job = null;
        }
        self.closeStdout();

        var diagnostics = self.diagnostics.iterator();
        while (diagnostics.next()) |entry| {
            self.alloc.free(entry.key_ptr.*);
            self.alloc.free(entry.value_ptr.*.text);
        }
        self.diagnostics.deinit();
        self.pending.deinit();
        self.alloc.free(self.root);
        self.alloc.destroy(self);
    }

    fn isRunning(self: *Client) bool {
        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return self.running;
    }

    fn closeStdin(self: *Client) void {
        const io = io_mod.getIo();
        self.write_mutex.lockUncancelable(io);
        defer self.write_mutex.unlock(io);
        if (self.stdin) |file| file.close(io);
        self.stdin = null;
    }

    fn closeStdout(self: *Client) void {
        const io = io_mod.getIo();
        if (self.stdout) |file| file.close(io);
        self.stdout = null;
    }

    pub fn request(
        self: *Client,
        method: []const u8,
        params_json: []const u8,
        timeout_ms: u32,
    ) ![]u8 {
        const io = io_mod.getIo();
        const pending = try self.alloc.create(Pending);
        pending.* = .{};
        var pending_owned = true;
        defer if (pending_owned) self.alloc.destroy(pending);

        self.mutex.lockUncancelable(io);
        if (!self.running) {
            self.mutex.unlock(io);
            return error.LspConnectionClosed;
        }
        const id = self.next_id;
        self.next_id += 1;
        self.pending.put(id, pending) catch {
            self.mutex.unlock(io);
            return error.OutOfMemory;
        };
        self.mutex.unlock(io);

        errdefer {
            self.mutex.lockUncancelable(io);
            _ = self.pending.remove(id);
            self.mutex.unlock(io);
        }

        const frame = try std.fmt.allocPrint(
            self.alloc,
            "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":{f},\"params\":{s}}}",
            .{ id, std.json.fmt(method, .{}), params_json },
        );
        defer self.alloc.free(frame);
        try self.writeFrame(frame);

        const deadline = timestampFromNow(io, timeout_ms);

        self.mutex.lockUncancelable(io);
        while (pending.response == null and pending.failure == null) {
            pending.signal.prepareLocked();
            self.mutex.unlock(io);
            pending.signal.wait(deadline);
            self.mutex.lockUncancelable(io);
            if (pending.response != null or pending.failure != null) break;
            if (deadlineExpired(io, deadline)) {
                _ = self.pending.remove(id);
                self.mutex.unlock(io);
                return error.LspTimeout;
            }
        }
        _ = self.pending.remove(id);
        const response = pending.response;
        const failure = pending.failure;
        self.mutex.unlock(io);

        pending_owned = false;
        self.alloc.destroy(pending);
        if (failure) |err| return err;
        return response orelse error.LspConnectionClosed;
    }

    pub fn notify(self: *Client, method: []const u8, params_json: []const u8) !void {
        const frame = try std.fmt.allocPrint(
            self.alloc,
            "{{\"jsonrpc\":\"2.0\",\"method\":{f},\"params\":{s}}}",
            .{ std.json.fmt(method, .{}), params_json },
        );
        defer self.alloc.free(frame);
        try self.writeFrame(frame);
    }

    fn respond(self: *Client, id: std.json.Value, result_json: []const u8) !void {
        var id_text: std.Io.Writer.Allocating = .init(self.alloc);
        defer id_text.deinit();
        std.json.Stringify.value(id, .{}, &id_text.writer) catch return error.OutOfMemory;
        const frame = try std.fmt.allocPrint(
            self.alloc,
            "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}",
            .{ id_text.written(), result_json },
        );
        defer self.alloc.free(frame);
        try self.writeFrame(frame);
    }

    fn respondUnsupported(self: *Client, id: std.json.Value) !void {
        var id_text: std.Io.Writer.Allocating = .init(self.alloc);
        defer id_text.deinit();
        std.json.Stringify.value(id, .{}, &id_text.writer) catch return error.OutOfMemory;
        const frame = try std.fmt.allocPrint(
            self.alloc,
            "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32601,\"message\":\"unsupported\"}}}}",
            .{id_text.written()},
        );
        defer self.alloc.free(frame);
        try self.writeFrame(frame);
    }

    fn writeFrame(self: *Client, body: []const u8) !void {
        const io = io_mod.getIo();
        self.write_mutex.lockUncancelable(io);
        defer self.write_mutex.unlock(io);
        const writable = self.stdin orelse return error.LspConnectionClosed;
        var header_buf: [64]u8 = undefined;
        const header = std.fmt.bufPrint(
            &header_buf,
            "Content-Length: {d}\r\n\r\n",
            .{body.len},
        ) catch return error.LspInvalidFrame;
        writable.writeStreamingAll(io, header) catch return error.LspConnectionClosed;
        writable.writeStreamingAll(io, body) catch return error.LspConnectionClosed;
    }

    fn readerMain(self: *Client) void {
        var read_buf: [4096]u8 = undefined;
        const stdout = self.stdout orelse {
            self.failAll(error.LspConnectionClosed);
            return;
        };
        var file_reader = stdout.reader(io_mod.getIo(), &read_buf);

        while (true) {
            const frame = readFrame(self.alloc, &file_reader.interface) catch break;
            self.dispatchFrame(frame) catch {};
            self.alloc.free(frame);
        }
        self.failAll(error.LspConnectionClosed);
    }

    fn trackProgress(self: *Client, params: ?std.json.Value) void {
        const envelope = params orelse return;
        if (envelope != .object) return;
        const detail = envelope.object.get("value") orelse return;
        if (detail != .object) return;
        const kind = detail.object.get("kind") orelse return;
        if (kind != .string) return;

        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (std.mem.eql(u8, kind.string, "begin")) {
            self.active_progress += 1;
            self.progress_seen = true;
        } else if (std.mem.eql(u8, kind.string, "end")) {
            if (self.active_progress == 0) return;
            self.active_progress -= 1;
        } else return;
        self.progress_signal.notifyLocked();
    }

    pub fn waitUntilIdle(self: *Client, timeout_ms: u32) void {
        const io = io_mod.getIo();
        const deadline = timestampFromNow(io, timeout_ms);
        var quiet: ?std.Io.Clock.Timestamp = null;
        while (true) {
            self.mutex.lockUncancelable(io);
            if (!self.running or deadlineExpired(io, deadline)) {
                self.mutex.unlock(io);
                return;
            }
            if (self.active_progress > 0) {
                quiet = null;
            } else if (quiet) |limit| {
                if (deadlineExpired(io, limit)) {
                    self.mutex.unlock(io);
                    return;
                }
            } else {
                quiet = timestampFromNow(io, if (self.progress_seen) progress_quiet_ms else first_progress_ms);
            }
            self.progress_signal.prepareLocked();
            self.mutex.unlock(io);
            self.progress_signal.wait(if (quiet) |limit| limit else deadline);
        }
    }

    fn failAll(self: *Client, err: anyerror) void {
        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        self.running = false;
        var entries = self.pending.iterator();
        while (entries.next()) |entry| {
            entry.value_ptr.*.failure = err;
            entry.value_ptr.*.signal.notifyLocked();
        }
        self.diagnostics_signal.notifyLocked();
        self.progress_signal.notifyLocked();
        self.mutex.unlock(io);
    }

    fn dispatchFrame(self: *Client, frame: []u8) !void {
        var parsed = std.json.parseFromSlice(std.json.Value, self.alloc, frame, .{}) catch
            return error.LspInvalidFrame;
        defer parsed.deinit();
        if (parsed.value != .object) return error.LspInvalidFrame;
        const object = parsed.value.object;

        if (object.get("method")) |method| {
            if (method != .string) return error.LspInvalidFrame;
            if (object.get("id")) |id| {
                try self.handleServerRequest(id, method.string, object.get("params"));
                return;
            }
            if (std.mem.eql(u8, method.string, "textDocument/publishDiagnostics")) {
                try self.storeDiagnostics(object.get("params"));
            } else if (std.mem.eql(u8, method.string, "$/progress")) {
                self.trackProgress(object.get("params"));
            }
            return;
        }

        const id_value = object.get("id") orelse return;
        const id = switch (id_value) {
            .integer => |value| value,
            else => return,
        };

        const io = io_mod.getIo();
        const owned = try self.alloc.dupe(u8, frame);
        self.mutex.lockUncancelable(io);
        if (self.pending.get(id)) |pending| {
            pending.response = owned;
            pending.signal.notifyLocked();
            self.mutex.unlock(io);
            return;
        }
        self.mutex.unlock(io);
        self.alloc.free(owned);
    }

    fn handleServerRequest(
        self: *Client,
        id: std.json.Value,
        method: []const u8,
        params: ?std.json.Value,
    ) !void {
        if (std.mem.eql(u8, method, "workspace/configuration")) {
            var count: usize = 0;
            if (params) |value| {
                if (value == .object) {
                    if (value.object.get("items")) |items| {
                        if (items == .array) count = items.array.items.len;
                    }
                }
            }
            var out: std.Io.Writer.Allocating = .init(self.alloc);
            defer out.deinit();
            out.writer.writeAll("[") catch return error.OutOfMemory;
            for (0..count) |index| {
                if (index > 0) out.writer.writeAll(",") catch return error.OutOfMemory;
                out.writer.writeAll("null") catch return error.OutOfMemory;
            }
            out.writer.writeAll("]") catch return error.OutOfMemory;
            return self.respond(id, out.written());
        }
        if (std.mem.eql(u8, method, "workspace/workspaceFolders")) {
            const uri = try pathToUri(self.alloc, self.root);
            defer self.alloc.free(uri);
            const body = try std.fmt.allocPrint(
                self.alloc,
                "[{{\"uri\":{f},\"name\":{f}}}]",
                .{ std.json.fmt(uri, .{}), std.json.fmt(std.fs.path.basename(self.root), .{}) },
            );
            defer self.alloc.free(body);
            return self.respond(id, body);
        }
        if (std.mem.eql(u8, method, "client/registerCapability") or
            std.mem.eql(u8, method, "client/unregisterCapability") or
            std.mem.eql(u8, method, "window/workDoneProgress/create") or
            std.mem.eql(u8, method, "workspace/semanticTokens/refresh") or
            std.mem.eql(u8, method, "workspace/diagnostic/refresh") or
            std.mem.eql(u8, method, "workspace/codeLens/refresh") or
            std.mem.eql(u8, method, "workspace/inlayHint/refresh"))
        {
            return self.respond(id, "null");
        }
        return self.respondUnsupported(id);
    }

    fn storeDiagnostics(self: *Client, params: ?std.json.Value) !void {
        const value = params orelse return;
        if (value != .object) return;
        const uri_value = value.object.get("uri") orelse return;
        if (uri_value != .string) return;
        const list = value.object.get("diagnostics") orelse return;

        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        std.json.Stringify.value(list, .{}, &out.writer) catch return error.OutOfMemory;
        const encoded = try self.alloc.dupe(u8, out.written());
        errdefer self.alloc.free(encoded);

        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.diagnostics_stamp += 1;
        const stored = Diagnostics{ .text = encoded, .stamp = self.diagnostics_stamp };
        if (self.diagnostics.getEntry(uri_value.string)) |entry| {
            self.alloc.free(entry.value_ptr.*.text);
            entry.value_ptr.* = stored;
        } else {
            const key = try self.alloc.dupe(u8, uri_value.string);
            errdefer self.alloc.free(key);
            try self.diagnostics.put(key, stored);
        }
        self.diagnostics_signal.notifyLocked();
    }

    pub fn waitForDiagnostics(
        self: *Client,
        alloc: Allocator,
        uri: []const u8,
        timeout_ms: u32,
    ) !?[]u8 {
        const io = io_mod.getIo();
        const deadline = timestampFromNow(io, timeout_ms);
        const settle_ms = @min(timeout_ms, diagnostics_settle_ms);
        var settle_deadline = deadline;
        var seen_stamp: u64 = 0;
        var latest: ?[]u8 = null;
        errdefer if (latest) |owned| alloc.free(owned);

        while (true) {
            self.mutex.lockUncancelable(io);
            if (self.diagnostics.get(uri)) |stored| {
                if (latest == null or stored.stamp != seen_stamp) {
                    if (latest) |owned| alloc.free(owned);
                    latest = try alloc.dupe(u8, stored.text);
                    seen_stamp = stored.stamp;
                    settle_deadline = timestampFromNow(io, settle_ms);
                }
            }
            const running = self.running;
            self.diagnostics_signal.prepareLocked();
            self.mutex.unlock(io);

            if (!running) return latest;
            if (deadlineExpired(io, deadline)) return latest;
            if (latest != null and deadlineExpired(io, settle_deadline)) return latest;
            self.diagnostics_signal.wait(if (latest != null) settle_deadline else deadline);
        }
    }

    pub fn forgetDiagnostics(self: *Client, uri: []const u8) void {
        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.diagnostics.fetchRemove(uri)) |entry| {
            self.alloc.free(entry.key);
            self.alloc.free(entry.value.text);
        }
    }

    pub fn initialize(
        self: *Client,
        arena: Allocator,
        timeout_ms: u32,
        failure_message: *?[]const u8,
    ) !void {
        const uri = try pathToUri(self.alloc, self.root);
        defer self.alloc.free(uri);
        const params = try std.fmt.allocPrint(
            self.alloc,
            "{{\"processId\":null,\"clientInfo\":{{\"name\":\"emma-cli\"}}," ++
                "\"rootUri\":{f},\"rootPath\":{f}," ++
                "\"workspaceFolders\":[{{\"uri\":{f},\"name\":{f}}}]," ++
                "\"initializationOptions\":{s},\"capabilities\":{s}}}",
            .{
                std.json.fmt(uri, .{}),
                std.json.fmt(self.root, .{}),
                std.json.fmt(uri, .{}),
                std.json.fmt(std.fs.path.basename(self.root), .{}),
                try servers.initializationOptions(arena, self.server, self.root),
                client_capabilities,
            },
        );
        defer self.alloc.free(params);

        const response = try self.request("initialize", params, timeout_ms);
        defer self.alloc.free(response);

        var parsed = std.json.parseFromSlice(std.json.Value, arena, response, .{}) catch
            return error.LspInvalidFrame;
        defer parsed.deinit();
        if (parsed.value == .object) {
            if (parsed.value.object.get("error")) |failure| {
                if (failure == .object) {
                    if (failure.object.get("message")) |message| {
                        if (message == .string) {
                            failure_message.* = try arena.dupe(u8, message.string);
                        }
                    }
                }
                return error.LspServerError;
            }
        }
        try self.notify("initialized", "{}");
    }
};

const client_capabilities =
    \\{"general":{"positionEncodings":["utf-16"]},
    \\"workspace":{"workspaceFolders":true,"configuration":true,"symbol":{"dynamicRegistration":false}},
    \\"window":{"workDoneProgress":true},
    \\"textDocument":{"synchronization":{"dynamicRegistration":false,"didSave":false,"willSave":false},
    \\"publishDiagnostics":{"relatedInformation":false,"versionSupport":false},
    \\"diagnostic":{"dynamicRegistration":false,"relatedDocumentSupport":false},
    \\"hover":{"contentFormat":["plaintext","markdown"]},
    \\"definition":{"linkSupport":false},
    \\"typeDefinition":{"linkSupport":false},
    \\"implementation":{"linkSupport":false},
    \\"references":{"dynamicRegistration":false},
    \\"documentSymbol":{"hierarchicalDocumentSymbolSupport":true}}}
;

fn timestampFromNow(io: std.Io, milliseconds: u32) std.Io.Clock.Timestamp {
    return std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = .fromMilliseconds(milliseconds),
    });
}

fn deadlineExpired(io: std.Io, deadline: std.Io.Clock.Timestamp) bool {
    return std.Io.Clock.Timestamp.compare(deadline, .lte, timestampFromNow(io, 0));
}

fn terminateChild(child_id: std.process.Child.Id) void {
    if (comptime builtin.os.tag == .windows) {
        const Native = struct {
            extern "kernel32" fn TerminateProcess(
                process: std.os.windows.HANDLE,
                exit_code: u32,
            ) callconv(.winapi) std.os.windows.BOOL;
        };
        _ = Native.TerminateProcess(child_id, 1);
        return;
    }
    if (builtin.os.tag == .wasi) return;
    std.posix.kill(child_id, .TERM) catch |err| switch (err) {
        error.ProcessNotFound => {},
        else => debug_trace.logf(
            "lsp",
            "failed to terminate language server pid={d} err={s}",
            .{ child_id, @errorName(err) },
        ),
    };
}

fn readFrame(alloc: Allocator, reader: *std.Io.Reader) ![]u8 {
    var content_length: ?usize = null;
    var line: std.ArrayList(u8) = .empty;
    defer line.deinit(alloc);

    while (true) {
        line.clearRetainingCapacity();
        while (true) {
            var byte: [1]u8 = undefined;
            const count = try reader.readSliceShort(&byte);
            if (count == 0) return error.LspConnectionClosed;
            if (byte[0] == '\n') break;
            if (line.items.len > 1024) return error.LspInvalidFrame;
            try line.append(alloc, byte[0]);
        }
        const header = std.mem.trimEnd(u8, line.items, "\r");
        if (header.len == 0) break;
        if (std.ascii.startsWithIgnoreCase(header, "content-length:")) {
            const raw = std.mem.trim(u8, header["content-length:".len..], " \t");
            content_length = std.fmt.parseInt(usize, raw, 10) catch return error.LspInvalidFrame;
        }
    }

    const length = content_length orelse return error.LspInvalidFrame;
    if (length > max_frame_bytes) return error.LspFrameTooLarge;
    const body = try alloc.alloc(u8, length);
    errdefer alloc.free(body);
    try reader.readSliceAll(body);
    return body;
}

pub fn pathToUri(alloc: Allocator, path: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    out.writer.writeAll("file://") catch return error.OutOfMemory;
    for (path) |byte| {
        const unreserved = std.ascii.isAlphanumeric(byte) or switch (byte) {
            '-', '_', '.', '~', '/' => true,
            else => false,
        };
        if (unreserved) {
            out.writer.writeByte(byte) catch return error.OutOfMemory;
        } else {
            out.writer.print("%{X:0>2}", .{byte}) catch return error.OutOfMemory;
        }
    }
    return alloc.dupe(u8, out.written());
}

pub fn uriToPath(alloc: Allocator, uri: []const u8) ![]u8 {
    const body = if (std.mem.startsWith(u8, uri, "file://")) uri["file://".len..] else uri;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    var index: usize = 0;
    while (index < body.len) {
        if (body[index] == '%' and index + 2 < body.len) {
            const decoded = std.fmt.parseInt(u8, body[index + 1 .. index + 3], 16) catch {
                out.writer.writeByte(body[index]) catch return error.OutOfMemory;
                index += 1;
                continue;
            };
            out.writer.writeByte(decoded) catch return error.OutOfMemory;
            index += 3;
            continue;
        }
        out.writer.writeByte(body[index]) catch return error.OutOfMemory;
        index += 1;
    }
    return alloc.dupe(u8, out.written());
}

test "uri encoding round-trips paths that need escaping" {
    const alloc = std.testing.allocator;
    const uri = try pathToUri(alloc, "/tmp/a b/c#d/main.zig");
    defer alloc.free(uri);
    try std.testing.expectEqualStrings("file:///tmp/a%20b/c%23d/main.zig", uri);

    const path = try uriToPath(alloc, uri);
    defer alloc.free(path);
    try std.testing.expectEqualStrings("/tmp/a b/c#d/main.zig", path);
}

test "frames are read by content length and reject missing headers" {
    const alloc = std.testing.allocator;
    var reader: std.Io.Reader = .fixed("Content-Length: 7\r\n\r\n{\"a\":1}Content-Length: 2\r\n\r\n{}");
    const first = try readFrame(alloc, &reader);
    defer alloc.free(first);
    try std.testing.expectEqualStrings("{\"a\":1}", first);
    const second = try readFrame(alloc, &reader);
    defer alloc.free(second);
    try std.testing.expectEqualStrings("{}", second);

    var headerless: std.Io.Reader = .fixed("Content-Type: x\r\n\r\n{}");
    try std.testing.expectError(error.LspInvalidFrame, readFrame(alloc, &headerless));
}
