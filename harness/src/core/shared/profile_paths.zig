const std = @import("std");

const Allocator = std.mem.Allocator;

pub const root_dir_name = ".fx";
pub const auth_file_name = "auth.json";
pub const chatgpt_auth_file_name = "chatgpt-auth.json";
pub const api_key_file_name = "api-key";
pub const sessions_dir_name = "sessions";
pub const prompt_history_file_name = "history.jsonl";
pub const usage_file_name = "usage.jsonl";
pub const usage_recovery_dir_name = "usage-recovery";
pub const backups_dir_name = "backups";
pub const mcp_credentials_dir_name = "mcp-credentials";
pub const mcp_credentials_file_name = "credentials.json";

const settings_file_name = "settings.json";
const mcp_config_file_name = "mcp.json";
const managed_skills_dir_name = "skills";
const memories_file_name = "memories.json";
const logs_dir_name = "logs";
const trace_log_file_name = "trace.log";
const recordings_dir_name = "recordings";

pub fn rootDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name });
}

pub fn settingsPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, settings_file_name });
}

pub fn mcpConfigPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, mcp_config_file_name });
}

pub fn mcpCredentialsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, mcp_credentials_dir_name });
}

pub fn mcpCredentialsPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{
        home,
        root_dir_name,
        mcp_credentials_dir_name,
        mcp_credentials_file_name,
    });
}

pub fn managedSkillsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, managed_skills_dir_name });
}

pub fn authPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, auth_file_name });
}

pub fn chatgptAuthPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, chatgpt_auth_file_name });
}

pub fn apiKeyPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, api_key_file_name });
}

pub fn sessionsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, sessions_dir_name });
}

pub fn promptHistoryPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, prompt_history_file_name });
}

pub fn memoriesPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, memories_file_name });
}

pub fn backupsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, backups_dir_name });
}

pub fn logsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, logs_dir_name });
}

pub fn traceLogPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, logs_dir_name, trace_log_file_name });
}

pub fn recordingsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, recordings_dir_name });
}

fn expectProfilePath(actual: []const u8, parts: []const []const u8) !void {
    const alloc = std.testing.allocator;
    const base = try std.fs.path.join(alloc, &.{ "/tmp/fake-home", ".fx" });
    defer alloc.free(base);
    var expected = try alloc.dupe(u8, base);
    defer alloc.free(expected);
    for (parts) |part| {
        const next = try std.fs.path.join(alloc, &.{ expected, part });
        alloc.free(expected);
        expected = next;
    }
    try std.testing.expectEqualStrings(expected, actual);
}

test "profile path helpers preserve current default locations" {
    const alloc = std.testing.allocator;

    const root = try rootDir(alloc, "/tmp/fake-home");
    defer alloc.free(root);
    try expectProfilePath(root, &.{});

    const settings = try settingsPath(alloc, "/tmp/fake-home");
    defer alloc.free(settings);
    try expectProfilePath(settings, &.{"settings.json"});

    const mcp = try mcpConfigPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp);
    try expectProfilePath(mcp, &.{"mcp.json"});

    const mcp_credentials_dir = try mcpCredentialsDir(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials_dir);
    try expectProfilePath(mcp_credentials_dir, &.{"mcp-credentials"});

    const mcp_credentials = try mcpCredentialsPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials);
    try expectProfilePath(mcp_credentials, &.{ "mcp-credentials", "credentials.json" });

    const skills = try managedSkillsDir(alloc, "/tmp/fake-home");
    defer alloc.free(skills);
    try expectProfilePath(skills, &.{"skills"});

    const auth = try authPath(alloc, "/tmp/fake-home");
    defer alloc.free(auth);
    try expectProfilePath(auth, &.{"auth.json"});

    const chatgpt_auth = try chatgptAuthPath(alloc, "/tmp/fake-home");
    defer alloc.free(chatgpt_auth);
    try expectProfilePath(chatgpt_auth, &.{"chatgpt-auth.json"});

    const api_key = try apiKeyPath(alloc, "/tmp/fake-home");
    defer alloc.free(api_key);
    try expectProfilePath(api_key, &.{"api-key"});

    const sessions = try sessionsDir(alloc, "/tmp/fake-home");
    defer alloc.free(sessions);
    try expectProfilePath(sessions, &.{"sessions"});

    const history = try promptHistoryPath(alloc, "/tmp/fake-home");
    defer alloc.free(history);
    try expectProfilePath(history, &.{"history.jsonl"});

    const memories = try memoriesPath(alloc, "/tmp/fake-home");
    defer alloc.free(memories);
    try expectProfilePath(memories, &.{"memories.json"});

    const backups = try backupsDir(alloc, "/tmp/fake-home");
    defer alloc.free(backups);
    try expectProfilePath(backups, &.{"backups"});

    const logs = try logsDir(alloc, "/tmp/fake-home");
    defer alloc.free(logs);
    try expectProfilePath(logs, &.{"logs"});

    const trace = try traceLogPath(alloc, "/tmp/fake-home");
    defer alloc.free(trace);
    try expectProfilePath(trace, &.{ "logs", "trace.log" });

    const recordings = try recordingsDir(alloc, "/tmp/fake-home");
    defer alloc.free(recordings);
    try expectProfilePath(recordings, &.{"recordings"});
}
