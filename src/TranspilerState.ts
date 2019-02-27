import * as ts from "ts-morph";
import { ScriptContext } from "./utility";

interface Partition {
	dir: ts.Directory;
	target: string;
}

export class TranspilerState {
	constructor(public readonly syncInfo: Array<Partition>, public readonly modulesDir?: ts.Directory) {}

	// indent
	public indent = "";

	public pushIndent() {
		this.indent += "\t";
	}

	public popIndent() {
		this.indent = this.indent.substr(1);
	}

	// id stack
	public idStack = new Array<number>();

	public pushIdStack() {
		this.idStack.push(0);
	}

	public popIdStack() {
		this.idStack.pop();
	}

	public getNewId() {
		const sum = this.idStack.reduce((accum, value) => accum + value);
		this.idStack[this.idStack.length - 1]++;
		return ["_", sum.toString()];
	}

	// hoist stack
	public hoistStack = new Array<Array<Array<string>>>();

	public pushHoistStack(name: Array<string>) {
		this.hoistStack[this.hoistStack.length - 1].push(name);
	}

	public popHoistStack(result: Array<string>) {
		const top = this.hoistStack.pop();
		if (top) {
			// const hoists = [...top];
			const namedHoists = new Array<string>();
			const declareHoists = new Array<string>();

			// TODO
			// hoists.forEach(v => (v.includes("=") ? declareHoists : namedHoists).push(v));

			if (namedHoists && namedHoists.length > 0) {
				result.unshift(this.indent + `local ${namedHoists.join(", ")};\n`);
			}

			if (declareHoists && declareHoists.length > 0) {
				result.unshift(this.indent + `${declareHoists.join(";\n" + this.indent)};\n`);
			}
		}
	}

	// export stack
	public exportStack = new Array<Array<Array<string>>>();

	public pushExport(name: Array<string>, node: ts.Node & ts.ExportableNode) {
		if (!node.hasExportKeyword()) {
			return;
		}

		const ancestorName = this.getExportContextName(node);
		const alias = node.isDefaultExport() ? ["_default"] : name;
		this.exportStack[this.exportStack.length - 1].push([ancestorName, `.`, ...alias, ` = `, ...name, `;\n`]);
	}

	public getExportContextName(node: ts.VariableStatement | ts.Node): string {
		const myNamespace = node.getFirstAncestorByKind(ts.SyntaxKind.ModuleDeclaration);
		let name;

		if (myNamespace) {
			name = myNamespace.getName();
			name = this.namespaceStack.get(name) || name;
		} else {
			name = "_exports";
			this.isModule = true;
		}

		return name;
	}

	// in the form: { ORIGINAL_IDENTIFIER = REPLACEMENT_VALUE }
	// For example, this is used for  exported/namespace values
	// which should be represented differently in Lua than they
	// can be represented in TS
	public variableAliases = new Map<string, Array<string>>();

	public getAlias(name: Array<string>) {
		const alias = this.variableAliases.get(name.join(""));
		if (alias !== undefined) {
			return alias;
		} else {
			return name;
		}
	}

	public namespaceStack = new Map<string, string>();
	public continueId = -1;
	public isModule = false;
	public scriptContext = ScriptContext.None;
	public roactIndent: number = 0;
	public hasRoactImport: boolean = false;
	public usesTSLibrary = false;
}
