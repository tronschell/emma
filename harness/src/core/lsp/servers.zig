const std = @import("std");
const io_mod = @import("../shared/io.zig");

pub const Server = struct {
    id: []const u8,
    language_id: []const u8,
    argv: []const []const u8,
    extensions: []const []const u8 = &.{},
    filenames: []const []const u8 = &.{},
    install: []const u8,
};

pub const table = [_]Server{
    .{
        .id = "typescript-language-server",
        .language_id = "typescript",
        .argv = &.{ "typescript-language-server", "--stdio" },
        .extensions = &.{ "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs" },
        .install = "npm i -g typescript-language-server typescript",
    },
    .{
        .id = "rust-analyzer",
        .language_id = "rust",
        .argv = &.{"rust-analyzer"},
        .extensions = &.{"rs"},
        .install = "rustup component add rust-analyzer",
    },
    .{
        .id = "zls",
        .language_id = "zig",
        .argv = &.{"zls"},
        .extensions = &.{ "zig", "zon" },
        .install = "brew install zls",
    },
    .{
        .id = "pyright",
        .language_id = "python",
        .argv = &.{ "pyright-langserver", "--stdio" },
        .extensions = &.{ "py", "pyi" },
        .install = "npm i -g pyright",
    },
    .{
        .id = "gopls",
        .language_id = "go",
        .argv = &.{"gopls"},
        .extensions = &.{"go"},
        .install = "go install golang.org/x/tools/gopls@latest",
    },
    .{
        .id = "clangd",
        .language_id = "cpp",
        .argv = &.{"clangd"},
        .extensions = &.{ "c", "h", "cc", "cpp", "cxx", "c++", "hpp", "hh", "hxx", "cu", "m", "mm" },
        .install = "brew install llvm",
    },
    .{
        .id = "sourcekit-lsp",
        .language_id = "swift",
        .argv = &.{"sourcekit-lsp"},
        .extensions = &.{"swift"},
        .install = "xcode-select --install",
    },
    .{
        .id = "jdtls",
        .language_id = "java",
        .argv = &.{"jdtls"},
        .extensions = &.{"java"},
        .install = "brew install jdtls",
    },
    .{
        .id = "kotlin-language-server",
        .language_id = "kotlin",
        .argv = &.{"kotlin-language-server"},
        .extensions = &.{ "kt", "kts" },
        .install = "brew install kotlin-language-server",
    },
    .{
        .id = "csharp-ls",
        .language_id = "csharp",
        .argv = &.{"csharp-ls"},
        .extensions = &.{"cs"},
        .install = "dotnet tool install --global csharp-ls",
    },
    .{
        .id = "fsautocomplete",
        .language_id = "fsharp",
        .argv = &.{ "fsautocomplete", "--adaptive-lsp-server-enabled" },
        .extensions = &.{ "fs", "fsi", "fsx" },
        .install = "dotnet tool install --global fsautocomplete",
    },
    .{
        .id = "ruby-lsp",
        .language_id = "ruby",
        .argv = &.{"ruby-lsp"},
        .extensions = &.{ "rb", "rake", "gemspec" },
        .filenames = &.{ "Gemfile", "Rakefile" },
        .install = "gem install ruby-lsp",
    },
    .{
        .id = "intelephense",
        .language_id = "php",
        .argv = &.{ "intelephense", "--stdio" },
        .extensions = &.{"php"},
        .install = "npm i -g intelephense",
    },
    .{
        .id = "lua-language-server",
        .language_id = "lua",
        .argv = &.{"lua-language-server"},
        .extensions = &.{"lua"},
        .install = "brew install lua-language-server",
    },
    .{
        .id = "bash-language-server",
        .language_id = "shellscript",
        .argv = &.{ "bash-language-server", "start" },
        .extensions = &.{ "sh", "bash", "zsh", "ksh" },
        .install = "npm i -g bash-language-server",
    },
    .{
        .id = "vscode-json-language-server",
        .language_id = "json",
        .argv = &.{ "vscode-json-language-server", "--stdio" },
        .extensions = &.{ "json", "jsonc", "json5" },
        .install = "npm i -g vscode-langservers-extracted",
    },
    .{
        .id = "yaml-language-server",
        .language_id = "yaml",
        .argv = &.{ "yaml-language-server", "--stdio" },
        .extensions = &.{ "yaml", "yml" },
        .install = "npm i -g yaml-language-server",
    },
    .{
        .id = "taplo",
        .language_id = "toml",
        .argv = &.{ "taplo", "lsp", "stdio" },
        .extensions = &.{"toml"},
        .install = "brew install taplo",
    },
    .{
        .id = "vscode-html-language-server",
        .language_id = "html",
        .argv = &.{ "vscode-html-language-server", "--stdio" },
        .extensions = &.{ "html", "htm" },
        .install = "npm i -g vscode-langservers-extracted",
    },
    .{
        .id = "vscode-css-language-server",
        .language_id = "css",
        .argv = &.{ "vscode-css-language-server", "--stdio" },
        .extensions = &.{ "css", "scss", "less" },
        .install = "npm i -g vscode-langservers-extracted",
    },
    .{
        .id = "svelteserver",
        .language_id = "svelte",
        .argv = &.{ "svelteserver", "--stdio" },
        .extensions = &.{"svelte"},
        .install = "npm i -g svelte-language-server",
    },
    .{
        .id = "vue-language-server",
        .language_id = "vue",
        .argv = &.{ "vue-language-server", "--stdio" },
        .extensions = &.{"vue"},
        .install = "npm i -g @vue/language-server",
    },
    .{
        .id = "astro-ls",
        .language_id = "astro",
        .argv = &.{ "astro-ls", "--stdio" },
        .extensions = &.{"astro"},
        .install = "npm i -g @astrojs/language-server",
    },
    .{
        .id = "prisma-language-server",
        .language_id = "prisma",
        .argv = &.{ "prisma-language-server", "--stdio" },
        .extensions = &.{"prisma"},
        .install = "npm i -g @prisma/language-server",
    },
    .{
        .id = "graphql-lsp",
        .language_id = "graphql",
        .argv = &.{ "graphql-lsp", "server", "-m", "stream" },
        .extensions = &.{ "graphql", "gql" },
        .install = "npm i -g graphql-language-service-cli",
    },
    .{
        .id = "elixir-ls",
        .language_id = "elixir",
        .argv = &.{"elixir-ls"},
        .extensions = &.{ "ex", "exs" },
        .install = "brew install elixir-ls",
    },
    .{
        .id = "erlang_ls",
        .language_id = "erlang",
        .argv = &.{"erlang_ls"},
        .extensions = &.{ "erl", "hrl" },
        .install = "brew install erlang_ls",
    },
    .{
        .id = "gleam",
        .language_id = "gleam",
        .argv = &.{ "gleam", "lsp" },
        .extensions = &.{"gleam"},
        .install = "brew install gleam",
    },
    .{
        .id = "haskell-language-server",
        .language_id = "haskell",
        .argv = &.{ "haskell-language-server-wrapper", "--lsp" },
        .extensions = &.{ "hs", "lhs" },
        .install = "ghcup install hls",
    },
    .{
        .id = "ocamllsp",
        .language_id = "ocaml",
        .argv = &.{"ocamllsp"},
        .extensions = &.{ "ml", "mli" },
        .install = "opam install ocaml-lsp-server",
    },
    .{
        .id = "metals",
        .language_id = "scala",
        .argv = &.{"metals"},
        .extensions = &.{ "scala", "sbt", "sc" },
        .install = "cs install metals",
    },
    .{
        .id = "clojure-lsp",
        .language_id = "clojure",
        .argv = &.{"clojure-lsp"},
        .extensions = &.{ "clj", "cljs", "cljc", "edn" },
        .install = "brew install clojure-lsp/brew/clojure-lsp-native",
    },
    .{
        .id = "dart",
        .language_id = "dart",
        .argv = &.{ "dart", "language-server", "--protocol=lsp" },
        .extensions = &.{"dart"},
        .install = "brew install dart-sdk",
    },
    .{
        .id = "elm-language-server",
        .language_id = "elm",
        .argv = &.{"elm-language-server"},
        .extensions = &.{"elm"},
        .install = "npm i -g @elm-tooling/elm-language-server",
    },
    .{
        .id = "nimlangserver",
        .language_id = "nim",
        .argv = &.{"nimlangserver"},
        .extensions = &.{ "nim", "nims" },
        .install = "nimble install nimlangserver",
    },
    .{
        .id = "crystalline",
        .language_id = "crystal",
        .argv = &.{"crystalline"},
        .extensions = &.{"cr"},
        .install = "brew install crystalline",
    },
    .{
        .id = "serve-d",
        .language_id = "d",
        .argv = &.{"serve-d"},
        .extensions = &.{ "d", "di" },
        .install = "dub fetch serve-d && dub run serve-d",
    },
    .{
        .id = "racket-langserver",
        .language_id = "racket",
        .argv = &.{ "racket", "-l", "racket-langserver" },
        .extensions = &.{ "rkt", "rktl" },
        .install = "raco pkg install racket-langserver",
    },
    .{
        .id = "perlnavigator",
        .language_id = "perl",
        .argv = &.{ "perlnavigator", "--stdio" },
        .extensions = &.{ "pl", "pm", "t" },
        .install = "npm i -g perlnavigator-server",
    },
    .{
        .id = "r-languageserver",
        .language_id = "r",
        .argv = &.{ "R", "--no-echo", "-e", "languageserver::run()" },
        .extensions = &.{ "r", "R", "Rmd" },
        .install = "Rscript -e 'install.packages(\"languageserver\")'",
    },
    .{
        .id = "julia-lsp",
        .language_id = "julia",
        .argv = &.{ "julia", "--startup-file=no", "-e", "using LanguageServer; runserver()" },
        .extensions = &.{"jl"},
        .install = "julia -e 'using Pkg; Pkg.add(\"LanguageServer\")'",
    },
    .{
        .id = "texlab",
        .language_id = "latex",
        .argv = &.{"texlab"},
        .extensions = &.{ "tex", "bib", "sty", "cls" },
        .install = "brew install texlab",
    },
    .{
        .id = "marksman",
        .language_id = "markdown",
        .argv = &.{ "marksman", "server" },
        .extensions = &.{ "md", "markdown" },
        .install = "brew install marksman",
    },
    .{
        .id = "terraform-ls",
        .language_id = "terraform",
        .argv = &.{ "terraform-ls", "serve" },
        .extensions = &.{ "tf", "tfvars" },
        .install = "brew install hashicorp/tap/terraform-ls",
    },
    .{
        .id = "docker-langserver",
        .language_id = "dockerfile",
        .argv = &.{ "docker-langserver", "--stdio" },
        .extensions = &.{"dockerfile"},
        .filenames = &.{"Dockerfile"},
        .install = "npm i -g dockerfile-language-server-nodejs",
    },
    .{
        .id = "cmake-language-server",
        .language_id = "cmake",
        .argv = &.{"cmake-language-server"},
        .extensions = &.{"cmake"},
        .filenames = &.{"CMakeLists.txt"},
        .install = "pipx install cmake-language-server",
    },
    .{
        .id = "sqls",
        .language_id = "sql",
        .argv = &.{"sqls"},
        .extensions = &.{"sql"},
        .install = "go install github.com/sqls-server/sqls@latest",
    },
    .{
        .id = "solidity-language-server",
        .language_id = "solidity",
        .argv = &.{ "nomicfoundation-solidity-language-server", "--stdio" },
        .extensions = &.{"sol"},
        .install = "npm i -g @nomicfoundation/solidity-language-server",
    },
    .{
        .id = "fortls",
        .language_id = "fortran",
        .argv = &.{"fortls"},
        .extensions = &.{ "f", "f90", "f95", "f03", "f08" },
        .install = "pipx install fortls",
    },
    .{
        .id = "asm-lsp",
        .language_id = "asm",
        .argv = &.{"asm-lsp"},
        .extensions = &.{ "asm", "s", "S" },
        .install = "cargo install asm-lsp",
    },
    .{
        .id = "veryl-ls",
        .language_id = "verilog",
        .argv = &.{"svls"},
        .extensions = &.{ "v", "sv", "svh" },
        .install = "cargo install svls",
    },
};

pub fn byId(id: []const u8) ?Server {
    for (table) |server| {
        if (std.mem.eql(u8, server.id, id)) return server;
    }
    return null;
}

pub fn forPath(path: []const u8) ?Server {
    const base = std.fs.path.basename(path);
    for (table) |server| {
        for (server.filenames) |name| {
            if (std.mem.eql(u8, name, base)) return server;
        }
    }

    const dot = std.mem.lastIndexOfScalar(u8, base, '.') orelse return null;
    const ext = base[dot + 1 ..];
    if (ext.len == 0) return null;
    for (table) |server| {
        for (server.extensions) |candidate| {
            if (std.mem.eql(u8, candidate, ext)) return server;
        }
    }
    return null;
}

pub fn executablePath(alloc: std.mem.Allocator, name: []const u8) ?[]u8 {
    if (std.mem.indexOfScalar(u8, name, '/') != null) {
        std.Io.Dir.cwd().access(io_mod.getIo(), name, .{}) catch return null;
        return alloc.dupe(u8, name) catch null;
    }
    const path_env = io_mod.getenv("PATH") orelse return null;
    var directories = std.mem.tokenizeScalar(u8, path_env, ':');
    while (directories.next()) |directory| {
        const candidate = std.fs.path.join(alloc, &.{ directory, name }) catch return null;
        const stat = std.Io.Dir.cwd().statFile(io_mod.getIo(), candidate, .{}) catch {
            alloc.free(candidate);
            continue;
        };
        if (stat.kind == .directory) {
            alloc.free(candidate);
            continue;
        }
        return candidate;
    }
    return null;
}

pub fn initializationOptions(
    alloc: std.mem.Allocator,
    server: Server,
    root: []const u8,
) ![]const u8 {
    if (!std.mem.eql(u8, server.id, "typescript-language-server")) return "null";
    if (workspaceTypescript(alloc, root)) return "null";
    const tsserver = globalTypescriptLib(alloc) orelse return "null";
    defer alloc.free(tsserver);
    return std.fmt.allocPrint(
        alloc,
        "{{\"tsserver\":{{\"path\":{f}}}}}",
        .{std.json.fmt(tsserver, .{})},
    );
}

fn workspaceTypescript(alloc: std.mem.Allocator, root: []const u8) bool {
    const candidate = std.fs.path.join(
        alloc,
        &.{ root, "node_modules", "typescript", "lib", "tsserver.js" },
    ) catch return false;
    defer alloc.free(candidate);
    _ = std.Io.Dir.cwd().statFile(io_mod.getIo(), candidate, .{}) catch return false;
    return true;
}

fn globalTypescriptLib(alloc: std.mem.Allocator) ?[]u8 {
    const executable = executablePath(alloc, "typescript-language-server") orelse return null;
    defer alloc.free(executable);
    const resolved = io_mod.realpathAlloc(alloc, executable) catch return null;
    defer alloc.free(resolved);

    var directory = std.fs.path.dirname(resolved);
    while (directory) |current| : (directory = std.fs.path.dirname(current)) {
        if (!std.mem.eql(u8, std.fs.path.basename(current), "node_modules")) continue;
        const candidate = std.fs.path.join(
            alloc,
            &.{ current, "typescript", "lib", "tsserver.js" },
        ) catch return null;
        _ = std.Io.Dir.cwd().statFile(io_mod.getIo(), candidate, .{}) catch {
            alloc.free(candidate);
            return null;
        };
        return candidate;
    }
    return null;
}

pub fn isInstalled(alloc: std.mem.Allocator, server: Server) bool {
    const resolved = executablePath(alloc, server.argv[0]) orelse return false;
    alloc.free(resolved);
    return true;
}

test "servers resolve by extension and by exact filename" {
    try std.testing.expectEqualStrings("zls", (forPath("src/main.zig").?).id);
    try std.testing.expectEqualStrings("rust-analyzer", (forPath("/a/b/lib.rs").?).id);
    try std.testing.expectEqualStrings("typescript-language-server", (forPath("app/main.tsx").?).id);
    try std.testing.expectEqualStrings("docker-langserver", (forPath("deploy/Dockerfile").?).id);
    try std.testing.expectEqualStrings("cmake-language-server", (forPath("CMakeLists.txt").?).id);
    try std.testing.expect(forPath("notes") == null);
    try std.testing.expect(forPath("archive.unknownext") == null);
}

test "server ids are unique and every server documents an install command" {
    for (table, 0..) |server, index| {
        try std.testing.expect(server.argv.len > 0);
        try std.testing.expect(server.install.len > 0);
        try std.testing.expect(server.language_id.len > 0);
        for (table[index + 1 ..]) |other| {
            try std.testing.expect(!std.mem.eql(u8, server.id, other.id));
        }
    }
}
