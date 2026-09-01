const std = @import("std");
const text_utils = @import("text_utils.zig");

const Allocator = std.mem.Allocator;

pub const max_steps: usize = 5_000_000;
pub const max_depth: usize = 2_000;
pub const max_repeat: usize = 1_000;
pub const max_nesting: usize = 64;

pub const CompileError = error{
    OutOfMemory,
    RegexBackreference,
    RegexLookaround,
    RegexNonGreedy,
    RegexStackedQuantifier,
    RegexShorthandClass,
    RegexUnknownEscape,
    RegexTrailingBackslash,
    RegexUnbalancedParen,
    RegexUnterminatedClass,
    RegexUnknownClassName,
    RegexInvalidClassRange,
    RegexQuantifierWithoutTarget,
    RegexEmptyBranch,
    RegexRepeatBound,
    RegexTooDeep,
};

pub const MatchError = error{RegexTooExpensive};

pub fn explain(err: CompileError) []const u8 {
    return switch (err) {
        error.OutOfMemory => "out of memory",
        error.RegexBackreference => "backreferences such as \\1 are not supported; POSIX ERE has none, so spell the repeated text out",
        error.RegexLookaround => "lookaround such as (?=), (?!), (?<=) and (?<!) is not supported; POSIX ERE has none",
        error.RegexNonGreedy => "non-greedy quantifiers such as *?, +? and ?? are not supported; POSIX ERE quantifiers are always greedy",
        error.RegexStackedQuantifier => "one quantifier cannot follow another; group the first one, as in (x*)+",
        error.RegexShorthandClass => "the \\d \\w \\s \\D \\W \\S shorthands are not supported; use [[:digit:]], [[:alnum:]_] and [[:space:]]",
        error.RegexUnknownEscape => "unsupported escape; a backslash only escapes a metacharacter, as in \\. \\( \\[ \\* \\+ \\? \\| \\\\",
        error.RegexTrailingBackslash => "the pattern ends with a lone backslash; write \\\\ to search for a backslash",
        error.RegexUnbalancedParen => "unbalanced parenthesis; write \\( or \\) to search for a literal parenthesis",
        error.RegexUnterminatedClass => "unterminated [ character class; write \\[ to search for a literal bracket",
        error.RegexUnknownClassName => "unknown [[:name:]] class; POSIX ERE has alpha, digit, alnum, upper, lower, space, blank, punct, print, graph, cntrl and xdigit",
        error.RegexInvalidClassRange => "character class range runs backwards",
        error.RegexQuantifierWithoutTarget => "a quantifier (* + ? {m,n}) has nothing to repeat",
        error.RegexEmptyBranch => "empty subexpression; every branch of a | and every () group needs content",
        error.RegexRepeatBound => "invalid {m,n} bound; m must not exceed n and neither may exceed 1000",
        error.RegexTooDeep => "the pattern nests groups more than 64 deep",
    };
}

pub const ClassSet = struct {
    bits: [32]u8 = [_]u8{0} ** 32,

    fn add(self: *ClassSet, c: u8) void {
        self.bits[c >> 3] |= @as(u8, 1) << @intCast(c & 7);
    }

    fn has(self: *const ClassSet, c: u8) bool {
        return self.bits[c >> 3] & (@as(u8, 1) << @intCast(c & 7)) != 0;
    }

    fn negate(self: *ClassSet) void {
        for (&self.bits) |*byte| byte.* = ~byte.*;
    }

    fn foldCase(self: *ClassSet) void {
        var lower: u8 = 'a';
        while (lower <= 'z') : (lower += 1) {
            const upper = std.ascii.toUpper(lower);
            if (self.has(lower)) self.add(upper);
            if (self.has(upper)) self.add(lower);
        }
    }
};

pub const Node = union(enum) {
    char: u8,
    any,
    class: *const ClassSet,
    bol,
    eol,
    seq: []const Node,
    alt: []const Node,
    star: *const Node,
};

const no_nodes: []const Node = &.{};

pub const Program = struct {
    source: []const u8,
    case_insensitive: bool,
    body: Body,

    const Body = union(enum) {
        literal: []const u8,
        tree: Node,
    };

    pub fn isLiteral(self: Program) bool {
        return self.body == .literal;
    }

    pub fn matches(self: Program, line: []const u8) MatchError!bool {
        switch (self.body) {
            .literal => |needle| return if (self.case_insensitive)
                text_utils.containsIgnoreCase(line, needle)
            else
                std.mem.find(u8, line, needle) != null,
            .tree => {},
        }

        const root = self.body.tree;
        var matcher = Matcher{ .fold = self.case_insensitive };
        var start: usize = 0;
        while (true) : (start += 1) {
            if (try matcher.runNode(&root, null, line, start)) return true;
            if (start == line.len) return false;
        }
    }
};

pub fn compile(arena: Allocator, pattern: []const u8, case_insensitive: bool) CompileError!Program {
    if (isLiteralPattern(pattern)) {
        return .{
            .source = pattern,
            .case_insensitive = case_insensitive,
            .body = .{ .literal = pattern },
        };
    }

    var parser = Parser{ .arena = arena, .pattern = pattern, .case_insensitive = case_insensitive };
    const root = try parser.parseAlternation();
    if (parser.pos != pattern.len) return error.RegexUnbalancedParen;
    return .{
        .source = pattern,
        .case_insensitive = case_insensitive,
        .body = .{ .tree = root },
    };
}

pub fn isLiteralPattern(pattern: []const u8) bool {
    var index: usize = 0;
    while (index < pattern.len) : (index += 1) {
        if (std.mem.findScalar(u8, "\\|.*+?[]()^$", pattern[index]) != null) return false;
        if (pattern[index] == '{' and intervalAt(pattern, index) != null) return false;
    }
    return true;
}

const Interval = struct {
    min: usize,
    max: ?usize,
    end: usize,
};

fn intervalAt(pattern: []const u8, open: usize) ?Interval {
    if (open >= pattern.len or pattern[open] != '{') return null;

    var index = open + 1;
    const min_start = index;
    while (index < pattern.len and std.ascii.isDigit(pattern[index])) index += 1;
    if (index == min_start) return null;
    const min = std.fmt.parseInt(usize, pattern[min_start..index], 10) catch return null;

    if (index < pattern.len and pattern[index] == '}') {
        return .{ .min = min, .max = min, .end = index + 1 };
    }
    if (index >= pattern.len or pattern[index] != ',') return null;

    index += 1;
    const max_start = index;
    while (index < pattern.len and std.ascii.isDigit(pattern[index])) index += 1;
    if (index >= pattern.len or pattern[index] != '}') return null;
    const max: ?usize = if (index == max_start)
        null
    else
        std.fmt.parseInt(usize, pattern[max_start..index], 10) catch return null;

    return .{ .min = min, .max = max, .end = index + 1 };
}

const NamedClass = enum {
    alpha,
    digit,
    alnum,
    upper,
    lower,
    space,
    blank,
    punct,
    print,
    graph,
    cntrl,
    xdigit,

    fn contains(self: NamedClass, c: u8) bool {
        const printable = c >= 0x20 and c < 0x7f;
        return switch (self) {
            .alpha => std.ascii.isAlphabetic(c),
            .digit => std.ascii.isDigit(c),
            .alnum => std.ascii.isAlphanumeric(c),
            .upper => std.ascii.isUpper(c),
            .lower => std.ascii.isLower(c),
            .space => std.ascii.isWhitespace(c),
            .blank => c == ' ' or c == '\t',
            .punct => printable and c != ' ' and !std.ascii.isAlphanumeric(c),
            .print => printable,
            .graph => printable and c != ' ',
            .cntrl => std.ascii.isControl(c),
            .xdigit => std.ascii.isHex(c),
        };
    }
};

const Parser = struct {
    arena: Allocator,
    pattern: []const u8,
    case_insensitive: bool,
    pos: usize = 0,
    depth: usize = 0,

    fn parseAlternation(self: *Parser) CompileError!Node {
        if (self.depth >= max_nesting) return error.RegexTooDeep;
        self.depth += 1;
        defer self.depth -= 1;

        var branches: std.ArrayList(Node) = .empty;
        try branches.append(self.arena, try self.parseSequence());
        while (self.pos < self.pattern.len and self.pattern[self.pos] == '|') {
            self.pos += 1;
            try branches.append(self.arena, try self.parseSequence());
        }
        if (branches.items.len == 1) return branches.items[0];
        for (branches.items) |branch| {
            if (isEmptySequence(branch)) return error.RegexEmptyBranch;
        }
        return .{ .alt = try branches.toOwnedSlice(self.arena) };
    }

    fn parseSequence(self: *Parser) CompileError!Node {
        var items: std.ArrayList(Node) = .empty;
        while (self.pos < self.pattern.len) {
            const c = self.pattern[self.pos];
            if (c == '|' or c == ')') break;
            try items.append(self.arena, try self.parseQuantified());
        }
        if (items.items.len == 0) return .{ .seq = no_nodes };
        if (items.items.len == 1) return items.items[0];
        return .{ .seq = try items.toOwnedSlice(self.arena) };
    }

    fn parseQuantified(self: *Parser) CompileError!Node {
        const atom = try self.parseAtom();
        if (self.pos >= self.pattern.len) return atom;

        const quantified = switch (self.pattern[self.pos]) {
            '*' => star: {
                self.pos += 1;
                break :star try self.starNode(atom);
            },
            '+' => plus: {
                self.pos += 1;
                break :plus try self.plusNode(atom);
            },
            '?' => optional: {
                self.pos += 1;
                break :optional try self.optionalNode(atom);
            },
            '{' => interval: {
                const interval = intervalAt(self.pattern, self.pos) orelse return atom;
                self.pos = interval.end;
                break :interval try self.repeatNode(atom, interval);
            },
            else => return atom,
        };

        if (self.pos < self.pattern.len) {
            const next = self.pattern[self.pos];
            if (next == '?') return error.RegexNonGreedy;
            if (next == '*' or next == '+') return error.RegexStackedQuantifier;
            if (next == '{' and intervalAt(self.pattern, self.pos) != null) return error.RegexStackedQuantifier;
        }
        return quantified;
    }

    fn parseAtom(self: *Parser) CompileError!Node {
        const c = self.pattern[self.pos];
        switch (c) {
            '(' => {
                self.pos += 1;
                if (self.pos + 1 < self.pattern.len and self.pattern[self.pos] == '?') {
                    const flag = self.pattern[self.pos + 1];
                    if (flag == '=' or flag == '!' or flag == '<') return error.RegexLookaround;
                }
                const inner = try self.parseAlternation();
                if (self.pos >= self.pattern.len or self.pattern[self.pos] != ')') return error.RegexUnbalancedParen;
                self.pos += 1;
                if (isEmptySequence(inner)) return error.RegexEmptyBranch;
                return inner;
            },
            '[' => return self.parseClass(),
            '.' => {
                self.pos += 1;
                return .any;
            },
            '^' => {
                self.pos += 1;
                return .bol;
            },
            '$' => {
                self.pos += 1;
                return .eol;
            },
            '*', '+', '?' => return error.RegexQuantifierWithoutTarget,
            '{' => {
                if (intervalAt(self.pattern, self.pos) != null) return error.RegexQuantifierWithoutTarget;
                self.pos += 1;
                return self.charNode('{');
            },
            '\\' => return self.parseEscape(),
            else => {
                self.pos += 1;
                return self.charNode(c);
            },
        }
    }

    fn parseEscape(self: *Parser) CompileError!Node {
        self.pos += 1;
        if (self.pos >= self.pattern.len) return error.RegexTrailingBackslash;

        const c = self.pattern[self.pos];
        self.pos += 1;
        if (std.ascii.isDigit(c)) return error.RegexBackreference;
        switch (c) {
            'd', 'w', 's', 'D', 'W', 'S' => return error.RegexShorthandClass,
            else => {},
        }
        if (std.ascii.isAlphabetic(c)) return error.RegexUnknownEscape;
        return self.charNode(c);
    }

    fn parseClass(self: *Parser) CompileError!Node {
        self.pos += 1;
        var set = ClassSet{};
        var negated = false;
        if (self.pos < self.pattern.len and self.pattern[self.pos] == '^') {
            negated = true;
            self.pos += 1;
        }

        var first = true;
        while (true) {
            if (self.pos >= self.pattern.len) return error.RegexUnterminatedClass;
            const c = self.pattern[self.pos];
            if (c == ']' and !first) {
                self.pos += 1;
                break;
            }
            first = false;

            if (c == '[' and self.pos + 1 < self.pattern.len and self.pattern[self.pos + 1] == ':') {
                try self.addNamedClass(&set);
                continue;
            }

            self.pos += 1;
            if (self.pos + 1 < self.pattern.len and self.pattern[self.pos] == '-' and self.pattern[self.pos + 1] != ']') {
                const high = self.pattern[self.pos + 1];
                if (high < c) return error.RegexInvalidClassRange;
                self.pos += 2;
                var value = c;
                while (true) {
                    set.add(value);
                    if (value == high) break;
                    value += 1;
                }
                continue;
            }
            set.add(c);
        }

        if (self.case_insensitive) set.foldCase();
        if (negated) set.negate();

        const owned = try self.arena.create(ClassSet);
        owned.* = set;
        return .{ .class = owned };
    }

    fn addNamedClass(self: *Parser, set: *ClassSet) CompileError!void {
        const start = self.pos + 2;
        const closing = std.mem.find(u8, self.pattern[start..], ":]") orelse return error.RegexUnterminatedClass;
        const name = self.pattern[start .. start + closing];
        const named = std.meta.stringToEnum(NamedClass, name) orelse return error.RegexUnknownClassName;
        self.pos = start + closing + 2;

        var value: usize = 0;
        while (value < 256) : (value += 1) {
            const byte: u8 = @intCast(value);
            if (named.contains(byte)) set.add(byte);
        }
    }

    fn charNode(self: *Parser, c: u8) Node {
        return .{ .char = if (self.case_insensitive) std.ascii.toLower(c) else c };
    }

    fn allocNode(self: *Parser, node: Node) CompileError!*const Node {
        const owned = try self.arena.create(Node);
        owned.* = node;
        return owned;
    }

    fn starNode(self: *Parser, inner: Node) CompileError!Node {
        return .{ .star = try self.allocNode(inner) };
    }

    fn plusNode(self: *Parser, inner: Node) CompileError!Node {
        const items = try self.arena.alloc(Node, 2);
        items[0] = inner;
        items[1] = try self.starNode(inner);
        return .{ .seq = items };
    }

    fn optionalNode(self: *Parser, inner: Node) CompileError!Node {
        const items = try self.arena.alloc(Node, 2);
        items[0] = inner;
        items[1] = .{ .seq = no_nodes };
        return .{ .alt = items };
    }

    fn repeatNode(self: *Parser, inner: Node, interval: Interval) CompileError!Node {
        const upper = interval.max orelse interval.min;
        if (interval.min > max_repeat or upper > max_repeat or upper < interval.min) return error.RegexRepeatBound;

        var items: std.ArrayList(Node) = .empty;
        var required = interval.min;
        while (required > 0) : (required -= 1) try items.append(self.arena, inner);
        if (interval.max) |max| {
            var optional = max - interval.min;
            while (optional > 0) : (optional -= 1) try items.append(self.arena, try self.optionalNode(inner));
        } else {
            try items.append(self.arena, try self.starNode(inner));
        }

        if (items.items.len == 0) return .{ .seq = no_nodes };
        if (items.items.len == 1) return items.items[0];
        return .{ .seq = try items.toOwnedSlice(self.arena) };
    }
};

const Cont = struct {
    kind: Kind,
    next: ?*const Cont,

    const Kind = union(enum) {
        seq: []const Node,
        repeat: Repeat,
    };

    const Repeat = struct {
        inner: *const Node,
        last_start: ?usize,
    };
};

const Matcher = struct {
    fold: bool,
    steps: usize = 0,
    depth: usize = 0,

    fn step(self: *Matcher) MatchError!void {
        self.steps += 1;
        if (self.steps > max_steps) return error.RegexTooExpensive;
    }

    fn runCont(self: *Matcher, cont: ?*const Cont, text: []const u8, pos: usize) MatchError!bool {
        try self.step();
        if (self.depth >= max_depth) return error.RegexTooExpensive;
        self.depth += 1;
        defer self.depth -= 1;

        const frame = cont orelse return true;
        switch (frame.kind) {
            .seq => |nodes| {
                if (nodes.len == 0) return self.runCont(frame.next, text, pos);
                const rest = Cont{ .kind = .{ .seq = nodes[1..] }, .next = frame.next };
                return self.runNode(&nodes[0], &rest, text, pos);
            },
            .repeat => |repeat| {
                if (repeat.last_start) |last| {
                    if (last == pos) return self.runCont(frame.next, text, pos);
                }
                const again = Cont{
                    .kind = .{ .repeat = .{ .inner = repeat.inner, .last_start = pos } },
                    .next = frame.next,
                };
                if (try self.runNode(repeat.inner, &again, text, pos)) return true;
                return self.runCont(frame.next, text, pos);
            },
        }
    }

    fn runNode(self: *Matcher, node: *const Node, cont: ?*const Cont, text: []const u8, pos: usize) MatchError!bool {
        try self.step();
        switch (node.*) {
            .char, .any, .class => {
                if (pos >= text.len or !self.singleMatches(node, text[pos])) return false;
                return self.runCont(cont, text, pos + 1);
            },
            .bol => {
                if (pos != 0) return false;
                return self.runCont(cont, text, pos);
            },
            .eol => {
                if (pos != text.len) return false;
                return self.runCont(cont, text, pos);
            },
            .seq => |nodes| {
                const frame = Cont{ .kind = .{ .seq = nodes }, .next = cont };
                return self.runCont(&frame, text, pos);
            },
            .alt => |branches| {
                for (branches) |*branch| {
                    if (try self.runNode(branch, cont, text, pos)) return true;
                }
                return false;
            },
            .star => |inner| {
                if (isSingleWidth(inner)) return self.runSingleWidthStar(inner, cont, text, pos);
                const frame = Cont{
                    .kind = .{ .repeat = .{ .inner = inner, .last_start = null } },
                    .next = cont,
                };
                return self.runCont(&frame, text, pos);
            },
        }
    }

    fn runSingleWidthStar(self: *Matcher, inner: *const Node, cont: ?*const Cont, text: []const u8, pos: usize) MatchError!bool {
        var end = pos;
        while (end < text.len and self.singleMatches(inner, text[end])) : (end += 1) try self.step();

        var index = end;
        while (true) {
            if (try self.runCont(cont, text, index)) return true;
            if (index == pos) return false;
            index -= 1;
        }
    }

    fn singleMatches(self: *const Matcher, node: *const Node, byte: u8) bool {
        return switch (node.*) {
            .char => |c| c == (if (self.fold) std.ascii.toLower(byte) else byte),
            .any => true,
            .class => |set| set.has(byte),
            else => false,
        };
    }
};

fn isEmptySequence(node: Node) bool {
    return node == .seq and node.seq.len == 0;
}

fn isSingleWidth(node: *const Node) bool {
    return switch (node.*) {
        .char, .any, .class => true,
        else => false,
    };
}

fn expectMatch(pattern: []const u8, line: []const u8, expected: bool) !void {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const program = try compile(arena_state.allocator(), pattern, false);
    try std.testing.expectEqual(expected, try program.matches(line));
}

fn expectCompileError(pattern: []const u8, expected: CompileError) !void {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectError(expected, compile(arena_state.allocator(), pattern, false));
}

test "regex keeps metacharacter-free patterns on the literal path" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try std.testing.expect((try compile(arena, "needle", false)).isLiteral());
    try std.testing.expect((try compile(arena, "path={d} name", false)).isLiteral());
    try std.testing.expect((try compile(arena, "", false)).isLiteral());
    try std.testing.expect(!(try compile(arena, "alpha|beta", false)).isLiteral());
    try std.testing.expect(!(try compile(arena, "a{2}", false)).isLiteral());

    const literal = try compile(arena, "path={d}", false);
    try std.testing.expect(try literal.matches("logf path={d} end"));
    try std.testing.expect(!(try literal.matches("path={s}")));
}

test "regex matches every supported construct" {
    try expectMatch("stopTurn|pairBlocks|landed", "  pairBlocks(x)", true);
    try expectMatch("stopTurn|pairBlocks|landed", "  nothing here", false);
    try expectMatch("systemPrompt\\(", "emma.systemPrompt(x)", true);
    try expectMatch("systemPrompt\\(", "systemPrompt = 1", false);
    try expectMatch("a.c", "xxabcxx", true);
    try expectMatch("a.c", "xxacxx", false);
    try expectMatch("ab*c", "ac", true);
    try expectMatch("ab*c", "abbbc", true);
    try expectMatch("ab+c", "ac", false);
    try expectMatch("ab?c", "abc", true);
    try expectMatch("a{2,3}b", "aab", true);
    try expectMatch("a{2,3}b", "ab", false);
    try expectMatch("a{2,}b", "aaaab", true);
    try expectMatch("[a-cx]y", "by", true);
    try expectMatch("[a-cx]y", "dy", false);
    try expectMatch("[^a-c]y", "dy", true);
    try expectMatch("[^a-c]y", "by", false);
    try expectMatch("v[[:digit:]][[:alpha:]]", "v9z", true);
    try expectMatch("v[[:digit:]][[:alpha:]]", "vzz", false);
    try expectMatch("^fn ", "fn main", true);
    try expectMatch("^fn ", "  fn main", false);
    try expectMatch("end$", "the end", true);
    try expectMatch("end$", "the end.", false);
    try expectMatch("(ab|cd)+e", "ababcde", true);
    try expectMatch("(ab|cd)+e", "abx", false);
    try expectMatch("a\\|b", "a|b", true);
    try expectMatch("\\[\\]", "x[]y", true);
    try expectMatch(".*", "", true);
    try expectMatch("^$", "", true);
}

test "regex folds case for literals and classes when asked" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const program = try compile(arena, "need[le]e?|HAY", true);
    try std.testing.expect(try program.matches("Needl"));
    try std.testing.expect(try program.matches("hay bale"));
    try std.testing.expect(!(try program.matches("nothing")));

    const negated = try compile(arena, "x[^a]y", true);
    try std.testing.expect(!(try negated.matches("xAy")));
    try std.testing.expect(try negated.matches("xby"));
}

test "regex rejects constructs POSIX ERE does not have" {
    try expectCompileError("(a)\\1", error.RegexBackreference);
    try expectCompileError("(?=foo)bar", error.RegexLookaround);
    try expectCompileError("(?<=foo)bar", error.RegexLookaround);
    try expectCompileError("a+?b", error.RegexNonGreedy);
    try expectCompileError("a**", error.RegexStackedQuantifier);
    try expectCompileError("\\d+", error.RegexShorthandClass);
    try expectCompileError("\\w", error.RegexShorthandClass);
    try expectCompileError("\\s", error.RegexShorthandClass);
    try expectCompileError("a\\tb", error.RegexUnknownEscape);
    try expectCompileError("trailing\\", error.RegexTrailingBackslash);
    try expectCompileError("fn (", error.RegexUnbalancedParen);
    try expectCompileError("a)b", error.RegexUnbalancedParen);
    try expectCompileError("[abc", error.RegexUnterminatedClass);
    try expectCompileError("[[:bogus:]]", error.RegexUnknownClassName);
    try expectCompileError("[z-a]", error.RegexInvalidClassRange);
    try expectCompileError("*needle", error.RegexQuantifierWithoutTarget);
    try expectCompileError("{2}", error.RegexQuantifierWithoutTarget);
    try expectCompileError("needle|", error.RegexEmptyBranch);
    try expectCompileError("a{2,1}", error.RegexRepeatBound);
    try expectCompileError("a{9999}", error.RegexRepeatBound);
    try expectCompileError("(" ** 100 ++ "a" ++ ")" ** 100, error.RegexTooDeep);
}

test "regex explains every rejected construct by name" {
    try std.testing.expect(std.mem.find(u8, explain(error.RegexShorthandClass), "[[:digit:]]") != null);
    try std.testing.expect(std.mem.find(u8, explain(error.RegexBackreference), "backreference") != null);
    try std.testing.expect(std.mem.find(u8, explain(error.RegexLookaround), "lookaround") != null);
    try std.testing.expect(std.mem.find(u8, explain(error.RegexNonGreedy), "non-greedy") != null);
}

test "regex step budget stops catastrophic backtracking" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    const program = try compile(arena_state.allocator(), "(a+)+b", false);
    try std.testing.expect(try program.matches("aaab"));
    try std.testing.expectError(error.RegexTooExpensive, program.matches("a" ** 40 ++ "c"));
}

test "regex greedy runs of one-width nodes do not recurse per character" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    const line = "x" ** 60_000 ++ "needle";
    const program = try compile(arena_state.allocator(), "^x.*needle$", false);
    try std.testing.expect(try program.matches(line));
}
