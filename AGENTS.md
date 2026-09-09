# pi-agent-canvas (Plane: **pi vantage** / VNTG)

## Project state — tracked in Plane cycles

Project state is managed as high-level **cycles** in the Plane project
**pi vantage** (identifier `VNTG`, connected via the `plane` MCP server).
Check/update the current cycle there before planning or reporting status.

### Cycle map
| Cycle | Name | Window | Status |
|---|---|---|---|
| Cycle 1 | Blank canvas window | 2026-09-09 → 2026-09-12 | **~50% done** — extension, chat removal, tests committed (`0470d6b`); remaining: GitHub push + packaging (publisher, icon, vsce) |
| Cycle 2 | UI interface for pi dev | 2026-09-13 → 2026-09-26 | upcoming |

### Working rules
- **Incremental build only.** This tool is created incrementally; every
  addition (dependency, feature, abstraction, setting) must be thoughtful and
  **earn its place**. No speculative scaffolding, no "might need later" code.
  When in doubt, leave it out — it can always be added when it proves needed.
- **Always anchor status to the active cycle** in Plane: when a milestone lands,
  update the cycle's description / add a work item; when starting work, confirm
  which cycle it belongs to (create a new cycle via `plane_cycle create` if none fits).
- Repo: `/home/rajdeep-yadav/projects/pi-agent-canvas` (git `main`).
- Plane project id: `b06463f6-360f-4320-83ed-a01add5695b8`.
- Owner/member id for `owned_by`: `e82f68ff-922c-4794-b772-bf8aad4cf93e`.
