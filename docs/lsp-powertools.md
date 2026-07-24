# LSP powertools

The language server exposes `duck.runExample` as an optional workspace command.
Runnable files receive a `▸ run example` code lens when their path appears in
`examples/manifest.ts`.

The command returns a Deno test invocation for the client terminal. The language
server does not execute the program itself.

For Helix, bind a key to the workspace command:

```toml
[keys.normal]
space-r = ":lsp-workspace-command duck.runExample"
```
