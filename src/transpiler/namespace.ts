import * as ts from "ts-morph";
import { checkReserved, transpileStatementedNode } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { isTypeOnlyNamespace } from "../typeUtilities";

function safeMapGet<T, R>(map: Map<T, R>, key: T, node: ts.Node) {
	const find = map.get(key);
	if (!find) {
		throw new TranspilerError(
			`Failed to find context for ${node.getKindName()} ${node.getText()}`,
			node,
			TranspilerErrorType.BadContext,
		);
	}
	return find;
}

export function transpileNamespaceDeclaration(state: TranspilerState, node: ts.NamespaceDeclaration) {
	if (isTypeOnlyNamespace(node)) {
		return [];
	}
	state.pushIdStack();
	const name = node.getName();
	checkReserved(name, node, true);
	const parentNamespace = node.getFirstAncestorByKind(ts.SyntaxKind.ModuleDeclaration);
	state.pushExport([name], node);
	state.pushHoistStack([name]);
	const result = new Array<string>();
	const id = state.getNewId();
	const previousName = state.namespaceStack.get(name);
	if (parentNamespace) {
		const parentName = safeMapGet(state.namespaceStack, parentNamespace.getName(), node);
		result.push(state.indent, `${name} = ${parentName}.${name} or {} do\n`);
	} else {
		result.push(state.indent, `${name} = ${name} or {} do\n`);
	}
	state.namespaceStack.set(name, id);
	state.pushIndent();
	result.push(state.indent, `local ${id} = ${name};\n`);
	result.push(...transpileStatementedNode(state, node));
	if (previousName) {
		state.namespaceStack.set(name, previousName);
	} else {
		state.namespaceStack.delete(name);
	}
	state.popIndent();
	result.push(state.indent, `end;\n`);
	state.popIdStack();
	return result;
}
