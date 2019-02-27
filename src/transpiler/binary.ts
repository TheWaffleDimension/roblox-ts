import * as ts from "ts-morph";
import { checkNonAny, getBindingData, transpileExpression } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { isNumberType, isStringType } from "../typeUtilities";
import { addSeparator, flatten } from "../utility";

function getLuaBarExpression(
	state: TranspilerState,
	node: ts.BinaryExpression,
	lhs: Array<string>,
	rhs: Array<string>,
) {
	state.usesTSLibrary = true;
	const rhsNode = node.getRight();
	if (ts.TypeGuards.isNumericLiteral(rhsNode) && rhsNode.getLiteralValue() === 0) {
		return ["TS.round(", ...lhs, ")"];
	} else {
		return ["TS.bor(", ...lhs, ", ", ...rhs, ")"];
	}
}

function getLuaBitExpression(state: TranspilerState, lhs: Array<string>, rhs: Array<string>, name: string) {
	state.usesTSLibrary = true;
	return ["TS.b", name, "(", ...lhs, ", ", ...rhs, ")"];
}

function getLuaAddExpression(node: ts.BinaryExpression, lhs: Array<string>, rhs: Array<string>, wrap = false) {
	if (wrap) {
		rhs.unshift("(");
		rhs.push(")");
	}
	const leftType = node.getLeft().getType();
	const rightType = node.getRight().getType();

	/* istanbul ignore else */
	if (isStringType(leftType) || isStringType(rightType)) {
		return ["(", ...lhs, ") .. ", ...rhs];
	} else if (isNumberType(leftType) && isNumberType(rightType)) {
		return [...lhs, " + ", ...rhs];
	} else {
		/* istanbul ignore next */
		throw new TranspilerError(
			`Unexpected types for addition: ${leftType.getText()} + ${rightType.getText()}`,
			node,
			TranspilerErrorType.BadAddition,
		);
	}
}

export function isSetToken(opKind: ts.ts.SyntaxKind) {
	return (
		opKind === ts.SyntaxKind.EqualsToken ||
		opKind === ts.SyntaxKind.BarEqualsToken ||
		opKind === ts.SyntaxKind.AmpersandEqualsToken ||
		opKind === ts.SyntaxKind.CaretEqualsToken ||
		opKind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
		opKind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
		opKind === ts.SyntaxKind.PlusEqualsToken ||
		opKind === ts.SyntaxKind.MinusEqualsToken ||
		opKind === ts.SyntaxKind.AsteriskEqualsToken ||
		opKind === ts.SyntaxKind.SlashEqualsToken ||
		opKind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
		opKind === ts.SyntaxKind.PercentEqualsToken
	);
}

export function transpileBinaryExpression(state: TranspilerState, node: ts.BinaryExpression) {
	const opToken = node.getOperatorToken();
	const opKind = opToken.getKind();

	const lhsNode = node.getLeft();
	const rhsNode = node.getRight();
	let lhs: Array<string>;
	const rhs = transpileExpression(state, rhsNode);
	const statements = new Array<Array<string>>();

	if (opKind !== ts.SyntaxKind.EqualsToken) {
		checkNonAny(lhsNode);
		checkNonAny(rhsNode);
	}

	// binding patterns
	if (ts.TypeGuards.isArrayLiteralExpression(lhsNode)) {
		const names = new Array<Array<string>>();
		const values = new Array<Array<string>>();
		const preStatements = new Array<Array<string>>();
		const postStatements = new Array<Array<string>>();

		let rootId: Array<string>;
		if (ts.TypeGuards.isIdentifier(rhsNode)) {
			rootId = transpileExpression(state, rhsNode);
		} else {
			rootId = state.getNewId();
			preStatements.push(["local ", ...rootId, " = ", ...transpileExpression(state, rhsNode), ";"]);
		}
		getBindingData(state, names, values, preStatements, postStatements, lhsNode, rootId);

		const result = new Array<string>();
		const parentKind = node.getParentOrThrow().getKind();
		if (parentKind === ts.SyntaxKind.ExpressionStatement || parentKind === ts.SyntaxKind.ForStatement) {
			preStatements.forEach(statementStr => result.push(state.indent, ...statementStr, "\n"));
			result.push(state.indent, names.join(", "), " = ", values.join(", "), ";\n");
			postStatements.forEach(statementStr => result.push(state.indent, ...statementStr, "\n"));
			result[result.length - 1] = result[result.length - 1].replace(/;\n$/, ""); // terrible hack
		} else {
			result.push("(function()\n");
			state.pushIndent();
			preStatements.forEach(statementStr => result.push(state.indent, ...statementStr, "\n"));
			result.push(state.indent, names.join(", "), " = ", values.join(", "), ";\n");
			postStatements.forEach(statementStr => result.push(state.indent, ...statementStr, "\n"));
			result.push(state.indent, "return ", ...rootId, ";\n");
			state.popIndent();
			result.push("end)()");
		}
		return result;
	}

	if (isSetToken(opKind)) {
		if (ts.TypeGuards.isPropertyAccessExpression(lhsNode) && opKind !== ts.SyntaxKind.EqualsToken) {
			const expression = lhsNode.getExpression();
			const opExpStr = transpileExpression(state, expression);
			const propertyStr = lhsNode.getName();
			const id = state.getNewId();
			statements.push(["local ", ...id, " = ", ...opExpStr]);
			lhs = [...id, ".", propertyStr];
		} else {
			lhs = transpileExpression(state, lhsNode);
		}

		/* istanbul ignore else */
		if (opKind === ts.SyntaxKind.EqualsToken) {
			statements.push([...lhs, " = ", ...rhs]);
		} else if (opKind === ts.SyntaxKind.BarEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaBarExpression(state, node, lhs, rhs)]);
		} else if (opKind === ts.SyntaxKind.AmpersandEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaBitExpression(state, lhs, rhs, "and")]);
		} else if (opKind === ts.SyntaxKind.CaretEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaBitExpression(state, lhs, rhs, "xor")]);
		} else if (opKind === ts.SyntaxKind.LessThanLessThanEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaBitExpression(state, lhs, rhs, "lsh")]);
		} else if (opKind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaBitExpression(state, lhs, rhs, "rsh")]);
		} else if (opKind === ts.SyntaxKind.PlusEqualsToken) {
			statements.push([...lhs, " = ", ...getLuaAddExpression(node, lhs, rhs, true)]);
		} else if (opKind === ts.SyntaxKind.MinusEqualsToken) {
			statements.push([...lhs, " = ", ...lhs, " - (", ...rhs, ")"]);
		} else if (opKind === ts.SyntaxKind.AsteriskEqualsToken) {
			statements.push([...lhs, " = ", ...lhs, " * (", ...rhs, ")"]);
		} else if (opKind === ts.SyntaxKind.SlashEqualsToken) {
			statements.push([...lhs, " = ", ...lhs, " / (", ...rhs, ")"]);
		} else if (opKind === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
			statements.push([...lhs, " = ", ...lhs, " ^ (", ...rhs, ")"]);
		} else if (opKind === ts.SyntaxKind.PercentEqualsToken) {
			statements.push([...lhs, " = ", ...lhs, " % (", ...rhs, ")"]);
		}

		const parentKind = node.getParentOrThrow().getKind();
		addSeparator(statements, "; ");
		if (parentKind === ts.SyntaxKind.ExpressionStatement || parentKind === ts.SyntaxKind.ForStatement) {
			return flatten(statements);
		} else {
			return ["(function() ", ...flatten(statements), "; return ", ...lhs, "; end)()"];
		}
	} else {
		lhs = transpileExpression(state, lhsNode);
	}

	/* istanbul ignore else */
	if (opKind === ts.SyntaxKind.EqualsEqualsToken) {
		throw new TranspilerError(
			"operator '==' is not supported! Use '===' instead.",
			opToken,
			TranspilerErrorType.NoEqualsEquals,
		);
	} else if (opKind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
		return [...lhs, ` == `, ...rhs];
	} else if (opKind === ts.SyntaxKind.ExclamationEqualsToken) {
		throw new TranspilerError(
			"operator '!=' is not supported! Use '!==' instead.",
			opToken,
			TranspilerErrorType.NoExclamationEquals,
		);
	} else if (opKind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
		return [...lhs, ` ~= `, ...rhs];
	} else if (opKind === ts.SyntaxKind.BarToken) {
		return getLuaBarExpression(state, node, lhs, rhs);
	} else if (opKind === ts.SyntaxKind.AmpersandToken) {
		return getLuaBitExpression(state, lhs, rhs, "and");
	} else if (opKind === ts.SyntaxKind.CaretToken) {
		return getLuaBitExpression(state, lhs, rhs, "xor");
	} else if (opKind === ts.SyntaxKind.LessThanLessThanToken) {
		return getLuaBitExpression(state, lhs, rhs, "lsh");
	} else if (opKind === ts.SyntaxKind.GreaterThanGreaterThanToken) {
		return getLuaBitExpression(state, lhs, rhs, "rsh");
	} else if (opKind === ts.SyntaxKind.PlusToken) {
		return getLuaAddExpression(node, lhs, rhs);
	} else if (opKind === ts.SyntaxKind.MinusToken) {
		return [...lhs, ` - `, ...rhs];
	} else if (opKind === ts.SyntaxKind.AsteriskToken) {
		return [...lhs, ` * `, ...rhs];
	} else if (opKind === ts.SyntaxKind.SlashToken) {
		return [...lhs, ` / `, ...rhs];
	} else if (opKind === ts.SyntaxKind.AsteriskAsteriskToken) {
		return [...lhs, ` ^ `, ...rhs];
	} else if (opKind === ts.SyntaxKind.InKeyword) {
		// doesn't need parenthesis because In is restrictive
		return [...rhs, `[`, ...lhs, `] ~= nil`];
	} else if (opKind === ts.SyntaxKind.AmpersandAmpersandToken) {
		return [...lhs, ` and `, ...rhs];
	} else if (opKind === ts.SyntaxKind.BarBarToken) {
		return [...lhs, ` or `, ...rhs];
	} else if (opKind === ts.SyntaxKind.GreaterThanToken) {
		return [...lhs, ` > `, ...rhs];
	} else if (opKind === ts.SyntaxKind.LessThanToken) {
		return [...lhs, ` < `, ...rhs];
	} else if (opKind === ts.SyntaxKind.GreaterThanEqualsToken) {
		return [...lhs, ` >= `, ...rhs];
	} else if (opKind === ts.SyntaxKind.LessThanEqualsToken) {
		return [...lhs, ` <= `, ...rhs];
	} else if (opKind === ts.SyntaxKind.PercentToken) {
		return [...lhs, ` % `, ...rhs];
	} else if (opKind === ts.SyntaxKind.InstanceOfKeyword) {
		state.usesTSLibrary = true;
		return [`TS.instanceof(`, ...lhs, `, `, ...rhs, `)`];
	} else {
		/* istanbul ignore next */
		throw new TranspilerError(
			`Bad binary expression! (${node.getOperatorToken().getKindName()})`,
			opToken,
			TranspilerErrorType.BadBinaryExpression,
		);
	}
}
