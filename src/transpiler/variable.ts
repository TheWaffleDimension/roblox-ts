import * as ts from "ts-morph";
import { checkReserved, getBindingData, transpileCallExpression, transpileExpression } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { isTupleReturnType, shouldHoist } from "../typeUtilities";

export function transpileVariableDeclaration(state: TranspilerState, node: ts.VariableDeclaration) {
	const lhs = node.getNameNode();
	const rhsNode = node.getInitializer();

	const parent = node.getParent();
	const grandParent = parent.getParent();
	const isExported = ts.TypeGuards.isVariableStatement(grandParent) && grandParent.isExported();

	let decKind = ts.VariableDeclarationKind.Const;
	if (ts.TypeGuards.isVariableDeclarationList(parent)) {
		decKind = parent.getDeclarationKind();
	}

	let parentName = "";
	if (isExported) {
		parentName = state.getExportContextName(grandParent);
	}

	if (ts.TypeGuards.isArrayBindingPattern(lhs)) {
		const isFlatBinding = lhs
			.getElements()
			.filter(v => ts.TypeGuards.isBindingElement(v))
			.every(bindingElement => bindingElement.getChildAtIndex(0).getKind() === ts.SyntaxKind.Identifier);
		if (isFlatBinding && rhsNode && ts.TypeGuards.isCallExpression(rhsNode) && isTupleReturnType(rhsNode)) {
			const names = new Array<Array<string>>();
			const values = new Array<Array<string>>();
			for (const element of lhs.getElements()) {
				if (ts.TypeGuards.isBindingElement(element)) {
					const nameNode = element.getNameNode();
					if (ts.TypeGuards.isIdentifier(nameNode)) {
						names.push(transpileExpression(state, nameNode));
					}
				} else if (ts.TypeGuards.isOmittedExpression(element)) {
					names.push(["_"]);
				}
			}
			values.push(transpileCallExpression(state, rhsNode, true));
			if (isExported && decKind === ts.VariableDeclarationKind.Let) {
				return [state.indent, names.join(", "), " = ", values.join(", "), ";\n"];
			} else {
				if (isExported && ts.TypeGuards.isVariableStatement(grandParent)) {
					names.forEach(name => state.pushExport(name, grandParent));
				}
				return [state.indent, "local ", names.join(", "), " = ", values.join(", "), ";\n"];
			}
		}
	}

	const result = new Array<string>();
	if (ts.TypeGuards.isIdentifier(lhs)) {
		const name = lhs.getText();
		checkReserved(name, lhs, true);
		if (rhsNode) {
			const value = transpileExpression(state, rhsNode);
			if (isExported && decKind === ts.VariableDeclarationKind.Let) {
				result.push(state.indent, parentName, ".", name, " = ", ...value, ";\n");
			} else {
				if (isExported && ts.TypeGuards.isVariableStatement(grandParent)) {
					state.pushExport([name], grandParent);
				}
				if (shouldHoist(grandParent, lhs)) {
					state.pushHoistStack([name]);
					result.push(state.indent, name, " = ", ...value, ";\n");
				} else {
					result.push(state.indent, "local ", name, " = ", ...value, ";\n");
				}
			}
		} else if (!isExported) {
			if (shouldHoist(grandParent, lhs)) {
				state.pushHoistStack([name]);
			} else {
				result.push(state.indent, "local ", name, ";\n");
			}
		}
	} else if ((ts.TypeGuards.isArrayBindingPattern(lhs) || ts.TypeGuards.isObjectBindingPattern(lhs)) && rhsNode) {
		// binding patterns MUST have rhs
		const names = new Array<Array<string>>();
		const values = new Array<Array<string>>();
		const preStatements = new Array<Array<string>>();
		const postStatements = new Array<Array<string>>();
		if (ts.TypeGuards.isIdentifier(rhsNode)) {
			getBindingData(state, names, values, preStatements, postStatements, lhs, transpileExpression(state, rhsNode));
		} else {
			const rootId = state.getNewId();
			const rhs = transpileExpression(state, rhsNode);
			preStatements.push(["local ", ...rootId, " = ", ...rhs, ";"]);
			getBindingData(state, names, values, preStatements, postStatements, lhs, rootId);
		}
		preStatements.forEach(statementStr => (result.push(state.indent, ...statementStr, "\n")));
		if (values.length > 0) {
			if (isExported && decKind === ts.VariableDeclarationKind.Let) {
				result.push(state.indent, names.join(", "), " = ", values.join(", "), ";\n");
			} else {
				if (isExported && ts.TypeGuards.isVariableStatement(grandParent)) {
					names.forEach(name => state.pushExport(name, grandParent));
				}
				result.push(state.indent, "local ", names.join(", "), " = ", values.join(", "), ";\n");
			}
		}
		postStatements.forEach(statementStr => (result.push(state.indent, ...statementStr, "\n")));
	}

	return result;
}

export function transpileVariableDeclarationList(state: TranspilerState, node: ts.VariableDeclarationList) {
	const declarationKind = node.getDeclarationKind();
	if (declarationKind === ts.VariableDeclarationKind.Var) {
		throw new TranspilerError(
			"'var' keyword is not supported! Use 'let' or 'const' instead.",
			node,
			TranspilerErrorType.NoVarKeyword,
		);
	}

	const result = new Array<string>();
	for (const declaration of node.getDeclarations()) {
		result.push(...transpileVariableDeclaration(state, declaration));
	}
	return result;
}

export function transpileVariableStatement(state: TranspilerState, node: ts.VariableStatement) {
	const list = node.getFirstChildByKindOrThrow(ts.SyntaxKind.VariableDeclarationList);
	return transpileVariableDeclarationList(state, list);
}
