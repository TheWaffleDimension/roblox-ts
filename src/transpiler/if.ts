import * as ts from "ts-morph";
import { transpileExpression, transpileStatement } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileIfStatement(state: TranspilerState, node: ts.IfStatement) {
	const result = new Array<string>();
	const expStr = transpileExpression(state, node.getExpression());
	result.push(state.indent, "if ", ...expStr, " then\n");
	state.pushIndent();
	result.push(...transpileStatement(state, node.getThenStatement()));
	state.popIndent();
	let elseStatement = node.getElseStatement();
	while (elseStatement && ts.TypeGuards.isIfStatement(elseStatement)) {
		const elseIfExpression = transpileExpression(state, elseStatement.getExpression());
		result.push(state.indent, "elseif ", ...elseIfExpression, " then\n");
		state.pushIndent();
		result.push(...transpileStatement(state, elseStatement.getThenStatement()));
		state.popIndent();
		elseStatement = elseStatement.getElseStatement();
	}
	if (elseStatement) {
		result.push(state.indent, "else\n");
		state.pushIndent();
		result.push(...transpileStatement(state, elseStatement));
		state.popIndent();
	}
	result.push(state.indent, "end;\n");
	return result;
}
