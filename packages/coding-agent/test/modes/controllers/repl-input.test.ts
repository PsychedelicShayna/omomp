import { describe, expect, it } from "bun:test";
import { parseReplEvalInput } from "../../../src/modes/controllers/repl-input";

describe("parseReplEvalInput", () => {
	it("parses every built-in language prefix", () => {
		expect(parseReplEvalInput("$ print('py')")).toEqual({
			language: "py",
			alias: "py",
			code: "print('py')",
			excludeFromContext: false,
			reset: false,
		});
		expect(parseReplEvalInput("$$ console.log('js')")).toMatchObject({ language: "js", alias: "$" });
		expect(parseReplEvalInput("$r puts 'rb'")).toMatchObject({ language: "rb", alias: "r" });
		expect(parseReplEvalInput("$j println(\"jl\")")).toMatchObject({ language: "jl", alias: "j" });
		expect(parseReplEvalInput("$! printf shell")).toMatchObject({ language: "sh", alias: "!" });
	});

	it("preserves the historical hidden Python cell form", () => {
		expect(parseReplEvalInput("  $~ print('private')")).toEqual({
			language: "py",
			alias: "py",
			code: "print('private')",
			excludeFromContext: true,
			reset: false,
		});
	});

	it("parses only registered external aliases", () => {
		expect(parseReplEvalInput("$fish echo ok", ["fish"])).toMatchObject({
			language: "fish",
			alias: "fish",
			code: "echo ok",
		});
		expect(parseReplEvalInput("$fish echo ok")).toBeUndefined();
	});

	it("leaves ambiguous dollar-prefixed chat untouched", () => {
		for (const input of ["$print(1)", "$$", "$1", "${name}", "$p", "$unknown code"]) {
			expect(parseReplEvalInput(input)).toBeUndefined();
		}
		expect(parseReplEvalInput("$ cd ~/project && make")).toBeUndefined();
	});
});
