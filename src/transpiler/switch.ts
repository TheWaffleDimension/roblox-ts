import * as ts from "ts-morph";
import { transpileExpression, transpileStatementedNode } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileSwitchStatement(state: TranspilerState, node: ts.SwitchStatement) {
	const expStr = transpileExpression(state, node.getExpression());
	const result = new Array<string>();
	result.push(state.indent, "repeat\n");
	state.pushIndent();
	state.pushIdStack();
	const fallThroughVar = state.getNewId();

	const clauses = node.getCaseBlock().getClauses();
	let anyFallThrough = false;
	for (const clause of clauses) {
		const statements = clause.getStatements();

		let lastStatement = statements[statements.length - 1];
		while (lastStatement && ts.TypeGuards.isBlock(lastStatement)) {
			const blockStatements = lastStatement.getStatements();
			lastStatement = blockStatements[blockStatements.length - 1];
		}
		const endsInReturnOrBreakStatement =
			lastStatement &&
			(ts.TypeGuards.isReturnStatement(lastStatement) || ts.TypeGuards.isBreakStatement(lastStatement));
		if (!endsInReturnOrBreakStatement) {
			anyFallThrough = true;
		}
	}

	if (anyFallThrough) {
		result.push(state.indent, "local ", ...fallThroughVar, " = false;\n");
	}

	let lastFallThrough = false;

	for (const clause of clauses) {
		// add if statement if the clause is non-default
		if (ts.TypeGuards.isCaseClause(clause)) {
			const clauseExpStr = transpileExpression(state, clause.getExpression());
			const fallThroughVarOr = lastFallThrough ? [...fallThroughVar, " or "] : [];
			result.push(state.indent, "if ", ...fallThroughVarOr, ...expStr, " == ( ", ...clauseExpStr, " ) then\n");
			state.pushIndent();
		}

		const statements = clause.getStatements();

		let lastStatement = statements[statements.length - 1];
		while (lastStatement && ts.TypeGuards.isBlock(lastStatement)) {
			const blockStatements = lastStatement.getStatements();
			lastStatement = blockStatements[blockStatements.length - 1];
		}
		const endsInReturnOrBreakStatement =
			lastStatement &&
			(ts.TypeGuards.isReturnStatement(lastStatement) || ts.TypeGuards.isBreakStatement(lastStatement));
		lastFallThrough = !endsInReturnOrBreakStatement;

		result.push(...transpileStatementedNode(state, clause));

		if (ts.TypeGuards.isCaseClause(clause)) {
			if (!endsInReturnOrBreakStatement) {
				result.push(state.indent, ...fallThroughVar, " = true;\n");
			}
			state.popIndent();
			result.push(state.indent, "end;\n");
		}
	}
	state.popIdStack();
	state.popIndent();
	result.push(state.indent, "until true;\n");
	return result;
}
