import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { addSeparator, flatten } from "../utility";

function useIIFEforUnaryExpression(
	parent: ts.Node<ts.ts.Node>,
	node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
) {
	return !(
		ts.TypeGuards.isExpressionStatement(parent) ||
		(ts.TypeGuards.isForStatement(parent) && parent.getCondition() !== node)
	);
}

export function transpilePrefixUnaryExpression(state: TranspilerState, node: ts.PrefixUnaryExpression) {
	const operand = node.getOperand();
	const opKind = node.getOperatorToken();
	if (opKind === ts.SyntaxKind.PlusPlusToken || opKind === ts.SyntaxKind.MinusMinusToken) {
		const parent = node.getParentOrThrow();
		const useIIFE = useIIFEforUnaryExpression(parent, node);
		const statements = new Array<Array<string>>();
		if (useIIFE) {
			state.pushIdStack();
		}
		let expStr: Array<string>;
		if (ts.TypeGuards.isPropertyAccessExpression(operand)) {
			const expression = operand.getExpression();
			const opExpStr = transpileExpression(state, expression);
			const propertyStr = operand.getName();
			const id = state.getNewId();
			statements.push(["local ", ...id, " = ", ...opExpStr]);
			expStr = [...id, ".", propertyStr];
		} else {
			expStr = transpileExpression(state, operand);
		}
		if (opKind === ts.SyntaxKind.PlusPlusToken) {
			statements.push([...expStr, " = ", ...expStr, " + 1"]);
		} else if (opKind === ts.SyntaxKind.MinusMinusToken) {
			statements.push([...expStr, " = ", ...expStr, " - 1"]);
		}
		addSeparator(statements, "; ");
		if (useIIFE) {
			state.popIdStack();
			return ["(function() ", ...flatten(statements), "; return ", ...expStr, "; end)()"];
		} else {
			return flatten(statements);
		}
	} else {
		const expStr = transpileExpression(state, operand);
		const tokenKind = node.getOperatorToken();
		if (tokenKind === ts.SyntaxKind.ExclamationToken) {
			return ["not ", ...expStr];
		} else if (tokenKind === ts.SyntaxKind.MinusToken) {
			return ["-", ...expStr];
		} else {
			/* istanbul ignore next */
			throw new TranspilerError(
				`Bad prefix unary expression! (${tokenKind})`,
				node,
				TranspilerErrorType.BadPrefixUnaryExpression,
			);
		}
	}
}

export function transpilePostfixUnaryExpression(state: TranspilerState, node: ts.PostfixUnaryExpression) {
	const operand = node.getOperand();
	const opKind = node.getOperatorToken();
	if (opKind === ts.SyntaxKind.PlusPlusToken || opKind === ts.SyntaxKind.MinusMinusToken) {
		const parent = node.getParentOrThrow();
		const useIIFE = useIIFEforUnaryExpression(parent, node);
		const statements = new Array<Array<string>>();
		if (useIIFE) {
			state.pushIdStack();
		}
		let expStr: Array<string>;
		if (ts.TypeGuards.isPropertyAccessExpression(operand)) {
			const expression = operand.getExpression();
			const opExpStr = transpileExpression(state, expression);
			const propertyStr = operand.getName();
			const id = state.getNewId();
			statements.push(["local ", ...id, " = ", ...opExpStr]);
			expStr = [...id, ".", propertyStr];
		} else {
			expStr = transpileExpression(state, operand);
		}

		function getAssignmentExpression() {
			if (opKind === ts.SyntaxKind.PlusPlusToken) {
				statements.push([...expStr, " = ", ...expStr, " + 1"]);
			} else {
				statements.push([...expStr, " = ", ...expStr, " - 1"]);
			}
		}

		addSeparator(statements, "; ");
		if (useIIFE) {
			const id = state.getNewId();
			state.popIdStack();
			statements.push(["local ", ...id, " = ", ...expStr]);
			getAssignmentExpression();
			return ["(function() ", ...flatten(statements), "; return ", ...id, "; end)()"];
		} else {
			getAssignmentExpression();
			return flatten(statements);
		}
	} else {
		/* istanbul ignore next */
		throw new TranspilerError(
			`Bad postfix unary expression! (${opKind})`,
			node,
			TranspilerErrorType.BadPostfixUnaryExpression,
		);
	}
}
