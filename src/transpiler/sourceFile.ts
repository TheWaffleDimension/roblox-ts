import * as ts from "ts-morph";
import { transpileStatementedNode } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { getScriptContext, getScriptType, ScriptType } from "../utility";

export function transpileSourceFile(state: TranspilerState, node: ts.SourceFile) {
	state.scriptContext = getScriptContext(node);
	const scriptType = getScriptType(node);
	const result = transpileStatementedNode(state, node);
	if (state.isModule) {
		if (scriptType !== ScriptType.Module) {
			throw new TranspilerError(
				"Attempted to export in a non-ModuleScript!",
				node,
				TranspilerErrorType.ExportInNonModuleScript,
			);
		}

		let hasExportEquals = false;
		for (const descendant of node.getDescendantsOfKind(ts.SyntaxKind.ExportAssignment)) {
			if (descendant.isExportEquals()) {
				hasExportEquals = true;
				break;
			}
		}

		if (hasExportEquals) {
			result.unshift(state.indent, `local _exports;\n`);
		} else {
			result.unshift(state.indent, `local _exports = {};\n`);
		}
		result.push(state.indent, "return _exports;\n");
	} else {
		if (scriptType === ScriptType.Module) {
			result.push(state.indent, "return nil;\n");
		}
	}
	if (state.usesTSLibrary) {
		result.unshift(
			state.indent,
			`local TS = require(
	game:GetService("ReplicatedStorage")
		:WaitForChild("RobloxTS")
		:WaitForChild("Include")
		:WaitForChild("RuntimeLib")
);\n`,
		);
	}
	return result.join("");
}
