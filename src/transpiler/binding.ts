import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { HasParameters } from "../types";
import { addSeparatorAndFlatten } from "../utility";

export function getParameterData(
	state: TranspilerState,
	paramNames: Array<Array<string>>,
	initializers: Array<Array<string>>,
	node: HasParameters,
	defaults?: Array<Array<string>>,
) {
	for (const param of node.getParameters()) {
		const child =
			param.getFirstChildByKind(ts.SyntaxKind.Identifier) ||
			param.getFirstChildByKind(ts.SyntaxKind.ArrayBindingPattern) ||
			param.getFirstChildByKind(ts.SyntaxKind.ObjectBindingPattern);

		/* istanbul ignore next */
		if (child === undefined) {
			throw new TranspilerError(
				"Child missing from parameter!",
				param,
				TranspilerErrorType.ParameterChildMissing,
			);
		}

		let name: Array<string>;
		if (ts.TypeGuards.isIdentifier(child)) {
			if (param.getName() === "this") {
				continue;
			}
			name = transpileExpression(state, child);
		} else {
			name = state.getNewId();
		}

		if (param.isRestParameter()) {
			paramNames.push(["..."]);
			initializers.push(["local ", ...name, " = { ... };"]);
		} else {
			paramNames.push(name);
		}

		const initial = param.getInitializer();
		if (initial) {
			const expStr = transpileExpression(state, initial);
			const defaultValue = ["if ", ...name, " == nil then ", ...name, " = ", ...expStr, " end;"];
			if (defaults) {
				defaults.push(defaultValue);
			} else {
				initializers.push(defaultValue);
			}
		}

		if (param.hasScopeKeyword()) {
			initializers.push(["self.", ...name, " = ", ...name, ";"]);
		}

		if (ts.TypeGuards.isArrayBindingPattern(child) || ts.TypeGuards.isObjectBindingPattern(child)) {
			const names = new Array<Array<string>>();
			const values = new Array<Array<string>>();
			const preStatements = new Array<Array<string>>();
			const postStatements = new Array<Array<string>>();
			getBindingData(state, names, values, preStatements, postStatements, child, name);
			preStatements.forEach(statement => initializers.push(statement));
			initializers.push([
				"local ",
				...addSeparatorAndFlatten(names, ", "),
				" = ",
				...addSeparatorAndFlatten(values, ", "),
				";",
			]);
			postStatements.forEach(statement => initializers.push(statement));
		}
	}
}

export function getBindingData(
	state: TranspilerState,
	names: Array<Array<string>>,
	values: Array<Array<string>>,
	preStatements: Array<Array<string>>,
	postStatements: Array<Array<string>>,
	bindingPattern: ts.Node,
	parentId: Array<string>,
) {
	const strKeys = bindingPattern.getKind() === ts.SyntaxKind.ObjectBindingPattern;
	const listItems = bindingPattern
		.getFirstChildByKindOrThrow(ts.SyntaxKind.SyntaxList)
		.getChildren()
		.filter(
			child =>
				ts.TypeGuards.isBindingElement(child) ||
				ts.TypeGuards.isOmittedExpression(child) ||
				ts.TypeGuards.isIdentifier(child) ||
				ts.TypeGuards.isArrayLiteralExpression(child) ||
				ts.TypeGuards.isPropertyAccessExpression(child),
		);
	let childIndex = 1;
	let childIndexStr = childIndex.toString();
	for (const item of listItems) {
		/* istanbul ignore else */
		if (ts.TypeGuards.isBindingElement(item)) {
			const [child, op, pattern] = item.getChildren();
			const childText = child.getText();
			const key = strKeys ? ['"', childText, '"'] : [childIndexStr];

			if (child.getKind() === ts.SyntaxKind.DotDotDotToken) {
				throw new TranspilerError(
					"Operator ... is not supported for destructuring!",
					child,
					TranspilerErrorType.SpreadDestructuring,
				);
			}

			/* istanbul ignore else */
			if (
				pattern &&
				(ts.TypeGuards.isArrayBindingPattern(pattern) || ts.TypeGuards.isObjectBindingPattern(pattern))
			) {
				const childId = state.getNewId();
				preStatements.push(["local ", ...childId, " = ", ...parentId, "[", ...key, "];"]);
				getBindingData(state, names, values, preStatements, postStatements, pattern, childId);
			} else if (ts.TypeGuards.isArrayBindingPattern(child)) {
				const childId = state.getNewId();
				preStatements.push(["local ", ...childId, " = ", ...parentId, "[", ...key, "];"]);
				getBindingData(state, names, values, preStatements, postStatements, child, childId);
			} else if (ts.TypeGuards.isIdentifier(child)) {
				let id: Array<string>;
				if (pattern && pattern.getKind() === ts.SyntaxKind.Identifier) {
					id = transpileExpression(state, pattern as ts.Expression);
				} else {
					id = transpileExpression(state, child as ts.Expression);
				}
				names.push(id);
				if (op && op.getKind() === ts.SyntaxKind.EqualsToken) {
					const value = transpileExpression(state, pattern as ts.Expression);
					postStatements.push(["if ", ...id, " == nil then ", ...id, " = ", ...value, " end;"]);
				}
				values.push([...parentId, "[", ...key, "]"]);
			}
		} else if (ts.TypeGuards.isIdentifier(item)) {
			const id = transpileExpression(state, item as ts.Expression);
			names.push(id);
			values.push([...parentId, "[", childIndexStr, "]"]);
		} else if (ts.TypeGuards.isPropertyAccessExpression(item)) {
			const id = transpileExpression(state, item as ts.Expression);
			names.push(id);
			values.push([...parentId, "[", childIndexStr, "]"]);
		} else if (ts.TypeGuards.isArrayLiteralExpression(item)) {
			const childId = state.getNewId();
			preStatements.push(["local ", ...childId, " = ", ...parentId, "[", childIndexStr, "];"]);
			getBindingData(state, names, values, preStatements, postStatements, item, childId);
		}
		childIndex++;
		childIndexStr = childIndex.toString();
	}
}
