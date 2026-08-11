import {
	type Component,
	Ellipsis,
	getKeybindings,
	type Keybinding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row as overlayRow, topBorder } from "./overlay-box";
import { theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";

/** A volatile, complete snapshot of rows displayed by a dashboard. */
export interface DashboardDataSource<Row extends { id: string }> {
	/**
	 * Return the current complete row snapshot. A source must replace this snapshot
	 * when its content changes; callers retain the array reference until the next
	 * change notification.
	 */
	getRows(): readonly Row[];
	/** Subscribe to complete-snapshot replacements. */
	subscribe?(listener: () => void): () => void;
	/** Optionally ask the source to obtain a newer complete snapshot. */
	refresh?(): void | Promise<void>;
}

/** Callbacks supplied by a dashboard feature; the toolkit owns no feature state. */
export interface DashboardActions<Row extends { id: string }> {
	requestRender?(): void;
	onRowsChange?(rows: readonly Row[]): void;
	onSelectionChange?(row: Row | null): void;
	onActivate?(row: Row): void;
	onClose?(): void;
}

export type DashboardDisposer = () => void;

/**
 * A disposal bag that can safely be torn down more than once. Adding a disposer
 * after teardown runs it immediately, which prevents a late async completion
 * from leaking a subscription or timer.
 */
export class DashboardDisposalBag {
	#disposers: DashboardDisposer[] | null = [];

	add(disposer: DashboardDisposer): DashboardDisposer {
		const disposers = this.#disposers;
		if (disposers === null) {
			disposer();
			return disposer;
		}
		disposers.push(disposer);
		return disposer;
	}

	dispose(): void {
		const disposers = this.#disposers;
		if (disposers === null) return;
		this.#disposers = null;
		for (let index = disposers.length - 1; index >= 0; index--) {
			disposers[index]!();
		}
	}
}

/** Coalesces repeated invalidations into one render request per 100 ms window. */
export class DashboardInvalidator {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(
		private readonly invalidate: () => void,
		private readonly delayMs: number = 100,
	) {}

	schedule(): void {
		if (this.#disposed || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (!this.#disposed) this.invalidate();
		}, this.delayMs);
		this.#timer.unref?.();
	}

	flush(): void {
		if (this.#disposed || this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.invalidate();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * ID-based selection survives row-object replacement and temporary filtering.
 * When a filter hides the selected ID, `selected()` returns null, but the ID is
 * retained so the same row becomes selected if it returns.
 */
export class DashboardSelection<Row extends { id: string }> {
	#selectedId: string | null;
	#rows: readonly Row[] = [];

	constructor(selectedId: string | null = null) {
		this.#selectedId = selectedId;
	}

	get selectedId(): string | null {
		return this.#selectedId;
	}

	get rows(): readonly Row[] {
		return this.#rows;
	}

	replace(rows: readonly Row[]): void {
		assertUniqueDashboardRowIds(rows);
		this.#rows = rows;
	}

	selected(): Row | null {
		const id = this.#selectedId;
		if (id === null) return null;
		for (const row of this.#rows) {
			if (row.id === id) return row;
		}
		return null;
	}

	indexOfSelected(): number {
		const id = this.#selectedId;
		if (id === null) return -1;
		for (let index = 0; index < this.#rows.length; index++) {
			if (this.#rows[index]!.id === id) return index;
		}
		return -1;
	}

	select(id: string | null): Row | null {
		this.#selectedId = id;
		return this.selected();
	}

	/**
	 * Move the cursor by `delta`, wrapping at both ends so no arrow key is ever
	 * dead. A page-sized delta past an end lands on that end before wrapping on
	 * the next press, which keeps paging predictable in long lists.
	 */
	move(delta: number): Row | null {
		const rows = this.#rows;
		if (rows.length === 0) return this.select(null);
		const index = this.indexOfSelected();
		if (index < 0) return this.select(rows[delta < 0 ? rows.length - 1 : 0]!.id);
		const target = index + delta;
		let next: number;
		if (target < 0) next = index === 0 ? rows.length - 1 : 0;
		else if (target > rows.length - 1) next = index === rows.length - 1 ? 0 : rows.length - 1;
		else next = target;
		return this.select(rows[next]!.id);
	}
}

/** Reject duplicate IDs before a new row snapshot is committed. */
export function assertUniqueDashboardRowIds<Row extends { id: string }>(rows: readonly Row[]): void {
	const ids = new Set<string>();
	for (const row of rows) {
		if (!row.id) throw new Error("Dashboard row IDs must be non-empty");
		if (ids.has(row.id)) throw new Error(`Duplicate dashboard row ID: ${row.id}`);
		ids.add(row.id);
	}
}

/** Width-safe one-line dashboard text that preserves the TUI ANSI convention. */
export function dashboardText(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\r\n]+/g, " "), Math.max(1, width), Ellipsis.Unicode);
}

/** Width-safe title text for dashboard headers. */
export function dashboardHeaderText(text: string, width: number): string {
	return dashboardText(text, width);
}

/** Width-safe text for dashboard rows. */
export function dashboardRowText(text: string, width: number): string {
	return dashboardText(text, width);
}

/** Width-safe text for dashboard footers. */
export function dashboardFooterText(text: string, width: number): string {
	return dashboardText(text, width);
}

/** Match a configured editor keybinding by semantic action rather than raw bytes. */
export function matchesDashboardKey(data: string, action: Keybinding): boolean {
	return getKeybindings().matches(data, action);
}

/** Render a configured editor keybinding with the standard dashboard hint styling. */
export function dashboardKeyHint(action: Keybinding, description: string): string {
	return keyHint(action, description);
}

/** Render a non-configurable key (arrows, page keys) with the same hint styling. */
export function dashboardRawKeyHint(key: string, description: string): string {
	return rawKeyHint(key, description);
}

/** The two navigation hints every dashboard footer carries. */
export function dashboardMoveHint(): string {
	return rawKeyHint("↑↓", "move");
}

export function dashboardPageHint(): string {
	return rawKeyHint("PgUp/PgDn", "page");
}

/** Join footer hints with the house dim separator. */
export function joinDashboardHints(hints: readonly string[]): string {
	return hints.filter(hint => hint.length > 0).join(theme.fg("dim", " · "));
}

/** Accent cursor for the selected row; a blank cell keeps unselected rows aligned. */
export function dashboardCursor(selected: boolean): string {
	return selected ? theme.fg("accent", theme.nav.cursor) : " ";
}

/** Semantic row states shared by every dashboard list. */
export type DashboardRowState = "active" | "inactive" | "busy" | "pending" | "warning" | "error";

/**
 * Themed glyph for a row state. Colour never carries the meaning alone — every
 * caller pairs this with the state word in the row or detail text.
 */
export function dashboardStateGlyph(state: DashboardRowState): string {
	switch (state) {
		case "active":
			return theme.fg("success", theme.status.enabled);
		case "inactive":
			return theme.fg("dim", theme.status.disabled);
		case "busy":
			return theme.fg("accent", theme.status.running);
		case "pending":
			return theme.fg("muted", theme.status.pending);
		case "warning":
			return theme.fg("warning", theme.status.warning);
		case "error":
			return theme.fg("error", theme.status.error);
	}
}

/** Dim secondary metadata, prefixed by the house dot separator. */
export function dashboardMeta(text: string): string {
	return theme.fg("dim", `${theme.sep.dot}${text}`);
}

/** A themed error line for a failure the dashboard must keep visible. */
export function dashboardWarningText(warning: string): string {
	return theme.fg("error", `${theme.status.warning} ${warning}`);
}

/** Shared selector navigation, delegated to the application's semantic matchers. */
export const dashboardNavigation = {
	cancel: matchesSelectCancel,
	down: matchesSelectDown,
	pageDown: matchesSelectPageDown,
	pageUp: matchesSelectPageUp,
	up: matchesSelectUp,
} as const;

export interface DashboardListShellOptions<Row extends { id: string }> {
	rows: readonly Row[];
	selectedId?: string | null;
	emptyText?: string;
	/**
	 * Total line budget including any `… N more` markers. Omit to render every
	 * row, which keeps non-interactive renders deterministic.
	 */
	maxRows?: number;
	renderRow(row: Row, selected: boolean, width: number): string;
}

/**
 * Render a width-safe list body without retaining feature-specific row state.
 * When `maxRows` is smaller than the row count, the window is centred on the
 * selection and the hidden head/tail counts are reported so the cursor is never
 * silently clipped.
 */
export function renderDashboardListShell<Row extends { id: string }>(
	options: DashboardListShellOptions<Row>,
	width: number,
): readonly string[] {
	const rows = options.rows;
	const renderWidth = Math.max(1, width);
	if (rows.length === 0) return [dashboardRowText(options.emptyText ?? "No items", renderWidth)];

	const selectedId = options.selectedId ?? null;
	const budget = options.maxRows === undefined ? rows.length : Math.max(1, Math.trunc(options.maxRows));

	let start = 0;
	let end = rows.length;
	if (rows.length > budget) {
		let selected = 0;
		for (let index = 0; index < rows.length; index++) {
			if (rows[index]!.id === selectedId) {
				selected = index;
				break;
			}
		}
		// Reserve a line for each marker, then reclaim one when the window sits
		// against an end and that marker is unnecessary.
		let visible = Math.max(1, budget - 2);
		start = Math.min(Math.max(0, selected - (visible >> 1)), rows.length - visible);
		end = start + visible;
		if (start === 0 && end < rows.length) {
			visible = Math.max(1, budget - 1);
			end = Math.min(rows.length, visible);
		} else if (end >= rows.length && start > 0) {
			visible = Math.max(1, budget - 1);
			start = Math.max(0, rows.length - visible);
			end = rows.length;
		}
	}

	const rendered: string[] = [];
	if (start > 0) rendered.push(dashboardRowText(theme.fg("dim", `… ${start} more`), renderWidth));
	for (let index = start; index < end; index++) {
		const row = rows[index]!;
		rendered.push(dashboardRowText(options.renderRow(row, row.id === selectedId, renderWidth), renderWidth));
	}
	const hiddenTail = rows.length - end;
	if (hiddenTail > 0) rendered.push(dashboardRowText(theme.fg("dim", `… ${hiddenTail} more`), renderWidth));
	return rendered;
}

export interface DashboardDetailShellOptions<Row extends { id: string }> {
	row: Row | null;
	emptyText?: string;
	renderDetail(row: Row, width: number): readonly string[];
}

/** Render a width-safe detail body for the current row. */
export function renderDashboardDetailShell<Row extends { id: string }>(
	options: DashboardDetailShellOptions<Row>,
	width: number,
): readonly string[] {
	const renderWidth = Math.max(1, width);
	if (options.row === null) return [dashboardText(options.emptyText ?? "No item selected", renderWidth)];
	const detail = options.renderDetail(options.row, renderWidth);
	const rendered = new Array<string>(detail.length);
	for (let index = 0; index < detail.length; index++) {
		rendered[index] = dashboardText(detail[index]!, renderWidth);
	}
	return rendered;
}

/** Below this width the box chrome costs more columns than it earns. */
const MIN_BOXED_WIDTH = 24;

/** Rows a dashboard may paint when the terminal height is unknown. */
const DEFAULT_VIEWPORT_ROWS = 40;

export interface DashboardOverlayOptions<Row extends { id: string }> {
	title: string;
	/** A failure the view must surface; rendered between the title and the list. */
	warning?: string | undefined;
	rows: readonly Row[];
	selectedId?: string | null;
	emptyText?: string;
	renderRow(row: Row, selected: boolean, width: number): string;
	detail: Row | null;
	detailEmptyText?: string;
	renderDetail(row: Row, width: number): readonly string[];
	/** Footer hints, already formatted by `dashboardKeyHint`/`dashboardMoveHint`. */
	hints: readonly string[];
	/**
	 * Total line budget. Omit to use the terminal height, or pass an explicit
	 * value for a deterministic non-interactive render.
	 */
	viewportRows?: number;
}

/**
 * The single dashboard frame: titled rule, optional warning, windowed list,
 * divider, detail, divider, key hints. Every view in the suite renders through
 * this so the chrome, spacing, and separator style cannot drift apart.
 */
export function renderDashboardOverlay<Row extends { id: string }>(
	options: DashboardOverlayOptions<Row>,
	width: number,
): readonly string[] {
	const totalWidth = Math.max(1, Math.trunc(width));
	const boxed = totalWidth >= MIN_BOXED_WIDTH;
	const innerWidth = boxed ? totalWidth - 4 : totalWidth;
	const viewportRows = Math.max(
		8,
		Math.trunc(options.viewportRows ?? (process.stdout.rows || DEFAULT_VIEWPORT_ROWS) - 2),
	);

	const warning = options.warning ? dashboardWarningText(options.warning) : undefined;
	const detail = renderDashboardDetailShell(
		{ row: options.detail, emptyText: options.detailEmptyText, renderDetail: options.renderDetail },
		innerWidth,
	);
	const hints = dashboardFooterText(joinDashboardHints(options.hints), innerWidth);

	// Chrome: title rule, two dividers, hint line, closing rule (boxed only).
	const chrome = (boxed ? 4 : 3) + (warning ? 1 : 0) + detail.length;
	const list = renderDashboardListShell(
		{
			rows: options.rows,
			selectedId: options.selectedId,
			emptyText: options.emptyText,
			maxRows: Math.max(1, viewportRows - chrome),
			renderRow: options.renderRow,
		},
		innerWidth,
	);

	if (!boxed) {
		const lines: string[] = [dashboardHeaderText(theme.bold(theme.fg("accent", options.title)), innerWidth)];
		if (warning) lines.push(dashboardText(warning, innerWidth));
		lines.push(...list, ...detail, hints);
		return lines;
	}

	const lines: string[] = [topBorder(totalWidth, options.title)];
	if (warning) lines.push(overlayRow(warning, totalWidth));
	for (const line of list) lines.push(overlayRow(line, totalWidth));
	lines.push(divider(totalWidth));
	for (const line of detail) lines.push(overlayRow(line, totalWidth));
	lines.push(divider(totalWidth));
	lines.push(overlayRow(hints, totalWidth));
	lines.push(bottomBorder(totalWidth));
	return lines;
}

/**
 * A one-line status widget that re-truncates at the width it is handed, so a
 * pinned summary reflows on resize instead of wrapping.
 */
export function dashboardSummaryComponent(line: () => string): Component {
	let cachedLines: readonly string[] | null = null;
	let cachedWidth = -1;
	let cachedText = "";
	return {
		render(width: number): readonly string[] {
			const text = line();
			if (cachedLines !== null && cachedWidth === width && cachedText === text) return cachedLines;
			cachedWidth = width;
			cachedText = text;
			cachedLines = [` ${dashboardText(text, Math.max(1, width - 1))}`];
			return cachedLines;
		},
		invalidate(): void {
			cachedLines = null;
		},
	};
}

export interface DashboardMountOptions {
	/** Refresh the source on this cadence; omit to refresh only on source changes. */
	refreshIntervalMs?: number;
	selectedId?: string | null;
}

/**
 * Lifecycle bridge between a generic dashboard data source and a UI component.
 * It only retains row snapshots, selection identity, and UI teardown resources.
 */
export class DashboardMount<Row extends { id: string }> {
	readonly selection: DashboardSelection<Row>;
	readonly invalidator: DashboardInvalidator;
	#disposables = new DashboardDisposalBag();
	#disposed = false;
	#refreshing = false;
	#refreshPending = false;

	constructor(
		private readonly source: DashboardDataSource<Row>,
		private readonly actions: DashboardActions<Row>,
		options: DashboardMountOptions = {},
	) {
		this.selection = new DashboardSelection(options.selectedId);
		this.invalidator = new DashboardInvalidator(() => this.actions.requestRender?.());
		this.#disposables.add(() => this.invalidator.dispose());
		this.#replaceRows(source.getRows(), false);

		if (source.subscribe) {
			this.#disposables.add(source.subscribe(() => this.#syncRows()));
		}
		const refreshIntervalMs = options.refreshIntervalMs;
		if (refreshIntervalMs !== undefined) {
			if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
				throw new Error("Dashboard refreshIntervalMs must be a positive finite number");
			}
			const timer = setInterval(() => this.refresh(), refreshIntervalMs);
			timer.unref?.();
			this.#disposables.add(() => clearInterval(timer));
		}
	}

	get rows(): readonly Row[] {
		return this.selection.rows;
	}

	get selectedId(): string | null {
		return this.selection.selectedId;
	}

	get selected(): Row | null {
		return this.selection.selected();
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	select(id: string | null): Row | null {
		if (this.#disposed || id === this.selection.selectedId) return this.selection.selected();
		const row = this.selection.select(id);
		this.actions.onSelectionChange?.(row);
		this.invalidator.schedule();
		return row;
	}

	/**
	 * Guarantee a cursor once rows exist: keep a live selection, otherwise take
	 * `preferredId` when it is present and fall back to the first row. Without
	 * this an overlay opens with no row selected and Enter does nothing.
	 */
	ensureSelection(preferredId?: string | null): Row | null {
		if (this.#disposed) return null;
		const current = this.selection.selected();
		if (current !== null) return current;
		const rows = this.selection.rows;
		if (rows.length === 0) return null;
		const preferred =
			preferredId != null && rows.some(row => row.id === preferredId) ? preferredId : rows[0]!.id;
		return this.select(preferred);
	}

	moveSelection(delta: number): Row | null {
		if (this.#disposed || !Number.isFinite(delta) || delta === 0) return this.selection.selected();
		const previousId = this.selection.selectedId;
		const row = this.selection.move(Math.trunc(delta));
		if (this.selection.selectedId !== previousId) this.actions.onSelectionChange?.(row);
		this.invalidator.schedule();
		return row;
	}

	activate(): void {
		if (this.#disposed) return;
		const row = this.selection.selected();
		if (row) this.actions.onActivate?.(row);
	}

	refresh(): void {
		if (this.#disposed) return;
		if (this.#refreshing) {
			this.#refreshPending = true;
			return;
		}
		const refresh = this.source.refresh;
		if (!refresh) {
			this.#syncRows();
			return;
		}
		this.#refreshing = true;
		let result: void | Promise<void>;
		try {
			result = refresh();
		} catch (error) {
			this.#finishRefresh();
			throw error;
		}
		if (result && typeof result.then === "function") {
			void result.then(
				() => this.#finishRefresh(),
				() => this.#finishRefresh(),
			);
		} else {
			this.#finishRefresh();
		}
	}

	/**
	 * Await a complete refresh. Callers that paint immediately afterwards use
	 * this so the first frame shows real data instead of the empty state.
	 */
	async refreshNow(): Promise<void> {
		if (this.#disposed) return;
		const refresh = this.source.refresh;
		if (refresh) {
			if (this.#refreshing) {
				this.#refreshPending = true;
				return;
			}
			this.#refreshing = true;
			try {
				await refresh();
			} finally {
				this.#refreshing = false;
			}
		}
		if (this.#disposed) return;
		this.#syncRows();
		if (!this.#refreshPending) return;
		this.#refreshPending = false;
		this.refresh();
	}

	close(): void {
		if (this.#disposed) return;
		this.actions.onClose?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disposables.dispose();
	}

	#syncRows(): void {
		if (this.#disposed) return;
		this.#replaceRows(this.source.getRows(), true);
	}

	#replaceRows(rows: readonly Row[], signal: boolean): void {
		this.selection.replace(rows);
		if (!signal) return;
		this.actions.onRowsChange?.(rows);
		this.invalidator.schedule();
	}

	#finishRefresh(): void {
		this.#refreshing = false;
		if (this.#disposed) return;
		this.#syncRows();
		if (!this.#refreshPending) return;
		this.#refreshPending = false;
		this.refresh();
	}
}

/** Pad already-truncated text to a target terminal-cell width. */
export function padDashboardText(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const truncated = dashboardText(text, safeWidth);
	return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}
