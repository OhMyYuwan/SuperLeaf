# YuwanLabWriter MCPs

Curated MCP catalog for YuwanLabWriter Native Agents.

This support library records verified MCP servers, their startup configuration,
environment requirements, risk posture, recommended tools, known limitations,
and golden tests. The main YuwanLabWriter app consumes this catalog; it should
not hardcode one-off MCP behavior in the frontend.

## Registry Model

MCPs are maintained as marketplace entries, not as frontend-specific presets.
Each preset belongs to one registry:

- `official`: maintained or deeply adapted by YuwanLabWriter.
- `external`: sourced from GitHub / community MCP projects and verified here.

Every MCP display name should use `owner@mcp-name`. For GitHub projects, the
owner should match the GitHub owner where possible, for example
`akapet00@semantic-scholar`.

Use `official_recommended: true` only for entries that YuwanLabWriter actively
recommends as a default choice after manual acceptance. This is an endorsement,
not a change of ownership.

## Verification Grades

- `citation_metadata`: suitable for source-backed citation metadata when the
  preset passes its golden tests.
- `preprint_discovery`: useful for exploratory discovery, not citation-grade
  verification by itself.
- `general_tool`: generic MCP tool server; safety depends on risk flags and
  selected tools.

## Current Academic Search Policy

Semantic Scholar is the primary owned-market academic metadata search preset.
Paper Search is kept as exploratory preprint discovery because its arXiv
keyword search can return noisy results for exact benchmark names.

## Contributor Docs

- [MCP catalog docs](docs/README.md)
- [Add an MCP preset](docs/adding-mcp.md)
- [Verification and golden tests](docs/verification.md)

For app-side routing, see the ACP slice
`native-agent-skills/mcp-catalog` in the main repository.
