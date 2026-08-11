// Absolute host-path type import: the extension loader's graph walker follows
// *relative* specifiers into the host source tree (15s startup penalty) but
// skips absolute ones; `import type` is erased at runtime either way.
import type { ExtensionContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import {
	type DashboardRowState,
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
import { getJupyterRuntimeSnapshot, interruptJupyterKernel, restartJupyterKernel } from "../jupyter";

type KernelState = "idle" | "busy" | "starting" | "error";

type KernelRow = {
	id: string;
	kernelName: string;
	displayName: string;
	state: KernelState;
};

/** No feature writes a kernel status key, so the dashboard owns this one alone. */
const VIEW_KEY = "bomp-kernel-view";
const CONFIRM_KEY = "tui.select.confirm" as const;
const INTERRUPT_KEY = "i";
const RESTART_KEY = "r";
const MAX_NAME_COLUMN = 24;
const HEADLESS_ROWS = 40;
/** Kernel state changes underneath the view. */
const REFRESH_INTERVAL_MS = 1000;

const ROW_STATE: Record<KernelState, DashboardRowState> = {
	idle: "active",
	busy: "busy",
	starting: "pending",
	error: "error",
};

/** UI-only adapter for Jupyter kernel runtime actions. */
export interface KernelDashboard {
	update(): readonly string[];
	interruptSelected(): Promise<boolean>;
	restartSelected(): Promise<boolean>;
	showOverlay(): Promise<void>;
	renderText(width: number): readonly string[];
	dispose(): void;
}

export function createKernelDashboard(ctx: ExtensionContext): KernelDashboard {
	let overlayTui: { requestRender(): void } | null = null;
	let actionError: string | undefined;
	/** Restart is irreversible, so it takes a second confirming keypress. */
	let pendingRestart: string | null = null;
	let widgetInstalled = false;
	let disposed = false;

	const mount = new DashboardMount<KernelRow>(
		{
			getRows: () =>
				getJupyterRuntimeSnapshot().map(kernel => ({
					id: kernel.alias,
					kernelName: kernel.kernelName,
					displayName: kernel.displayName,
					state: kernel.state,
				})),
		},
		{
			requestRender: () => overlayTui?.requestRender(),
			onActivate: () => {
				// Enter selects and inspects; the destructive actions have their own keys.
				pendingRestart = null;
				actionError = undefined;
				overlayTui?.requestRender();
			},
		},
		{ refreshIntervalMs: REFRESH_INTERVAL_MS },
	);

	const summary = (): string => {
		const kernels = getJupyterRuntimeSnapshot();
		if (actionError) return `Kernels: ${actionError}`;
		const busy = kernels.filter(kernel => kernel.state === "busy" || kernel.state === "starting").length;
		return busy === 0 ? `Kernels: ${kernels.length} idle` : `Kernels: ${busy}/${kernels.length} active`;
	};

	const nameColumn = (): number => {
		let widest = 0;
		for (const row of mount.rows) widest = Math.max(widest, row.displayName.length);
		return Math.min(widest, MAX_NAME_COLUMN);
	};

	const notice = (): string | undefined => {
		if (actionError) return actionError;
		if (pendingRestart) return `Press ${RESTART_KEY} again to restart ${pendingRestart}, any other key cancels`;
		return undefined;
	};

	const renderText = (width: number): readonly string[] => {
		if (disposed) return [];
		const column = nameColumn();
		return renderDashboardOverlay(
			{
				title: "Bomp Jupyter kernels",
				warning: notice(),
				rows: mount.rows,
				selectedId: mount.selectedId,
				emptyText: 'No kernels — map an alias under "kernelAliases" in bomp.json',
				renderRow: (row, selected) =>
					`${dashboardCursor(selected)} ${dashboardStateGlyph(ROW_STATE[row.state])} ` +
					`${padDashboardText(row.displayName, column)}${dashboardMeta(row.state)}`,
				detail: mount.selected,
				detailEmptyText: "No kernel selected",
				renderDetail: row => [
					`Kernel: ${row.displayName}`,
					`Alias: ${row.id}`,
					`Name: ${row.kernelName}`,
					`State: ${row.state}`,
					`${INTERRUPT_KEY} interrupts this kernel, ${RESTART_KEY} restarts it`,
				],
				hints: [
					dashboardMoveHint(),
					dashboardPageHint(),
					dashboardKeyHint(CONFIRM_KEY, "select"),
					dashboardRawKeyHint(INTERRUPT_KEY, "interrupt"),
					dashboardRawKeyHint(RESTART_KEY, "restart"),
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

	const runAction = async (label: string, action: (alias: string) => Promise<boolean>): Promise<boolean> => {
		const row = mount.selected;
		if (!row || disposed) return false;
		let result = false;
		try {
			actionError = undefined;
			result = await action(row.id);
			if (!result) actionError = `Could not ${label} ${row.displayName}`;
		} catch (error) {
			actionError = error instanceof Error ? error.message : String(error);
		}
		if (actionError) ctx.ui.notify(actionError, "error");
		if (disposed) return result;
		mount.refresh();
		overlayTui?.requestRender();
		return result;
	};

	const interruptSelected = (): Promise<boolean> => runAction("interrupt", interruptJupyterKernel);
	const restartSelected = (): Promise<boolean> => runAction("restart", restartJupyterKernel);

	return {
		update,
		interruptSelected,
		restartSelected,
		renderText,
		async showOverlay(): Promise<void> {
			if (!ctx.hasUI || disposed) return;
			mount.refresh();
			mount.ensureSelection(null);
			installWidget();
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					setDashboardTheme(theme);
					overlayTui = tui;
					return {
						render: renderText,
						handleInput(data: string): void {
							if (data === RESTART_KEY) {
								const row = mount.selected;
								if (!row) return;
								if (pendingRestart === row.id) {
									pendingRestart = null;
									void restartSelected();
								} else {
									pendingRestart = row.id;
									overlayTui?.requestRender();
								}
								return;
							}
							// Any other key answers a pending restart prompt with "no".
							pendingRestart = null;
							if (dashboardNavigation.cancel(data)) return done(undefined);
							if (dashboardNavigation.up(data)) mount.moveSelection(-1);
							else if (dashboardNavigation.down(data)) mount.moveSelection(1);
							else if (dashboardNavigation.pageUp(data)) mount.moveSelection(-5);
							else if (dashboardNavigation.pageDown(data)) mount.moveSelection(5);
							else if (data === INTERRUPT_KEY) void interruptSelected();
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
			pendingRestart = null;
			mount.dispose();
			if (widgetInstalled) {
				widgetInstalled = false;
				ctx.ui.setWidget(VIEW_KEY, undefined);
			}
		},
	};
}
