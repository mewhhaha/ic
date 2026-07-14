import { assert_equals } from "../assert.ts";
import type { TextDocument } from "./documents.ts";
import {
  discover_workspace_roots,
  workspace_definition_location,
  workspace_reference_locations,
  workspace_rename_symbol,
  WorkspaceModel,
} from "./workspace.ts";

Deno.test("workspace discovers marker roots, imports, and overlay precedence", async () => {
  const root_path = await Deno.makeTempDir({ prefix: "ix-workspace-" });

  try {
    await Deno.writeTextFile(root_path + "/AGENTS.md", "workspace\n");
    await Deno.mkdir(root_path + "/src", { recursive: true });
    await Deno.writeTextFile(
      root_path + "/src/a.ix",
      "let exported = 1\nexported\n",
    );
    await Deno.writeTextFile(
      root_path + "/src/b.ix",
      'const a = import "./a.ix"\nlet value = a.exported\n',
    );
    await Deno.writeTextFile(
      root_path + "/src/c.ix",
      'const b = import "./b.ix"\nlet value = b.value\n',
    );
    await Deno.writeTextFile(
      root_path + "/src/unrelated.ix",
      "let separate = 9\n",
    );
    const root_uri = directory_uri(root_path);
    const nested_uri = directory_uri(root_path + "/src");
    assert_equals(discover_workspace_roots([nested_uri]), [root_uri]);

    const model = new WorkspaceModel([nested_uri]);
    const progress: Array<[number, number]> = [];
    model.load([], (event) => progress.push([event.loaded, event.total]));
    assert_equals(model.file_count(), 4);
    assert_equals(model.dependency_count(), 2);
    assert_equals(progress.at(-1), [4, 4]);

    const a_uri = file_uri(root_path + "/src/a.ix");
    const b_uri = file_uri(root_path + "/src/b.ix");
    const c_uri = file_uri(root_path + "/src/c.ix");
    assert_equals(model.affected_dependents(a_uri, 8, 8), [b_uri, c_uri]);
    assert_equals(model.affected_dependents(a_uri, 1, 8), [b_uri]);
    assert_equals(model.affected_dependents(a_uri, 8, 1), [b_uri]);

    const overlay: TextDocument = {
      uri: b_uri,
      version: 2,
      text: 'const a = import "./a.ix"\nlet value = a.exported + 1\n',
    };
    assert_equals(model.text(b_uri, [overlay]), overlay.text);
    assert_equals(
      model.entries([overlay]).find((entry) => entry.uri === b_uri)?.text,
      overlay.text,
    );
  } finally {
    await Deno.remove(root_path, { recursive: true });
  }
});

Deno.test("workspace navigation follows and renames imported members", async () => {
  const root_path = await Deno.makeTempDir({ prefix: "ix-navigation-" });

  try {
    await Deno.writeTextFile(root_path + "/AGENTS.md", "workspace\n");
    const a_text = "let exported = 1\nexported\n";
    const b_text = 'const a = import "./a.ix"\nlet value = a.exported\n';
    await Deno.writeTextFile(root_path + "/a.ix", a_text);
    await Deno.writeTextFile(root_path + "/b.ix", b_text);
    const a_uri = file_uri(root_path + "/a.ix");
    const b_uri = file_uri(root_path + "/b.ix");
    const model = new WorkspaceModel([directory_uri(root_path)]);
    model.load([]);
    const entries = model.entries([]);
    const member_offset = b_text.lastIndexOf("exported");
    assert_equals(
      workspace_definition_location(
        entries,
        b_uri,
        member_offset,
        "utf-16",
      ),
      {
        uri: a_uri,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 12 },
        },
      },
    );
    assert_equals(
      workspace_reference_locations(
        entries,
        b_uri,
        member_offset,
        true,
        "utf-16",
      ),
      [{
        uri: a_uri,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 12 },
        },
      }, {
        uri: a_uri,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 8 },
        },
      }, {
        uri: b_uri,
        range: {
          start: { line: 1, character: 14 },
          end: { line: 1, character: 22 },
        },
      }],
    );

    const rename = workspace_rename_symbol(
      entries,
      b_uri,
      member_offset,
      "renamed",
      "utf-16",
    );
    assert_equals(rename, {
      changes: {
        [a_uri]: [{
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 12 },
          },
          newText: "renamed",
        }, {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 8 },
          },
          newText: "renamed",
        }],
        [b_uri]: [{
          range: {
            start: { line: 1, character: 14 },
            end: { line: 1, character: 22 },
          },
          newText: "renamed",
        }],
      },
    });
  } finally {
    await Deno.remove(root_path, { recursive: true });
  }
});

function directory_uri(path: string): string {
  const uri = new URL("file://" + path + "/");
  return uri.href;
}

function file_uri(path: string): string {
  return new URL("file://" + path).href;
}
