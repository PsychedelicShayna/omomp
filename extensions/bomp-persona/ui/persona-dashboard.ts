// Absolute host-path type import — see kernel-dashboard.ts for why.
import type { ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import {
	DashboardMount,
	dashboardCursor,
	dashboardKeyHint,
	dashboardMeta,
	dashboardMoveHint,
	dashboardNavigation,
	dashboardPageHint,
	dashboardRawKeyHint,
	dashboardStateGlyph,
	dashboardSummaryComponent,
	matchesDashboardKey,
	padDashboardText,
	renderDashboardOverlay,
	setDashboardTheme,
} from "./dashboard-kit";
import type { PersonaFeature } from "../persona";
import type { PersonaDefinition } from "../state";

type PersonaRow = {
	id: string;
	definition: PersonaDefinition;
	active: boolean;
};

type PersonaSnapshot = {
	items: Array<{ name: string; definition: PersonaDefinition; active: boolean }>;
	active?: string;
	warning?: string;
};

/**
 * `persona.ts` owns the `bomp-persona` status and warning widget. The dashboard
 * owns this key alone so the two never overwrite each other.
 */
const VIEW_KEY = "bomp-persona-view";
const CONFIRM_KEY = "tui.select.confirm" as const;
const OFF_KEY = "o";
/** Widest name column before the row falls back to truncation. */
const MAX_NAME_COLUMN = 24;
/** Deterministic height for non-interactive renders. */
const HEADLESS_ROWS = 40;

/** UI-only adapter for session-scoped, next-turn persona selection. */
export interface PersonaDashboard {
	update(): readonly string[];
	useSelected(): Promise<void>;
	clear(): Promise<void>;
	deleteSelected(): Promise<void>;
	showSelected(): Promise<string | undefined>;
	listText(): Promise<string>;
	statusText(): Promise<string>;
	showOverlay(): Promise<void>;
	renderText(width: number): readonly string[];
	dispose(): void;
}

export function createPersonaDashboard(
	feature: PersonaFeature,
	ctx: ExtensionCommandContext,
	sessionId: string,
): PersonaDashboard {
	let snapshot: PersonaSnapshot = { items: [] };
	let overlayTui: { requestRender(): void } | null = null;
	let actionError: string | undefined;
	let widgetInstalled = false;
	let disposed = false;

	const mount = new DashboardMount<PersonaRow>(
		{
			getRows: () => snapshot.items.map(item => ({ id: item.name, definition: item.definition, active: item.active })),
			refresh: async () => {
				snapshot = await feature.data(sessionId);
			},
		},
		{
			requestRender: () => overlayTui?.requestRender(),
			onActivate: () => {
				void useSelected();
			},
		},
	);

	const summary = (): string => {
		const warning = actionError ?? snapshot.warning;
		if (warning) return `Persona: ${snapshot.active ?? "off"} — ${warning}`;
		return snapshot.active ? `Persona: ${snapshot.active}` : "Persona: off";
	};

	const nameColumn = (): number => {
		let widest = 0;
		for (const row of mount.rows) widest = Math.max(widest, row.id.length);
		return Math.min(widest, MAX_NAME_COLUMN);
	};

	const detailLines = (row: PersonaRow): readonly string[] => {
		const source = row.definition.source;
		const lines = [
			`Persona: ${row.id}`,
			`Mode: ${row.definition.mode}`,
			`Source: ${source.kind}`,
			source.kind === "file" ? `Path: ${source.path}` : `Content: ${source.content}`,
		];
		if (row.definition.mode === "literal-substitute") lines.push(`Literal: ${row.definition.literal ?? ""}`);
		lines.push(`Tasks inherit: ${row.definition.inheritToTasks ? "yes" : "no"}`);
		lines.push(row.active ? "Active for the next turn" : "Press Enter to use for the next turn");
		return lines;
	};

	const renderText = (width: number): readonly string[] => {
		if (disposed) return [];
		const column = nameColumn();
		return renderDashboardOverlay(
			{
				title: "Bomp personas",
				warning: actionError ?? snapshot.warning,
				rows: mount.rows,
				selectedId: mount.selectedId,
				emptyText: "No personas yet — run /persona create to add one",
				renderRow: (row, selected) =>
					`${dashboardCursor(selected)} ${dashboardStateGlyph(row.active ? "active" : "inactive")} ` +
					`${padDashboardText(row.id, column)}${dashboardMeta(row.definition.mode)}`,
				detail: mount.selected,
				detailEmptyText: "No persona selected",
				renderDetail: row => detailLines(row),
				hints: [
					dashboardMoveHint(),
					dashboardPageHint(),
					dashboardKeyHint(CONFIRM_KEY, "use"),
					dashboardRawKeyHint(OFF_KEY, "off"),
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

	/** Surface an expected failure (idle-only, unreadable file) instead of rejecting. */
	const runAction = async (action: () => Promise<unknown>): Promise<void> => {
		if (disposed) return;
		try {
			actionError = undefined;
			await action();
			snapshot = await feature.data(sessionId);
		} catch (error) {
			actionError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(actionError, "error");
		}
		if (disposed) return;
		mount.refresh();
		overlayTui?.requestRender();
	};

	const useSelected = async (): Promise<void> => {
		const row = mount.selected;
		if (!row) return;
		await runAction(() => feature.use(row.id, ctx));
	};

	const clear = async (): Promise<void> => {
		await runAction(() => feature.off(ctx));
	};

	const deleteSelected = async (): Promise<void> => {
		const row = mount.selected;
		if (!row) return;
		await runAction(() => feature.delete(row.id, ctx));
	};

	const showSelected = async (): Promise<string | undefined> => {
		const row = mount.selected;
		return row ? feature.show(row.id) : undefined;
	};

	return {
		update,
		useSelected,
		clear,
		deleteSelected,
		showSelected,
		listText: () => feature.list(sessionId),
		statusText: () => feature.status(sessionId),
		renderText,
		async showOverlay(): Promise<void> {
			if (!ctx.hasUI || disposed) return;
			// First paint must show real rows, not the empty state.
			await mount.refreshNow();
			if (disposed) return;
			mount.ensureSelection(snapshot.active);
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
							else if (data === OFF_KEY) void clear();
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
