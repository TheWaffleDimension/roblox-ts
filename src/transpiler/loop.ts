import * as ts from "ts-morph";
import {
	expressionModifiesVariable,
	getBindingData,
	placeInStatementIfExpression,
	transpileExpression,
	transpileStatement,
	transpileVariableDeclarationList,
} from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { HasParameters } from "../types";
import { isArrayType, isNumberType, isStringType } from "../typeUtilities";
import { addSeparatorAndFlatten, isIdentifierWhoseDefinitionMatchesNode } from "../utility";

function hasContinueDescendant(node: ts.Node) {
	for (const child of node.getChildren()) {
		if (ts.TypeGuards.isContinueStatement(child)) {
			return true;
		}
		if (
			!(
				ts.TypeGuards.isForInStatement(child) ||
				ts.TypeGuards.isForOfStatement(child) ||
				ts.TypeGuards.isForStatement(child) ||
				ts.TypeGuards.isWhileStatement(child) ||
				ts.TypeGuards.isDoStatement(child)
			)
		) {
			if (hasContinueDescendant(child)) {
				return true;
			}
		}
	}
	return false;
}

export function transpileBreakStatement(state: TranspilerState, node: ts.BreakStatement) {
	return [state.indent, "break;\n"];
}

export function transpileContinueStatement(state: TranspilerState, node: ts.ContinueStatement) {
	return [state.indent, "_continue_", state.continueId.toString(), " = true; break;\n"];
}

export function transpileLoopBody(state: TranspilerState, node: ts.Statement) {
	const hasContinue = hasContinueDescendant(node);

	let endsWithBreakOrReturn = false;
	if (ts.TypeGuards.isBlock(node)) {
		const statements = node.getStatements();
		const lastStatement = statements[statements.length - 1];
		if (ts.TypeGuards.isBreakStatement(lastStatement) || ts.TypeGuards.isReturnStatement(lastStatement)) {
			endsWithBreakOrReturn = true;
		}
	}

	const result = new Array<string>();
	if (hasContinue) {
		state.continueId++;
		result.push(state.indent, `local _continue_`, state.continueId.toString(), ` = false;\n`);
		result.push(state.indent, `repeat\n`);
		state.pushIndent();
	}

	result.push(...transpileStatement(state, node));

	if (hasContinue) {
		if (!endsWithBreakOrReturn) {
			result.push(state.indent, `_continue_`, state.continueId.toString(), ` = true;\n`);
		}
		state.popIndent();
		result.push(state.indent, `until true;\n`);
		result.push(state.indent, `if not _continue_`, state.continueId.toString(), ` then\n`);
		state.pushIndent();
		result.push(state.indent, `break;\n`);
		state.popIndent();
		result.push(state.indent, `end\n`);
		state.continueId--;
	}

	return result;
}

export function transpileDoStatement(state: TranspilerState, node: ts.DoStatement) {
	const condition = transpileExpression(state, node.getExpression());
	const result = new Array<string>();
	result.push(state.indent, "repeat\n");
	state.pushIndent();
	result.push(...transpileLoopBody(state, node.getStatement()));
	state.popIndent();
	result.push(state.indent, "until not (", ...condition, ");\n");
	return result;
}

function isCallExpressionOverridable(node: ts.Expression<ts.ts.Expression>) {
	if (ts.TypeGuards.isCallExpression(node)) {
		const exp = node.getExpression();
		if (ts.TypeGuards.isPropertyAccessExpression(exp)) {
			const subExpType = exp.getExpression().getType();
			return isStringType(subExpType) && exp.getName() === "gmatch";
		}
	}
	return false;
}

function getFirstMemberWithParameters(nodes: Array<ts.Node<ts.ts.Node>>): HasParameters | undefined {
	for (const node of nodes) {
		if (
			ts.TypeGuards.isFunctionExpression(node) ||
			ts.TypeGuards.isArrowFunction(node) ||
			ts.TypeGuards.isFunctionDeclaration(node) ||
			ts.TypeGuards.isConstructorDeclaration(node) ||
			ts.TypeGuards.isMethodDeclaration(node) ||
			ts.TypeGuards.isGetAccessorDeclaration(node) ||
			ts.TypeGuards.isSetAccessorDeclaration(node)
		) {
			return node;
		}
	}
	return undefined;
}

export function transpileForInStatement(state: TranspilerState, node: ts.ForInStatement) {
	state.pushIdStack();
	const init = node.getInitializer();
	let varName = new Array<string>();
	if (ts.TypeGuards.isVariableDeclarationList(init)) {
		for (const declaration of init.getDeclarations()) {
			const lhs = declaration.getChildAtIndex(0);
			if (ts.TypeGuards.isArrayBindingPattern(lhs) || ts.TypeGuards.isObjectBindingPattern(lhs)) {
				throw new TranspilerError(
					`ForIn Loop did not expect binding pattern!`,
					init,
					TranspilerErrorType.UnexpectedBindingPattern,
				);
			} else if (ts.TypeGuards.isIdentifier(lhs)) {
				varName = [lhs.getText()];
			}
		}
	} else if (ts.TypeGuards.isExpression(init)) {
		const initKindName = init.getKindName();
		throw new TranspilerError(
			`ForIn Loop did not expect expression initializer! (${initKindName})`,
			init,
			TranspilerErrorType.UnexpectedInitializer,
		);
	}

	if (varName.length === 0) {
		throw new TranspilerError(`ForIn Loop empty varName!`, init, TranspilerErrorType.ForEmptyVarName);
	}

	const exp = node.getExpression();
	const expStr = transpileExpression(state, exp);
	const result = new Array<string>();

	if (isCallExpressionOverridable(exp)) {
		result.push(state.indent, `for `, ...varName, ` in `, ...expStr, ` do\n`);
	} else if (isArrayType(exp.getType())) {
		result.push(state.indent, `for `, ...varName, ` = 0, #`, ...expStr, ` - 1 do\n`);
	} else {
		result.push(state.indent, `for `, ...varName, ` in pairs(`, ...expStr, `) do\n`);
	}

	state.pushIndent();
	result.push(...transpileLoopBody(state, node.getStatement()));
	state.popIndent();
	result.push(state.indent, `end;\n`);
	state.popIdStack();
	return result;
}

export function transpileForOfStatement(state: TranspilerState, node: ts.ForOfStatement) {
	state.pushIdStack();
	const init = node.getInitializer();
	let lhs: ts.Node<ts.ts.Node> | undefined;
	let varName = new Array<string>();
	const initializers = new Array<Array<string>>();
	if (ts.TypeGuards.isVariableDeclarationList(init)) {
		for (const declaration of init.getDeclarations()) {
			lhs = declaration.getChildAtIndex(0);
			if (ts.TypeGuards.isArrayBindingPattern(lhs) || ts.TypeGuards.isObjectBindingPattern(lhs)) {
				varName = state.getNewId();
				const names = new Array<Array<string>>();
				const values = new Array<Array<string>>();
				const preStatements = new Array<Array<string>>();
				const postStatements = new Array<Array<string>>();
				getBindingData(state, names, values, preStatements, postStatements, lhs, varName);
				preStatements.forEach(myStatement => initializers.push(myStatement));
				initializers.push([
					`local `,
					...addSeparatorAndFlatten(names, ", "),
					` = `,
					...addSeparatorAndFlatten(values, ", "),
					`;\n`,
				]);
				postStatements.forEach(myStatement => initializers.push(myStatement));
			} else if (ts.TypeGuards.isIdentifier(lhs)) {
				varName = [lhs.getText()];
			}
		}
	} else if (ts.TypeGuards.isExpression(init)) {
		const initKindName = init.getKindName();
		throw new TranspilerError(
			`ForOf Loop did not expect expression initializer! (${initKindName})`,
			init,
			TranspilerErrorType.UnexpectedInitializer,
		);
	}

	if (varName.length === 0) {
		throw new TranspilerError(`ForOf Loop empty varName!`, init, TranspilerErrorType.ForEmptyVarName);
	}

	const statement = node.getStatement();
	const exp = node.getExpression();
	let expStr = transpileExpression(state, exp);
	const result = new Array<string>();

	if (isArrayType(exp.getType())) {
		let varValue: Array<string>;
		if (!ts.TypeGuards.isIdentifier(exp)) {
			const arrayName = state.getNewId();
			result.push(state.indent, "local ", ...arrayName, " = ", ...expStr, ";\n");
			expStr = arrayName;
		}
		const myInt = state.getNewId();
		result.push(state.indent, "for ", ...myInt, " = 1, #", ...expStr, " do\n");
		state.pushIndent();
		varValue = [...expStr, "[", ...myInt, "]"];
		result.push(state.indent, "local ", ...varName, " = ", ...varValue, ";\n");
	} else {
		result.push(state.indent, "for _, ", ...varName, " in pairs(", ...expStr, ") do\n");
		state.pushIndent();
	}

	initializers.forEach(initializer => result.push(state.indent, ...initializer));
	result.push(...transpileLoopBody(state, statement));
	state.popIndent();
	result.push(state.indent, `end;\n`);
	state.popIdStack();

	return result;
}

export function checkLoopClassExp(node?: ts.Expression<ts.ts.Expression>) {
	if (node && ts.TypeGuards.isClassExpression(node)) {
		throw new TranspilerError(
			"Loops cannot contain class expressions as their condition/init/incrementor!",
			node,
			TranspilerErrorType.ClassyLoop,
		);
	}
}

function getSignAndValueInForStatement(
	incrementor: ts.BinaryExpression | ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
) {
	let forIntervalStr = "";
	let sign = "";
	if (ts.TypeGuards.isBinaryExpression(incrementor)) {
		const sibling = incrementor.getChildAtIndex(0).getNextSibling();
		if (sibling) {
			let rhsIncr = sibling.getNextSibling();

			if (rhsIncr) {
				if (isNumberType(rhsIncr.getType())) {
					if (sibling.getKind() === ts.SyntaxKind.EqualsToken && ts.TypeGuards.isBinaryExpression(rhsIncr)) {
						// incrementor is something like i = i + 1
						const sib1 = rhsIncr.getChildAtIndex(0).getNextSibling();

						if (sib1) {
							if (sib1.getKind() === ts.SyntaxKind.MinusToken) {
								sign = "-";
							} else if (sib1.getKind() === ts.SyntaxKind.PlusToken) {
								sign = "+";
							}
							rhsIncr = sib1.getNextSibling();
							if (rhsIncr && rhsIncr.getNextSibling()) {
								rhsIncr = undefined;
							}
						}
					}
				} else {
					switch (sibling.getKind()) {
						case ts.SyntaxKind.PlusEqualsToken:
							sign = "+";
							break;
						case ts.SyntaxKind.MinusEqualsToken:
							sign = "-";
							break;
						default:
							break;
					}
				}

				if (rhsIncr && rhsIncr.getType().isNumberLiteral()) {
					forIntervalStr = rhsIncr.getText();
				}
			}
		}
	} else if (incrementor.getOperatorToken() === ts.SyntaxKind.MinusMinusToken) {
		forIntervalStr = "1";
		sign = "-";
	} else {
		forIntervalStr = "1";
		sign = "+";
	}
	return [sign, forIntervalStr];
}

function getLimitInForStatement(
	state: TranspilerState,
	condition: ts.Expression<ts.ts.Expression>,
	lhs: ts.Identifier,
): [string, ts.Node<ts.ts.Node> | undefined] {
	if (ts.TypeGuards.isBinaryExpression(condition)) {
		const lhsCond = condition.getChildAtIndex(0);
		const sibling = lhsCond.getNextSibling();
		if (sibling) {
			const rhsCond = sibling.getNextSibling();

			if (rhsCond) {
				let other: ts.Node<ts.ts.Node>;

				if (isIdentifierWhoseDefinitionMatchesNode(lhsCond, lhs)) {
					other = rhsCond;
					switch (sibling.getKind()) {
						case ts.SyntaxKind.GreaterThanEqualsToken: // >=
							return [">=", other];
						case ts.SyntaxKind.LessThanEqualsToken: // <=
							return ["<=", other];
					}
				} else {
					other = lhsCond;
					switch (sibling.getKind()) {
						case ts.SyntaxKind.GreaterThanEqualsToken: // >=
							return ["<=", other];
						case ts.SyntaxKind.LessThanEqualsToken: // <=
							return [">=", other];
					}
				}
			}
		}
	}
	return ["", undefined];
}

function safelyHandleExpressionsInForStatement(
	state: TranspilerState,
	incrementor: ts.Expression<ts.ts.Expression>,
	incrementorStr: Array<string>,
) {
	if (ts.TypeGuards.isExpression(incrementor)) {
		checkLoopClassExp(incrementor);
	}
	return [state.indent, ...placeInStatementIfExpression(state, incrementor, incrementorStr)];
}

function getSimpleForLoopString(
	state: TranspilerState,
	initializer: ts.VariableDeclarationList,
	forLoopVars: Array<string>,
	statement: ts.Statement<ts.ts.Statement>,
) {
	const result = new Array<string>();
	state.popIndent();

	// hack!
	const first = transpileVariableDeclarationList(state, initializer);
	first[0] = first[0].replace(/^local /, "");
	first[first.length - 1] = first[first.length - 1].replace(/;$/, "");

	result.push(state.indent, "for ", ...first, ", ", ...forLoopVars, " do\n");
	state.pushIndent();
	result.push(...transpileLoopBody(state, statement));
	state.popIndent();
	result.push(state.indent, "end;\n");
	return result;
}

export function transpileForStatement(state: TranspilerState, node: ts.ForStatement) {
	state.pushIdStack();
	const statement = node.getStatement();
	const condition = node.getCondition();
	checkLoopClassExp(condition);
	const conditionStr = condition ? transpileExpression(state, condition) : ["true"];
	const incrementor = node.getIncrementor();
	checkLoopClassExp(incrementor);
	const incrementorStr = incrementor ? [...transpileExpression(state, incrementor), ";\n"] : undefined;

	const result = new Array<string>();
	let localizations = new Array<string>();
	let cleanup = () => {};
	result.push(state.indent, "do\n");
	state.pushIndent();
	const initializer = node.getInitializer();

	if (initializer) {
		if (
			ts.TypeGuards.isVariableDeclarationList(initializer) &&
			initializer.getDeclarationKind() === ts.VariableDeclarationKind.Let
		) {
			const declarations = initializer.getDeclarations();
			const statementDescendants = statement.getDescendants();

			if (declarations.length > 0) {
				const lhs = declarations[0].getChildAtIndex(0);
				if (ts.TypeGuards.isIdentifier(lhs)) {
					const name = lhs.getText();
					let isLoopVarModified = false;
					for (const statementDescendant of statementDescendants) {
						if (expressionModifiesVariable(statementDescendant, lhs)) {
							isLoopVarModified = true;
							break;
						}
					}

					const nextSibling = lhs.getNextSibling();

					if (
						declarations.length === 1 &&
						!isLoopVarModified &&
						incrementor &&
						incrementorStr &&
						nextSibling &&
						condition
					) {
						// check if we can convert to a simple for loop
						// IF there aren't any in-loop modifications to the let variable
						// AND the let variable is a single numeric variable
						// AND the incrementor is a simple +/- expression of the let var
						// AND the conditional expression is a binary expression
						// with one of these operators: <= >= < >
						// AND the conditional expression compares the let var to a numeric literal
						// OR the conditional expression compares the let var to an unchanging number

						const rhs = nextSibling.getNextSibling();
						if (rhs) {
							const rhsType = rhs.getType();
							if (isNumberType(rhsType)) {
								if (expressionModifiesVariable(incrementor, lhs)) {
									let [incrSign, incrValue] = getSignAndValueInForStatement(incrementor);
									if (incrSign) {
										const [condSign, condValue] = getLimitInForStatement(state, condition, lhs);
										if (condValue && condValue.getType().isNumberLiteral()) {
											if (incrSign === "+" && condSign === "<=") {
												const forLoopVars = [
													condValue.getText(),
													incrValue === "1" ? "" : ", " + incrValue,
												];
												return getSimpleForLoopString(
													state,
													initializer,
													forLoopVars,
													statement,
												);
											} else if (incrSign === "-" && condSign === ">=") {
												incrValue = (incrSign + incrValue).replace("--", "");
												incrSign = "";
												const forLoopVars = [condValue.getText(), ", ", incrValue];
												return getSimpleForLoopString(
													state,
													initializer,
													forLoopVars,
													statement,
												);
											}
										}
									}
								}
							}
						}
					}

					// if we can't convert to a simple for loop:
					// if it has any internal function declarataions, make sure to locally scope variables
					if (getFirstMemberWithParameters(statementDescendants)) {
						const alias = state.getNewId();
						state.pushIndent();
						localizations = [state.indent, "local ", ...alias, " = ", name, ";\n"];
						state.popIndent();

						// don't leak
						const previous = state.variableAliases.get(name);

						cleanup = () => {
							if (previous) {
								state.variableAliases.set(name, previous);
							} else {
								state.variableAliases.delete(name);
							}

							if (isLoopVarModified) {
								result.push(state.indent, name, " = ", ...alias, ";\n");
							}
						};

						state.variableAliases.set(name, alias);
					}
				}
			}

			result.push(...transpileVariableDeclarationList(state, initializer));
		} else if (ts.TypeGuards.isExpression(initializer)) {
			const expStr = transpileExpression(state, initializer);
			result.push(...safelyHandleExpressionsInForStatement(state, initializer, expStr), ";\n");
		}
	}

	result.push(state.indent, "while ", ...conditionStr, " do\n");
	result.push(...localizations);
	state.pushIndent();
	result.push(...transpileLoopBody(state, statement));
	cleanup();
	if (incrementor && incrementorStr) {
		result.push(...safelyHandleExpressionsInForStatement(state, incrementor, incrementorStr));
	}
	state.popIndent();
	result.push(state.indent, "end;\n");
	state.popIndent();
	result.push(state.indent, "end;\n");
	state.popIdStack();
	return result;
}

export function transpileWhileStatement(state: TranspilerState, node: ts.WhileStatement) {
	const exp = node.getExpression();
	checkLoopClassExp(exp);
	const expStr = transpileExpression(state, exp);
	const result = new Array<string>();
	result.push(state.indent, "while ", ...expStr, " do\n");
	state.pushIndent();
	result.push(...transpileLoopBody(state, node.getStatement()));
	state.popIndent();
	result.push(state.indent, "end;\n");
	return result;
}
