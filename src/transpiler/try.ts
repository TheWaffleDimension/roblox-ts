import * as ts from "ts-morph";
import { transpileExpression, transpileStatementedNode } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileThrowStatement(state: TranspilerState, node: ts.ThrowStatement) {
	state.usesTSLibrary = true;
	return [state.indent, `TS.throw(`, ...transpileExpression(state, node.getExpressionOrThrow()), `);\n`];
}

export function transpileTryStatement(state: TranspilerState, node: ts.TryStatement) {
	const result = new Array<string>();

	state.pushIdStack();

	const returnsId = state.getNewId();
	state.usesTSLibrary = true;
	result.push(state.indent, `local `, returnsId, ` = TS.try(\n`);

	state.pushIndent();

	result.push(state.indent, "function()\n");
	state.pushIndent();
	result.push(...transpileStatementedNode(state, node.getTryBlock()));
	state.popIndent();
	result.push(state.indent, "end");

	const catchClause = node.getCatchClause();
	if (catchClause !== undefined) {
		result.push(",\n");
		const varName = catchClause.getVariableDeclarationOrThrow().getName();
		result.push(state.indent, `function(`, varName, `)\n`);
		state.pushIndent();
		result.push(...transpileStatementedNode(state, catchClause.getBlock()));
		state.popIndent();
		result.push(state.indent, "end");
	}
	result.push("\n");

	state.popIndent();
	result.push(state.indent, ");\n");
	result.push(state.indent, `if `, returnsId, `.size > 0 then return unpack(`, returnsId, `); end;\n`);

	const finallyBlock = node.getFinallyBlock();
	if (finallyBlock !== undefined) {
		result.push(...transpileStatementedNode(state, finallyBlock));
	}

	state.popIdStack();

	return result;
}
