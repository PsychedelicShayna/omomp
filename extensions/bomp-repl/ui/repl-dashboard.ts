// Absolute host-path type import — see kernel-dashboard.ts for why.
import type { ExtensionContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import {
	DashboardMount,
	dashboardCursor,
	dashboardKeyHint,
	dashboardMeta,
	dashboardMoveHint,
	dashboardNavigation,
	dashboardPageHint,
	dashboardStateGlyph,
	dashboardSummaryComponent,
	matchesDashboardKey,
	padDashboardText,
	renderDashboardOverlay,
	setDashboardTheme,
} from "./dashboard-kit";
import { cycleReplBackend, getReplRuntimeSnapshot, setReplBackend } from "../repl";

type ReplBackendRow = {
	id: string;
	label: string;
	kind: "agent" | "builtin" | "shell" | "kernel";
	active: boolean;
};

/** `repl.ts` owns the `bomp-repl` status; the dashboard owns this key alone. */
const VIEW_KEY = "bomp-repl-view";
const CONFIRM_KEY = "tui.select.confirm" as const;
const MAX_NAME_COLUMN = 24;
const HEADLESS_ROWS = 40;
/** Backend availability changes while the view is open. */
const REFRESH_INTERVAL_MS = 1000;

/** UI-only adapter for the volatile REPL backend selection. */
export interface ReplDashboard {
	update(): readonly string[];
	cycle(): readonly string[];
	showOverlay(): Promise<void>;
	renderText(width: number): readonly string[];
	dispose(): void;
}

export function createReplDashboard(ctx: ExtensionContext): ReplDashboard {
	let overlayTui: { requestRender(): void } | null = null;
	let actionError: string | undefined;
	let widgetInstalled = false;
	let disposed = false;

	const mount = new DashboardMount<ReplBackendRow>(
		{
			getRows: () => {
				const snapshot = getReplRuntimeSnapshot();
				return snapshot.available.map(backend => ({
					id: backend.id,
					label: backend.label,
					kind: backend.kind,
					active: backend.id === snapshot.active,
				}));
			},
		},
		{
			requestRender: () => overlayTui?.requestRender(),
			onActivate: row => {
				actionError = setReplBackend(row.id) ? undefined : `Unavailable REPL backend: ${row.id}`;
				if (actionError) ctx.ui.notify(actionError, "error");
				mount.refresh();
			},
		},
		{ selectedId: getReplRuntimeSnapshot().active, refreshIntervalMs: REFRESH_INTERVAL_MS },
	);

	const summary = (): string => {
		const snapshot = getReplRuntimeSnapshot();
		if (actionError) return `REPL: ${snapshot.active} — ${actionError}`;
		return `REPL: ${snapshot.active} (${snapshot.mode})`;
	};

	const nameColumn = (): number => {
		let widest = 0;
		for (const row of mount.rows) widest = Math.max(widest, row.label.length);
		return Math.min(widest, MAX_NAME_COLUMN);
	};

	const renderText = (width: number): readonly string[] => {
		if (disposed) return [];
		const column = nameColumn();
		return renderDashboardOverlay(
			{
				title: "Bomp REPL backends",
				warning: actionError,
				rows: mount.rows,
				selectedId: mount.selectedId,
				emptyText: 'No REPL backends — add "shellProfiles" or "kernelAliases" to bomp.json',
				renderRow: (row, selected) =>
					`${dashboardCursor(selected)} ${dashboardStateGlyph(row.active ? "active" : "inactive")} ` +
					`${padDashboardText(row.label, column)}${dashboardMeta(row.kind)}`,
				detail: mount.selected,
				detailEmptyText: "No REPL backend selected",
				renderDetail: row => [
					`Backend: ${row.label}`,
					`Alias: ${row.id}`,
					`Kind: ${row.kind}`,
					row.active ? "Active for the next evaluation" : "Press Enter to activate",
				],
				hints: [
					dashboardMoveHint(),
					dashboardPageHint(),
					dashboardKeyHint(CONFIRM_KEY, "use"),
					dashboardKeyHint("tui.select.cancel", "close"),
				],
				viewportRows: ctx.hasUI ? undefined : HEADLESS_ROWS,
			},
			width,
		);
	};

	const installWidget = (): void => {
		if (disposed || widgetInstalled || !ctx.hasUI) return;
		widgetInstalled = true;
		ctx.ui.setWidget(VIEW_KEY, () => dashboardSummaryComponent(summary));
	};

	const update = (): readonly string[] => {
		if (disposed) return [];
		mount.refresh();
		installWidget();
		return renderText(process.stdout.columns ?? 80);
	};

	return {
		update,
		cycle(): readonly string[] {
			if (disposed) return [];
			actionError = undefined;
			cycleReplBackend();
			return update();
		},
		renderText,
		async showOverlay(): Promise<void> {
			if (!ctx.hasUI || disposed) return;
			mount.refresh();
			mount.ensureSelection(getReplRuntimeSnapshot().active);
			installWidget();
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					setDashboardTheme(theme);
					overlayTui = tui;
					return {
						render: renderText,
						handleInput(data: string): void {
							if (dashboardNavigation.cancel(data)) return done(undefined);
							if (dashboardNavigation.up(data)) mount.moveSelection(-1);
							else if (dashboardNavigation.down(data)) mount.moveSelection(1);
							else if (dashboardNavigation.pageUp(data)) mount.moveSelection(-5);
							else if (dashboardNavigation.pageDown(data)) mount.moveSelection(5);
							else if (matchesDashboardKey(data, CONFIRM_KEY)) mount.activate();
						},
						invalidate(): void {},
						dispose(): void {
							overlayTui = null;
						},
					};
				},
				{ overlay: true },
			);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			overlayTui = null;
			mount.dispose();
			if (widgetInstalled) {
				widgetInstalled = false;
				ctx.ui.setWidget(VIEW_KEY, undefined);
			}
		},
	};
}
