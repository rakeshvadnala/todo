# Changelog

All notable changes to this project will be documented here.

## v2.0.0 (2026-07-23)

### Added
- Multi-profile support — switch between people on the same board with just a username, no passwords; each profile has fully isolated tasks, projects, and settings
- GitHub sync — push/pull board data to a GitHub repo so multiple people/devices stay in sync, with automatic per-task conflict merging (newest `updatedAt` wins) when two people edit around the same time, and a debounced auto-sync plus manual "Sync now" / "Pull latest" controls
- Projects — create, rename, and delete projects; assign tasks to a project; filter the board by project; color-coded project chips on cards
- Board Insights & Analytics dashboard — Active/Completed/Completion Rate/Overdue KPI cards, 7-day completion velocity chart, status and priority breakdowns, and a "Most Active Projects" panel
- Monthly calendar (inside Board Insights) — navigate by month and year (dropdowns plus prev/next), see completed and due-task counts per day, click any day to see exactly which tasks were completed or due that day
- Bulk select & actions — multi-select tasks (checkbox or click) and move, archive, or delete them as a batch, with the same undo/confirm safety as single-task actions
- Subtask timestamps — every subtask now records when it was added and last modified, shown in the subtask editor and as a hover tooltip on the card checklist
- Auto-scroll while dragging a card near the top/bottom edge of a long column

### Changed
- Drag-and-drop now preserves the exact position a card is dropped in — "Board order" (manual drag position) is the default sort, instead of the card snapping back to sort order after every drop
- Task completion attribution ("Completed by") now comes directly from the active profile, replacing the old separate name prompt
- Switching profiles now correctly refreshes the Sort/Status dropdown UI to match that profile's saved settings

### Fixed
- Dragging a card no longer "shakes" — the previous drag engine was repeatedly re-triggering the card's entrance animation on every live reorder; the drag engine now moves a lightweight placeholder instead of the real card, which structurally can't replay that animation
- Removed a leftover native `draggable="true"` attribute that was competing with the custom pointer-based drag system
- Fixed undefined CSS variables in `custom-ui.css` (`--text-main` / `--text-mut`) that meant custom dropdown and date-picker text wasn't properly themed

## v1.0.0 (2026-07-10)

### Added
- Kanban board
- Drag & Drop
- Daily / In Progress / Completed columns
- Subtasks
- Overall Progress Bar
- Search
- Filters
- Sorting
- Archive & Restore
- Export / Import JSON
- Dark Mode
- Keyboard Shortcuts
- Offline LocalStorage
- Responsive UI
