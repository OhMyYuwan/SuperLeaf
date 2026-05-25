# YuwanLabWriter MCPs

Curated MCP catalog for YuwanLabWriter Native Agents.

This support library records verified MCP servers, their startup configuration,
environment requirements, risk posture, recommended tools, known limitations,
and golden tests. The main YuwanLabWriter app consumes this catalog; it should
not hardcode one-off MCP behavior in the frontend.

## Verification Grades

- `citation_metadata`: suitable for source-backed citation metadata when the
  preset passes its golden tests.
- `preprint_discovery`: useful for exploratory discovery, not citation-grade
  verification by itself.
- `general_tool`: generic MCP tool server; safety depends on risk flags and
  selected tools.

## Current Academic Search Policy

Semantic Scholar is the primary built-in academic metadata search preset.
Paper Search is kept as exploratory preprint discovery because its arXiv
keyword search can return noisy results for exact benchmark names.

## Contributor Docs

- [MCP catalog docs](docs/README.md)
- [Add an MCP preset](docs/adding-mcp.md)
- [Verification and golden tests](docs/verification.md)

For app-side routing, see the ACP slice
`native-agent-skills/mcp-catalog` in the main repository.
