const std = @import("std");
const credentials = @import("credentials.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const io_mod = @import("../shared/io.zig");

const Allocator = std.mem.Allocator;

pub const SourceSet = std.EnumSet(credentials.Source);

fn sourceLabelOrMissing(source: ?credentials.Source) []const u8 {
    return credentials.sourceLabel(source orelse return "missing");
}

pub const FailureReason = enum {
    credential_refresh_failed,
    http_unauthorized,
};

pub const FailureSnapshot = struct {
    source: credentials.Source,
    reason: FailureReason,
    http_status: ?std.http.Status = null,

    pub fn fromHttp(status: std.http.Status, source: ?credentials.Source) ?FailureSnapshot {
        if (status != .unauthorized) return null;
        return .{
            .source = source orelse return null,
            .reason = .http_unauthorized,
            .http_status = status,
        };
    }

    /// Returns owned, detail-free text. The caller owns the returned slice.
    pub fn renderText(self: FailureSnapshot, alloc: Allocator) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();

        try out.writer.print("{s} {s}", .{
            credentials.sourceLabel(self.source),
            switch (self.reason) {
                .credential_refresh_failed => "credential refresh failed",
                .http_unauthorized => "authentication failed",
            },
        });
        if (self.http_status) |status| {
            try out.writer.print(" · HTTP {d}", .{@intFromEnum(status)});
        }
        return try out.toOwnedSlice();
    }

    /// Returns owned JSON containing only the shared auth-failure facts.
    pub fn renderJson(self: FailureSnapshot, alloc: Allocator) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();

        try self.writeJson(&out.writer);
        return try out.toOwnedSlice();
    }

    pub fn writeJson(self: FailureSnapshot, writer: *std.Io.Writer) !void {
        try writer.writeAll("{\"source\":");
        try std.json.Stringify.value(credentials.sourceLabel(self.source), .{}, writer);
        try writer.writeAll(",\"reason\":");
        try std.json.Stringify.value(@tagName(self.reason), .{}, writer);
        if (self.http_status) |status| {
            try writer.print(",\"http_status\":{d}", .{@intFromEnum(status)});
        }
        try writer.writeByte('}');
    }
};

pub const MissingHelpSurface = enum {
    cli,
    interactive,
};

pub const StatusSnapshot = struct {
    active_source: ?credentials.Source = null,

    pub fn activeSourceLabel(self: StatusSnapshot) []const u8 {
        return sourceLabelOrMissing(self.active_source);
    }

    pub fn missingHelp(self: StatusSnapshot, surface: MissingHelpSurface) ?[]const u8 {
        if (self.active_source != null) return null;
        return switch (surface) {
            .cli => credentials.missing_credential_message,
            .interactive => credentials.missing_interactive_credential_message,
        };
    }

    /// Returns owned doctor status text containing no credential bytes.
    pub fn formatDoctorDetail(self: StatusSnapshot, alloc: Allocator) ![]u8 {
        if (self.missingHelp(.cli)) |help| return alloc.dupe(u8, help);
        return std.fmt.allocPrint(alloc, "{s} is configured", .{self.activeSourceLabel()});
    }
};

pub fn loadStatusSnapshot(alloc: Allocator) !StatusSnapshot {
    var resolution = try credentials.resolve(alloc);
    const credential = &(resolution.credential orelse return .{});
    defer credential.deinit(alloc);
    return .{ .active_source = credential.source };
}

pub const View = struct {
    active_source: ?credentials.Source,

    pub fn activeSourceLabel(self: View) []const u8 {
        return sourceLabelOrMissing(self.active_source);
    }
};

pub const GatewayCredential = struct {
    api_key: []const u8,
    source: credentials.Source,
};

/// Owns the one credential for the process. Emma injects it through the
/// environment, so there is nothing to pick, refresh, or sign in to.
pub const Runtime = struct {
    const Self = @This();

    selected_credential: ?credentials.Credential = null,
    credential_refresh_failure_source: ?credentials.Source = null,
    source_inventory: SourceSet = .empty,

    pub fn init() Self {
        return .{};
    }

    pub fn deinit(self: *Self, alloc: Allocator) void {
        if (self.selected_credential) |*credential| credential.deinit(alloc);
        self.* = .{};
    }

    /// Borrows the current credential until this runtime replaces or releases it.
    pub fn gatewayCredential(self: *const Self) ?GatewayCredential {
        const credential = self.selected_credential orelse return null;
        return .{ .api_key = credential.token, .source = credential.source };
    }

    pub fn apiKey(self: *const Self) ?[]const u8 {
        const credential = self.gatewayCredential() orelse return null;
        return credential.api_key;
    }

    pub fn modelCatalogAccess(self: *const Self) credentials.CatalogAccess {
        if (self.credential_refresh_failure_source) |source| {
            return credentials.catalogAccessAfterRefreshFailure(source);
        }
        return credentials.catalogAccessAt(self.selected_credential, io_mod.milliTimestamp());
    }

    pub fn recordCredentialRefreshFailure(self: *Self, source: credentials.Source) void {
        std.debug.assert(self.credentialSource() == source);
        self.credential_refresh_failure_source = source;
    }

    pub fn credentialSource(self: *const Self) ?credentials.Source {
        const credential = self.selected_credential orelse return null;
        return credential.source;
    }

    pub fn credentialNeedsRefresh(_: *const Self) bool {
        return false;
    }

    pub fn statusSnapshot(self: *const Self) StatusSnapshot {
        return .{ .active_source = self.credentialSource() };
    }

    pub fn view(self: *const Self) View {
        return .{ .active_source = self.credentialSource() };
    }

    pub fn refreshSourceInventory(self: *Self, alloc: Allocator) !void {
        _ = alloc;
        var detected: SourceSet = .empty;
        if (credentials.sourceExists(.emma_provider_api_key)) {
            detected.insert(.emma_provider_api_key);
        }
        if (self.credentialSource()) |source| detected.insert(source);
        self.source_inventory = detected;
    }

    /// Moves the credential into this session and returns whether it changed.
    pub fn adoptCredential(self: *Self, alloc: Allocator, credential: *credentials.Credential) bool {
        const changed = if (self.selected_credential) |selected|
            selected.source != credential.source or
                !std.mem.eql(u8, selected.token, credential.token)
        else
            true;
        const source = credential.source;
        if (self.selected_credential) |*selected| selected.deinit(alloc);

        self.selected_credential = credential.*;
        self.credential_refresh_failure_source = null;
        credential.token = &.{};
        self.source_inventory.insert(source);
        return changed;
    }

    pub fn selectSource(self: *Self, alloc: Allocator, source: credentials.Source) !?bool {
        var credential = (try credentials.loadSource(alloc, source)) orelse return null;
        defer credential.deinit(alloc);
        return self.adoptCredential(alloc, &credential);
    }

    /// Re-reads the environment after the credential was rejected.
    pub fn reselectByPrecedence(self: *Self, alloc: Allocator) !bool {
        const previous = self.credentialSource();
        if (self.selected_credential) |*credential| credential.deinit(alloc);
        self.selected_credential = null;
        self.credential_refresh_failure_source = null;

        try self.refreshSourceInventory(alloc);
        if (try self.selectSource(alloc, .emma_provider_api_key) != null) {
            return self.credentialSource() != previous;
        }
        self.source_inventory.remove(.emma_provider_api_key);
        debug_trace.logf("auth", "no credential in {s}", .{credentials.api_key_env});
        return previous != null;
    }
};

test "auth failure snapshot names the selected source without exposing styling" {
    const snapshot = FailureSnapshot.fromHttp(.unauthorized, .emma_provider_api_key).?;
    const text = try snapshot.renderText(std.testing.allocator);
    defer std.testing.allocator.free(text);
    try std.testing.expectEqualStrings(
        credentials.api_key_env ++ " authentication failed · HTTP 401",
        text,
    );

    const json = try snapshot.renderJson(std.testing.allocator);
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.find(u8, json, "\"http_unauthorized\"") != null);

    try std.testing.expect(FailureSnapshot.fromHttp(.ok, .emma_provider_api_key) == null);
    try std.testing.expect(FailureSnapshot.fromHttp(.unauthorized, null) == null);
}

test "auth runtime adopts credential ownership and reports it once" {
    const alloc = std.testing.allocator;
    var runtime = Runtime.init();
    defer runtime.deinit(alloc);

    var credential = credentials.Credential{
        .token = try alloc.dupe(u8, "token"),
        .source = .emma_provider_api_key,
    };
    defer credential.deinit(alloc);

    try std.testing.expect(runtime.adoptCredential(alloc, &credential));
    try std.testing.expectEqualStrings("token", runtime.apiKey().?);
    try std.testing.expectEqual(credentials.Source.emma_provider_api_key, runtime.credentialSource().?);
    try std.testing.expect(runtime.modelCatalogAccess().publicOnlyReason() == null);

    runtime.recordCredentialRefreshFailure(.emma_provider_api_key);
    try std.testing.expectEqual(
        credentials.CatalogPublicOnlyReason.credential_refresh_failed,
        runtime.modelCatalogAccess().publicOnlyReason().?,
    );
}

test "auth status snapshot reports the missing-credential help per surface" {
    const missing = StatusSnapshot{};
    try std.testing.expectEqualStrings("missing", missing.activeSourceLabel());
    try std.testing.expect(missing.missingHelp(.cli) != null);
    try std.testing.expect(missing.missingHelp(.interactive) != null);

    const present = StatusSnapshot{ .active_source = .emma_provider_api_key };
    try std.testing.expect(present.missingHelp(.cli) == null);
    const detail = try present.formatDoctorDetail(std.testing.allocator);
    defer std.testing.allocator.free(detail);
    try std.testing.expectEqualStrings(credentials.api_key_env ++ " is configured", detail);
}
