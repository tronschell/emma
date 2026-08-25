pub const ModelPromptOverlayFn = *const fn (model: []const u8) ?[]const u8;
pub const SystemPromptFn = *const fn () []const u8;

pub const Policy = struct {
    system_prompt: []const u8,
    /// Resolved per turn when set, so a prompt the user can edit on disk takes
    /// effect without rebuilding the compiled-in default.
    system_prompt_fn: ?SystemPromptFn = null,
    model_prompt_overlay_fn: ?ModelPromptOverlayFn = null,

    pub fn systemPrompt(self: Policy) []const u8 {
        const prompt_fn = self.system_prompt_fn orelse return self.system_prompt;
        return prompt_fn();
    }

    pub fn modelPromptOverlay(self: Policy, model: []const u8) ?[]const u8 {
        const overlay_fn = self.model_prompt_overlay_fn orelse return null;
        return overlay_fn(model);
    }
};

test "prompt policy resolves the supplied model overlay" {
    const Fixture = struct {
        fn overlay(model: []const u8) ?[]const u8 {
            return if (model.len > 0) "overlay" else null;
        }
    };
    const policy = Policy{
        .system_prompt = "system",
        .model_prompt_overlay_fn = Fixture.overlay,
    };

    try @import("std").testing.expectEqualStrings("overlay", policy.modelPromptOverlay("model").?);
    try @import("std").testing.expect(policy.modelPromptOverlay("") == null);
}
