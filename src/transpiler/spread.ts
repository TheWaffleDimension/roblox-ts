import * as ts from "ts-morph";
import { checkNonAny, transpileExpression } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileSpreadElement(state: TranspilerState, node: ts.SpreadElement) {
	const expression = node.getExpression();
	const expStr = transpileExpression(state, expression);
	checkNonAny(expression, true);
	return ["unpack(", expStr, ")"];
}
