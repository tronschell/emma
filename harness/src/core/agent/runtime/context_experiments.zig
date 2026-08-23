//! Experimental context-window hooks, applied to the message list of one model
//! step just before it is sent.
//!
//! Two levers, both off by default and both driven from Emma's Harness settings
//! page over `session/set_config_option`:
//!
//!   * reinject — append the turn's original prompt again, so a long tool run
//!     does not push the request itself out of the model's attention.
//!   * prune — replace older tool results with a placeholder, so the transcript
//!     the model re-reads every step stops growing without a summarization pass.
//!
//! Both act on the per-step projection only. Nothing here touches durable
//! history or execution memory: the next step rebuilds the projection from the
//! untouched originals, and the trigger is evaluated again against it.

const std = @import("std");
const types = @import("../../shared/types.zig");

const ChatMessage = types.ChatMessage;

/// The same estimate the rest of the stack uses when no provider count is in hand.
const chars_per_token: usize = 4;

pub const pruned_notice =
    "[pruned] This tool result was removed from the context window by an Emma context experiment. Run the tool again if you still need what it said.";

pub const reinject_prefix =
    "[reminder] This is the request you are working on, repeated unchanged so it stays in view:\n\n";

/// Zero means off, for every field. A step trigger fires on every Nth step; a
/// percent trigger fires on every step from the point the projection is that
/// full. Set both and either one fires.
pub const Settings = struct {
    reinject_prompt_steps: usize = 0,
    reinject_prompt_percent: usize = 0,
    prune_tools_steps: usize = 0,
    prune_tools_percent: usize = 0,
    /// The window the percent triggers are a percent *of*. The harness's own
    /// capability table only knows a handful of model prefixes, so Emma sends
    /// the real number; zero leaves the percent triggers inert.
    context_window_tokens: usize = 0,
    /// What the previous step's response was billed for, straight off
    /// `GatewayBilling`, and the only observation of the prompt cache the loop
    /// has in hand. Zero input means no observation — the first step of a turn,
    /// a model that does not cache, missing billing metadata — and every
    /// unknown reads as a cold cache, so pruning behaves as it always has.
    previous_cache_read_tokens: u64 = 0,
    previous_input_tokens: u64 = 0,

    pub fn enabled(self: Settings) bool {
        return self.reinject_prompt_steps != 0 or self.reinject_prompt_percent != 0 or
            self.prune_tools_steps != 0 or self.prune_tools_percent != 0;
    }
};

pub const Outcome = struct {
    estimated_tokens: usize = 0,
    percent_used: usize = 0,
    pruned_results: usize = 0,
    reinjected: bool = false,
    /// What the step's rewrite did to the projection, in the same ~4-chars-a-token
    /// estimate as `estimated_tokens`: pruning takes tokens out of the request,
    /// the reminder puts tokens back in. Reported per step because the effect is
    /// per step — the front end is the one that totals a thread.
    saved_tokens: usize = 0,
    added_tokens: usize = 0,

    pub fn changedAnything(self: Outcome) bool {
        return self.pruned_results != 0 or self.reinjected;
    }
};

/// Runs both levers against one step's messages, newest-first ordering assumed
/// (the list ends with the current step's tool results).
///
/// `step_index` is 1-based, so `reinject_prompt_steps = 15` fires on steps 15,
/// 30, and so on rather than on the first step of every turn.
pub fn apply(
    alloc: std.mem.Allocator,
    messages: *std.ArrayList(ChatMessage),
    settings: Settings,
    step_index: usize,
    original_prompt: []const u8,
) !Outcome {
    if (!settings.enabled()) return .{};

    var outcome: Outcome = .{ .estimated_tokens = estimateTokens(messages.items) };
    outcome.percent_used = percentUsed(outcome.estimated_tokens, settings.context_window_tokens);

    // Pruning first: the reminder is appended after it, so it is never the thing
    // that gets pruned, and both triggers are judged against the same estimate.
    //
    // The two prune triggers part company on a warm cache. Window pressure is a
    // resource limit, so it fires whatever the cache is doing — cache economics
    // must never be the reason a turn overflows its window. The periodic trigger
    // is only ever a cost optimization, and on a warm cache it is a losing one,
    // so it stands down and waits for the cache to cool.
    const prune_pressure = firesOnPercent(settings.prune_tools_percent, outcome.percent_used);
    const prune_hygiene = firesOnStep(settings.prune_tools_steps, step_index) and !cacheWasWarm(settings);
    if (prune_pressure or prune_hygiene) {
        const pruned = pruneToolResults(messages.items);
        outcome.pruned_results = pruned.results;
        // Net of the notices that replaced the bodies, and saturating: a tool
        // result shorter than the notice costs rather than saves, and a step that
        // saved nothing must not report a saving.
        outcome.saved_tokens = (pruned.characters -| pruned.results * pruned_notice.len) / chars_per_token;
    }
    if (original_prompt.len > 0 and
        fires(settings.reinject_prompt_steps, settings.reinject_prompt_percent, step_index, outcome.percent_used))
    {
        const reminder = try std.fmt.allocPrint(alloc, "{s}{s}", .{ reinject_prefix, original_prompt });
        try messages.append(alloc, .{ .role = .user, .content = reminder });
        outcome.reinjected = true;
        outcome.added_tokens = reminder.len / chars_per_token;
    }
    return outcome;
}

fn fires(every_steps: usize, at_percent: usize, step_index: usize, percent_used: usize) bool {
    return firesOnStep(every_steps, step_index) or firesOnPercent(at_percent, percent_used);
}

fn firesOnStep(every_steps: usize, step_index: usize) bool {
    return every_steps != 0 and step_index != 0 and step_index % every_steps == 0;
}

fn firesOnPercent(at_percent: usize, percent_used: usize) bool {
    return at_percent != 0 and percent_used >= at_percent;
}

/// Cache reads are a subset of the input tokens they are reported beside, so a
/// warm cache is one where the read covered at least this much of the input.
/// Half, because the trade only has to beat a coin flip: below half the prefix
/// is being re-processed at full price anyway, and pruning it is free money.
const warm_cache_input_share: u64 = 2;

/// Whether the previous step's prefix came back out of the provider's cache.
///
/// Prompt caching is prefix-based: rewriting a tool result in the middle of the
/// transcript invalidates every cached byte after it. On a warm cache that
/// trades a tenth-price cache read for a full-price re-processing of everything
/// downstream, which usually costs more than the pruned tokens save.
fn cacheWasWarm(settings: Settings) bool {
    if (settings.previous_input_tokens == 0) return false;
    return settings.previous_cache_read_tokens * warm_cache_input_share >= settings.previous_input_tokens;
}

pub fn estimateTokens(messages: []const ChatMessage) usize {
    var characters: usize = 0;
    for (messages) |message| {
        if (message.content) |content| characters += content.len;
        for (message.tool_calls) |call| characters += call.name.len + call.arguments_json.len;
    }
    return characters / chars_per_token;
}

fn percentUsed(estimated_tokens: usize, context_window_tokens: usize) usize {
    if (context_window_tokens == 0) return 0;
    return estimated_tokens * 100 / context_window_tokens;
}

/// Blanks every tool result except the newest block of them.
///
/// The newest block is the answer to the calls the model made on the step
/// before this one. Taking that away does not save context, it just makes the
/// model run the same calls again. The messages stay in place with their ids
/// intact, so the assistant call and its result are still paired — a provider
/// rejects a tool call whose result went missing.
fn pruneToolResults(messages: []ChatMessage) struct { results: usize, characters: usize } {
    var keep_from = messages.len;
    while (keep_from > 0 and messages[keep_from - 1].role == .tool) keep_from -= 1;

    var results: usize = 0;
    var characters: usize = 0;
    for (messages[0..keep_from]) |*message| {
        if (message.role != .tool) continue;
        const content = message.content orelse continue;
        if (std.mem.eql(u8, content, pruned_notice)) continue;
        message.content = pruned_notice;
        results += 1;
        characters += content.len;
    }
    return .{ .results = results, .characters = characters };
}

test "both levers stay off until they are configured" {
    const alloc = std.testing.allocator;
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .user, .content = "build the thing" });

    const outcome = try apply(alloc, &messages, .{}, 15, "build the thing");
    try std.testing.expect(!outcome.changedAnything());
    try std.testing.expectEqual(@as(usize, 1), messages.items.len);
}

test "the step trigger reinjects the prompt on every Nth step only" {
    const alloc = std.testing.allocator;
    const settings: Settings = .{ .reinject_prompt_steps = 15 };

    for ([_]usize{ 1, 14, 16 }) |step| {
        var messages: std.ArrayList(ChatMessage) = .empty;
        defer messages.deinit(alloc);
        try messages.append(alloc, .{ .role = .user, .content = "build the thing" });
        const outcome = try apply(alloc, &messages, settings, step, "build the thing");
        try std.testing.expect(!outcome.reinjected);
        try std.testing.expectEqual(@as(usize, 1), messages.items.len);
    }

    for ([_]usize{ 15, 30 }) |step| {
        var messages: std.ArrayList(ChatMessage) = .empty;
        defer messages.deinit(alloc);
        try messages.append(alloc, .{ .role = .user, .content = "build the thing" });
        const outcome = try apply(alloc, &messages, settings, step, "build the thing");
        defer alloc.free(messages.items[messages.items.len - 1].content.?);
        try std.testing.expect(outcome.reinjected);
        try std.testing.expectEqual(@as(usize, 2), messages.items.len);
        const appended = messages.items[1];
        try std.testing.expectEqual(types.ChatRole.user, appended.role);
        try std.testing.expect(std.mem.endsWith(u8, appended.content.?, "build the thing"));
    }
}

test "the percent trigger fires off the estimated projection size" {
    const alloc = std.testing.allocator;
    const body = try alloc.alloc(u8, 4_000);
    defer alloc.free(body);
    @memset(body, 'x');

    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .user, .content = body });

    // 4000 characters is ~1000 tokens, half of a 2000-token window.
    const outcome = try apply(alloc, &messages, .{
        .reinject_prompt_percent = 50,
        .context_window_tokens = 2_000,
    }, 3, "build the thing");
    defer alloc.free(messages.items[messages.items.len - 1].content.?);
    try std.testing.expectEqual(@as(usize, 1_000), outcome.estimated_tokens);
    try std.testing.expectEqual(@as(usize, 50), outcome.percent_used);
    try std.testing.expect(outcome.reinjected);

    var untriggered: std.ArrayList(ChatMessage) = .empty;
    defer untriggered.deinit(alloc);
    try untriggered.append(alloc, .{ .role = .user, .content = body });
    const below = try apply(alloc, &untriggered, .{
        .reinject_prompt_percent = 51,
        .context_window_tokens = 2_000,
    }, 3, "build the thing");
    try std.testing.expect(!below.reinjected);
}

test "an unknown context window leaves the percent triggers inert" {
    const alloc = std.testing.allocator;
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .user, .content = "build the thing" });

    const outcome = try apply(alloc, &messages, .{ .prune_tools_percent = 1, .reinject_prompt_percent = 1 }, 4, "build the thing");
    try std.testing.expect(!outcome.changedAnything());
}

test "pruning blanks older tool results and keeps the newest block" {
    const alloc = std.testing.allocator;
    const old_file = try alloc.alloc(u8, 4_000);
    defer alloc.free(old_file);
    @memset(old_file, 'x');
    var calls = [_]types.ToolCall{.{ .id = "call_1", .name = "read_file", .arguments_json = "{}" }};
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .user, .content = "build the thing" });
    try messages.append(alloc, .{ .role = .assistant, .content = "reading", .tool_calls = calls[0..] });
    try messages.append(alloc, .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = old_file });
    try messages.append(alloc, .{ .role = .assistant, .content = "reading again", .tool_calls = calls[0..] });
    try messages.append(alloc, .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = "the newest file, in full" });

    const outcome = try apply(alloc, &messages, .{ .prune_tools_steps = 2 }, 4, "build the thing");
    try std.testing.expectEqual(@as(usize, 1), outcome.pruned_results);
    // 4000 characters out, one 143-character notice back in, at ~4 chars a token.
    try std.testing.expectEqual(@as(usize, 964), outcome.saved_tokens);
    try std.testing.expectEqual(@as(usize, 0), outcome.added_tokens);
    try std.testing.expectEqualStrings(pruned_notice, messages.items[2].content.?);
    try std.testing.expectEqualStrings("the newest file, in full", messages.items[4].content.?);
    // The pairing a provider validates survives: id, name and a non-null body.
    try std.testing.expectEqualStrings("call_1", messages.items[2].tool_call_id.?);
    try std.testing.expectEqualStrings("read_file", messages.items[2].tool_name.?);

    // Pruning twice does not count the same result again.
    const second = try apply(alloc, &messages, .{ .prune_tools_steps = 2 }, 6, "build the thing");
    try std.testing.expectEqual(@as(usize, 0), second.pruned_results);
    try std.testing.expectEqual(@as(usize, 0), second.saved_tokens);
}

test "a tool result smaller than the notice reports no saving" {
    const alloc = std.testing.allocator;
    var calls = [_]types.ToolCall{.{ .id = "call_1", .name = "read_file", .arguments_json = "{}" }};
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .assistant, .content = "reading", .tool_calls = calls[0..] });
    try messages.append(alloc, .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = "ok" });
    try messages.append(alloc, .{ .role = .assistant, .content = "done" });

    const outcome = try apply(alloc, &messages, .{ .prune_tools_steps = 1 }, 1, "");
    try std.testing.expectEqual(@as(usize, 1), outcome.pruned_results);
    try std.testing.expectEqual(@as(usize, 0), outcome.saved_tokens);
}

/// Two tool results, the older one prunable, in the ordering `pruneToolResults`
/// expects. Every cache-temperature test needs the same shape.
fn appendPrunableTranscript(alloc: std.mem.Allocator, messages: *std.ArrayList(ChatMessage), old_file: []const u8) !void {
    const calls = &[_]types.ToolCall{.{ .id = "call_1", .name = "read_file", .arguments_json = "{}" }};
    try messages.append(alloc, .{ .role = .assistant, .content = "reading", .tool_calls = calls });
    try messages.append(alloc, .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = old_file });
    try messages.append(alloc, .{ .role = .assistant, .content = "reading again", .tool_calls = calls });
    try messages.append(alloc, .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = "the newest file, in full" });
}

test "a warm cache stands the periodic prune down" {
    const alloc = std.testing.allocator;
    const old_file = try alloc.alloc(u8, 4_000);
    defer alloc.free(old_file);
    @memset(old_file, 'x');

    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try appendPrunableTranscript(alloc, &messages, old_file);

    // Half the input read back out of the cache is warm enough to wait.
    const outcome = try apply(alloc, &messages, .{
        .prune_tools_steps = 2,
        .previous_cache_read_tokens = 5_000,
        .previous_input_tokens = 10_000,
    }, 4, "build the thing");
    try std.testing.expectEqual(@as(usize, 0), outcome.pruned_results);
    try std.testing.expectEqual(@as(usize, 0), outcome.saved_tokens);
    try std.testing.expect(!outcome.changedAnything());
    try std.testing.expectEqualStrings(old_file, messages.items[1].content.?);

    // One token short of half is cold, and prunes as it always did.
    var cooled: std.ArrayList(ChatMessage) = .empty;
    defer cooled.deinit(alloc);
    try appendPrunableTranscript(alloc, &cooled, old_file);
    const cold = try apply(alloc, &cooled, .{
        .prune_tools_steps = 2,
        .previous_cache_read_tokens = 4_999,
        .previous_input_tokens = 10_000,
    }, 4, "build the thing");
    try std.testing.expectEqual(@as(usize, 1), cold.pruned_results);
}

test "a warm cache never stands the window-pressure prune down" {
    const alloc = std.testing.allocator;
    const old_file = try alloc.alloc(u8, 4_000);
    defer alloc.free(old_file);
    @memset(old_file, 'x');

    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try appendPrunableTranscript(alloc, &messages, old_file);

    // The same warm cache as above, and the step trigger firing alongside the
    // percent one: an overflow is not a price the cache gets to negotiate.
    const outcome = try apply(alloc, &messages, .{
        .prune_tools_steps = 2,
        .prune_tools_percent = 50,
        .context_window_tokens = 2_000,
        .previous_cache_read_tokens = 10_000,
        .previous_input_tokens = 10_000,
    }, 4, "build the thing");
    try std.testing.expect(outcome.percent_used >= 50);
    try std.testing.expectEqual(@as(usize, 1), outcome.pruned_results);
    try std.testing.expectEqualStrings(pruned_notice, messages.items[1].content.?);
}

test "unknown billing prunes exactly as it did before the cache gate" {
    const alloc = std.testing.allocator;
    const old_file = try alloc.alloc(u8, 4_000);
    defer alloc.free(old_file);
    @memset(old_file, 'x');

    // Nothing observed, a cache read with no input to be a share of, and a step
    // that read nothing back: every one of them is cold.
    const unknown = [_]Settings{
        .{ .prune_tools_steps = 2 },
        .{ .prune_tools_steps = 2, .previous_cache_read_tokens = 9_000 },
        .{ .prune_tools_steps = 2, .previous_input_tokens = 10_000 },
    };
    for (unknown) |settings| {
        var messages: std.ArrayList(ChatMessage) = .empty;
        defer messages.deinit(alloc);
        try appendPrunableTranscript(alloc, &messages, old_file);
        const outcome = try apply(alloc, &messages, settings, 4, "build the thing");
        try std.testing.expectEqual(@as(usize, 1), outcome.pruned_results);
        try std.testing.expectEqual(@as(usize, 964), outcome.saved_tokens);
    }
}

test "the reminder reports what it put back in" {
    const alloc = std.testing.allocator;
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(alloc);
    try messages.append(alloc, .{ .role = .user, .content = "build the thing" });

    const outcome = try apply(alloc, &messages, .{ .reinject_prompt_steps = 1 }, 1, "build the thing");
    defer alloc.free(messages.items[messages.items.len - 1].content.?);
    // The 92-character prefix plus the prompt itself, at ~4 chars a token.
    try std.testing.expectEqual(@as(usize, 26), outcome.added_tokens);
    try std.testing.expectEqual(@as(usize, 0), outcome.saved_tokens);
}
