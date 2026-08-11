// Absolute host-path type import — see kernel-dashboard.ts for why.
import type {
	ExtensionCommandContext,
	RuntimeModelLoadout,
} from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
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
import type { LoadoutFeature } from "../loadout";

type LoadoutRow = {
	id: string;
	loadout: RuntimeModelLoadout;
	active: boolean;
};

type LoadoutSnapshot = {
	items: Array<{ name: string; loadout: RuntimeModelLoadout; active: boolean }>;
	active?: string;
};

/** `loadout.ts` owns `bomp-loadout`; the dashboard owns this key alone. */
const VIEW_KEY = "bomp-loadout-view";
const CONFIRM_KEY = "tui.select.confirm" as const;
const OFF_KEY = "o";
const MAX_NAME_COLUMN = 24;
const HEADLESS_ROWS = 40;

/** UI-only adapter for idle-only, future-child model loadout selection. */
export interface LoadoutDashboard {
	update(): readonly string[];
	useSelected(): Promise<void>;
	clear(): Promise<void>;
	showSelected(): Promise<string | undefined>;
	listText(): Promise<string>;
	statusText(): Promise<string>;
	showOverlay(): Promise<void>;
	renderText(width: number): readonly string[];
	dispose(): void;
}

export function createLoadoutDashboard(feature: LoadoutFeature, ctx: ExtensionCommandContext): LoadoutDashboard {
	let snapshot: LoadoutSnapshot = { items: [] };
	let overlayTui: { requestRender(): void } | null = null;
	let actionError: string | undefined;
	let widgetInstalled = false;
	let disposed = false;

	const mount = new DashboardMount<LoadoutRow>(
		{
			getRows: () => snapshot.items.map(item => ({ id: item.name, loadout: item.loadout, active: item.active })),
			refresh: async () => {
				snapshot = await feature.data();
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
		if (actionError) return `Loadout: ${snapshot.active ?? "off"} — ${actionError}`;
		return snapshot.active ? `Loadout: ${snapshot.active}` : "Loadout: off";
	};

	const nameColumn = (): number => {
		let widest = 0;
		for (const row of mount.rows) widest = Math.max(widest, row.id.length);
		return Math.min(widest, MAX_NAME_COLUMN);
	};

	const renderText = (width: number): readonly string[] => {
		if (disposed) return [];
		const column = nameColumn();
		return renderDashboardOverlay(
			{
				title: "Bomp loadouts",
				warning: actionError,
				rows: mount.rows,
				selectedId: mount.selectedId,
				emptyText: 'No loadouts yet — add one under "loadouts" in bomp.json',
				renderRow: (row, selected) =>
					`${dashboardCursor(selected)} ${dashboardStateGlyph(row.active ? "active" : "inactive")} ` +
					`${padDashboardText(row.id, column)}${dashboardMeta(row.loadout.mainModel)}`,
				detail: mount.selected,
				detailEmptyText: "No loadout selected",
				renderDetail: row => [
					`Loadout: ${row.id}`,
					`Main model: ${row.loadout.mainModel}`,
					`Model roles: ${Object.keys(row.loadout.modelRoles).length}`,
					`Fallback chains: ${Object.keys(row.loadout.retryFallbackChains).length}`,
					`Task overrides: ${Object.keys(row.loadout.taskAgentModelOverrides).length}`,
					row.active ? "Active for future children" : "Press Enter to use for future children",
				],
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

	/** A loadout switch during streaming is an expected refusal, not a crash. */
	const runAction = async (action: () => Promise<unknown>): Promise<void> => {
		if (disposed) return;
		try {
			actionError = undefined;
			await action();
			snapshot = await feature.data();
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

	const showSelected = async (): Promise<string | undefined> => {
		const row = mount.selected;
		return row ? feature.show(row.id) : undefined;
	};

	return {
		update,
		useSelected,
		clear,
		showSelected,
		listText: () => feature.list(),
		statusText: () => feature.status(),
		renderText,
		async showOverlay(): Promise<void> {
			if (!ctx.hasUI || disposed) return;
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
