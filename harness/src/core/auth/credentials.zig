const std = @import("std");
const io_mod = @import("../shared/io.zig");
const secret = @import("secret.zig");
const types = @import("../shared/types.zig");

pub const Source = types.CredentialSource;

pub const api_key_env = "EMMA_PROVIDER_API_KEY";

pub const CatalogPublicOnly = union(enum) {
    no_credential,
    credential_refresh_failed: Source,
    authenticated_credential_rejected: Source,

    fn credentialSource(self: CatalogPublicOnly) ?Source {
        return switch (self) {
            .no_credential => null,
            .credential_refresh_failed => |source| source,
            .authenticated_credential_rejected => |source| source,
        };
    }
};

pub const CatalogPublicOnlyReason = std.meta.Tag(CatalogPublicOnly);

pub const CatalogAccess = union(enum) {
    public_only: CatalogPublicOnly,
    authenticated: struct {
        source: Source,
        credential: []const u8,
    },

    pub fn credentialSource(self: CatalogAccess) ?Source {
        return switch (self) {
            .public_only => |access| access.credentialSource(),
            .authenticated => |access| access.source,
        };
    }

    pub fn publicOnlyReason(self: CatalogAccess) ?CatalogPublicOnlyReason {
        const access = self.publicOnly() orelse return null;
        return std.meta.activeTag(access);
    }

    pub fn publicOnly(self: CatalogAccess) ?CatalogPublicOnly {
        return switch (self) {
            .public_only => |access| access,
            .authenticated => null,
        };
    }

    pub fn publicFallbackAfterRejection(self: CatalogAccess) ?CatalogAccess {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| .{
                .public_only = .{ .authenticated_credential_rejected = access.source },
            },
        };
    }

    pub fn authorizationCredential(self: CatalogAccess) ?[]const u8 {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| access.credential,
        };
    }
};

pub fn catalogAccessAt(credential: ?Credential, now_ms: i64) CatalogAccess {
    _ = now_ms;
    const selected = credential orelse return .{ .public_only = .no_credential };
    return catalogAccessForCredential(selected.source, selected.token);
}

pub fn catalogAccessAfterRefreshFailure(source: Source) CatalogAccess {
    return .{ .public_only = .{ .credential_refresh_failed = source } };
}

pub fn catalogAccessForCredential(source: ?Source, credential: []const u8) CatalogAccess {
    const selected_source = source orelse return .{ .public_only = .no_credential };
    return .{ .authenticated = .{ .source = selected_source, .credential = credential } };
}

pub const missing_credential_message = "emma-cli has no provider credential. Set " ++ api_key_env ++ ".";
pub const missing_interactive_credential_message = missing_credential_message;

pub const Credential = struct {
    token: []u8,
    source: Source,

    pub fn deinit(self: *Credential, alloc: std.mem.Allocator) void {
        secret.zeroAndFree(alloc, self.token);
        self.* = undefined;
    }

    pub fn needsRefreshAt(self: Credential, now_ms: i64) bool {
        _ = self;
        _ = now_ms;
        return false;
    }
};

pub const Resolution = struct {
    credential: ?Credential = null,
};

pub fn resolve(alloc: std.mem.Allocator) !Resolution {
    return .{ .credential = try loadSource(alloc, .emma_provider_api_key) };
}

pub fn loadSource(alloc: std.mem.Allocator, source: Source) !?Credential {
    const value = nonEmptyEnvValue(api_key_env) orelse return null;
    return .{ .token = try alloc.dupe(u8, value), .source = source };
}

pub fn sourceExists(source: Source) bool {
    _ = source;
    return nonEmptyEnvValue(api_key_env) != null;
}

fn nonEmptyEnvValue(name: []const u8) ?[]const u8 {
    const raw = io_mod.getenv(name) orelse return null;
    if (std.mem.trim(u8, raw, " \t\r\n").len == 0) return null;
    return raw;
}

pub fn sourceLabel(source: Source) []const u8 {
    return switch (source) {
        .emma_provider_api_key => api_key_env,
    };
}

var stable_credential_test_environ: ?*std.process.Environ.Map = null;

fn stableCredentialTestEnviron() !*const std.process.Environ.Map {
    if (stable_credential_test_environ) |map| return map;

    const alloc = std.heap.page_allocator;
    const map = try alloc.create(std.process.Environ.Map);
    map.* = std.process.Environ.Map.init(alloc);
    stable_credential_test_environ = map;
    return map;
}

const CredentialTestEnv = struct {
    alloc: std.mem.Allocator,
    map: std.process.Environ.Map,

    fn install(alloc: std.mem.Allocator, entries: []const [2][]const u8) !*CredentialTestEnv {
        _ = try stableCredentialTestEnviron();

        const self = try alloc.create(CredentialTestEnv);
        errdefer alloc.destroy(self);
        self.* = .{
            .alloc = alloc,
            .map = std.process.Environ.Map.init(alloc),
        };
        errdefer self.map.deinit();

        for (entries) |entry| try self.map.put(entry[0], entry[1]);
        io_mod.setEnvironMap(&self.map);
        return self;
    }

    fn deinit(self: *CredentialTestEnv) void {
        if (stable_credential_test_environ) |map| io_mod.setEnvironMap(map);
        self.map.deinit();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

test "catalog access isolates public and authenticated provider credentials" {
    const missing = catalogAccessAt(null, 0);
    try std.testing.expectEqual(CatalogPublicOnlyReason.no_credential, missing.publicOnlyReason().?);
    try std.testing.expect(missing.credentialSource() == null);
    try std.testing.expect(missing.authorizationCredential() == null);

    const refresh_failed = catalogAccessAfterRefreshFailure(.emma_provider_api_key);
    try std.testing.expectEqual(CatalogPublicOnlyReason.credential_refresh_failed, refresh_failed.publicOnlyReason().?);
    try std.testing.expectEqual(Source.emma_provider_api_key, refresh_failed.credentialSource().?);

    var credential = Credential{
        .token = try std.testing.allocator.dupe(u8, "token"),
        .source = .emma_provider_api_key,
    };
    defer credential.deinit(std.testing.allocator);

    const authenticated = catalogAccessAt(credential, 0);
    try std.testing.expect(authenticated.publicOnlyReason() == null);
    try std.testing.expectEqualStrings("token", authenticated.authorizationCredential().?);

    const fallback = authenticated.publicFallbackAfterRejection().?;
    try std.testing.expectEqual(CatalogPublicOnlyReason.authenticated_credential_rejected, fallback.publicOnlyReason().?);
    try std.testing.expect(fallback.authorizationCredential() == null);
    try std.testing.expect(fallback.publicFallbackAfterRejection() == null);
}

test "credential resolution reads only the emma provider environment variable" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ api_key_env, "api-key" },
        .{ "AI_GATEWAY_API_KEY", "stale-key" },
    });
    defer env.deinit();

    var resolution = try resolve(alloc);
    defer if (resolution.credential) |*credential| credential.deinit(alloc);
    const credential = resolution.credential orelse return error.TestExpectedCredential;
    try std.testing.expectEqualStrings("api-key", credential.token);
    try std.testing.expectEqual(Source.emma_provider_api_key, credential.source);
    try std.testing.expect(sourceExists(.emma_provider_api_key));
}

test "a blank credential is absent rather than empty" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{.{ api_key_env, "   " }});
    defer env.deinit();

    const resolution = try resolve(alloc);
    try std.testing.expect(resolution.credential == null);
    try std.testing.expect(!sourceExists(.emma_provider_api_key));
}
