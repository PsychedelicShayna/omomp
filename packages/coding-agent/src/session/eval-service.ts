import type { ToolSession } from "../tools";
import type { ExecutorBackend, ExecutorBackendExecOptions, ExecutorBackendResult } from "../eval/backend";
import type { ExtensionEvalBackend } from "../extensibility/extensions/types";

const EVAL_BACKEND_TOKEN = /^[a-z][a-z0-9_-]*$/;
const BUILTIN_EVAL_TOKENS = new Set(["py", "python", "js", "javascript", "rb", "ruby", "jl", "julia"]);

interface RegisteredBackend {
	backend: ExtensionEvalBackend;
	keys: readonly string[];
}

/** Session-scoped, volatile registry for extension-provided eval backends. */
export class EvalBackendRegistry {
	readonly #byKey = new Map<string, RegisteredBackend>();
	readonly #registrations = new Set<RegisteredBackend>();

	register(backend: ExtensionEvalBackend): void {
		const id = validateToken(backend.id, "backend id");
		if (!backend.label.trim()) throw new Error(`Eval backend "${id}" must have a non-empty label`);
		if (!backend.highlightLang.trim()) throw new Error(`Eval backend "${id}" must have a non-empty highlightLang`);
		const aliases = backend.aliases.map(alias => validateToken(alias, `alias for "${id}"`));
		const keys = [...new Set([id, ...aliases])];
		if (keys.length !== aliases.length + 1) throw new Error(`Eval backend "${id}" contains a duplicate alias`);
		for (const key of keys) {
			if (BUILTIN_EVAL_TOKENS.has(key)) throw new Error(`Eval backend token "${key}" is reserved by a built-in backend`);
		}
		for (const key of keys) {
			const owner = this.#byKey.get(key);
			if (owner) throw new Error(`Eval backend token "${key}" is already registered by "${owner.backend.id}"`);
		}
		const registration = { backend, keys };
		this.#registrations.add(registration);
		for (const key of keys) this.#byKey.set(key, registration);
	}

	resolve(token: string): ExtensionEvalBackend | undefined {
		return this.#byKey.get(token)?.backend;
	}

	aliases(): readonly string[] {
		return [...this.#byKey.keys()];
	}

	modelVisibleBackends(): readonly ExtensionEvalBackend[] {
		return [...this.#registrations].map(item => item.backend).filter(backend => backend.modelVisible);
	}

	async reset(token: string): Promise<void> {
		const backend = this.resolve(token);
		if (!backend) throw new Error(`Unknown eval backend: ${token}`);
		await backend.reset?.();
	}

	async interrupt(): Promise<void> {
		await Promise.allSettled([...this.#registrations].map(item => item.backend.interrupt?.()));
	}

	async dispose(): Promise<void> {
		const registrations = [...this.#registrations];
		this.#byKey.clear();
		this.#registrations.clear();
		const results = await Promise.allSettled(registrations.map(item => item.backend.dispose?.()));
		const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, "Failed to dispose one or more extension eval backends");
	}
}

const registries = new WeakMap<object, EvalBackendRegistry>();

export function evalBackendRegistry(owner: object): EvalBackendRegistry {
	let registry = registries.get(owner);
	if (!registry) {
		registry = new EvalBackendRegistry();
		registries.set(owner, registry);
	}
	return registry;
}

export function extensionBackendAdapter(backend: ExtensionEvalBackend): ExecutorBackend {
	const adapter: ExecutorBackend & Pick<ExtensionEvalBackend, "reset" | "interrupt" | "dispose"> = {
		id: backend.id as ExecutorBackend["id"],
		label: backend.label,
		highlightLang: backend.highlightLang,
		isAvailable: async () => await backend.isAvailable(),
		execute: (code, options) => backend.execute(code, options),
		reset: backend.reset?.bind(backend),
		interrupt: backend.interrupt?.bind(backend),
		dispose: backend.dispose?.bind(backend),
	};
	return adapter;
}

/** The sole backend invocation boundary for model- and user-initiated single cells. */
export async function invokeEvalCell(
	backend: ExecutorBackend | ExtensionEvalBackend,
	code: string,
	options: ExecutorBackendExecOptions,
): Promise<ExecutorBackendResult> {
	if (options.reset && "reset" in backend) await backend.reset?.();
	return await backend.execute(code, options);
}

export function registryForToolSession(session: ToolSession): EvalBackendRegistry | undefined {
	return session.sessionManager ? evalBackendRegistry(session.sessionManager) : undefined;
}

function validateToken(value: string, description: string): string {
	const token = value.trim();
	if (token !== value || !EVAL_BACKEND_TOKEN.test(token)) {
		throw new Error(`Invalid eval ${description}: "${value}"`);
	}
	return token;
}
