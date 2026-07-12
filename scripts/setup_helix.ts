const begin_marker = "# >>> ix (managed by /home/mewhhaha/src/binned) >>>";
const end_marker = "# <<< ix (managed by /home/mewhhaha/src/binned) <<<";

const repository_url = new URL("../", import.meta.url);
const repository = decodeURIComponent(repository_url.pathname).replace(
  /\/$/,
  "",
);
const home = Deno.env.get("HOME");

if (home === undefined) {
  throw new Error("HOME is not set");
}

let config_home = Deno.env.get("XDG_CONFIG_HOME");

if (config_home === undefined) {
  config_home = home + "/.config";
}

const helix = config_home + "/helix";
const languages_path = helix + "/languages.toml";
const query_target = helix + "/runtime/queries/ix";
const grammar_directory = helix + "/runtime/grammars";
const grammar_path = repository + "/tree-sitter-ix";
const query_source = grammar_path + "/queries";
let grammar_extension: string;

if (Deno.build.os === "linux") {
  grammar_extension = "so";
} else if (Deno.build.os === "darwin") {
  grammar_extension = "dylib";
} else if (Deno.build.os === "windows") {
  grammar_extension = "dll";
} else {
  throw new Error("Unsupported operating system: " + Deno.build.os);
}

const grammar_target = grammar_directory + "/ix." + grammar_extension;

await Deno.mkdir(helix, { recursive: true });
await Deno.mkdir(query_target, { recursive: true });
await Deno.mkdir(grammar_directory, { recursive: true });

let languages = "";

try {
  languages = await Deno.readTextFile(languages_path);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) {
    throw error;
  }
}

const start = languages.indexOf(begin_marker);

if (start >= 0) {
  const end = languages.indexOf(end_marker, start);

  if (end < 0) {
    throw new Error("Found Ix Helix block without its closing marker");
  }

  const after = end + end_marker.length;
  languages = languages.slice(0, start) + languages.slice(after);
}

const managed_block = `${begin_marker}
[language-server.ix]
command = "deno"
args = ["run", "--allow-read", "${repository}/ix.ts", "lsp"]

[[language]]
name = "ix"
language-id = "ix"
scope = "source.ix"
injection-regex = "^ix$"
file-types = ["ix"]
roots = ["AGENTS.md", ".git"]
comment-token = "//"
grammar = "ix"
rainbow-brackets = true
indent = { tab-width = 2, unit = "  " }
language-servers = ["ix"]
auto-format = true

[[grammar]]
name = "ix"
source = { path = "${grammar_path}" }
${end_marker}
`;

const updated = languages.trimEnd() + "\n\n" + managed_block;
await Deno.writeTextFile(languages_path, updated);

for await (const entry of Deno.readDir(query_source)) {
  if (!entry.isFile || !entry.name.endsWith(".scm")) {
    continue;
  }

  await Deno.copyFile(
    query_source + "/" + entry.name,
    query_target + "/" + entry.name,
  );
}

const grammar_build = new Deno.Command("tree-sitter", {
  args: ["build", "--output", grammar_target, grammar_path],
  stdout: "inherit",
  stderr: "inherit",
});
const grammar_status = await grammar_build.spawn().status;

if (!grammar_status.success) {
  throw new Error("Failed to build the Ix Tree-sitter grammar");
}

console.log("Registered Ix in " + languages_path);
console.log("Installed Ix queries in " + query_target);
console.log("Installed Ix grammar in " + grammar_target);
