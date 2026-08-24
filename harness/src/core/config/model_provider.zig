const std = @import("std");
const types = @import("../shared/types.zig");

/// Emma routes every model through one OpenAI-compatible endpoint, so the
/// provider seam has a single member. It is kept as a type rather than removed
/// so a second route can be added without re-threading every call site.
pub const ProviderId = enum {
    gateway,
};

pub const ProviderSelection = struct {
    provider: ProviderId,
    model: []const u8,
};

pub fn parse(value: []const u8) ?ProviderId {
    if (std.ascii.eqlIgnoreCase(value, "gateway")) return .gateway;
    return null;
}

pub fn label(provider: ProviderId) []const u8 {
    return switch (provider) {
        .gateway => "Emma provider",
    };
}

pub fn authorizesCredential(provider: ProviderId, source: ?types.CredentialSource) bool {
    _ = provider;
    return source != null;
}

pub fn usesGatewayAuxiliaries(provider: ProviderId) bool {
    return provider == .gateway;
}

test "the single provider authorizes any resolved credential" {
    try std.testing.expect(authorizesCredential(.gateway, .emma_provider_api_key));
    try std.testing.expect(!authorizesCredential(.gateway, null));
}

test "provider parsing exposes only the gateway route" {
    try std.testing.expectEqual(ProviderId.gateway, parse("gateway").?);
    try std.testing.expect(parse("codex") == null);
    try std.testing.expect(parse("") == null);
}
