import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileArrayLiteralExpression(state: TranspilerState, node: ts.ArrayLiteralExpression) {
	const elements = node.getElements();
	if (elements.length === 0) {
		return ["{}"];
	}
	let isInArray = false;
	const parts = new Array<Array<string> | string>();
	elements.forEach(element => {
		if (ts.TypeGuards.isSpreadElement(element)) {
			parts.push(...transpileExpression(state, element.getExpression()));
			isInArray = false;
		} else {
			let last: Array<string>;
			if (isInArray) {
				last = parts[parts.length - 1] as Array<string>;
			} else {
				last = new Array<string>();
				parts.push(last);
			}
			last.push(...transpileExpression(state, element));
			isInArray = true;
		}
	});

	const params = parts.map(v => (typeof v === "string" ? v : `{ ${v.join(", ")} }`)).join(", ");
	if (elements.some(v => ts.TypeGuards.isSpreadElement(v))) {
		state.usesTSLibrary = true;
		return ["TS.array_concat(", ...params, ")"];
	} else {
		return [params];
	}
}
