import * as ts from "ts-morph";
import { checkReserved } from ".";
import { TranspilerState } from "../TranspilerState";
import { shouldHoist } from "../typeUtilities";
import { safeLuaIndex } from "../utility";

export function transpileEnumDeclaration(state: TranspilerState, node: ts.EnumDeclaration) {
	const result = new Array<string>();
	if (node.isConstEnum()) {
		return result;
	}
	const name = [node.getName()];
	const nameNode = node.getNameNode();
	checkReserved(name, nameNode, true);
	state.pushExport(name, node);
	if (shouldHoist(node, nameNode)) {
		state.pushHoistStack(name);
	}
	result.push(state.indent, ...name, " = ", ...name, " or {};\n");
	result.push(state.indent, "do\n");
	state.pushIndent();
	for (const member of node.getMembers()) {
		const memberName = [member.getName()];
		checkReserved(memberName, member.getNameNode());
		const memberValue = member.getValue();
		const safeIndex = safeLuaIndex(name, memberName);
		if (typeof memberValue === "string") {
			result.push(state.indent, ...safeIndex, ' = "', memberValue, '";\n');
		} else if (typeof memberValue === "number") {
			const memberValueStr = memberValue.toString();
			result.push(state.indent, ...safeIndex, " = ", memberValueStr, ";\n");
			result.push(state.indent, ...name, "[", memberValueStr, '] = "', ...memberName, '";\n');
		}
	}
	state.popIndent();
	result.push(state.indent, "end\n");
	return result;
}
