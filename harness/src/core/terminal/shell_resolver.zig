const std = @import("std");
const builtin = @import("builtin");
const contracts = @import("contracts.zig");
const command_environment = @import("../execution/command_environment.zig");
const io_mod = @import("../shared/io.zig");
const windows_paths = if (builtin.os.tag == .windows)
    @import("../shared/windows_paths.zig")
else
    struct {};

const Allocator = std.mem.Allocator;
const windows_cmd_path = "C:\\Windows\\System32\\cmd.exe";
const windows_powershell_path = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const windows_pwsh_suffix = "\\PowerShell\\7\\pwsh.exe";
const windows_pwsh_app_suffix = "\\Microsoft\\WindowsApps\\pwsh.exe";

pub const windows_agent_shell_flags = [_][]const u8{ "-NoLogo", "-NoProfile", "-NonInteractive", "-Command" };

const windows_script_prelude =
    "$fx_utf8 = [Text.UTF8Encoding]::new($false); " ++
    "[Console]::InputEncoding = $fx_utf8; " ++
    "[Console]::OutputEncoding = $fx_utf8; " ++
    "$OutputEncoding = $fx_utf8\r\n";

const windows_script_epilogue =
    "\r\nexit $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })";

pub const ResolveError = error{
    MissingLoginShell,
    RelativeShellPath,
    UnsupportedShell,
};

pub const Profile = command_environment.Profile;
pub const Environment = command_environment.Environment;

const ShellKind = enum { bash, zsh, cmd, powershell };

fn shellBasename(path: []const u8) []const u8 {
    var index = path.len;
    while (index > 0) {
        index -= 1;
        if (path[index] == '/' or path[index] == '\\') return path[index + 1 ..];
    }
    return path;
}

fn shellNameIs(path: []const u8, name: []const u8) bool {
    return std.ascii.eqlIgnoreCase(shellBasename(path), name);
}

fn shellKind(path: []const u8) ?ShellKind {
    if (shellNameIs(path, "bash")) return .bash;
    if (shellNameIs(path, "zsh")) return .zsh;
    if (shellNameIs(path, "cmd") or shellNameIs(path, "cmd.exe")) return .cmd;
    if (shellNameIs(path, "powershell") or shellNameIs(path, "powershell.exe") or
        shellNameIs(path, "pwsh") or shellNameIs(path, "pwsh.exe")) return .powershell;
    return null;
}

fn fallbackLoginShell() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "/bin/zsh",
        .windows => windows_powershell_path,
        else => "/bin/bash",
    };
}

fn absoluteFileExists(path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io_mod.getIo(), path, .{}) catch return false;
    return true;
}

fn copyInto(buffer: []u8, value: []const u8) ?[]const u8 {
    if (value.len > buffer.len) return null;
    @memcpy(buffer[0..value.len], value);
    return buffer[0..value.len];
}

fn windowsPwshInto(buffer: []u8) ?[]const u8 {
    const roots = [_]struct { key: []const u8, suffix: []const u8 }{
        .{ .key = "ProgramW6432", .suffix = windows_pwsh_suffix },
        .{ .key = "ProgramFiles", .suffix = windows_pwsh_suffix },
        .{ .key = "ProgramFiles(x86)", .suffix = windows_pwsh_suffix },
        .{ .key = "LOCALAPPDATA", .suffix = windows_pwsh_app_suffix },
    };
    var candidate: [32768]u8 = undefined;
    for (roots) |root| {
        const value = io_mod.getenv(root.key) orelse continue;
        const trimmed = std.mem.trimEnd(u8, value, "\\/");
        if (trimmed.len == 0) continue;
        const path = std.fmt.bufPrint(&candidate, "{s}{s}", .{ trimmed, root.suffix }) catch continue;
        if (!std.fs.path.isAbsolute(path) or !absoluteFileExists(path)) continue;
        return copyInto(buffer, path);
    }
    return null;
}

pub fn windowsAgentShellInto(buffer: []u8) []const u8 {
    if (comptime builtin.os.tag != .windows) return fallbackLoginShell();
    if (windowsPwshInto(buffer)) |path| return path;
    var trusted: [32768]u8 = undefined;
    const system = windows_paths.system32ExecutableInto(
        &trusted,
        "WindowsPowerShell\\v1.0\\powershell.exe",
    ) catch null;
    if (system) |path| {
        if (absoluteFileExists(path)) {
            if (copyInto(buffer, path)) |copied| return copied;
        }
    }
    return copyInto(buffer, windows_powershell_path) orelse windows_powershell_path;
}

pub fn windowsAgentScript(alloc: Allocator, command: []const u8) Allocator.Error![]u8 {
    return std.mem.concat(alloc, u8, &.{
        windows_script_prelude,
        command,
        windows_script_epilogue,
    });
}

pub fn preparedCommand(
    alloc: Allocator,
    shell_path: []const u8,
    command: []const u8,
) Allocator.Error![]const u8 {
    if (shellKind(shell_path) != .powershell) return command;
    return windowsAgentScript(alloc, command);
}

fn supportedLoginShell(configured_login_shell: ?[]const u8) ResolveError![]const u8 {
    const path = configured_login_shell orelse return error.MissingLoginShell;
    if (!std.fs.path.isAbsolute(path)) return error.RelativeShellPath;
    if (shellKind(path) != null) return path;
    return fallbackLoginShell();
}

pub const Invocation = struct {
    path: []const u8,
    values: [6][]const u8 = @splat(""),
    len: usize = 0,

    pub fn argv(self: *const Invocation) []const []const u8 {
        return self.values[0..self.len];
    }

    fn append(self: *Invocation, value: []const u8) void {
        self.values[self.len] = value;
        self.len += 1;
    }

    pub fn setCommand(self: *Invocation, command: []const u8) void {
        const kind = shellKind(self.path) orelse .bash;
        self.append(if (kind == .cmd) "/c" else if (kind == .powershell) "-Command" else "-c");
        self.append(command);
    }
};

pub fn resolve(
    configured_login_shell: ?[]const u8,
    shell: contracts.ShellSpec,
) ResolveError!Invocation {
    const Selection = struct {
        path: []const u8,
        clean_start: bool,
    };
    const selection: Selection = switch (shell) {
        .user_login => .{
            .path = try supportedLoginShell(configured_login_shell),
            .clean_start = false,
        },
        .executable => |value| .{
            .path = value.path,
            .clean_start = value.clean_start,
        },
    };
    if (!std.fs.path.isAbsolute(selection.path)) {
        return error.RelativeShellPath;
    }

    const kind = shellKind(selection.path) orelse return error.UnsupportedShell;

    var result = Invocation{ .path = selection.path };
    result.append(selection.path);
    switch (kind) {
        .bash => {
            if (selection.clean_start) {
                result.append("--noprofile");
                result.append("--norc");
            } else {
                result.append("--login");
            }
            result.append("-i");
        },
        .zsh => {
            if (selection.clean_start) {
                result.append("-f");
            } else {
                result.append("-l");
            }
            result.append("-i");
        },
        .cmd => {
            result.append("/d");
            result.append("/q");
        },
        .powershell => {
            result.append("-NoLogo");
            if (selection.clean_start) result.append("-NoProfile");
        },
    }
    return result;
}

pub fn configuredLoginShellInto(buffer: []u8) ?[]const u8 {
    if (comptime builtin.os.tag == .windows) {
        return windowsAgentShellInto(buffer);
    }
    if (comptime !builtin.link_libc or builtin.os.tag == .wasi) {
        return null;
    }
    var entry: std.c.passwd = undefined;
    var scratch: [4096]u8 = undefined;
    var found: ?*std.c.passwd = null;
    if (std.c.getpwuid_r(
        io_mod.currentUserId(),
        &entry,
        &scratch,
        scratch.len,
        &found,
    ) != 0) return null;
    const record = found orelse return null;
    const shell_ptr = record.shell orelse return null;
    const shell = std.mem.span(shell_ptr);
    if (shell.len == 0 or shell.len > buffer.len) return null;
    @memcpy(buffer[0..shell.len], shell);
    return buffer[0..shell.len];
}

pub fn environment(
    alloc: Allocator,
    configured_login_shell: ?[]const u8,
    profile: ?Profile,
) (ResolveError || Allocator.Error)!Environment {
    const selected = profile orelse .user;
    const path = try supportedLoginShell(configured_login_shell);
    _ = try resolve(null, switch (selected) {
        .clean => .{ .executable = .{ .path = path, .clean_start = true } },
        .user => .{ .executable = .{ .path = path } },
    });
    return switch (selected) {
        .clean => .{ .clean = try alloc.dupe(u8, path) },
        .user => .{ .user = try alloc.dupe(u8, path) },
    };
}

pub fn profileShell(
    alloc: Allocator,
    configured_login_shell: ?[]const u8,
    profile: Profile,
) (ResolveError || Allocator.Error)!contracts.ShellSpec {
    return switch (profile) {
        .clean => blk: {
            const path = try supportedLoginShell(configured_login_shell);
            _ = try resolve(null, .{ .executable = .{ .path = path, .clean_start = true } });
            break :blk .{ .executable = .{
                .path = try alloc.dupe(u8, path),
                .clean_start = true,
            } };
        },
        .user => blk: {
            const configured = configured_login_shell orelse
                break :blk .user_login;
            const path = try supportedLoginShell(configured);
            if (std.mem.eql(u8, path, configured)) break :blk .user_login;
            break :blk .{ .executable = .{
                .path = try alloc.dupe(u8, path),
            } };
        },
    };
}

pub fn preparedCapturedInvocation(
    alloc: Allocator,
    environment_value: Environment,
    command: []const u8,
) (ResolveError || Allocator.Error)!Invocation {
    const shell_path = switch (environment_value) {
        .legacy, .workspace_clean => return error.UnsupportedShell,
        .clean, .user => |path| path,
    };
    return capturedInvocation(
        environment_value,
        try preparedCommand(alloc, shell_path, command),
    );
}

pub fn capturedInvocation(environment_value: Environment, command: []const u8) ResolveError!Invocation {
    switch (environment_value) {
        .legacy, .workspace_clean => return error.UnsupportedShell,
        .clean => |path| {
            var invocation = try resolve(null, .{ .executable = .{
                .path = path,
                .clean_start = true,
            } });
            removeInteractiveFlag(&invocation);
            appendNonInteractiveFlag(&invocation);
            invocation.setCommand(command);
            return invocation;
        },
        .user => |path| {
            var invocation = try resolve(path, .user_login);
            if (shellNameIs(path, "bash")) {
                removeInteractiveFlag(&invocation);
                invocation.append("-O");
                invocation.append("expand_aliases");
            }
            appendNonInteractiveFlag(&invocation);
            invocation.setCommand(command);
            return invocation;
        },
    }
}

pub fn formatInvocationCommand(
    alloc: Allocator,
    invocation: *const Invocation,
) Allocator.Error![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(alloc);
    for (invocation.argv(), 0..) |word, index| {
        if (index != 0) try output.append(alloc, ' ');
        try appendShellWord(&output, alloc, word);
    }
    return output.toOwnedSlice(alloc);
}

fn appendNonInteractiveFlag(invocation: *Invocation) void {
    if (shellKind(invocation.path) == .powershell) invocation.append("-NonInteractive");
}

fn removeInteractiveFlag(invocation: *Invocation) void {
    std.debug.assert(invocation.len > 0);
    if (!std.mem.eql(u8, invocation.values[invocation.len - 1], "-i")) return;
    invocation.len -= 1;
}

pub fn buildBootstrap(
    alloc: Allocator,
    executable: []const u8,
    control_path: []const u8,
    nonce: []const u8,
    command_path: ?[]const u8,
) Allocator.Error![]u8 {
    return buildBootstrapForShell(
        alloc,
        if (comptime builtin.os.tag == .windows) fallbackLoginShell() else "/bin/sh",
        executable,
        control_path,
        nonce,
        command_path,
    );
}

pub fn buildBootstrapForShell(
    alloc: Allocator,
    shell_path: []const u8,
    executable: []const u8,
    control_path: []const u8,
    nonce: []const u8,
    command_path: ?[]const u8,
) Allocator.Error![]u8 {
    if (comptime builtin.os.tag == .windows) {
        return buildWindowsBootstrap(
            alloc,
            shellKind(shell_path) orelse .cmd,
            executable,
            control_path,
            nonce,
            command_path,
        );
    }
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(alloc);

    try output.appendSlice(alloc, "set +x; ");
    if (command_path) |path| {
        try output.appendSlice(alloc, "fx_terminal_command=$(< ");
        try appendShellWord(&output, alloc, path);
        try output.appendSlice(alloc, ") || exit 125; ");
    }
    try appendMarker(&output, alloc, executable, control_path, nonce, "shell-ready");
    if (command_path) |_| {
        try output.appendSlice(alloc, " || exit 125; ");
        try appendMarker(
            &output,
            alloc,
            executable,
            control_path,
            nonce,
            "command-started",
        );
        try output.appendSlice(
            alloc,
            " || exit 125; builtin eval -- \"$fx_terminal_command\"; " ++
                "fx_terminal_status=$?; exit \"$fx_terminal_status\"\n",
        );
    } else {
        try output.appendSlice(alloc, " || exit 125\n");
    }
    return output.toOwnedSlice(alloc);
}

pub fn bootstrapExtensionForShell(shell_path: []const u8) []const u8 {
    if (comptime builtin.os.tag != .windows) return "bootstrap";
    return switch (shellKind(shell_path) orelse .cmd) {
        .powershell => "ps1",
        else => "cmd",
    };
}

pub fn buildSourceCommand(
    alloc: Allocator,
    bootstrap_path: []const u8,
) Allocator.Error![]u8 {
    return buildSourceCommandForShell(
        alloc,
        if (comptime builtin.os.tag == .windows) fallbackLoginShell() else "/bin/sh",
        bootstrap_path,
    );
}

pub fn buildSourceCommandForShell(
    alloc: Allocator,
    shell_path: []const u8,
    bootstrap_path: []const u8,
) Allocator.Error![]u8 {
    if (comptime builtin.os.tag == .windows) {
        var output: std.ArrayList(u8) = .empty;
        errdefer output.deinit(alloc);
        const kind = shellKind(shell_path) orelse .cmd;
        if (kind == .powershell) {
            try output.appendSlice(alloc, "& ");
            try appendPowerShellWord(&output, alloc, bootstrap_path);
            try output.append(alloc, '\r');
        } else {
            try output.appendSlice(alloc, "call ");
            try appendCmdWord(&output, alloc, bootstrap_path);
            try output.appendSlice(alloc, "\r\n");
        }
        return output.toOwnedSlice(alloc);
    }
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(alloc);
    try output.appendSlice(alloc, ". ");
    try appendShellWord(&output, alloc, bootstrap_path);
    try output.append(alloc, '\n');
    return output.toOwnedSlice(alloc);
}

fn buildWindowsBootstrap(
    alloc: Allocator,
    kind: ShellKind,
    executable: []const u8,
    control_path: []const u8,
    nonce: []const u8,
    command_path: ?[]const u8,
) Allocator.Error![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(alloc);
    switch (kind) {
        .cmd => {
            try output.appendSlice(
                alloc,
                "@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n",
            );
            try appendWindowsMarker(&output, alloc, kind, executable, control_path, nonce, "shell-ready");
            try output.appendSlice(alloc, "\r\nif errorlevel 1 exit /b 125\r\n");
            if (command_path) |path| {
                try output.appendSlice(alloc, "set /p fx_terminal_command=<");
                try appendCmdWord(&output, alloc, path);
                try output.appendSlice(alloc, "\r\nif errorlevel 1 exit /b 125\r\n");
                try appendWindowsMarker(&output, alloc, kind, executable, control_path, nonce, "command-started");
                try output.appendSlice(
                    alloc,
                    "\r\nif errorlevel 1 exit /b 125\r\ncall %fx_terminal_command%\r\n" ++
                        "set fx_terminal_status=%errorlevel%\r\nexit /b %fx_terminal_status%\r\n",
                );
            }
        },
        .powershell => {
            try output.appendSlice(alloc, "$ErrorActionPreference = 'Stop'\r\n");
            try appendWindowsMarker(&output, alloc, kind, executable, control_path, nonce, "shell-ready");
            try output.appendSlice(alloc, "\r\nif ($LASTEXITCODE -ne 0) { exit 125 }\r\n");
            if (command_path) |path| {
                try output.appendSlice(alloc, "$fx_terminal_command = Get-Content -Raw -LiteralPath ");
                try appendPowerShellWord(&output, alloc, path);
                try output.appendSlice(
                    alloc,
                    "\r\nif ($LASTEXITCODE -ne 0) { exit 125 }\r\n",
                );
                try appendWindowsMarker(&output, alloc, kind, executable, control_path, nonce, "command-started");
                try output.appendSlice(
                    alloc,
                    "\r\nif ($LASTEXITCODE -ne 0) { exit 125 }\r\n" ++
                        "& ([scriptblock]::Create($fx_terminal_command))\r\n" ++
                        "$fx_terminal_status = $LASTEXITCODE\r\nexit $fx_terminal_status\r\n",
                );
            }
        },
        .bash, .zsh => unreachable,
    }
    return output.toOwnedSlice(alloc);
}

fn appendWindowsMarker(
    output: *std.ArrayList(u8),
    alloc: Allocator,
    kind: ShellKind,
    executable: []const u8,
    control_path: []const u8,
    nonce: []const u8,
    event: []const u8,
) Allocator.Error!void {
    if (kind == .powershell) {
        try output.appendSlice(alloc, "& ");
        try appendPowerShellWord(output, alloc, executable);
        inline for (.{
            "--fx-internal-terminal-control",
            control_path,
            nonce,
            event,
        }) |word| {
            try output.append(alloc, ' ');
            try appendPowerShellWord(output, alloc, word);
        }
        return;
    }
    try appendCmdWord(output, alloc, executable);
    inline for (.{
        "--fx-internal-terminal-control",
        control_path,
        nonce,
        event,
    }) |word| {
        try output.append(alloc, ' ');
        try appendCmdWord(output, alloc, word);
    }
}

fn appendCmdWord(
    output: *std.ArrayList(u8),
    alloc: Allocator,
    word: []const u8,
) Allocator.Error!void {
    try output.append(alloc, '"');
    for (word) |byte| {
        if (byte == '"') try output.appendSlice(alloc, "^^\"") else try output.append(alloc, byte);
    }
    try output.append(alloc, '"');
}

fn appendPowerShellWord(
    output: *std.ArrayList(u8),
    alloc: Allocator,
    word: []const u8,
) Allocator.Error!void {
    try output.append(alloc, '\'');
    for (word) |byte| {
        if (byte == '\'') try output.appendSlice(alloc, "''") else try output.append(alloc, byte);
    }
    try output.append(alloc, '\'');
}

fn appendMarker(
    output: *std.ArrayList(u8),
    alloc: Allocator,
    executable: []const u8,
    control_path: []const u8,
    nonce: []const u8,
    event: []const u8,
) Allocator.Error!void {
    try appendShellWord(output, alloc, executable);
    inline for (.{
        "--fx-internal-terminal-control",
        control_path,
        nonce,
        event,
    }) |word| {
        try output.append(alloc, ' ');
        try appendShellWord(output, alloc, word);
    }
}

fn appendShellWord(
    output: *std.ArrayList(u8),
    alloc: Allocator,
    word: []const u8,
) Allocator.Error!void {
    try output.append(alloc, '\'');
    for (word) |byte| {
        if (byte == '\'') {
            try output.appendSlice(alloc, "'\"'\"'");
        } else {
            try output.append(alloc, byte);
        }
    }
    try output.append(alloc, '\'');
}

test "resolver builds Bash and zsh interactive argv" {
    const bash = try resolve("/bin/bash", .user_login);
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/bash", "--login", "-i" },
        bash.argv(),
    );

    const zsh = try resolve(
        null,
        .{ .executable = .{ .path = "/bin/zsh" } },
    );
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/zsh", "-l", "-i" },
        zsh.argv(),
    );
}

test "resolver makes clean startup explicit" {
    const bash = try resolve(
        null,
        .{ .executable = .{ .path = "/usr/local/bin/bash", .clean_start = true } },
    );
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/usr/local/bin/bash", "--noprofile", "--norc", "-i" },
        bash.argv(),
    );

    const zsh = try resolve(
        null,
        .{ .executable = .{ .path = "/bin/zsh", .clean_start = true } },
    );
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/zsh", "-f", "-i" },
        zsh.argv(),
    );
}

test "resolver rejects missing relative and unsupported shells" {
    try std.testing.expectError(
        error.MissingLoginShell,
        resolve(null, .user_login),
    );
    try std.testing.expectError(
        error.RelativeShellPath,
        resolve(null, .{ .executable = .{ .path = "zsh" } }),
    );
    try std.testing.expectError(
        error.UnsupportedShell,
        resolve(null, .{ .executable = .{ .path = "/bin/fish" } }),
    );
}

test "login shell resolution falls back without accepting explicit unsupported shells" {
    const fallback = try resolve("/opt/homebrew/bin/fish", .user_login);
    try std.testing.expectEqualStrings(fallbackLoginShell(), fallback.path);
    if (builtin.os.tag == .macos) {
        try std.testing.expectEqualSlices(
            []const u8,
            &.{ "/bin/zsh", "-l", "-i" },
            fallback.argv(),
        );
    } else if (builtin.os.tag == .windows) {
        try std.testing.expectEqualSlices(
            []const u8,
            &.{ windows_powershell_path, "-NoLogo" },
            fallback.argv(),
        );
    } else {
        try std.testing.expectEqualSlices(
            []const u8,
            &.{ "/bin/bash", "--login", "-i" },
            fallback.argv(),
        );
    }

    try std.testing.expectError(
        error.UnsupportedShell,
        resolve(null, .{ .executable = .{ .path = "/opt/homebrew/bin/fish" } }),
    );
}

test "captured profiles use exact non-PTY argv" {
    const bash_clean = try capturedInvocation(.{ .clean = "/bin/bash" }, "printf clean");
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/bash", "--noprofile", "--norc", "-c", "printf clean" },
        bash_clean.argv(),
    );
    const bash_user = try capturedInvocation(.{ .user = "/bin/bash" }, "printf user");
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/bash", "--login", "-O", "expand_aliases", "-c", "printf user" },
        bash_user.argv(),
    );
    const zsh_clean = try capturedInvocation(.{ .clean = "/bin/zsh" }, "printf clean");
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/zsh", "-f", "-c", "printf clean" },
        zsh_clean.argv(),
    );
    const zsh_user = try capturedInvocation(.{ .user = "/bin/zsh" }, "printf user");
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "/bin/zsh", "-l", "-i", "-c", "printf user" },
        zsh_user.argv(),
    );
}

test "captured invocation provider projection shell-quotes every argv word" {
    const invocation = try capturedInvocation(.{ .clean = "/bin/zsh" }, "printf '%s' ok");
    const command = try formatInvocationCommand(std.testing.allocator, &invocation);
    defer std.testing.allocator.free(command);
    try std.testing.expectEqualStrings(
        "'/bin/zsh' '-f' '-c' 'printf '\"'\"'%s'\"'\"' ok'",
        command,
    );
}

test "profile normalization defaults captured and persistent execution to user" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    try std.testing.expect((try environment(arena, "/bin/bash", null)).eql(.{ .user = "/bin/bash" }));
    try std.testing.expect((try environment(arena, "/bin/zsh", null)).eql(.{ .user = "/bin/zsh" }));
    try std.testing.expect((try environment(arena, "/bin/zsh", .clean)).eql(.{ .clean = "/bin/zsh" }));
    try std.testing.expect((try environment(arena, "/bin/zsh", .user)).eql(.{ .user = "/bin/zsh" }));
    try std.testing.expectEqual(contracts.ShellSpec.user_login, try profileShell(arena, "/bin/zsh", .user));
    try std.testing.expectEqualStrings(
        "/bin/zsh",
        (try profileShell(arena, "/bin/zsh", .clean)).executable.path,
    );
}

test "unsupported login shell profiles fall back for captured and persistent execution" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fallback = fallbackLoginShell();
    const user_environment = try environment(arena, "/opt/homebrew/bin/fish", .user);
    const clean_environment = try environment(arena, "/opt/homebrew/bin/fish", .clean);
    try std.testing.expect(user_environment.eql(.{ .user = fallback }));
    try std.testing.expect(clean_environment.eql(.{ .clean = fallback }));

    const user_invocation = try capturedInvocation(user_environment, "printf user");
    const clean_invocation = try capturedInvocation(clean_environment, "printf clean");
    try std.testing.expectEqualStrings(fallback, user_invocation.path);
    try std.testing.expectEqualStrings(fallback, clean_invocation.path);

    try std.testing.expectEqualStrings(
        fallback,
        (try profileShell(arena, "/opt/homebrew/bin/fish", .user)).executable.path,
    );
    try std.testing.expectEqualStrings(
        fallback,
        (try profileShell(arena, "/opt/homebrew/bin/fish", .clean)).executable.path,
    );
}

test "bootstrap quotes private paths and separates command completion" {
    if (comptime builtin.os.tag == .windows) return error.SkipZigTest;
    const commandless = try buildBootstrap(
        std.testing.allocator,
        "/tmp/fx'bin",
        "/tmp/control",
        "nonce",
        null,
    );
    defer std.testing.allocator.free(commandless);
    try std.testing.expectEqualStrings(
        "set +x; '/tmp/fx'\"'\"'bin' '--fx-internal-terminal-control' " ++
            "'/tmp/control' 'nonce' 'shell-ready' || exit 125\n",
        commandless,
    );

    const command = try buildBootstrap(
        std.testing.allocator,
        "/tmp/fx",
        "/tmp/control",
        "nonce",
        "/tmp/command",
    );
    defer std.testing.allocator.free(command);
    try std.testing.expect(
        std.mem.find(u8, command, "'command-started'") != null,
    );
    try std.testing.expect(
        std.mem.find(u8, command, "builtin eval --") != null,
    );
    try std.testing.expect(
        std.mem.find(u8, command, "exit \"$fx_terminal_status\"") != null,
    );

    const source = try buildSourceCommand(
        std.testing.allocator,
        "/tmp/bootstrap'file",
    );
    defer std.testing.allocator.free(source);
    try std.testing.expectEqualStrings(
        ". '/tmp/bootstrap'\"'\"'file'\n",
        source,
    );
}

test "Windows agent shell is an absolute PowerShell" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var buffer: [32768]u8 = undefined;
    const path = windowsAgentShellInto(&buffer);
    try std.testing.expect(std.fs.path.isAbsolute(path));
    try std.testing.expectEqual(ShellKind.powershell, shellKind(path).?);
    var configured: [32768]u8 = undefined;
    try std.testing.expectEqualStrings(path, configuredLoginShellInto(&configured).?);
}

test "Windows captured profiles run PowerShell without a profile or a prompt" {
    const clean = try capturedInvocation(
        .{ .clean = windows_powershell_path },
        "Get-ChildItem",
    );
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ windows_powershell_path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem" },
        clean.argv(),
    );
    const user = try capturedInvocation(
        .{ .user = "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
        "Get-ChildItem",
    );
    try std.testing.expectEqualSlices(
        []const u8,
        &.{ "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo", "-NonInteractive", "-Command", "Get-ChildItem" },
        user.argv(),
    );
}

test "PowerShell commands carry a UTF-8 prelude and a three-way exit epilogue" {
    const alloc = std.testing.allocator;
    const script = try preparedCommand(alloc, windows_powershell_path, "Get-ChildItem");
    defer alloc.free(script);
    try std.testing.expect(std.mem.startsWith(u8, script, "$fx_utf8 = [Text.UTF8Encoding]::new($false)"));
    try std.testing.expect(std.mem.find(u8, script, "[Console]::OutputEncoding = $fx_utf8") != null);
    try std.testing.expect(std.mem.find(u8, script, "\r\nGet-ChildItem\r\nexit $(") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, windows_script_prelude, "\n"));
    try std.testing.expect(std.mem.endsWith(
        u8,
        script,
        "exit $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })",
    ));

    const untouched = try preparedCommand(alloc, "/bin/zsh", "printf ok");
    try std.testing.expectEqualStrings("printf ok", untouched);
    const cmd_untouched = try preparedCommand(alloc, windows_cmd_path, "dir");
    try std.testing.expectEqualStrings("dir", cmd_untouched);
}

test "Windows bootstrap follows the resolved PowerShell shell" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const bootstrap = try buildBootstrap(
        std.testing.allocator,
        "C:\\fx\\emma-cli.exe",
        "C:\\fx\\control",
        "nonce",
        "C:\\fx\\command",
    );
    defer std.testing.allocator.free(bootstrap);
    try std.testing.expect(std.mem.startsWith(u8, bootstrap, "$ErrorActionPreference = 'Stop'"));
    try std.testing.expect(std.mem.find(u8, bootstrap, "'shell-ready'") != null);
    try std.testing.expect(std.mem.find(u8, bootstrap, "'command-started'") != null);
    try std.testing.expect(std.mem.startsWith(
        u8,
        bootstrap["$ErrorActionPreference = 'Stop'\r\n".len..],
        "& 'C:\\fx\\emma-cli.exe'",
    ));

    const source = try buildSourceCommand(std.testing.allocator, "C:\\fx\\boot'strap");
    defer std.testing.allocator.free(source);
    try std.testing.expectEqualStrings("& 'C:\\fx\\boot''strap'\r", source);
    try std.testing.expectEqualStrings(
        "ps1",
        bootstrapExtensionForShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    );
    try std.testing.expectEqualStrings(
        "cmd",
        bootstrapExtensionForShell(windows_cmd_path),
    );
}

fn checkBootstrapAllocationFailures(alloc: Allocator) !void {
    const bootstrap = try buildBootstrap(
        alloc,
        "/tmp/fx",
        "/tmp/control",
        "nonce",
        "/tmp/command",
    );
    defer alloc.free(bootstrap);
    const source = try buildSourceCommand(alloc, "/tmp/bootstrap");
    defer alloc.free(source);
}

test "bootstrap construction cleans every allocation failure" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        checkBootstrapAllocationFailures,
        .{},
    );
}
