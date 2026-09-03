import { describe, expect, test } from "bun:test";
import { assertBaselineEmbedding, resolvePortableNativeBuild } from "./build-portable";

describe("portable native build selection", () => {
	test("prefers bazelisk, then bazel, otherwise cargo", () => {
		expect(resolvePortableNativeBuild(name => (name === "bazelisk" ? "/bin/bazelisk" : null))).toBe("bazel");
		expect(resolvePortableNativeBuild(name => (name === "bazel" ? "/bin/bazel" : null))).toBe("bazel");
		expect(resolvePortableNativeBuild(() => null)).toBe("cargo");
	});

	test("accepts exactly one embedded baseline native", () => {
		expect(() => assertBaselineEmbedding('{ variant: "baseline", filename: "pi_natives.linux-x64-baseline.node" }')).not.toThrow();
		expect(() => assertBaselineEmbedding('{ variant: "modern" }')).toThrow("exactly one embedded baseline native");
		expect(() => assertBaselineEmbedding('{ variant: "baseline" }, { variant: "modern" }')).toThrow(
			"exactly one embedded baseline native",
		);
		expect(() => assertBaselineEmbedding("export const embeddedAddonFiles = []")).toThrow(
			"exactly one embedded baseline native",
		);
	});
});
