import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileAwaitExpression(state: TranspilerState, node: ts.AwaitExpression) {
	state.usesTSLibrary = true;
	return ["TS.await(", ...transpileExpression(state, node.getExpression()), ")"];
}
