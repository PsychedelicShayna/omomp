type DashboardTheme = {
	fg?(color: string, text: string): string;
	bold?(text: string): string;
	nav?: { cursor?: string };
	status?: Partial<Record<DashboardRowState, string>> & { enabled?: string; disabled?: string; running?: string };
	sep?: { dot?: string };
};

type DashboardSource<Row> = { getRows(): readonly Row[]; refresh?(): void | Promise<void>; subscribe?(listener: () => void): () => void };
type DashboardActions<Row> = { requestRender?(): void; onRowsChange?(rows: readonly Row[]): void; onSelectionChange?(row: Row | null): void; onActivate?(row: Row): void; onClose?(): void };

export type DashboardRowState = "active" | "inactive" | "busy" | "pending" | "warning" | "error";

let activeTheme: DashboardTheme | undefined;
export function setDashboardTheme(theme: DashboardTheme | undefined): void { activeTheme = theme; }

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
function plain(text: string): string { return text.replace(ANSI, ""); }
function width(text: string): number { return [...plain(text)].length; }
function themed(color: string, text: string): string { return activeTheme?.fg?.(color, text) ?? text; }
function fit(text: string, columns: number): string {
	const safe = Math.max(1, Math.trunc(columns));
	const normalized = text.replace(/[\r\n]+/g, " ");
	if (width(normalized) <= safe) return normalized;
	const value = plain(normalized);
	return safe === 1 ? "…" : `${[...value].slice(0, safe - 1).join("")}…`;
}
function fill(text: string, columns: number): string { const clipped = fit(text, columns); return clipped + " ".repeat(Math.max(0, columns - width(clipped))); }

export function matchesDashboardKey(data: string, action: string): boolean {
	if (action === "tui.select.confirm") return data === "\r" || data === "\n";
	if (action === "tui.select.cancel") return data === "\x1b" || data === "\x03";
	return false;
}
export const dashboardNavigation = {
	cancel: (data: string) => matchesDashboardKey(data, "tui.select.cancel"),
	up: (data: string) => data === "\x1b[A" || data === "k",
	down: (data: string) => data === "\x1b[B" || data === "j",
	pageUp: (data: string) => data === "\x1b[5~",
	pageDown: (data: string) => data === "\x1b[6~",
} as const;
export function dashboardKeyHint(action: string, description: string): string { return `${action === "tui.select.confirm" ? "enter" : action === "tui.select.cancel" ? "esc" : action} ${description}`; }
export function dashboardRawKeyHint(key: string, description: string): string { return `${key} ${description}`; }
export function dashboardMoveHint(): string { return dashboardRawKeyHint("↑↓", "move"); }
export function dashboardPageHint(): string { return dashboardRawKeyHint("PgUp/PgDn", "page"); }
export function dashboardCursor(selected: boolean): string { return selected ? themed("accent", activeTheme?.nav?.cursor ?? "›") : " "; }
export function dashboardStateGlyph(state: DashboardRowState): string {
	const glyph = state === "active" ? (activeTheme?.status?.enabled ?? "●")
		: state === "inactive" ? (activeTheme?.status?.disabled ?? "○")
		: state === "busy" ? (activeTheme?.status?.running ?? "◆")
		: state === "pending" ? (activeTheme?.status?.pending ?? "◌")
		: state === "warning" ? (activeTheme?.status?.warning ?? "!")
		: (activeTheme?.status?.error ?? "×");
	const color = state === "active" ? "success" : state === "error" ? "error" : state === "warning" ? "warning" : state === "busy" ? "accent" : "dim";
	return themed(color, glyph);
}
export function dashboardMeta(text: string): string { return themed("dim", `${activeTheme?.sep?.dot ?? " · "}${text}`); }
export function padDashboardText(text: string, columns: number): string { return fill(text, Math.max(1, columns)); }

interface OverlayOptions<Row extends { id: string }> {
	title: string;
	warning?: string;
	rows: readonly Row[];
	selectedId?: string | null;
	emptyText?: string;
	renderRow(row: Row, selected: boolean, width: number): string;
	detail: Row | null;
	detailEmptyText?: string;
	renderDetail(row: Row, width: number): readonly string[];
	hints: readonly string[];
	viewportRows?: number;
}

export function renderDashboardOverlay<Row extends { id: string }>(options: OverlayOptions<Row>, columns: number): readonly string[] {
	const total = Math.max(1, Math.trunc(columns));
	const boxed = total >= 24;
	const inner = boxed ? total - 4 : total;
	const viewport = Math.max(8, Math.trunc(options.viewportRows ?? (process.stdout.rows || 40) - 2));
	const details = options.detail ? options.renderDetail(options.detail, inner).map(line => fit(line, inner)) : [fit(options.detailEmptyText ?? "No selection", inner)];
	const fixed = (boxed ? 5 : 2) + details.length + (options.warning ? 1 : 0);
	const limit = Math.max(1, viewport - fixed);
	let list: readonly string[];
	if (options.rows.length > limit) {
		const selected = Math.max(0, options.rows.findIndex(row => row.id === options.selectedId));
		let rowBudget = Math.max(1, limit - 2);
		let start = Math.max(0, Math.min(selected - Math.floor(rowBudget / 2), options.rows.length - rowBudget));
		let end = Math.min(options.rows.length, start + rowBudget);
		const initialMarkers = Number(start > 0) + Number(end < options.rows.length);
		rowBudget = Math.max(1, limit - initialMarkers);
		start = Math.max(0, Math.min(selected - Math.floor(rowBudget / 2), options.rows.length - rowBudget));
		end = Math.min(options.rows.length, start + rowBudget);
		const visible = options.rows.slice(start, end);
		list = [
			...(start > 0 ? [themed("dim", `… ${start} more above`)] : []),
			...visible.map(row => fit(options.renderRow(row, row.id === options.selectedId, inner), inner)),
			...(end < options.rows.length ? [themed("dim", `… ${options.rows.length - end} more below`)] : []),
		];
	} else {
		list = options.rows.length
			? options.rows.map(row => fit(options.renderRow(row, row.id === options.selectedId, inner), inner))
			: [fit(options.emptyText ?? "No items", inner)];
	}
	const hints = fit(options.hints.filter(Boolean).join(themed("dim", " · ")), inner);
	const title = activeTheme?.bold?.(themed("accent", options.title)) ?? options.title;
	if (!boxed) return [fit(title, inner), ...(options.warning ? [fit(`! ${options.warning}`, inner)] : []), ...list, ...details, hints];
	const borderTitle = ` ${plain(options.title)} `;
	const top = `┌${borderTitle}${"─".repeat(Math.max(0, total - 2 - borderTitle.length))}┐`;
	const rule = `├${"─".repeat(total - 2)}┤`;
	const row = (value: string) => `│ ${fill(value, inner)} │`;
	return [top, ...(options.warning ? [row(themed("error", `! ${options.warning}`))] : []), ...list.map(row), rule, ...details.map(row), rule, row(hints), `└${"─".repeat(total - 2)}┘`];
}

export function dashboardSummaryComponent(line: () => string): { render(width: number): readonly string[]; invalidate(): void } {
	let cache: readonly string[] | undefined; let priorWidth = -1; let priorText = "";
	return {
		render(columns: number) { const text = line(); if (cache && priorWidth === columns && priorText === text) return cache; priorWidth = columns; priorText = text; cache = [` ${fit(text, Math.max(1, columns - 1))}`]; return cache; },
		invalidate() { cache = undefined; },
	};
}

export interface DashboardMountOptions {
	selectedId?: string | null;
	refreshIntervalMs?: number;
}

export class DashboardMount<Row extends { id: string }> {
	#rows: readonly Row[] = [];
	#selectedId: string | null = null;
	#disposed = false;
	#unsubscribe?: () => void;
	#refreshTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly source: DashboardSource<Row>,
		private readonly actions: DashboardActions<Row>,
		options: DashboardMountOptions = {},
	) {
		this.#replace(source.getRows(), false);
		if (options.selectedId && this.#rows.some(row => row.id === options.selectedId)) {
			this.#selectedId = options.selectedId;
		}
		this.#unsubscribe = source.subscribe?.(() => this.#replace(source.getRows(), true));
		const refreshIntervalMs = options.refreshIntervalMs;
		if (refreshIntervalMs !== undefined && Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
			this.#refreshTimer = setInterval(() => this.refresh(), refreshIntervalMs);
			this.#refreshTimer.unref?.();
		}
	}

	get rows(): readonly Row[] { return this.#rows; }
	get selectedId(): string | null { return this.#selectedId; }
	get selected(): Row | null { return this.#rows.find(row => row.id === this.#selectedId) ?? null; }
	select(id: string | null): Row | null { if (this.#disposed) return null; this.#selectedId = id && this.#rows.some(row => row.id === id) ? id : null; const row = this.selected; this.actions.onSelectionChange?.(row); this.actions.requestRender?.(); return row; }
	ensureSelection(preferred?: string | null): Row | null { if (this.selected) return this.selected; const row = this.#rows.find(item => item.id === preferred) ?? this.#rows[0]; return row ? this.select(row.id) : null; }
	moveSelection(delta: number): Row | null { if (!this.#rows.length || this.#disposed) return null; const index = Math.max(0, this.#rows.findIndex(row => row.id === this.#selectedId)); const next = (index + Math.trunc(delta) % this.#rows.length + this.#rows.length) % this.#rows.length; return this.select(this.#rows[next]!.id); }
	activate(): void { const row = this.selected; if (row && !this.#disposed) this.actions.onActivate?.(row); }
	refresh(): void { if (this.#disposed) return; const refreshed = this.source.refresh?.(); if (refreshed && typeof refreshed.then === "function") void refreshed.finally(() => this.#replace(this.source.getRows(), true)); else this.#replace(this.source.getRows(), true); }
	async refreshNow(): Promise<void> { if (this.#disposed) return; await this.source.refresh?.(); this.#replace(this.source.getRows(), true); }
	close(): void { if (!this.#disposed) this.actions.onClose?.(); }
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		if (this.#refreshTimer) clearInterval(this.#refreshTimer);
		this.#refreshTimer = undefined;
	}
	#replace(rows: readonly Row[], signal: boolean): void { const ids = new Set<string>(); for (const row of rows) { if (!row.id || ids.has(row.id)) throw new Error(`Invalid dashboard row ID: ${row.id}`); ids.add(row.id); } this.#rows = rows; if (this.#selectedId && !ids.has(this.#selectedId)) this.#selectedId = null; if (signal) { this.actions.onRowsChange?.(rows); this.actions.requestRender?.(); } }
}
