const std = @import("std");
const gateway_client = @import("../../gateway/client.zig");
const gateway_json = @import("../../core/gateway/gateway_json.zig");
const io_mod = @import("../../core/shared/io.zig");
const session = @import("../../core/session/session.zig");
const types = @import("../../core/shared/types.zig");

const Allocator = std.mem.Allocator;

const single_attempt: usize = 1;
const default_timeout_ms: u32 = 30_000;
var default_post_ctx: u8 = 0;

pub const PostFn = *const fn (
    *Config,
    Allocator,
    []const u8,
    std.Io.Clock.Timestamp,
) anyerror!gateway_client.PostResult;

pub const Config = struct {
    api_key: []const u8,
    chat_url: []const u8,
    model: []const u8,
    cancel_flag: *std.atomic.Value(bool),
    timeout_ms: u32 = default_timeout_ms,
    post_ctx: *anyopaque = @ptrCast(&default_post_ctx),
    post_fn: PostFn = postBounded,
};

pub fn summarizer(config: *Config) session.Summarizer {
    return .{ .context = @ptrCast(config), .summarize_fn = summarize };
}

fn postBounded(
    config: *Config,
    alloc: Allocator,
    payload: []const u8,
    deadline: std.Io.Clock.Timestamp,
) anyerror!gateway_client.PostResult {
    const Operation = struct {
        alloc: Allocator,
        config: *Config,
        payload: []const u8,

        pub fn run(self: @This()) anyerror!gateway_client.PostResult {
            return gateway_client.postGatewayCompletion(
                self.alloc,
                self.config.api_key,
                self.config.model,
                single_attempt,
                self.config.chat_url,
                self.payload,
            );
        }
    };
    return gateway_client.runBoundedHttpOperation(
        gateway_client.PostResult,
        alloc,
        config.cancel_flag,
        deadline,
        Operation{ .alloc = alloc, .config = config, .payload = payload },
    );
}

fn summarize(raw_ctx: *anyopaque, alloc: Allocator, request: session.SummaryRequest) anyerror![]u8 {
    const config: *Config = @ptrCast(@alignCast(raw_ctx));
    if (config.api_key.len == 0 or config.chat_url.len == 0 or config.model.len == 0) {
        return error.CompactionGatewayUnconfigured;
    }
    if (config.cancel_flag.load(.seq_cst)) return error.Cancelled;

    const user_message = try session.buildCompactionUserMessage(alloc, request);
    defer alloc.free(user_message);

    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = session.compact_summary_system_prompt },
        .{ .role = .user, .content = user_message },
    };

    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(config.timeout_ms),
    });

    const payload = try gateway_json.buildGatewayRequestBodyWithOptionsAndBudget(
        alloc,
        "[]",
        &messages,
        .{},
        .none,
        @intCast(@max(request.max_chars / 4, 1)),
        .{ .deadline = deadline, .cancel_flag = config.cancel_flag },
    );
    defer alloc.free(payload);

    var result = try config.post_fn(config, alloc, payload, deadline);
    defer result.deinit(alloc);
    if (config.cancel_flag.load(.seq_cst)) return error.Cancelled;
    if (result.status != .ok) return error.CompactionGatewayStatus;

    const completion = try gateway_json.parseGatewayCompletion(alloc, result.body);
    defer gateway_json.freeGatewayCompletion(alloc, completion);
    const content = completion.content orelse return error.EmptyCompactionSummary;
    return alloc.dupe(u8, content);
}

const FakePost = struct {
    body: []const u8,
    status: std.http.Status = .ok,
    fail: bool = false,
    calls: usize = 0,
    seen_payload: []u8 = &.{},

    fn execute(
        config: *Config,
        alloc: Allocator,
        payload: []const u8,
        _: std.Io.Clock.Timestamp,
    ) anyerror!gateway_client.PostResult {
        const self: *FakePost = @ptrCast(@alignCast(config.post_ctx));
        self.calls += 1;
        if (self.seen_payload.len > 0) alloc.free(self.seen_payload);
        self.seen_payload = try alloc.dupe(u8, payload);
        if (self.fail) return error.HttpConnectionClosing;
        return .{ .status = self.status, .body = try alloc.dupe(u8, self.body) };
    }
};

test "gateway compaction summarizer returns the model summary" {
    const alloc = std.testing.allocator;
    var fake = FakePost{ .body =
        \\{"choices":[{"message":{"content":"## Goal\nship it"},"finish_reason":"stop"}]}
    };
    var cancel_flag = std.atomic.Value(bool).init(false);
    var config = Config{
        .api_key = "key",
        .chat_url = "https://example.test/chat",
        .model = "openai/gpt-5",
        .cancel_flag = &cancel_flag,
        .post_fn = FakePost.execute,
        .post_ctx = @ptrCast(&fake),
    };
    defer if (fake.seen_payload.len > 0) alloc.free(fake.seen_payload);

    const text = try summarize(@ptrCast(&config), alloc, .{ .conversation = "[User]: do the thing" });
    defer alloc.free(text);
    try std.testing.expectEqualStrings("## Goal\nship it", text);
    try std.testing.expectEqual(@as(usize, 1), fake.calls);
    try std.testing.expect(std.mem.indexOf(u8, fake.seen_payload, "\"maxOutputTokens\":300") != null);
    try std.testing.expect(std.mem.indexOf(u8, fake.seen_payload, "ONLY output the structured summary") != null);
    try std.testing.expect(std.mem.indexOf(u8, fake.seen_payload, "do the thing") != null);
}

test "gateway compaction summarizer refuses an unconfigured gateway and a cancelled turn" {
    const alloc = std.testing.allocator;
    var cancel_flag = std.atomic.Value(bool).init(false);
    var unconfigured = Config{
        .api_key = "",
        .chat_url = "",
        .model = "",
        .cancel_flag = &cancel_flag,
    };
    try std.testing.expectError(
        error.CompactionGatewayUnconfigured,
        summarize(@ptrCast(&unconfigured), alloc, .{ .conversation = "x" }),
    );

    cancel_flag.store(true, .seq_cst);
    var cancelled = Config{
        .api_key = "key",
        .chat_url = "https://example.test/chat",
        .model = "openai/gpt-5",
        .cancel_flag = &cancel_flag,
    };
    try std.testing.expectError(
        error.Cancelled,
        summarize(@ptrCast(&cancelled), alloc, .{ .conversation = "x" }),
    );
}

test "gateway compaction summarizer reports transport and status failures" {
    const alloc = std.testing.allocator;
    var cancel_flag = std.atomic.Value(bool).init(false);
    var failing = FakePost{ .body = "", .fail = true };
    var failing_config = Config{
        .api_key = "key",
        .chat_url = "https://example.test/chat",
        .model = "openai/gpt-5",
        .cancel_flag = &cancel_flag,
        .post_fn = FakePost.execute,
        .post_ctx = @ptrCast(&failing),
    };
    defer if (failing.seen_payload.len > 0) alloc.free(failing.seen_payload);
    try std.testing.expectError(
        error.HttpConnectionClosing,
        summarize(@ptrCast(&failing_config), alloc, .{ .conversation = "x" }),
    );

    var rejected = FakePost{ .body = "{}", .status = .too_many_requests };
    var rejected_config = Config{
        .api_key = "key",
        .chat_url = "https://example.test/chat",
        .model = "openai/gpt-5",
        .cancel_flag = &cancel_flag,
        .post_fn = FakePost.execute,
        .post_ctx = @ptrCast(&rejected),
    };
    defer if (rejected.seen_payload.len > 0) alloc.free(rejected.seen_payload);
    try std.testing.expectError(
        error.CompactionGatewayStatus,
        summarize(@ptrCast(&rejected_config), alloc, .{ .conversation = "x" }),
    );
}

test "gateway compaction summarizer forwards the previous summary for an iterative update" {
    const alloc = std.testing.allocator;
    var fake = FakePost{ .body =
        \\{"choices":[{"message":{"content":"## Goal\nstill shipping"},"finish_reason":"stop"}]}
    };
    var cancel_flag = std.atomic.Value(bool).init(false);
    var config = Config{
        .api_key = "key",
        .chat_url = "https://example.test/chat",
        .model = "openai/gpt-5",
        .cancel_flag = &cancel_flag,
        .post_fn = FakePost.execute,
        .post_ctx = @ptrCast(&fake),
    };
    defer if (fake.seen_payload.len > 0) alloc.free(fake.seen_payload);

    const text = try summarize(@ptrCast(&config), alloc, .{
        .conversation = "[User]: keep going",
        .previous_summary = "## Goal\nearlier goal",
    });
    defer alloc.free(text);
    try std.testing.expect(std.mem.indexOf(u8, fake.seen_payload, "earlier goal") != null);
    try std.testing.expect(std.mem.indexOf(u8, fake.seen_payload, "PRESERVE all existing information") != null);
}
