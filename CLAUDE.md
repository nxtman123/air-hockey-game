# TelemetryOS Application

**Application:** Air Hockey

## Skills (REQUIRED)

**IMPORTANT:** You MUST invoke the `skill` MCP tool BEFORE planning a design OR writing code for any of these tasks, and invoke `testing` AFTER building views. This applies equally in plan mode — load the skill into context before you propose an approach, not after code edits start. Available skills and their descriptions are listed in the tool's description — use `ToolSearch("skill")` to see them.

**Never plan or write Render layouts, Settings components, or proxy.fetch code without invoking the relevant skill first.**

## MCP Tools

**IMPORTANT:** If any `tos` MCP tool call fails or is not available, do NOT attempt to debug or find workarounds. Instead, immediately tell the user to close and reopen Claude Code, or use `/mcp` to reconnect.

The `tos` MCP server exposes tools for interacting with the running Developer App. Use `ToolSearch("tos")` to discover all available tools and their parameters.

Tool categories:
- **Visual** — screenshot mount points, set aspect ratio / background / color scheme for testing responsive layouts
- **Store** — read, write, and inspect store values across scopes to test data flows
- **DOM** — click elements, fill inputs, read text, and evaluate JS in mount points
- **Logs** — read console output, dev server stderr, and internal utility logs for debugging
- **Lifecycle** — reload the window, restart the dev server, clear all stub data
- **Project** — check which projects are currently open in the Developer App

## Development Workflow

1. **Open the project** — run `tos dev` (idempotent — opens the project if needed, no-ops if already open). It auto-applies pending migrations. The MCP tools require the Developer App to be running.
2. **During development** — use `dev_server_logs` and `console_logs` MCP tools to check for TypeScript and runtime errors. The dev server provides HMR and shows compilation errors in real time. Do not run `pnpm run build` during development.
3. **Testing** — invoke `skill(name: "testing")` and test all views: screenshots at multiple aspect ratios, settings UI, data sync, and edge cases.
4. **Final verification** — run `pnpm run build` once at the end for a clean TypeScript + production build pass.

**If MCP tools aren't connecting** — run `tos dev` to auto-apply pending migrations and ensure the Developer App is running.

**Node.js access** — If `pnpm` or `node` are not available on the system PATH, use `tos pnpm` and `tos node` instead. These resolve to the managed Node.js installation.

## CLI

The `tos` CLI manages TelemetryOS application projects. Run `tos --help` to see all commands.

Key commands: `tos dev`, `tos init`, `tos migrate`, `tos publish`, `tos archive`, `tos version`, `tos auth`.

The dev server runs on a dynamic port assigned by the app (`$PORT` in `telemetry.config.json`) — there is no fixed URL. The Render mount point is in a resizable canvas pane. The Settings mount point is in the right sidebar. The Web mount point (if configured) appears as a tab.

## Documentation

- [SDK Getting Started](https://docs.telemetryos.com/docs/sdk-getting-started)
- [SDK Method Reference](https://docs.telemetryos.com/docs/sdk-method-reference)
- [Building Applications](https://docs.telemetryos.com/docs/applications)
