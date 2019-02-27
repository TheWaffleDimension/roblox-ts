import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileParenthesizedExpression(state: TranspilerState, node: ts.ParenthesizedExpression) {
	return ["(", ...transpileExpression(state, node.getExpression()), ")"];
}
